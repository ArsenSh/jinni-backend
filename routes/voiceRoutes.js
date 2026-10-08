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

// Founder 2026-10-09: "initially free mode can have it too, I don't have many users" — Jinni's voice is open to every
// signed-in user with the same daily cap. VOICE_PREMIUM_ONLY=true in Coolify makes it Premium-only again.
const premiumOnly = () => process.env.VOICE_PREMIUM_ONLY === 'true';
const mayHearVoice = (user) => !!user && (!premiumOnly() || !!user.isPremium);
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
    const may = mayHearVoice(req.user), used = may ? await usageToday(req.user._id) : 0;
    res.json({ success: true, isPremium: !!req.user.isPremium, voice: may, tts: ttsConfigured(), stt: !!whisperKey(), cap: CAP, remaining: may ? Math.max(0, CAP - used) : 0 });
}));

// speech → text. Voice mode sends every turn here (founder 2026-10-09: the phone's own recogniser heard
// "Amar" as "MA" — it cannot be taught local names). The model is told which names to expect: "Jinni", the
// places already on the user's screen (hints from the app) and the best-known places around the user in
// Jinni's own data. STT_MODEL (default gpt-4o-transcribe) falls back to whisper-1 if it is refused.
const PlaceCache = require('../models/PlaceCache');
const nearbyNamesCache = new Map();   // "lat,lng" rounded → { at, names }
async function namesNear(user) {
    const c = user?.settings?.location?.coordinates;
    if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number' || (!c.lat && !c.lng)) return [];
    const key = `${c.lat.toFixed(2)},${c.lng.toFixed(2)}`;
    const hit = nearbyNamesCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.names;
    const d = 0.12;   // ~13 km box
    try {
        const rows = await PlaceCache.find({
            'details.geometry.location.lat': { $gte: c.lat - d, $lte: c.lat + d },
            'details.geometry.location.lng': { $gte: c.lng - d, $lte: c.lng + d },
            aiBlocked: { $ne: true }, 'explore.status': { $ne: 'hidden' },
        }).select('name rating likes').sort({ likes: -1, rating: -1 }).limit(160).lean();
        const names = [...new Set(rows.map(r => String(r.name || '').trim()).filter(n => n.length > 2 && n.length < 50))].slice(0, 80);
        if (nearbyNamesCache.size > 500) nearbyNamesCache.clear();
        nearbyNamesCache.set(key, { at: Date.now(), names });
        return names;
    } catch (e) { return []; }
}
function sttPrompt(hints, near) {
    const seen = new Set(); const out = [];
    for (const n of [...hints, ...near]) { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } }
    let p = 'Jinni is a travel app; the user may say place names such as: ';
    for (const n of out) { if (p.length + n.length + 2 > 900) break; p += n + ', '; }
    return p.replace(/, $/, '.');
}
/** "A, M, A, R" / "a-m-a-r" spoken letter by letter → "Amar". */
function joinSpelled(text) {
    return String(text || '').replace(/\b(?:[A-Za-z][\s,.\-]+){2,}[A-Za-z]\b/g, (m) => { const w = m.replace(/[^A-Za-z]/g, ''); return w[0].toUpperCase() + w.slice(1).toLowerCase(); });
}
async function transcribe(key, file, lang, prompt, model) {
    const fd = new FormData();
    fd.append('file', new Blob([file.buffer], { type: file.mimetype || 'audio/webm' }), file.originalname || 'speech.webm');
    fd.append('model', model);
    if (lang) fd.append('language', lang);
    if (prompt) fd.append('prompt', prompt);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, text: String(j.text || '').trim(), error: j.error?.message };
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post('/transcribe', auth, sttLimiter, upload.single('audio'), wrap(async (req, res) => {
    const key = whisperKey();
    if (!key) return res.status(503).json({ success: false, error: 'stt_unavailable' });
    if (!req.file) return res.status(400).json({ success: false, error: 'no_audio' });
    const lang = /^(en|ru|hy|fr|ar|zh)$/.test(String(req.body.lang || '')) ? req.body.lang : undefined;
    let hints = [];
    try { hints = JSON.parse(req.body.hints || '[]'); } catch (e) { hints = []; }
    hints = (Array.isArray(hints) ? hints : []).filter(h => typeof h === 'string').map(h => h.replace(/[\r\n]+/g, ' ').trim().slice(0, 60)).filter(h => h.length > 1).slice(0, 40);
    const prompt = sttPrompt(hints, await namesNear(req.user));
    const model = process.env.STT_MODEL || 'gpt-4o-transcribe';
    const t0 = Date.now();
    let out = await transcribe(key, req.file, lang, prompt, model);
    if (!out.ok && model !== 'whisper-1') { console.warn(`[voice] ${model}: ${out.status} ${out.error} — retrying with whisper-1`); out = await transcribe(key, req.file, lang, prompt.slice(0, 600), 'whisper-1'); }
    if (!out.ok) { console.warn('[voice] stt:', out.status, out.error); return res.status(502).json({ success: false, error: 'stt_failed' }); }
    const text = joinSpelled(out.text);
    console.log(`[voice] heard ${text.length} chars in ${Date.now() - t0}ms (${model}, ${hints.length} hint(s))`);
    res.json({ success: true, text });
}));

// text → Jinni's voice. Premium, capped, clipped. Streams the mp3 straight through. One request per
// answer and style 0 / stability 0.65 (founder 2026-10-08: paragraph-by-paragraph requests came back
// at different loudness — ElevenLabs levels each request on its own).
router.post('/speak', auth, speakLimiter, wrap(async (req, res) => {
    if (!mayHearVoice(req.user)) return res.status(403).json({ success: false, error: 'premium_required' });
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
    // Flash = ElevenLabs' low-latency model (founder 2026-10-08: "claude replies instantly"); the chat
    // speaks sentence by sentence while the answer streams, and previous_request_ids stitch the
    // sentences so they sound like one reading.
    const model = lang === 'hy' ? (process.env.ELEVENLABS_MODEL_HY || 'eleven_v3') : (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5');
    const prev = Array.isArray(req.body?.previous_request_ids) ? req.body.previous_request_ids.filter(x => typeof x === 'string' && /^[\w-]{4,64}$/.test(x)).slice(-3) : [];
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}/stream?output_format=mp3_44100_96`;
    const r = await fetch(url, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.65, similarity_boost: 0.8, style: 0, speed: Number(process.env.ELEVENLABS_SPEED || 0.95) }, ...(prev.length ? { previous_request_ids: prev } : {}) }) });
    if (!r.ok || !r.body) {
        const detail = await r.text().catch(() => '');
        console.warn('[voice] elevenlabs:', r.status, detail.slice(0, 200));
        return res.status(502).json({ success: false, error: 'tts_failed' });
    }
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...(r.headers.get('request-id') ? { 'X-Voice-Request-Id': r.headers.get('request-id') } : {}) });
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    console.log(`[voice] spoke ${text.length} chars (${model}) for ${req.user.id}`);
}));

// A short spoken "working on it" line (founder 2026-10-07: "ok, let's see what I can find…, not
// every time the same") played the moment a premium user's spoken message goes off, so there is
// no silence while Jinni searches. Each line is made ONCE per deploy and cached on disk, so the
// cost is a few hundred characters in total, not per answer. Not counted against the daily cap.
const fs = require('fs');
const path = require('path');
const os = require('os');
const FILLERS = {
    en: ["Okay, let me see what I can find.", "One moment, I'm looking into it.", "Let me check that for you.", "Good question. Give me a second.", "Alright, searching now."],
    ru: ["Хорошо, сейчас посмотрю, что можно найти.", "Секунду, ищу.", "Сейчас проверю для вас.", "Хороший вопрос, дайте мне секунду.", "Так, ищу прямо сейчас."],
    hy: ["Լավ, տեսնեմ ինչ կարող եմ գտնել։", "Մի պահ, նայում եմ։", "Հիմա կստուգեմ ձեզ համար։", "Լավ հարց է, մի վայրկյան։", "Լավ, փնտրում եմ։"],
    fr: ["D'accord, voyons ce que je peux trouver.", "Un instant, je regarde.", "Je vérifie ça pour vous.", "Bonne question, une seconde.", "Très bien, je cherche."],
    ar: ["حسنًا، دعني أرى ما يمكنني إيجاده.", "لحظة، أبحث الآن.", "سأتحقق من ذلك لك.", "سؤال جيد، أمهلني ثانية.", "حسنًا، أبحث الآن."],
    zh: ["好的，让我看看能找到什么。", "稍等，我来查一下。", "我帮您查一下。", "好问题，请给我一点时间。", "好的，正在搜索。"],
};
const CACHE_DIR = path.join(process.env.VOICE_CACHE_DIR || os.tmpdir(), 'jinni-voice-fillers');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* read-only fs: fillers are then made each time */ }
const fillerCacheKey = (lang, i) => path.join(CACHE_DIR, `${lang}-${i}-${String(process.env.ELEVENLABS_VOICE_ID || '').slice(-6)}.mp3`);

router.get('/filler', auth, speakLimiter, wrap(async (req, res) => {
    if (!mayHearVoice(req.user)) return res.status(403).json({ success: false, error: 'premium_required' });
    if (!ttsConfigured()) return res.status(503).json({ success: false, error: 'tts_unavailable' });
    const lang = FILLERS[String(req.query.lang || '').slice(0, 2)] ? String(req.query.lang).slice(0, 2) : 'en';
    const lines = FILLERS[lang];
    const i = Number.isInteger(+req.query.i) && +req.query.i >= 0 && +req.query.i < lines.length ? +req.query.i : Math.floor(Math.random() * lines.length);
    const file = fillerCacheKey(lang, i);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'X-Voice-Filler': String(i) });
    if (fs.existsSync(file)) return fs.createReadStream(file).pipe(res);
    const model = lang === 'hy' ? (process.env.ELEVENLABS_MODEL_HY || 'eleven_v3') : (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_96`, {
        method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines[i], model_id: model, voice_settings: { stability: 0.65, similarity_boost: 0.8, style: 0, speed: Number(process.env.ELEVENLABS_SPEED || 0.95) } }) });
    if (!r.ok) { console.warn('[voice] filler:', r.status); return res.status(502).json({ success: false, error: 'tts_failed' }); }
    const buf = Buffer.from(await r.arrayBuffer());
    try { fs.writeFileSync(file, buf); } catch (e) { /* no cache, still served */ }
    res.end(buf);
}));

module.exports = router;
module.exports._test = { joinSpelled, sttPrompt };
