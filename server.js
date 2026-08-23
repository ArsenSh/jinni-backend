require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// connect-mongo v6 ships an ESM-style export: the CJS require() returns a
// namespace object, so the store lives on `.default` (with `.MongoStore` as
// a named alias). Destructuring the wrong one yields `MongoStore.create is
// not a function` and the server dies on boot.
const MongoStore = require('connect-mongo').default;
const morgan = require('morgan');
const path = require('path');
const logger = require('./utils/logger');
const emailService = require('./services/emailService');
const contactRoutes = require('./routes/contact');
const currencyService = require('./services/currencyService'); // ← Currency service import
const session = require('express-session');
const passport = require('passport');
const app = express();

app.set('trust proxy', 1);

// =============================================
// 1. Environment Validation
// =============================================
const envConfig = {
    JWT_SECRET: {
        required: true,
        type: 'string',
        minLength: 32,
        errorMessage: 'JWT_SECRET must be at least 32 characters long'
    },
    MONGODB_URI: {
        required: true,
        type: 'string',
        regex: /^mongodb(\+srv)?:\/\//,
        errorMessage: 'MONGODB_URI must be a valid MongoDB connection string'
    },
    OPENAI_API_KEY: {
        required: true,
        type: 'string',
        startsWith: 'sk-',
        errorMessage: 'OPENAI_API_KEY must start with "sk-"'
    },
    EMAIL_USER: {
        required: true,
        type: 'string',
        regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        errorMessage: 'EMAIL_USER must be a valid email address'
    },
    EMAIL_APP_PASSWORD: {
        required: true,
        type: 'string',
        minLength: 10,
        errorMessage: 'EMAIL_APP_PASSWORD is required for sending emails'
    },
    GOOGLE_CLIENT_ID: {
        required: true,
        type: 'string',
        regex: /\.apps\.googleusercontent\.com$/,
        errorMessage: 'GOOGLE_CLIENT_ID must be a valid Google OAuth client ID'
    },
    GOOGLE_CLIENT_SECRET: {
        required: true,
        type: 'string',
        minLength: 20,
        errorMessage: 'GOOGLE_CLIENT_SECRET is required for Google OAuth'
    },
    SESSION_SECRET: {
        required: true,
        type: 'string',
        minLength: 32,
        errorMessage: 'SESSION_SECRET must be at least 32 characters long'
    },
    PORT: {
        required: false,
        type: 'number',
        default: 5000
    },
    FRONTEND_URL: {
        required: true,
        type: 'string',
        errorMessage: 'FRONTEND_URL is required for CORS configuration'
    }
};

const validateEnv = () => {
    let isValid = true;
    for (const [key, config] of Object.entries(envConfig)) {
        if (config.required && !process.env[key]) {
            logger.error(`❌ Missing environment variable: ${key}`);
            if (config.errorMessage) logger.error(`   ${config.errorMessage}`);
            isValid = false;
            continue;
        }
        if (process.env[key]) {
            if (config.type === 'number' && isNaN(Number(process.env[key]))) {
                logger.error(`❌ ${key} must be a number, got: ${process.env[key]}`);
                isValid = false;
            }
            if (config.regex && !config.regex.test(process.env[key])) {
                logger.error(`❌ ${key} has invalid format: ${process.env[key]}`);
                isValid = false;
            }
            if (config.startsWith && !process.env[key].startsWith(config.startsWith)) {
                logger.error(`❌ ${key} must start with "${config.startsWith}"`);
                isValid = false;
            }
            if (config.minLength && process.env[key].length < config.minLength) {
                logger.error(`❌ ${key} must be at least ${config.minLength} characters`);
                isValid = false;
            }
        }
    }
    if (!isValid) {
        logger.error('🛑 Server startup aborted due to invalid environment configuration');
        process.exit(1);
    }
    for (const [key, config] of Object.entries(envConfig)) { if (!process.env[key] && config.default !== undefined) { process.env[key] = config.default } }
    logger.info('✅ Environment variables validated successfully');
};
validateEnv();

// =============================================
// SESSION AND PASSPORT MIDDLEWARE (ADD THIS)
// =============================================
// Refuse to boot in production without real secrets — a hardcoded fallback
// session/JWT secret is a public key everyone can forge with.
const SESSION_SECRET = process.env.SESSION_SECRET
    || (process.env.NODE_ENV === 'production'
        ? (() => { console.error('FATAL: SESSION_SECRET is required in production'); process.exit(1); })()
        : 'dev-only-insecure-session-secret');
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is required in production'); process.exit(1);
}

// Sessions live in MongoDB, not in the process. The default MemoryStore warns
// on boot that it "will leak memory, and will not scale past a single
// process" — and it means it: every OAuth round trip allocated a session that
// was never evicted, so the container grew until it was OOM-killed. That is
// the classic "server stopped responding after a few hours" cause.
app.use(session({
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: 'sessions',
        ttl: 24 * 60 * 60,          // seconds — matches the cookie maxAge below
        autoRemove: 'native',       // let Mongo expire them via a TTL index
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to false for HTTP (localhost)
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true
    }
}));
app.use(passport.initialize());
app.use(passport.session());

// =============================================
// 2. Database Connection
// =============================================
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            // Force IPv4. macOS + Atlas SRV records intermittently resolve to an
            // IPv6 route that silently times out — the classic cause of the
            // "connects fine → Mongoose disconnected → ReplicaSetNoPrimary →
            // reconnects" flapping in dev. IPv4 sidesteps it entirely.
            family: 4,
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
            // Atlas idles quiet sockets; a finite socketTimeout + frequent
            // heartbeats detect a dead link in seconds instead of minutes.
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 5000,
            maxPoolSize: 10,
            // Auto-retry a read/write that dies mid-flight during a brief
            // primary election or network hiccup (Atlas supports both).
            retryWrites: true,
            retryReads: true,
        });
        logger.info('✅ Connected to MongoDB');
        mongoose.connection.on('connected', () => { logger.info('Mongoose connected to DB') });
        mongoose.connection.on('error', (err) => { logger.error('Mongoose connection error:', err) });
        mongoose.connection.on('disconnected', () => { logger.warn('Mongoose disconnected from DB') });
        process.on('SIGINT', async () => {
            await mongoose.connection.close();
            logger.info('Mongoose connection closed due to app termination');
            process.exit(0);
        });
    } catch (error) {
        logger.error('❌ MongoDB connection error:', error);
        throw error;
    }
};

const connectWithRetry = async (maxRetries = 5, retryDelay = 5000) => {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            await connectDB();
            return;
        } catch (error) {
            retries++;
            if (retries >= maxRetries) {
                logger.error(`🛑 Failed to connect to MongoDB after ${maxRetries} attempts`);
                process.exit(1);
            }
            logger.warn(`Retrying MongoDB connection (attempt ${retries}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
};

// =============================================
// 3. Email Service Initialization
// =============================================
const initializeEmailService = async () => {
    try {
        const isConnected = await emailService.testConnection();
        if (isConnected) { logger.info('✅ Email service initialized successfully') } 
        else {
            logger.error('❌ Email service failed to initialize');
            process.exit(1);
        }
    } catch (error) {
        logger.error('❌ Email service initialization error:', error);
        process.exit(1);
    }
};

// =============================================
// 3.5 Currency Service Initialization (NEW)
// =============================================
const initializeCurrencyService = async () => {
    try {
        await currencyService.initialize();
        const health = currencyService.healthCheck();
        logger.info('✅ Currency service initialized successfully');
        logger.info(`💱 Current rates: ${JSON.stringify(health.currentRates)}`);
    } catch (error) {
        logger.warn('⚠️ Currency service failed to fetch rates, using fallback rates');
        logger.warn('   The service will retry in 12 hours');
        // Don't exit - the service can still work with fallback rates
    }
};


// =============================================
// 4. Middleware Configuration
// =============================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://static.cloudflareinsights.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: [
                "'self'",
                process.env.FRONTEND_URL,
                "https://static.cloudflareinsights.com",
                "https://cloudflareinsights.com",
                "https://nominatim.openstreetmap.org",
                "https://*.tile.openstreetmap.org"
            ],
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const corsOptions = {
    origin: (origin, callback) => {
        const allowedOrigins = [
            process.env.FRONTEND_URL,
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://192.168.1.5:5173',
            'http://localhost:5000'
        ].filter(Boolean);
        if (!origin || allowedOrigins.includes(origin)) { callback(null, true) } 
        else {
            logger.warn(`CORS blocked request from origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Custom response headers are invisible to cross-origin JS unless they
    // are named here. The X-Usage-* values were being set on every AI
    // response and silently dropped by the browser, so the client could
    // never show live quota.
    exposedHeaders: [
        'X-Usage-Tokens-Used',
        'X-Usage-Tokens-Remaining',
        'X-Usage-Places-Viewed',
        'X-Usage-Places-Remaining',
        'X-Usage-Requests-Remaining'
    ],
    maxAge: 86400
};
app.use(cors(corsOptions));

// Now define and apply rate limiters

// Real client IP for rate limiting. Behind Cloudflare→Caddy→Node, req.ip is a
// proxy address; CF-Connecting-IP is the true origin and Cloudflare always
// sets it. Falls back to req.ip for direct/local requests.
const clientKey = (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown');

const emailLimiter = rateLimit({
    keyGenerator: clientKey,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 email requests per window
    message: { status: 'error', message: 'Too many email requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/auth/send-verification', emailLimiter);
app.use('/api/auth/resend-verification', emailLimiter);

const apiLimiter = rateLimit({
    keyGenerator: clientKey,
    windowMs: 15 * 60 * 1000, // 15 minutes
    // 100/15min proved far too low in practice: the staff page fires ~12
    // requests per load, the admin dashboard dozens, and several users often
    // share one IP (household / office NAT). 2000 ≈ 2.2 req/s sustained —
    // still a wall against scripted abuse, invisible to real users.
    // (The old per-path max() and the '/api/health' skip never matched at all:
    // req.path inside a middleware mounted at '/api' has the mount prefix
    // stripped — that's why we test req.originalUrl below.)
    max: 2000,
    message: { status: 'error', message: 'Too many requests from this IP, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    // Health checks and cached place images (served from Mongo, no Google
    // call, Cloudflare-cacheable) don't count — one Explore load pulls 40+
    // images and would eat the whole budget otherwise.
    skip: (req) => req.originalUrl === '/api/health' || req.originalUrl.startsWith('/api/ai/place-image')
});
app.use('/api/', apiLimiter);

const googleLimiter = rateLimit({
    keyGenerator: clientKey,
    windowMs: 60 * 1000, // 1 minute
    max: 50, // 50 requests/min
    message: 'Too many Google API requests',
    // Stored images don't touch Google — exempt them here too.
    skip: (req) => req.originalUrl.startsWith('/api/ai/place-image')
});
app.use('/api/ai', googleLimiter);

app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        try { JSON.parse(buf.toString()) } 
        catch (e) { throw new Error('Invalid JSON payload') }
    }
}));

app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 10000 }));

// Strip Mongo operators ($, .) from user input app-wide. Without this, a body
// like {"email": {"$ne": null}} can turn a findOne into an auth bypass.
const mongoSanitize = require('express-mongo-sanitize');
app.use(mongoSanitize());


app.use(morgan(':method :url :status :response-time ms - :res[content-length]', {
    stream: { write: (message) => logger.http(message.trim()) },
    skip: (req) => req.path === '/api/health'
}));

app.use((req, res, next) => {
    logger.debug(`Incoming request: ${req.method} ${req.path}`);
    next();
});

// =============================================
// 5. Database Connection Initialization (UPDATED)
// =============================================
const initializeServices = async () => {
    await connectWithRetry();
    await initializeEmailService();
    await initializeCurrencyService(); // ← Added currency service initialization
};
initializeServices().catch(err => {
    logger.error('🛑 Failed to initialize services:', err);
    process.exit(1);
});

// =============================================
// 6. Route Configuration
// =============================================
const authRoutes = require(path.join(__dirname, 'routes', 'authRoutes'));
const aiRoutes = require(path.join(__dirname, 'routes', 'aiRoutes'));
const businessRoutes = require(path.join(__dirname, 'routes', 'businessRoutes'));
const analyticsRoutes = require(path.join(__dirname, 'routes', 'analyticsRoutes'));
const settingsRoutes = require(path.join(__dirname, 'routes', 'settingsRoutes'));
const adminRoutes = require(path.join(__dirname, 'routes', 'adminRoutes'));
const mediaRoutes = require(path.join(__dirname, 'routes', 'mediaRoutes'));
const savesRoutes = require(path.join(__dirname, 'routes', 'saves'));
const shareRouter = require('./routes/share');
const staffRoutes = require(path.join(__dirname, 'routes', 'staffRoutes'));
const routingRoutes = require(path.join(__dirname, 'routes', 'routingRoutes'));


const auth = require(path.join(__dirname, 'middleware', 'auth'));

app.use('/api/auth', authRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/ai', require(path.join(__dirname, 'routes', 'aiChatV2')));   // v2 engine, parallel to v1 — see backend/engine/ENGINE.md
app.use('/auth', authRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/saves', auth, savesRoutes);
app.use('/api/share', shareRouter);
// Root-mounted OG preview for shared trips. Caddy routes jinni.travel/share/*
// here ONLY for crawler user-agents (WhatsApp/Facebook/Twitter/etc.) so link
// previews render rich cards; human browsers keep hitting the static SPA.
app.get('/share/:token', shareRouter.ogHandler);
app.use('/api/staff', staffRoutes);
app.use('/api/routing', routingRoutes);
app.use('/api/itinerary', require('./routes/itineraryRoutes'));

// =============================================
// 6.5 Currency API Endpoints (NEW - OPTIONAL)
// =============================================
app.get('/api/currency/rates', (req, res) => {
    try {
        const rates = currencyService.getCurrentRates();
        res.json({ success: true, data: rates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/currency/health', (req, res) => {
    try {
        const health = currencyService.healthCheck();
        res.json({ success: true, data: health });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/currency/refresh', async (req, res) => {
    try {
        // Optional: Add admin authentication here
        const updatedRates = await currencyService.forceUpdate();
        res.json({ success: true, message: 'Exchange rates refreshed', data: updatedRates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/currency/convert', (req, res) => {
    try {
        const { amount, from, to } = req.body;
        
        if (!amount || !from || !to) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: amount, from, to'
            });
        }
        
        const usdAmount = currencyService.convertToUSD(amount, from);
        const converted = currencyService.convertFromUSD(usdAmount, to);
        const display = currencyService.convertPriceForDisplay(usdAmount, to);
        
        res.json({
            success: true,
            data: {
                original: { amount: amount, currency: from },
                converted: {
                    amount: Math.round(converted * 100) / 100,
                    currency: to,
                    formatted: display.formatted
                },
                rate: currencyService.getExchangeRate(to)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// =============================================
// 7. Health Check Endpoint (UPDATED)
// =============================================
app.get('/api/health', async (req, res) => {
    const healthcheck = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'ExploreAI Backend',
        version: require('./package.json').version,
        checks: {
            database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            memoryUsage: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`,
            uptime: `${process.uptime().toFixed(2)}s`,
            environment: process.env.NODE_ENV || 'development',
            currency: currencyService.healthCheck().status // ← Added currency health check
        }
    };
    try {
        await mongoose.connection.db.admin().ping();
        res.json(healthcheck);
    } catch (error) {
        healthcheck.status = 'WARNING';
        healthcheck.checks.database = 'unresponsive';
        healthcheck.error = error.message;
        res.status(503).json(healthcheck);
    }
});

// =============================================
// 8. API Documentation Endpoint (UPDATED)
// =============================================
app.get('/', (req, res) => {
    res.json({
        message: 'ExploreAI Backend API',
        version: require('./package.json').version,
        endpoints: {
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login',
                profile: 'GET /api/auth/me'
            },
            ai: {
                travelAssistant: 'POST /api/ai/travel-assistant',
                chat: 'POST /api/ai/chat',
                quickActions: 'POST /api/ai/quick-action'
            },
            business: {
                create: 'POST /api/business',
                get: 'GET /api/business/:id',
                update: 'PUT /api/business/:id'
            },
            analytics: {
                dashboard: 'GET /api/analytics/dashboard',
                business: 'GET /api/analytics/business/:id'
            },
            currency: { // ← Added currency endpoints
                rates: 'GET /api/currency/rates',
                health: 'GET /api/currency/health',
                refresh: 'POST /api/currency/refresh',
                convert: 'POST /api/currency/convert'
            }
        },
        documentation: 'https://docs.exploreai.com/api'
    });
});

// =============================================
// 9. Error Handling
// =============================================
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Route not found',
        path: req.path,
        method: req.method
    });
});
const errorHandler = require(path.join(__dirname, 'middleware', 'errorHandler'));
app.use(errorHandler);

// =============================================
// 10. Server Startup
// =============================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
    logger.info(`💱 Currency service active with auto-updates every 12 hours`);
});

// ── Connection timeouts ─────────────────────────────────────────────────────
// All three were left at Node's defaults, so a stalled or half-open socket
// could occupy a slot indefinitely and they accumulate until nothing new can
// be served. Ordered deliberately: headersTimeout MUST exceed keepAliveTimeout
// or Node races itself and drops healthy keep-alive connections.
//
// `requestTimeout` is 0 (disabled) ON PURPOSE — the AI endpoints stream for
// minutes and a blanket request timeout would cut them off mid-answer. Stream
// handlers bound themselves via their own disconnect handling instead.
server.keepAliveTimeout = 65_000;   // > the 60s most proxies/CDNs use
server.headersTimeout   = 70_000;   // must be greater than keepAliveTimeout
server.requestTimeout   = 0;        // streaming endpoints need unbounded time

// =============================================
// Zone Auction resolution scheduler
// =============================================
// Periodically resolves the Zone Auction: opens 72h defend windows ~7 days
// before a slot's quarterly renewal, processes forfeits whose window lapsed,
// and promotes bidders into slots freed by cancellation.
//
// runAuctionResolution() is idempotent, so a plain interval is safe — no
// external cron dependency needed. Runs once on startup, then hourly.
//
// Hourly cadence chosen so a forfeit deadline (72h fixed) is awarded within
// at most ~1h of expiry — tight enough to feel responsive, loose enough
// that the DB sweep cost is negligible.
//
// IMPORTANT: assumes a single API server instance. If you ever scale to
// multiple instances behind a load balancer, every instance will fire its
// own interval independently — sweeps are data-safe (idempotent) but you
// will send duplicate emails. Migrate to scripts/runAuctionResolver.js
// (standalone worker + cross-process Mongo lock) before scaling horizontally.
const zoneAuction = require('./services/zoneAuction');
const AUCTION_SWEEP_MS = 60 * 60 * 1000; // 1 hour

// ── Safety: dry-run by default ────────────────────────────────────────────
// runAuctionResolution() can promote bidders, expire incumbents, and email
// owners. Since it had never run against real data, the sweep starts in
// DRY-RUN mode: it computes and logs exactly what it WOULD do (which bidder
// would win which slot, at what price) but writes nothing and sends no email.
//
// Flip to live mode only after inspecting a few dry-run logs:
//     AUCTION_SCHEDULER_LIVE=true
// Other controls:
//     AUCTION_SCHEDULER_ENABLED=false  → don't schedule the sweep at all
const AUCTION_SCHEDULER_ENABLED = process.env.AUCTION_SCHEDULER_ENABLED !== 'false';
const AUCTION_SCHEDULER_LIVE    = process.env.AUCTION_SCHEDULER_LIVE === 'true';

// Overlap guard: if a previous sweep is still running when the next tick
// fires (e.g. Mongo was slow), skip the new one rather than running two
// concurrent passes. The next tick will pick up wherever the slow one left
// off — the passes are idempotent.
let sweepInFlight = false;

async function runAuctionSweep() {
    if (sweepInFlight) {
        logger.warn('[zoneAuction] previous sweep still running — skipping this tick');
        return;
    }
    sweepInFlight = true;
    const startedAt = Date.now();
    const dryRun = !AUCTION_SCHEDULER_LIVE;
    const mode = dryRun ? 'DRY-RUN' : 'LIVE';
    try {
        const summary = await zoneAuction.runAuctionResolution({ dryRun });
        logger.info(
            `[zoneAuction:${mode}] sweep done in ${Date.now() - startedAt}ms — ` +
            `defendWindowsOpened=${summary.defendWindowsOpened} ` +
            `forfeitsResolved=${summary.forfeitsResolved} ` +
            `cleanVacancies=${summary.cleanVacancies}`
        );
        if (dryRun && summary.plans?.length) {
            // Surface the intended promotions so you can verify before going live.
            logger.info(`[zoneAuction:DRY-RUN] would promote: ${JSON.stringify(summary.plans)}`);
        }
        if (summary.errors?.length) {
            summary.errors.forEach(e => logger.warn(`[zoneAuction:${mode}] sweep error: ${e}`));
        }
    } catch (err) {
        logger.error(`[zoneAuction:${mode}] sweep failed:`, err);
    } finally {
        sweepInFlight = false;
    }
}

// ── Finished event destinations ──────────────────────────────────────────────
// Staff-added event destinations (concerts, festivals) are editorial content
// with no owner, so once they have happened they are deleted outright rather
// than parked in a status the way an owner's event business is. The sweep also
// clears the mirrored images those destinations left in PlaceCache. Runs on its
// own schedule with a grace window — see services/eventCleanup.js.
const { startEventCleanup } = require('./services/eventCleanup');
startEventCleanup();

let auctionSweepTimer = null;
if (AUCTION_SCHEDULER_ENABLED) {
    // First sweep shortly after startup (give Mongo time to connect), then on interval.
    setTimeout(runAuctionSweep, 30 * 1000);
    auctionSweepTimer = setInterval(runAuctionSweep, AUCTION_SWEEP_MS);
    logger.info(
        `⚖️  Zone Auction scheduler active — sweep every 1 hour, mode: ` +
        `${AUCTION_SCHEDULER_LIVE ? 'LIVE (writes enabled)' : 'DRY-RUN (no writes — set AUCTION_SCHEDULER_LIVE=true to go live)'}`
    );
} else {
    logger.info('⚖️  Zone Auction scheduler disabled via AUCTION_SCHEDULER_ENABLED=false');
}

// ── Embedding sweep (v2 corpus) ──────────────────────────────────────────────
// A newly registered Business / validator Destination / fresh PlaceCache row
// gets its semantic vector automatically: shortly after boot and then daily,
// any doc missing an embedding for the current model is topped up. The
// embedder is already resident (it embeds every v2 chat query), so a normal
// sweep costs milliseconds. Fail-open — a sweep failure only logs.
const EMBED_SWEEP_MS = 24 * 60 * 60 * 1000;
const runEmbedSweep = async () => {
    try {
        const { sweepMissingEmbeddings } = require('./engine/retrieval/embedSweep');
        const r = await sweepMissingEmbeddings();
        if (r.embedded > 0) logger.info(`[embed] sweep: +${r.embedded} embedded ${JSON.stringify(r.bySource)}`);
    } catch (err) { logger.warn(`[embed] sweep failed: ${err.message}`); }
};
setTimeout(runEmbedSweep, 2 * 60 * 1000);   // post-boot top-up (give Mongo time)
setInterval(runEmbedSweep, EMBED_SWEEP_MS);

// ── Curated event-source sweep ───────────────────────────────────────────────
// Reads every validator-registered EventSource with patient timeouts and
// fills the AiFoundEvent shelf daily, so events are warm before anyone asks.
// Never spends a paid web search (the sweep hard-stubs searchWeb).
const SOURCE_SWEEP_MS = 24 * 60 * 60 * 1000;
const runSourceSweep = async () => {
    try {
        const { sweepEventSources } = require('./engine/events/sourceSweep');
        const r = await sweepEventSources();
        if (r.locations > 0) logger.info(`[source-sweep] ${r.locations} location(s) → ${r.events} event(s)`);
    } catch (err) { logger.warn(`[source-sweep] failed: ${err.message}`); }
};
setTimeout(runSourceSweep, 4 * 60 * 1000);  // post-boot (after Mongo + embedder)
setInterval(runSourceSweep, SOURCE_SWEEP_MS);

// ── Local knowledge refresh (Wikivoyage + UK FCDO) ───────────────────────────
// Both sources maintain themselves — FCDO republishes advice continuously with
// its own review date, Wikivoyage is edited daily — so answers must age WITH
// them, never freeze on first fetch. Entry-requirement and safety rows go stale
// in 30 days and are refused by the serving path until re-read; this sweep is
// what re-reads them. Cities come from the event-source registry, so one
// curation effort feeds both pipelines.
const KNOWLEDGE_SYNC_MS = 24 * 60 * 60 * 1000;
const runKnowledgeSync = async () => {
    try {
        const { syncKnowledge } = require('./engine/knowledge/sync');
        const EventSource = require('./models/EventSource');
        const LocalFact = require('./models/LocalFact');
        // Registered event-source cities PLUS anything already in the store —
        // so a place synced once by hand (a script run for another city) keeps
        // refreshing forever instead of ageing out silently.
        const [srcRows, factRows] = await Promise.all([
            EventSource.find({ enabled: true }).select('city country').lean(),
            LocalFact.aggregate([{ $group: { _id: { city: '$city', country: '$country' } } }]),
        ]);
        const rows = [...srcRows, ...factRows.map(r => r._id)];
        const seen = new Set();
        let places = 0, facts = 0;
        for (const r of rows) {
            const k = `${r.city || ''}|${r.country || ''}`.toLowerCase();
            if (seen.has(k) || !(r.city || r.country)) continue;
            seen.add(k);
            const out = await syncKnowledge({ city: r.city, country: r.country });
            places++; facts += out.stored;
        }
        if (places) logger.info(`[knowledge] refreshed ${places} place(s) → ${facts} fact(s)`);
    } catch (err) { logger.warn(`[knowledge] sync failed: ${err.message}`); }
};
setTimeout(runKnowledgeSync, 6 * 60 * 1000);
setInterval(runKnowledgeSync, KNOWLEDGE_SYNC_MS);

// ── Crash visibility & survival ──────────────────────────────────────────────
// Previous version had two problems that made crashes invisible AND fatal:
//   1. `logger.error('…:', err)` — winston often swallows an Error passed as
//      the second argument (prints `{}` unless errors({stack:true})+splat are
//      configured), so shutdowns happened with no visible trace.
//   2. unhandledRejection called server.close() — so ANY fire-and-forget
//      promise that rejected without a .catch shut the whole server down
//      (this is what "the server turned off" on a normal chat message was).
// Policy now: REJECTIONS are logged in full and the server keeps running —
// they are almost always failed background work, not corrupted state.
// EXCEPTIONS still exit (state genuinely unsafe) but print the full stack
// first via console.error, which bypasses any logger formatting.
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION (server continues):');
    console.error(reason instanceof Error ? reason.stack : reason);
    try { logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : String(reason)}`); } catch (_) {}
});
process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION (exiting — state unsafe):');
    console.error(err && err.stack ? err.stack : err);
    try { logger.error(`Uncaught Exception: ${err && err.stack ? err.stack : String(err)}`); } catch (_) {}
    if (auctionSweepTimer) clearInterval(auctionSweepTimer);
    server.close(() => process.exit(1));
    // Safety valve: if open connections keep close() from completing, exit anyway.
    setTimeout(() => process.exit(1), 5000).unref();
})