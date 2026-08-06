module.exports = (req, res, next) => {
    // Assuming your user model has an isAdmin field
    if (!req.user.isAdmin) {
        return res.status(403).json({
            success: false,
            error: 'Admin privileges required'
        });
    }
    next();
};