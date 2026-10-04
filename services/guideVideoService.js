// services/guideVideoService.js
//
// A guide's OWN video on a pick (founder 2026-10-05: Instagram's embed "looks
// like колхоз" — the account header, the likes, the caption. Jinni plays the
// clip itself: only the video, starting by itself, with a small Instagram mark
// that links to the original post).
//
// The guide uploads the file in their dashboard. It is converted to one small
// H.264 MP4 (720 px wide at most, 90 s at most) so every phone can play it, a
// poster frame is cut, and both are kept in MongoDB GridFS (bucket
// 'guideVideos') — the same "binary in our own database" pattern as images.
//
// ffmpeg comes from the optional `ffmpeg-static` package. If it is missing
// (the install failed on a deploy) an MP4 is stored as it arrived, without a
// poster — a missing OPTIONAL capability never takes uploads down.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;     // what a guide may send
const MAX_RAW_BYTES = 25 * 1024 * 1024;        // stored as-is only when ffmpeg is missing
const MAX_SECONDS = 90;
const ALLOWED_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];
const STALE_PROCESSING_MS = 15 * 60 * 1000;    // a conversion a restart interrupted

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'guideVideos' });

function ffmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try { return require('ffmpeg-static') || null; } catch { return null; }
}

function run(bin, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
    });
}

/** "Duration: 00:00:31.52" in ffmpeg's log → 31.52, capped at the limit; null when unknown. */
function parseDuration(log) {
    const m = String(log || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    return Number.isFinite(s) ? Math.min(MAX_SECONDS, Math.round(s * 10) / 10) : null;
}

function storeFile(filePath, filename, contentType) {
    return new Promise((resolve, reject) => {
        const up = bucket().openUploadStream(filename, { metadata: { contentType } });
        fs.createReadStream(filePath).on('error', reject).pipe(up).on('error', reject).on('finish', () => resolve(up.id));
    });
}

const unlink = (p) => fs.promises.unlink(p).catch(() => {});

/** Delete a pick's stored video + poster. Best-effort: a missing file is not an error. */
async function removeVideoFiles(video) {
    if (!video) return;
    for (const id of [video.fileId, video.posterId]) {
        if (!id) continue;
        try { await bucket().delete(new mongoose.Types.ObjectId(String(id))); } catch { /* already gone */ }
    }
}

/** Every stored video of these picks (pick deleted, guide page deleted). */
async function removeVideosOfPicks(picks) {
    for (const p of picks || []) await removeVideoFiles(p && p.video);
}

// One conversion at a time: the server is small and a guide uploads rarely.
let chain = Promise.resolve();

/**
 * Convert + store the uploaded file, then mark the pick's video ready (or
 * failed, with a reason the guide can read). Runs after the upload request has
 * already answered; never throws.
 */
function processUpload(pickId, tmpPath, mimetype, deps = {}) {
    const job = async () => {
        const GuidePick = deps.GuidePick || require('../models/GuidePick');
        const out = path.join(os.tmpdir(), `jinni-gv-${pickId}-${Date.now()}.mp4`);
        const poster = out.replace(/\.mp4$/, '.jpg');
        const fail = async (msg) => {
            await GuidePick.updateOne({ _id: pickId, 'video.status': 'processing' }, { $set: { 'video.status': 'failed', 'video.error': msg } }).catch(() => {});
            console.warn(`[guides] video for pick ${pickId} failed: ${msg}`);
        };
        try {
            const bin = ffmpegPath();
            let fileId, posterId = null, durationSec = null, sizeBytes;
            if (bin) {
                let log;
                try {
                    log = await run(bin, ['-y', '-i', tmpPath, '-t', String(MAX_SECONDS), '-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast',
                        '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', '-threads', '2', out]);
                } catch (e) {
                    console.warn('[guides] ffmpeg:', e.message);
                    return await fail('This file could not be read as a video. Please upload the original MP4 or MOV.');
                }
                durationSec = parseDuration(log);
                try { await run(bin, ['-y', '-ss', durationSec && durationSec > 1 ? '0.5' : '0', '-i', out, '-frames:v', '1', '-q:v', '4', poster]); } catch { /* no poster — the place photo stands in */ }
                sizeBytes = (await fs.promises.stat(out)).size;
                fileId = await storeFile(out, `${pickId}.mp4`, 'video/mp4');
                if (fs.existsSync(poster)) posterId = await storeFile(poster, `${pickId}.jpg`, 'image/jpeg');
            } else {
                sizeBytes = (await fs.promises.stat(tmpPath)).size;
                if (mimetype !== 'video/mp4' || sizeBytes > MAX_RAW_BYTES) return await fail('Please upload an MP4 file under 25 MB.');
                fileId = await storeFile(tmpPath, `${pickId}.mp4`, 'video/mp4');
            }
            // The pick may have been removed, or its video replaced, while this ran.
            const r = await GuidePick.updateOne({ _id: pickId, 'video.status': 'processing' },
                { $set: { video: { status: 'ready', fileId, posterId, sizeBytes, durationSec, error: null, uploadedAt: new Date() } } });
            if (!r.modifiedCount) { await removeVideoFiles({ fileId, posterId }); return; }
            console.log(`[guides] video ready for pick ${pickId}: ${(sizeBytes / 1048576).toFixed(1)} MB${durationSec ? `, ${durationSec}s` : ''}${bin ? '' : ' (stored as uploaded — no ffmpeg)'}`);
        } catch (err) {
            await fail('The video could not be saved. Please try again.');
            console.warn('[guides] processUpload error:', err.message);
        } finally {
            await Promise.all([unlink(tmpPath), unlink(out), unlink(poster)]);
        }
    };
    chain = chain.then(job, job);
    return chain;
}

/** What the outside may know about a pick's video: playable links only when it is ready. */
function videoView(pick) {
    const v = pick && pick.video;
    if (!v || !v.status) return null;
    if (v.status === 'ready' && v.fileId) {
        const ver = String(v.fileId).slice(-6);
        return { status: 'ready', videoUrl: `/api/guides/video/${pick._id}?v=${ver}`, posterUrl: v.posterId ? `/api/guides/video/${pick._id}/poster?v=${ver}` : null, durationSec: v.durationSec ?? null };
    }
    if (v.status === 'processing' && v.uploadedAt && Date.now() - new Date(v.uploadedAt).getTime() > STALE_PROCESSING_MS) {
        return { status: 'failed', error: 'The video took too long to prepare. Please upload it again.' };
    }
    return { status: v.status, error: v.status === 'failed' ? (v.error || 'The video could not be saved.') : null };
}

/** Stream one GridFS file, honouring Range (Safari will not play a video without it). */
async function streamFile(req, res, fileId, { contentType, cacheControl }) {
    const id = new mongoose.Types.ObjectId(String(fileId));
    const file = await bucket().find({ _id: id }).next();
    if (!file) return res.status(404).json({ success: false, error: 'Not found' });
    const size = file.length;
    res.set({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl });
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0, end = size - 1;
    if (m && (m[1] || m[2])) {
        if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1); }
        else { start = Math.max(0, size - parseInt(m[2], 10)); }
        if (!(start <= end) || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    const dl = bucket().openDownloadStream(id, { start, end: end + 1 });
    dl.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => dl.destroy());
    dl.pipe(res);
}

module.exports = {
    MAX_UPLOAD_BYTES, MAX_SECONDS, ALLOWED_MIMES,
    ffmpegPath, parseDuration, processUpload, removeVideoFiles, removeVideosOfPicks, videoView, streamFile,
};
