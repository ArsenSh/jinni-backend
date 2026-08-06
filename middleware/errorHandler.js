module.exports = (err, req, res, next) => {
    console.error(err.stack);

    // Handle JSON parsing errors
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON format' });
    }

    // Handle Mongoose validation errors
    if (err.name === 'ValidationError' || err.error === 'Validation error') {
        return res.status(400).json(err);
    }

    // Handle JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
    }

    // Default error handler
    res.status(500).json({ error: 'Internal Server Error' });
};