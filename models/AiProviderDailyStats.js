// models/AiProviderDailyStats.js
//
// Per-provider daily AI usage, recorded ALONGSIDE the existing AiDailyStats
// (which stays as the provider-agnostic total). This is what powers the
// "DeepSeek vs Claude" split in the admin dashboard, so you can read the real
// cost of each provider before deciding which to leave switched on.
//
// One document per (date, provider, endpoint). `track()` upserts + $inc, so it
// is safe to call on every request with no read-modify-write race.

const mongoose = require('mongoose');

const aiProviderDailyStatsSchema = new mongoose.Schema({
    date:     { type: String, required: true },                                   // 'YYYY-MM-DD' (UTC), same keying as AiDailyStats
    provider: { type: String, enum: ['deepseek', 'claude'], required: true },
    endpoint: { type: String, enum: ['chat', 'quick_action', 'other'], default: 'other' },
    tokens:   { type: Number, default: 0 },   // input + output (estimated, same basis as AiDailyStats)
    queries:  { type: Number, default: 0 },   // request count
    searches: { type: Number, default: 0 },   // Claude web searches ($0.01 each); always 0 for DeepSeek
}, { timestamps: true });

aiProviderDailyStatsSchema.index({ date: 1, provider: 1, endpoint: 1 }, { unique: true });

/**
 * Increment today's counters for a provider/endpoint. Fire-and-forget safe.
 * @param {'deepseek'|'claude'} provider
 * @param {{ tokens?:number, queries?:number, searches?:number, endpoint?:string }} opts
 */
aiProviderDailyStatsSchema.statics.track = function (provider, opts = {}) {
    const { tokens = 0, queries = 1, searches = 0, endpoint = 'other' } = opts;
    const date = new Date().toISOString().slice(0, 10);
    return this.updateOne(
        { date, provider: provider === 'claude' ? 'claude' : 'deepseek', endpoint },
        { $inc: { tokens, queries, searches } },
        { upsert: true }
    );
};

module.exports = mongoose.model('AiProviderDailyStats', aiProviderDailyStatsSchema);