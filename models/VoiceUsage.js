// models/VoiceUsage.js — how many spoken answers a user had today (the voice
// feature's daily cap, founder 2026-10-07: Jinni's ElevenLabs voice is paid per
// character, so premium users get a fixed number of spoken answers a day).
const mongoose = require('mongoose');

const voiceUsageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },          // 'YYYY-MM-DD' (UTC)
    count: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

voiceUsageSchema.index({ userId: 1, day: 1 }, { unique: true });

module.exports = mongoose.models.VoiceUsage || mongoose.model('VoiceUsage', voiceUsageSchema);
