/**
 * mediaRoutes.js
 *
 * POST /api/media/upload
 *   Signature-only. Accepts a single image file, validates MIME + file size
 *   (via multer) then validates pixel dimensions (via sharp), stores the raw
 *   binary in the Business document's uploadedImages array, and returns a
 *   serve URL that the frontend can use immediately.
 *
 * GET  /api/media/business/:id/image/:index
 *   Public. Reads the binary buffer from MongoDB and streams it to the client.
 *   No Google API, no external storage — identical pattern to ImageStorageService.serveImage().
 *
 * Requires:
 *   npm install multer sharp
 */
const express  = require('express')
const multer   = require('multer')
const sharp    = require('sharp')
const auth     = require('../middleware/auth')
const Business = require('../models/Business')
const { IMAGE_CONSTRAINTS } = Business  // single source of truth from the model
const router = express.Router()

// ── multer: memory storage, first-pass guards ──────────────────────────────────
// We do NOT write to disk — the buffer goes straight into MongoDB.
// File size and MIME type are checked here; pixel dimensions are checked below
// by sharp after the upload is in memory.

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: IMAGE_CONSTRAINTS.maxBytes,   // 5 MB hard limit
        files: 1,                               // one file per request
    },
    fileFilter(_req, file, cb) {
        // Reject anything outside the allowed MIME whitelist immediately.
        // This is a first-pass check; sharp will re-verify format below.
        if (!IMAGE_CONSTRAINTS.allowedMimes.includes(file.mimetype)) {return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `Only ${IMAGE_CONSTRAINTS.allowedMimes.join(', ')} files are allowed`))}
        // Block path-traversal and double-extension filenames
        const dangerousExt = /\.(php\d?|phtml|phar|asp|aspx|jsp|exe|sh|bat|cmd|cgi|pl|py|rb)\./i
        const invalidChars  = /(\.\.(\/|\\)|[<>{}\[\]|\\^~`])/
        if (dangerousExt.test(file.originalname) || invalidChars.test(file.originalname)) {return cb(new Error('File name contains invalid characters or extensions'))}
        cb(null, true)
    },
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/media/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', auth, upload.single('image'), async (req, res) => {
    try {
        // ── Auth guard: Signature tier only ───────────────────────────────────
        if (!req.user) return res.status(401).json({ error: 'Not authenticated' })
        const business = await Business.findOne({ owner: req.user.id })
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.partnership.tier !== 'signature') {return res.status(403).json({ error: 'Image upload is available on Signature tier only' })}
        if ((business.uploadedImages?.length ?? 0) >= 8) {return res.status(400).json({ error: 'Maximum of 8 uploaded images reached' })}
        // ── File presence ─────────────────────────────────────────────────────
        if (!req.file) return res.status(400).json({ error: 'No image file provided' })
        const buffer = req.file.buffer
        // ── Pixel dimension check via sharp ───────────────────────────────────
        // sharp reads the actual image header — it does NOT trust the browser's
        // reported MIME type.  This also catches corrupt/spoofed files.
        let metadata
        try {metadata = await sharp(buffer).metadata()} 
        catch {return res.status(400).json({ error: 'File is not a valid image or is corrupt' })}
        const { width, height } = metadata
        if (width  < IMAGE_CONSTRAINTS.minWidth || height < IMAGE_CONSTRAINTS.minHeight) {return res.status(400).json({error: `Image is too small. Minimum size is ${IMAGE_CONSTRAINTS.minWidth}×${IMAGE_CONSTRAINTS.minHeight}px (uploaded: ${width}×${height}px)`})}
        if (width  > IMAGE_CONSTRAINTS.maxWidth || height > IMAGE_CONSTRAINTS.maxHeight) {return res.status(400).json({error: `Image is too large. Maximum size is ${IMAGE_CONSTRAINTS.maxWidth}×${IMAGE_CONSTRAINTS.maxHeight}px (uploaded: ${width}×${height}px)`})}
        // ── Use sharp's detected MIME type, not the browser's claim ──────────
        // sharp maps format names to MIME types:
        const FORMAT_TO_MIME = {jpeg: 'image/jpeg', png:  'image/png', webp: 'image/webp', gif:  'image/gif', avif: 'image/avif'}
        const verifiedMime = FORMAT_TO_MIME[metadata.format]
        if (!verifiedMime || !IMAGE_CONSTRAINTS.allowedMimes.includes(verifiedMime)) {return res.status(400).json({ error: 'Image format could not be verified. Use JPG, PNG, WEBP, GIF or AVIF.' })}
        // ── Store binary in MongoDB ───────────────────────────────────────────
        // Push a new entry onto uploadedImages — same shape as PlaceCache.photos.
        const imageEntry = {imageData:   buffer, contentType: verifiedMime, width, height, sizeBytes:   buffer.length, storedAt:    new Date()}
        business.uploadedImages.push(imageEntry)
        await business.save()
        const imageIndex = business.uploadedImages.length - 1
        // ── Return the serve URL ──────────────────────────────────────────────
        // The frontend stores this URL string in the images[] array it sends
        // with the final /apply or /update payload.
        const serveUrl = `/api/media/business/${business._id}/image/${imageIndex}`
        console.log(`✅ Stored uploaded image ${imageIndex} for business ${business._id} (${(buffer.length / 1024).toFixed(1)} KB, ${width}×${height}px, ${verifiedMime})`)
        return res.json({success: true,url: serveUrl,index: imageIndex,width,height,sizeBytes: buffer.length,contentType: verifiedMime})
    } catch (err) {
        // multer errors (file size exceeded, wrong field name, etc.)
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {return res.status(400).json({ error: `File exceeds the maximum allowed size of ${IMAGE_CONSTRAINTS.maxBytes / 1024 / 1024} MB` })}
            return res.status(400).json({ error: err.message })
        }
        console.error('❌ Media upload error:', err)
        return res.status(500).json({ error: 'Upload failed. Please try again.' })
    }
})


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/media/business/:id/image/:index
// Public — serve binary image from MongoDB.  Zero external calls.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/business/:id/image/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index, 10)
        if (isNaN(index) || index < 0) {return res.status(400).json({ error: 'Invalid image index' })}
        // Only fetch the uploadedImages field — skip everything else
        const business = await Business.findById(req.params.id).select('uploadedImages').lean()
        if (!business) return res.status(404).json({ error: 'Business not found' })
        const images = business.uploadedImages || []
        if (!images[index]) return res.status(404).json({ error: 'Image not found at this index' })
        const img = images[index]
        // Detect poisoned/corrupt entry (stored JSON instead of image bytes)
        if (img.contentType?.includes('application/json')) {
            console.error(`❌ Stored data for ${req.params.id}/${index} is JSON — stale upload, re-upload required`)
            return res.status(500).json({ error: 'Stored image data is invalid. Please re-upload this image.' })
        }
        const imageBuffer = toBuffer(img.imageData)
        if (!imageBuffer) {
            console.error(`❌ imageData is null or unreadable for ${req.params.id}/${index}`)
            return res.status(500).json({ error: 'Image data could not be read. Please re-upload.' })
        }
        // ── Send binary response ──────────────────────────────────────────────
        res.set('Content-Type', img.contentType || 'image/jpeg')
        res.set('Content-Length', imageBuffer.length)
        // Cache for 7 days — uploaded business images don't change
        res.set('Cache-Control', 'public, max-age=604800, immutable')
        return res.end(imageBuffer)
    } catch (err) {
        console.error('❌ Serve business image error:', err.message)
        return res.status(500).json({ error: 'Failed to serve image' })
    }
})


// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/media/business/:id/image/:index
// Owner only — removes one uploaded image slot.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/business/:id/image/:index', auth, async (req, res) => {
    try {
        const index = parseInt(req.params.index, 10)
        if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid index' })
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.owner?.toString() !== req.user.id && !req.user.isAdmin) {return res.status(403).json({ error: 'Not authorized' })}
        if (!business.uploadedImages?.[index]) {return res.status(404).json({ error: 'Image not found at this index' })}
        business.uploadedImages.splice(index, 1)
        await business.save()
        return res.json({ success: true, remaining: business.uploadedImages.length })
    } catch (err) {
        console.error('❌ Delete business image error:', err.message)
        return res.status(500).json({ error: 'Delete failed' })
    }
})


// ─────────────────────────────────────────────────────────────────────────────
// Helper — same as ImageStorageService._toBuffer(), handles all MongoDB/Mongoose
// binary representations.
// ─────────────────────────────────────────────────────────────────────────────
function toBuffer(imageData) {
    if (!imageData) return null
    if (Buffer.isBuffer(imageData)) return imageData
    if (imageData.buffer instanceof ArrayBuffer || ArrayBuffer.isView(imageData.buffer)) {return Buffer.from(imageData.buffer)}
    if (typeof imageData.value === 'function') {return Buffer.from(imageData.value('raw'))}
    if (typeof imageData === 'object' && imageData.type === 'Buffer' && Array.isArray(imageData.data)) {return Buffer.from(imageData.data)}
    if (imageData instanceof Uint8Array || imageData instanceof ArrayBuffer) {return Buffer.from(imageData)}
    return null
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/media/places/:placeId/photo/:index
// Public — serve Google Place image binary from MongoDB (PlaceCache).
// ─────────────────────────────────────────────────────────────────────────────
const imageStorageService = require('../services/imageStorageService')

router.get('/places/:placeId/photo/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index, 10)
        if (isNaN(index) || index < 0) {return res.status(400).json({ error: 'Invalid image index' })}
        const { data, contentType } = await imageStorageService.serveImage(req.params.placeId, index)
        res.set('Content-Type', contentType)
        res.set('Content-Length', data.length)
        res.set('Cache-Control', 'public, max-age=604800, immutable')
        return res.end(data)
    } catch (err) {
        console.error('❌ Serve place image error:', err.message)
        return res.status(404).json({ error: 'Image not found' })
    }
})


module.exports = router