const Joi = require('joi');

const schemas = {
    sendVerification: Joi.object({
        name: Joi.string()
            .min(2)
            .max(50)
            .pattern(/^[a-zA-Z\s\u00C0-\u017F]+$/)
            .required()
            .messages({
                'string.pattern.base': 'Name can only contain letters and spaces',
                'string.min': 'Name must be at least 2 characters long',
                'string.max': 'Name cannot exceed 50 characters'
            }),
        email: Joi.string()
            .email()
            .max(100)
            .required()
            .messages({
                'string.email': 'Please provide a valid email address',
                'string.max': 'Email is too long'
            }),
        password: Joi.string()
            .min(6)
            .max(128)
            .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
            .required()
            .messages({
                'string.pattern.base': 'Password must contain at least one lowercase letter, one uppercase letter, and one number',
                'string.min': 'Password must be at least 6 characters long',
                'string.max': 'Password is too long'
            })
    }),
    verifyEmail: Joi.object({
        email: Joi.string()
            .email()
            .required()
            .messages({
                'string.email': 'Please provide a valid email address'
            }),
        code: Joi.string()
            .pattern(/^\d{6}$/)
            .required()
            .messages({
                'string.pattern.base': 'Verification code must be a 6-digit number'
            })
    }),
    resendVerification: Joi.object({
        email: Joi.string()
            .email()
            .required()
            .messages({
                'string.email': 'Please provide a valid email address'
            })
    }),
    register: Joi.object({
        name: Joi.string().min(2).max(30).required(),
        email: Joi.string().email().required(),
        password: Joi.string().min(6).required()
    }),
    login: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().required()
    }),
    travelQuery: Joi.object({
        budget: Joi.number().min(10000).required(),
        duration: Joi.number().min(1).max(30).required(),
        interests: Joi.array().items(Joi.string()).min(1).required(),
        travelStyle: Joi.string().valid('luxury', 'budget', 'adventure').required()
    })
};
const validate = (schema) => (req, res, next) => {
    const { error } = schemas[schema].validate(req.body, {
        abortEarly: false,
        stripUnknown: true
    });
    if (error) {
        return res.status(400).json({
            error: 'Validation failed',
            details: error.details.map(err => ({
                field: err.path.join('.'),
                message: err.message,
                value: err.context?.value
            }))
        });
    }
    next();
};
const BLACKLISTED_WORDS = ['free', 'discount', 'cheap', 'best', 'promotion', 'sale', 'limited'];
const MIN_NAME_LENGTH = 3;

const isValidPlaceName = (name) => {
    if (name.length < MIN_NAME_LENGTH) return false;
    const lowerName = name.toLowerCase();
    if (BLACKLISTED_WORDS.some(word => lowerName.includes(word))) return false;
    return !/[0-9]|\$|http|www|\.com|@|\(|\)/i.test(name);

};
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};
const isStrongPassword = (password) => {
    const minLength = 6;
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    return password.length >= minLength && hasLower && hasUpper && hasNumber;
};
const validateRateLimit = (req, identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
    return true;
};
module.exports = {
    validate,
    isValidPlaceName,
    isValidEmail,
    isStrongPassword,
    validateRateLimit,
    schemas
};