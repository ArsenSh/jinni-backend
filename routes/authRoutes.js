const OAuthExchange = require('../models/OAuthExchange');
const express = require('express');
const router = express.Router();
const { validate } = require('../utils/validation');
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const User = require('../models/User');
const jwt = require('jsonwebtoken')
const GoogleStrategy = require('passport-google-oauth20').Strategy
const passport = require('passport')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit');

// Brute-force brake for credential + token endpoints. The global apiLimiter
// (100/15min) is far too loose for login: it allows ~100 password guesses per
// window. This caps the sensitive routes at 10 tries / 15 min per client, and
// only FAILURES count so a legitimate user is never locked out by success.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    // Behind Cloudflare, req.ip is an edge address shared by many users; key on
    // the real client so one attacker cannot exhaust everyone's login budget.
    keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown'),
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

router.post('/send-verification', validate('sendVerification'), authController.sendVerificationEmail);
router.post('/verify-email', authController.checkIPBlock, authController.verifyEmailAndRegister);
router.post('/resend-verification', validate('resendVerification'), authController.resendVerificationCode);
router.post('/forgot-password', authController.sendPasswordResetCode);
router.post('/reset-password', authController.verifyResetCode);
router.post('/resend-reset-code', authController.resendPasswordResetCode);
router.post('/login', authLimiter, validate('login'), authController.login);
router.get('/me', auth, authController.getProfile);
router.patch('/me', auth, authController.updateProfile);

router.patch('/onboarding', auth, async (req, res) => {
    try {
        // console.log('=== ONBOARDING ENDPOINT DEBUG ===');
        // console.log('Request body:', JSON.stringify(req.body, null, 2));
        if (!req.body.preferences || typeof req.body.onboardingCompleted !== 'boolean') {
            console.log('❌ Invalid request body structure');
            return res.status(400).json({ message: 'Invalid request body' });
        }
        // console.log('Updating user with ID:', req.userId.toString());        
        const updateData = {'preferences': req.body.preferences,'onboardingCompleted': req.body.onboardingCompleted};        
        if (req.body.settings) {
            if (req.body.settings.location) {
                const locationData = {...req.body.settings.location, lastUpdated: new Date()};
                updateData['settings.location'] = locationData;
                // console.log('✅ Updating location:', locationData);
            }
            if (req.body.settings.privacy) {
                updateData['settings.privacy'] = req.body.settings.privacy;
                // console.log('✅ Updating privacy settings:', req.body.settings.privacy);
            }
        }
        const updatedUser = await User.findByIdAndUpdate(req.userId.toString(),{ $set: updateData },{ new: true }).select('-password -__v');
        // console.log('✅ User updated successfully:', {
        //     id: updatedUser._id,
        //     email: updatedUser.email,
        //     onboardingCompleted: updatedUser.onboardingCompleted,
        //     location: updatedUser.settings?.location?.city + ', ' + updatedUser.settings?.location?.countryName,
        //     useGPS: updatedUser.settings?.privacy?.autoDetectLocation
        // });
        res.json({ user: updatedUser });
    } catch (error) {
        console.error('❌ Onboarding update error:', error);
        res.status(400).json({message: 'Update failed', error: error.message});
    }
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/auth/google/callback`
},  async (accessToken, refreshToken, profile, done) => {
    try {
        // console.log('Google OAuth Profile:', profile)
        let user = await User.findOne({ $or: [{ googleId: profile.id },{ email: profile.emails[0].value }] })
        if (user) {
            if (!user.googleId) {
                user.googleId = profile.id
                await user.save()
            }
        } else {
            user = new User({
                googleId: profile.id,
                email: profile.emails[0].value,
                name: profile.displayName,
                avatar: profile.photos[0]?.value,
                provider: 'google',
                isEmailVerified: true,
                password: crypto.randomBytes(32).toString('hex')
            })
            await user.save()
        }
        return done(null, user)
    } catch (error) {
        console.error('Google OAuth error:', error)
        return done(error, null)
    }
}))
passport.serializeUser((user, done) => {done(null, user._id)})
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id)
        done(null, user)
    } catch (error) {done(error, null)}
})
router.get('/google', (req, res, next) => {
    console.log('Initiating Google OAuth...')
    passport.authenticate('google', {scope: ['profile', 'email']})(req, res, next)
})
router.get('/google/callback',
    passport.authenticate('google', {failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:5173'}?error=google_failed`,session: false}),
    async (req, res) => {
        try {
            // console.log('Google OAuth callback successful');
            // Disabled / closed account — don't mint a token. Send the user
            // back to the app with an error param the frontend can explain.
            if (req.user?.isActive === false) {
                const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
                return res.redirect(`${frontendUrl}?error=account_disabled`);
            }
            const token = jwt.sign(
                {
                    userId: req.user._id,
                    email: req.user.email,
                    name: req.user.name,
                    onboardingCompleted: req.user.onboardingCompleted || false,
                    isAdmin: req.user.isAdmin || false,
                    role: req.user.role || (req.user.isAdmin ? 'admin' : 'user'),
                    businessId: req.user.businessId || null
                },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            // Never put the JWT in the URL — it lands in access logs, browser
            // history and the Referer header. Hand out a single-use code the
            // SPA swaps for the token via POST /api/auth/exchange.
            const code = crypto.randomBytes(32).toString('hex');
            await OAuthExchange.create({ code, token, expiresAt: new Date(Date.now() + 60 * 1000) });
            res.redirect(`${frontendUrl}/?code=${code}&provider=google`);
        } catch (error) {
            console.error('Token generation error:', error);
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            res.redirect(`${frontendUrl}?error=token_generation_failed`);
        }
    }
);

// POST /api/auth/exchange
// Swap a single-use OAuth code (from the /google/callback redirect) for the
// JWT. The code is consumed atomically so a replay — from a log, history entry
// or leaked Referer — finds nothing. Rate-limited to blunt code-guessing.
router.post('/exchange', authLimiter, async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Missing code' });
        }
        // findOneAndDelete is atomic: two racing requests cannot both win the
        // same code, so a code is usable exactly once.
        const row = await OAuthExchange.findOneAndDelete({ code, expiresAt: { $gt: new Date() } });
        if (!row) {
            return res.status(400).json({ error: 'This sign-in link is invalid or has expired. Please try again.' });
        }
        return res.json({ token: row.token, provider: 'google' });
    } catch (error) {
        console.error('OAuth exchange error:', error);
        return res.status(500).json({ error: 'Sign-in failed. Please try again.' });
    }
});

// POST /api/auth/setup-password
// Validates a business account setup token and sets the owner's chosen password.
// Token is single-use and expires after 24h.
router.post('/setup-password', authLimiter, async (req, res) => {
    try {
        const { token, password } = req.body
        if (!token || !password) {return res.status(400).json({ error: 'Token and password are required' })}
        if (password.length < 8) {return res.status(400).json({ error: 'Password must be at least 8 characters' })}
        const user = await User.findOne({
            passwordSetupToken:  token,
            passwordSetupExpiry: { $gt: new Date() }   // not expired
        })
        if (!user) {return res.status(400).json({ error: 'This setup link is invalid or has expired. Please contact support.' })}
        // Set the new password — pre('save') hook will hash it
        user.password           = password
        user.passwordSetupToken  = null
        user.passwordSetupExpiry = null
        await user.save()
        // Log them in immediately — return a JWT just like /login does
        const jwtToken = jwt.sign(
            {
                userId:               user._id,
                email:                user.email,
                name:                 user.name,
                onboardingCompleted:  user.onboardingCompleted || false,
                isAdmin:              user.isAdmin || false,
                role:                 user.role || (user.isAdmin ? 'admin' : 'user'),
                businessId:           user.businessId || null
            },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        )
        res.json({
            token: jwtToken,
            user: {
                id:                  user._id,
                email:               user.email,
                name:                user.name,
                onboardingCompleted: user.onboardingCompleted,
                isAdmin:             user.isAdmin || false,
                role:                user.role || (user.isAdmin ? 'admin' : 'user'),
                businessId:          user.businessId
            },
            message: user.role === 'staff'
                ? 'Password set successfully. Welcome to Jinni Staff!'
                : 'Password set successfully. Welcome to Jinni Business!'
        })
    } catch (error) {
        console.error('Setup password error:', error)
        res.status(500).json({ error: 'Failed to set password' })
    }
})

module.exports = router;