// routes/voiceRoutes.js — mounted at /api/voice
//
// Jinni's voice (founder 2026-10-07): the user talks to Jinni and, on Premium,
// hears the answer in Jinni's own ElevenLabs voice. Free users keep the mic
// (speech → text) and read the answer.
//   POST /transcribe  — Whisper fallback for speech → text (iPhone Safari has no
//                       Armenian recognition). Any signed-in user. Cheap.
//   POST /speak       — text → Jinni's voice. PREMIUM only, capped per day
//                       (VOICE_DAILY_CAP, default 30 answers), text clipped to
//                       VOICE_MAX_CHARS (default 1500) so one answer costs a
//                       bounded number of ElevenLabs characters.
//   GET  /status      — what this user may do today.
// Keys live in Coolify env only: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
// ELEVENLABS_MODEL (default eleven_multilingual_v2), ELEVENLABS_MODEL_HY
// (Armenian; default eleven_v3 — multilingual_v2 has no Armenian),
// WHISPER_API_KEY (falls back to OPENAI_API_KEY when OPENAI_BASE_URL is unset
// or OpenAI's own).

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Readable } = require('stream');
const auth = require('../middleware/auth');
const VoiceUsage = require('../models/VoiceUsage');

const router = express.Router();
const CAP = Math.max(1, parseInt(process.env.VOICE_DAILY_CAP || '30', 10));
const MAX_CHARS = Math.max(200, parseInt(process.env.VOICE_MAX_CHARS || '1500', 10));
const today = () => new Date().toISOString().slice(0, 10);
const clientKey = (req) => (req.user?.id ? `u:${req.user.id}` : (req.headers['cf-connecting-ip'] || req.ip || 'unknown'));
const speakLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });
const sttLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`[voice] ${req.method} ${req.originalUrl} failed:`, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});

const ttsConfigured = () => !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
function whisperKey() {
    if (process.env.WHISPER_API_KEY) return process.env.WHISPER_API_KEY;
    const base = process.env.OPENAI_BASE_URL || '';
    return (!base || /api\.openai\.com/.test(base)) ? (process.env.OPENAI_API_KEY || '') : '';
}

/** Chat markdown → something a voice can read: no card markers, links, emphasis marks or emoji. */
function speakable(text) {
    return String(text || '')
        .replace(/[→←]/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_`#>|]+/g, ' ')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
        .slice(0, MAX_CHARS);
}

async function usageToday(userId) {
    const row = await VoiceUsage.findOne({ userId, day: today() }).lean();
    return row ? row.count : 0;
}

router.get('/status', auth, wrap(async (req, res) => {
    const used = req.user.isPremium ? await usageToday(req.user._id) : 0;
    res.json({ success: true, isPremium: !!req.user.isPremium, tts: ttsConfigured(), stt: !!whisperKey(), cap: CAP, remaining: req.user.isPremium ? Math.max(0, CAP - used) : 0 });
}));

// speech → text (Whisper). The browser does this for free where it can; this is the fallback.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post('/transcribe', auth, sttLimiter, upload.single('audio'), wrap(async (req, res) => {
    const key = whisperKey();
    if (!key) return res.status(503).json({ success: false, error: 'stt_unavailable' });
    if (!req.file) return res.status(400).json({ success: false, error: 'no_audio' });
    const lang = /^(en|ru|hy|fr|ar|zh)$/.test(String(req.body.lang || '')) ? req.body.lang : undefined;
    const fd = new FormData();
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'speech.webm');
    fd.append('model', 'whisper-1');
    if (lang) fd.append('language', lang);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn('[voice] whisper:', r.status, j.error?.message); return res.status(502).json({ success: false, error: 'stt_failed' }); }
    res.json({ success: true, text: String(j.text || '').trim() });
}));

// text → Jinni's voice. Premium, capped, clipped. Streams the mp3 straight through.
router.post('/speak', auth, speakLimiter, wrap(async (req, res) => {
    if (!req.user.isPremium) return res.status(403).json({ success: false, error: 'premium_required' });
    if (!ttsConfigured()) return res.status(503).json({ success: false, error: 'tts_unavailable' });
    const text = speakable(req.body?.text);
    if (text.length < 2) return res.status(400).json({ success: false, error: 'no_text' });
    // the cap is counted per ANSWER: the first chunk of an answer pays, later chunks of the same answer ride free
    const first = req.body?.chunk === undefined || Number(req.body.chunk) === 0;
    if (first) {
        const row = await VoiceUsage.findOneAndUpdate({ userId: req.user._id, day: today() }, { $inc: { count: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
        if (row.count > CAP) {
            await VoiceUsage.updateOne({ _id: row._id }, { $inc: { count: -1 } });
            return res.status(429).json({ success: false, error: 'voice_limit', cap: CAP });
        }
    }
    const lang = String(req.body?.lang || 'en').slice(0, 2);
    const model = lang === 'hy' ? (process.env.ELEVENLABS_MODEL_HY || 'eleven_v3') : (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2');
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}/stream?output_format=mp3_44100_96`;
    const r = await fetch(url, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, speed: Number(process.env.ELEVENLABS_SPEED || 0.95) } }) });
    if (!r.ok || !r.body) {
        const detail = await r.text().catch(() => '');
        console.warn('[voice] elevenlabs:', r.status, detail.slice(0, 200));
        return res.status(502).json({ success: false, error: 'tts_failed' });
    }
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    console.log(`[voice] spoke ${text.length} chars (${model}) for ${req.user.id}`);
}));

module.exports = router;
