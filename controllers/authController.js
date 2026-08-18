const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const emailService = require('../services/emailService');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const BlockedIP = require('../models/BlockedIP');
const PasswordReset = require('../models/PasswordReset');

const generateVerificationCode = () => {return Math.floor(100000 + Math.random() * 900000).toString()};
exports.checkIPBlock = async (req, res, next) => {
    const blocked = await BlockedIP.findOne({ip: req.ip, expiresAt: { $gt: new Date() }});
    if (blocked) {return res.status(429).json({error: `Too many attempts. Try again after ${Math.round((blocked.expiresAt - Date.now()) / 60000)} minutes`, blocked: true})}
    next();
};
// ── Signup language ─────────────────────────────────────────────────────────
//
//  A visitor picks their language on the landing page before they ever create
//  an account. That choice lives only in the browser, so unless we carry it
//  into the account at signup the new user is created with the schema default
//  ('en') — and because JinniChat reads settings.language ahead of the browser
//  copy, the app flips to English the moment they arrive from onboarding.
//  Which is exactly the bug this exists to prevent.
//
//  Returns undefined for anything unrecognised so the caller falls through to
//  the schema default rather than writing a value the enum would reject.
//
const { SUPPORTED_LANGUAGES } = require('../utils/validation');
function normalizeLanguage(lang) {
    if (typeof lang !== 'string') return undefined;
    const code = lang.trim().toLowerCase().split('-')[0];   // 'ru-RU' -> 'ru'
    return SUPPORTED_LANGUAGES.includes(code) ? code : undefined;
}
exports.normalizeLanguage = normalizeLanguage;

exports.sendVerificationEmail = async (req, res) => {
    try {
        const { name, email, password, language } = req.body;
        if (!name || !email || !password) {return res.status(400).json({ error: 'Name, email, and password are required' })}
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {return res.status(400).json({ error: 'Email already registered' })}
        const recentVerification = await EmailVerification.findOne({email: email.toLowerCase(), createdAt: { $gte: new Date(Date.now() - 60000) }});
        if (recentVerification) {return res.status(429).json({error: 'Please wait before requesting another verification code', retryAfter: 60})}
        const verificationCode = generateVerificationCode();
        const hashedPassword = await bcrypt.hash(password, 10);
        await EmailVerification.deleteMany({ email: email.toLowerCase() });
        const verification = new EmailVerification({email: email.toLowerCase(), code: verificationCode, ipAddress: req.ip, expiresAt: new Date(Date.now() + 15 * 60 * 1000), userData: {name: name.trim(), password: hashedPassword, language: normalizeLanguage(language)}});
        await verification.save();
        await emailService.sendVerificationEmail(email.toLowerCase(), verificationCode, name.trim(), normalizeLanguage(language));
        res.status(200).json({message: 'Verification code sent to your email', email: email.toLowerCase(), expiresIn: '15 minutes'});
    } catch (error) {
        console.error('Send verification error:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
};

exports.verifyEmailAndRegister = async (req, res) => {
    try {
        const { email, code } = req.body;
        const clientIP = req.ip;
        const ipBlocked = await BlockedIP.findOne({ip: clientIP, expiresAt: { $gt: new Date() }});
        if (ipBlocked) { return res.status(429).json({error: `Too many attempts. Try again after ${Math.round((ipBlocked.expiresAt - Date.now()) / 60000)} minutes`, blocked: true}) }
        if (!email || !code) {return res.status(400).json({ error: 'Email and verification code are required' })}
        const verification = await EmailVerification.findOne({email: email.toLowerCase(), isVerified: false});
        if (!verification) {return res.status(400).json({ error: 'Invalid or expired verification code' })}
        if (verification.expiresAt < new Date()) {
            await EmailVerification.deleteOne({ _id: verification._id });
            return res.status(400).json({ error: 'Verification code has expired' });
        }
        if (verification.attempts >= 3) {
            console.log(`Blocking IP ${clientIP} due to too many attempts`);
            try {
                await EmailVerification.deleteMany({ ipAddress: clientIP });
                const blockedIP = await BlockedIP.create({ip: clientIP, expiresAt: new Date(Date.now() + 15 * 60 * 1000)});
                console.log("BlockedIP created:", blockedIP);
            } catch (err) {console.error("Failed to block IP:", err)}
            return res.status(429).json({error: 'Too many attempts. Please try again in 15 minutes.', blocked: true});
        }
        if (verification.code !== code.toString()) {
            verification.attempts += 1;
            await verification.save();
            if (verification.attempts >= 3) {
                console.log(`⛔ Blocking IP ${clientIP} (${verification.attempts} attempts)`);
                try {
                    await EmailVerification.deleteMany({ ipAddress: clientIP });
                    const blocked = await BlockedIP.create({ip: clientIP, expiresAt: new Date(Date.now() + 15 * 60 * 1000)});
                    console.log(`✅ Created BlockedIP: ${blocked._id}`);
                } catch (err) {console.error('❌ Blocking failed:', err)}
                return res.status(429).json({error: 'Too many attempts. Please try again in 15 minutes.', blocked: true});
            }
            return res.status(400).json({error: 'Invalid verification code', attemptsLeft: 3 - verification.attempts, blocked: false});
        }
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            await EmailVerification.deleteOne({ _id: verification._id });
            return res.status(400).json({ error: 'Email already registered' });
        }
        // Language the account starts in. Prefer what the client sends NOW —
        // the visitor may have switched language while the code was in their
        // inbox — and fall back to what they had when they began signing up.
        // Both are ignored unless they name a language we actually ship.
        const signupLanguage = normalizeLanguage(req.body.language)
            || normalizeLanguage(verification.userData.language);

        const user = new User({name: verification.userData.name, email: email.toLowerCase(), password: verification.userData.password});
        // Assigned after construction so an absent/unsupported value leaves the
        // schema default ('en') untouched rather than writing undefined over it.
        if (signupLanguage) user.settings.language = signupLanguage;
        user.isModified = () => false;
        await user.save();
        await EmailVerification.deleteOne({ _id: verification._id });
        const token = jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1d' });
        // `settings` is included so the client can adopt the account's language
        // immediately, without waiting for a /me round-trip. Previously absent,
        // which left the freshly-created user's language unknown to the app at
        // the exact moment it starts rendering.
        res.status(201).json({message: 'Account created successfully', token, user: {id: user._id, name: user.name, email: user.email, onboardingCompleted: user.onboardingCompleted, preferences: user.preferences, settings: user.settings, isAdmin: user.isAdmin || false, role: user.role || 'user'}});
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
};

exports.resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const ipBlocked = await BlockedIP.findOne({ip: req.ip, expiresAt: { $gt: new Date() }});
        if (ipBlocked) {return res.status(429).json({error: `Too many attempts. Try again after ${Math.round((ipBlocked.expiresAt - Date.now()) / 60000)} minutes`, blocked: true})}
        if (!email) {return res.status(400).json({ error: 'Email is required' })}
        const verification = await EmailVerification.findOne({email: email.toLowerCase(), isVerified: false});
        if (!verification) {return res.status(404).json({ error: 'No pending verification found for this email' })}
        const timeSinceCreation = Date.now() - verification.createdAt.getTime();
        if (timeSinceCreation < 60000) {return res.status(429).json({error: 'Please wait before requesting another code', retryAfter: Math.ceil((60000 - timeSinceCreation) / 1000)})}
        const newCode = generateVerificationCode();
        verification.code = newCode;
        verification.attempts = 0;
        verification.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await verification.save();
        await emailService.sendVerificationEmail(verification.email, newCode, verification.userData.name, verification.userData.language);
        res.status(200).json({message: 'New verification code sent to your email', expiresIn: '15 minutes'});
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Failed to resend verification code' });
    }
};
exports.sendPasswordResetCode = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {return res.status(400).json({ error: 'Email is required' })}
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {return res.status(404).json({ error: 'No account found with this email address' })}
        const recentReset = await PasswordReset.findOne({email: email.toLowerCase(), createdAt: { $gte: new Date(Date.now() - 60000) }});
        if (recentReset) {return res.status(429).json({error: 'Please wait before requesting another reset code', retryAfter: 60})}
        const resetCode = generateVerificationCode();
        await PasswordReset.deleteMany({ email: email.toLowerCase() });
        const passwordReset = new PasswordReset({email: email.toLowerCase(), code: resetCode, ipAddress: req.ip, expiresAt: new Date(Date.now() + 15 * 60 * 1000)});
        await passwordReset.save();
        await emailService.sendPasswordResetEmail(email.toLowerCase(), resetCode, user.name, user.settings?.language);
        res.status(200).json({message: 'Password reset code sent to your email', expiresIn: '15 minutes'});
    } catch (error) {
        console.error('Send password reset error:', error);
        res.status(500).json({ error: 'Failed to send password reset code' });
    }
};
exports.verifyResetCode = async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        const clientIP = req.ip;
        const ipBlocked = await BlockedIP.findOne({ip: clientIP, expiresAt: { $gt: new Date() }});
        if (ipBlocked) {return res.status(429).json({error: `Too many attempts. Try again after ${Math.round((ipBlocked.expiresAt - Date.now()) / 60000)} minutes`, blocked: true})}
        if (!email || !code || !newPassword) {return res.status(400).json({ error: 'Email, code, and new password are required' })}
        if (newPassword.length < 6) {return res.status(400).json({ error: 'Password must be at least 6 characters long' })}
        const resetRequest = await PasswordReset.findOne({email: email.toLowerCase(), isUsed: false});
        if (!resetRequest) {return res.status(400).json({ error: 'Invalid or expired reset code' })}
        if (resetRequest.expiresAt < new Date()) {
            await PasswordReset.deleteOne({ _id: resetRequest._id });
            return res.status(400).json({ error: 'Reset code has expired' });
        }
        if (resetRequest.attempts >= 3) {
            console.log(`Blocking IP ${clientIP} due to too many reset attempts`);
            try {
                await PasswordReset.deleteMany({ ipAddress: clientIP });
                await BlockedIP.create({ip: clientIP, expiresAt: new Date(Date.now() + 15 * 60 * 1000)});
            } catch (err) {console.error("Failed to block IP:", err)}
            return res.status(429).json({error: 'Too many attempts. Please try again in 15 minutes.', blocked: true});
        }
        if (resetRequest.code !== code.toString()) {
            resetRequest.attempts += 1;
            await resetRequest.save();
            if (resetRequest.attempts >= 3) {
                console.log(`Blocking IP ${clientIP} after 3 failed reset attempts`);
                try {
                    await PasswordReset.deleteMany({ ipAddress: clientIP });
                    await BlockedIP.create({ip: clientIP, expiresAt: new Date(Date.now() + 15 * 60 * 1000)});
                } catch (err) {console.error('Blocking failed:', err)}
                return res.status(429).json({error: 'Too many attempts. Please try again in 15 minutes.', blocked: true});
            }
            return res.status(400).json({error: 'Invalid reset code', attemptsLeft: 3 - resetRequest.attempts});
        }
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            await PasswordReset.deleteOne({ _id: resetRequest._id });
            return res.status(404).json({ error: 'User not found' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.isModified = () => false;
        await user.save();
        await PasswordReset.deleteOne({ _id: resetRequest._id });
        res.status(200).json({message: 'Password reset successfully'});
    } catch (error) {
        console.error('Password reset error:', error);
        res.status(500).json({ error: 'Password reset failed' });
    }
};
exports.resendPasswordResetCode = async (req, res) => {
    try {
        const { email } = req.body;
        const ipBlocked = await BlockedIP.findOne({ip: req.ip, expiresAt: { $gt: new Date() }});
        if (ipBlocked) {return res.status(429).json({error: `Too many attempts. Try again after ${Math.round((ipBlocked.expiresAt - Date.now()) / 60000)} minutes`, blocked: true})}
        if (!email) {return res.status(400).json({ error: 'Email is required' })}
        const resetRequest = await PasswordReset.findOne({email: email.toLowerCase(), isUsed: false});
        if (!resetRequest) {return res.status(404).json({ error: 'No pending reset request found for this email' })}
        const timeSinceCreation = Date.now() - resetRequest.createdAt.getTime();
        if (timeSinceCreation < 60000) {return res.status(429).json({error: 'Please wait before requesting another code', retryAfter: Math.ceil((60000 - timeSinceCreation) / 1000)})}
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {return res.status(404).json({ error: 'User not found' })}
        const newCode = generateVerificationCode();
        resetRequest.code = newCode;
        resetRequest.attempts = 0;
        resetRequest.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await resetRequest.save();
        await emailService.sendPasswordResetEmail(resetRequest.email, newCode, user.name);
        res.status(200).json({message: 'New reset code sent to your email', expiresIn: '15 minutes'});
    } catch (error) {
        console.error('Resend password reset error:', error);
        res.status(500).json({ error: 'Failed to resend reset code' });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) {return res.status(400).json({ error: 'Invalid credentials' })}
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {return res.status(400).json({ error: 'Invalid credentials' })}
        // ── Disabled / closed account ────────────────────────────────────
        // Checked AFTER the password matches on purpose: only someone who
        // proves they own the account learns it's closed. Checking before the
        // password would let anyone probe which emails are deactivated.
        // Covers both admin-revoked and self-deleted accounts (both set
        // isActive:false). 403 = "we know who you are, but you're not allowed".
        if (user.isActive === false) {
            return res.status(403).json({
                error: 'This account has been closed and can no longer be used. If you believe this is a mistake, please contact support.',
                code: 'account_disabled'
            });
        }
        const token = jwt.sign({ userId: user._id.toString(), businessId: user.businessId || null }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({token, user: {id: user._id, name: user.name, email: user.email, onboardingCompleted: user.onboardingCompleted, preferences: user.preferences, isAdmin: user.isAdmin || false, role: user.role || (user.isAdmin ? 'admin' : 'user'), businessId: user.businessId || null,
            // Router needs staff permissions to route validators vs marketing
            // staff to the right locked page (StaffValidation vs /marketing).
            staffPermissions: user.role === 'staff' ? (user.staffAssignment?.permissions || null) : null}});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
};
/**
 * @typedef {Object} UserRequest
 * @property {import('../models/User').UserDocument} user
 * @property {string} userId
 */
exports.getProfile = async (/** @type {UserRequest} */ req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');
        if (!user) {return res.status(404).json({ error: 'User not found' })}
        res.json({...user.toObject(), stats: {queries: user.analytics.totalQueries, sessions: user.analytics.totalSessions}});
    } catch (error) {res.status(500).json({ error: 'Server error' })}
};
exports.updateProfile = async (req, res) => {
    try {
        const updates = Object.keys(req.body);
        const allowedUpdates = ['name', 'preferences'];
        const isValidOperation = updates.every(update => allowedUpdates.includes(update));
        if (!isValidOperation) {return res.status(400).json({ error: 'Invalid updates' })}
        updates.forEach(update => req.user[update] = req.body[update]);
        await req.user.save();
        res.json(req.user);
    } catch (error) {res.status(400).json({ error: error.message })}
};
exports.completeOnboarding = async (req, res) => {
    try {
        const userId = req.user._id;
        const { preferences } = req.body;
        const updatedUser = await User.findByIdAndUpdate(userId, { preferences, onboardingCompleted: true }, { new: true }).select('-password');
        res.json({success: true, message: 'Preferences saved successfully', user: updatedUser});
    } catch (error) {
        console.error('Onboarding error:', error);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
};