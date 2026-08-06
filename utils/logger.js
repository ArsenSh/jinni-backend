const winston = require('winston');
const { combine, timestamp, printf } = winston.format;


const sensitiveFields = ['password', 'apiKey', 'jwt', 'token'];
const redactSensitiveInfo = (message) => {
    let redacted = message;
    sensitiveFields.forEach(field => {
        const regex = new RegExp(`("${field}":\\s*")[^"]*"`, 'gi');
        redacted = redacted.replace(regex, `"${field}": "***REDACTED***"`);
    });
    return redacted;
};

const logFormat = printf(({ level, message, timestamp }) => {return `${timestamp} [${level.toUpperCase()}]: ${redactSensitiveInfo(message)}`;});

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ],
});

module.exports = logger;