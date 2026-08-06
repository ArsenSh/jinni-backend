const mongoose = require('mongoose');

const AiDailyStatsSchema = new mongoose.Schema({
    date:    { type: String, required: true, unique: true }, // 'YYYY-MM-DD'
    tokens:  { type: Number, default: 0 },
    queries: { type: Number, default: 0 },
}, { timestamps: true });

AiDailyStatsSchema.statics.track = async function(tokens = 0, queries = 1) {
    const date = new Date().toISOString().slice(0, 10);
    await this.findOneAndUpdate(
        { date },
        { $inc: { tokens, queries } },
        { upsert: true, new: true }
    );
};

module.exports = mongoose.model('AiDailyStats', AiDailyStatsSchema);