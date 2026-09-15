// Backfill PlaceCache.opening_hours.periods from the display lines Google
// already gave us. Repo convention: DRY-RUN by default.
//
//   node scripts/backfillOpeningHours.js                 # counts + samples, no writes
//   node scripts/backfillOpeningHours.js --apply
//   node scripts/backfillOpeningHours.js --apply --limit=500
//
// ⚠ RUN THIS ON THE SERVER — the Atlas IP whitelist blocks local connections.
//
// WHY (2026-09-16): 1,249 of 1,869 cached places carry opening hours, but only
// as "Monday: 10:00 AM – 12:00 AM" lines; the structured periods the open-now
// check reads were never stored. isOpenAt now parses the lines on the fly, so
// the deck is already honest — this makes that free by storing the result.
// Nothing is guessed: a line the parser cannot read stays unknown for that
// day, and a row where nothing parses is left untouched and counted.
require('dotenv').config();
const mongoose = require('mongoose');
const { parseWeekdayText } = require('../engine/context/contextEngine');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const coll = mongoose.connection.db.collection('placecaches');
    const q = { 'opening_hours.weekday_text.0': { $exists: true }, 'opening_hours.periods.0': { $exists: false } };
    const cursor = coll.find(q, { projection: { placeId: 1, name: 1, 'opening_hours.weekday_text': 1 } });
    let seen = 0, parsed = 0, unreadable = 0, written = 0;
    const samples = [];
    for await (const row of cursor) {
        seen++;
        const periods = parseWeekdayText(row.opening_hours.weekday_text);
        if (!periods) { unreadable++; if (samples.length < 8) samples.push(`UNREADABLE ${row.name}: ${row.opening_hours.weekday_text.join(' | ')}`); continue; }
        parsed++;
        if (samples.length < 8) samples.push(`${row.name}: ${periods.length} period(s) e.g. ${JSON.stringify(periods[0])}`);
        if (APPLY) {
            await coll.updateOne({ _id: row._id }, { $set: { 'opening_hours.periods': periods } });
            written++;
        }
        if (LIMIT && seen >= LIMIT) break;
    }
    console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — rows with text but no periods: ${seen}; parsed: ${parsed}; unreadable: ${unreadable}; written: ${written}`);
    console.log(samples.join('\n'));
    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
