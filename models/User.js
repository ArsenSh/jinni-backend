const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true, minlength: 6 },
    name: { type: String, required: true },
    googleId: { type: String },
    onboardingCompleted: { type: Boolean, default: false },
    preferences: {
        interests: [String],
        budget: { min: Number, max: Number, currency: { type: String, default: 'USD' }},
        travelStyle: String,
        // OnboardingPage.vue has ALWAYS sent this in its payload, and the
        // onboarding route has always written `preferences` wholesale — but the
        // field was never declared here, so Mongoose's default strict mode
        // stripped it on every save, silently. The toggle therefore fell back to
        // its `true` default on every load, and applyProposal's write of it
        // (2026-08-25) went the same way: matched, acknowledged, discarded.
        // A path absent from the schema is not a place to store anything.
        useGPS: { type: Boolean, default: true },
        languages: { type: [String], default: ['en'] },
        accessibility: [String],
        destination: {
            country: { type: String, default: '' },
            countryName: { type: String, default: '' },
            city: { type: String, default: '' },
            coordinates: {
                lat: { type: Number, default: 0 },
                lng: { type: Number, default: 0 }
            }
        }
    },
    settings: {
        language: { type: String, enum: ['en', 'ru', 'zh', 'hy', 'fr', 'ar'], default: 'en' },
        theme: { type: String, enum: ['auto', 'light', 'dark'], default: 'auto' },
        location: {
            country: { type: String, default: '' },
            countryName: { type: String, default: 'Select a country' },
            city: { type: String, default: 'Select a city' },
            coordinates: { lat: { type: Number, default: 0 }, lng: { type: Number, default: 0 } },
            lastUpdated: { type: Date, default: Date.now }
        },
        searchRadius: {
            nearby: { type: Number, default: 5, min: 1, max: 20 },
            discovery: { type: Number, default: 50, min: 10, max: 100 }
        },
        privacy: {
            autoDetectLocation: { type: Boolean, default: true },
            locationPermissionGranted: { type: Boolean, default: false }
        }
    },
    aiLimits: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'UserAILimit'
    },
    analytics: {
        totalSessions: { type: Number, default: 0 },
        totalQueries: { type: Number, default: 0 },
        lastActive: Date,
        registrationDate: { type: Date, default: Date.now }
    },
    isPremium: { type: Boolean, default: false },
    // When the premium term ends. NULL MEANS NO EXPIRY — that is the
    // back-compat contract: accounts granted premium before this field
    // existed have no date, and treating those as expired would downgrade
    // every one of them on deploy. New grants always set a date.
    // Enforced lazily wherever premium is read (see utils/premium.js).
    premiumUntil: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false },
    // ── Role (replaces isAdmin going forward; isAdmin kept in sync for back-compat) ──
    // 'user'  : regular traveler
    // 'staff' : can ONLY validate businesses (StaffValidation page)
    // 'admin' : can do everything (including creating staff)
    role: {
        type: String,
        enum: ['user', 'staff', 'admin'],
        default: 'user',
        index: true
    },
    // True for staff accounts created by an admin with a temp password.
    // Forces the user to set a new password on first login.
    mustChangePassword: { type: Boolean, default: false },
    // ── Staff assignment (only meaningful when role === 'staff') ──────────────
    // Admin scopes which businesses this staff member can validate.
    // - countries / cities are arrays of plain strings matching
    //   Business.location.country / Business.location.city (case-insensitive
    //   match enforced at query time via regex).
    // - priorityCountries / priorityCities: subsets of countries / cities that
    //   this staff should focus on first; the validation queue bubbles these
    //   to the top.
    // - empty arrays = no scope yet → staff sees nothing until admin assigns.
    staffAssignment: {
        countries:         { type: [String], default: [] },
        cities:            { type: [String], default: [] },
        priorityCountries: { type: [String], default: [] },
        priorityCities:    { type: [String], default: [] },
        assignedAt:        { type: Date,     default: null },
        assignedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        notes:             { type: String,   default: '' },
        // ── Permissions ──────────────────────────────────────────────────
        // What a staff member is allowed to do. Admin picks at creation.
        //   validateBusinesses : can use StaffValidation queue (approve/reject)
        //   manageDestinations : can add / edit / delete destinations within
        //                        their assigned scope (countries / cities)
        //   moderateExplore    : can hide / verify cached places on the Explore
        //                        page within their assigned scope
        //   viewMarketing      : can view the Growth & Retention report
        //                        (/marketing) — for marketing partners; a
        //                        marketing-only staff is locked to that page
        //                        the same way validators are locked to their queue
        // Defaults:
        //   - validateBusinesses true → preserves behaviour for staff created
        //     before this field existed (legacy docs read the default).
        //   - manageDestinations / moderateExplore false → newer capabilities,
        //     opt-in by admin.
        permissions: {
            validateBusinesses: { type: Boolean, default: true  },
            manageDestinations: { type: Boolean, default: false },
            moderateExplore:    { type: Boolean, default: false },
            viewMarketing:      { type: Boolean, default: false }
        }
    },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },  // set when user owns a business listing
    // ── Password setup (business accounts created by the system) ──────────────
    passwordSetupToken:  { type: String, default: null },
    passwordSetupExpiry: { type: Date,   default: null }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Keep isAdmin and role in sync.
// - If role is set, derive isAdmin from it.
// - If only isAdmin was set (legacy data), derive role from it.
// - On new docs without an explicit role, default based on isAdmin.
userSchema.pre('save', function(next) {
    if (this.isModified('role')) {
        this.isAdmin = this.role === 'admin';
    } else if (this.isModified('isAdmin') && !this.isModified('role')) {
        this.role = this.isAdmin ? 'admin' : (this.role || 'user');
    } else if (this.isNew && !this.role) {
        this.role = this.isAdmin ? 'admin' : 'user';
    }
    next();
});

userSchema.post('save', async function(doc) {
    try {
        const UserAILimit = mongoose.model('UserAILimit');
        const existingLimit = await UserAILimit.findOne({ userId: doc._id });
        if (!existingLimit) {
            const aiLimit = new UserAILimit({ userId: doc._id, isPremium: doc.isPremium || false });
            await aiLimit.save();
            await mongoose.model('User').findByIdAndUpdate(doc._id, { aiLimits: aiLimit._id });
        } else if (existingLimit.isPremium !== doc.isPremium) {
            existingLimit.isPremium = doc.isPremium;
            await existingLimit.save();
        }
    } catch (error) {
        console.error('Error syncing AI limits for user:', error);
    }
});

userSchema.set('toJSON', {
    transform: (doc, ret) => {
        delete ret.password;
        delete ret.__v;
        return ret;
    }
});

userSchema.post('findOneAndUpdate', async function(doc) {
    if (doc && this.getUpdate().isPremium !== undefined) {
        const UserAILimit = mongoose.model('UserAILimit');
        await UserAILimit.syncUserPremium(doc._id, this.getUpdate().isPremium);
    }
});

userSchema.methods.comparePassword = async function(candidatePassword) {
    try {
        return await bcrypt.compare(candidatePassword, this.password);
    } catch (error) {
        throw new Error('Password comparison failed');
    }
};

module.exports = mongoose.model('User', userSchema);