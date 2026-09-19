// QA runner (founder 2026-09-18): plays scripted conversations against the
// LIVE API as the QA account and prints what the engine did on every turn —
// lane, path, search centre, radius, the cards with their distances, the
// reply — plus PASS/FAIL for the checks in qa/scenarios.json. Claude reads
// the report and judges; the app's own model (DeepSeek by default) answers.
//
//   node scripts/qaRun.js                       # every scenario on v3
//   node scripts/qaRun.js --engine=v2           # same on v2
//   node scripts/qaRun.js --only=lake-stay      # one scenario
//   node scripts/qaRun.js --api=https://api.jinni.travel
//
// Login token: backend/.qa-token (git-ignored). Sessions are titled "QA: …"
// so they are easy to find — and delete — in the admin Sessions tab.
const fs = require('fs');
const path = require('path');

const arg = (k, d = null) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const API = (arg('api', 'https://api.jinni.travel')).replace(/\/+$/, '');
const ENGINE = arg('engine', 'v3') === 'v2' ? 'v2' : 'v3';
const ONLY = arg('only');
const TOKEN = (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.qa-token'), 'utf8').trim(); } catch { return ''; } })();
if (!TOKEN) { console.error('no backend/.qa-token — log the QA account in first'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const km = (a, b, c, d) => { const R = 6371, t = x => x * Math.PI / 180; const dl = t(c - a), dn = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

async function json(method, url, body) {
    const res = await fetch(`${API}${url}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
    return data;
}

/** One turn: POST the message, read the SSE stream, return what happened. */
async function turn(sessionId, message) {
    const body = {
        message, userTimezone: 'Asia/Yerevan',
        destinationInfo: { city: '', country: '', mode: 'nearby' },
        actionType: 'general_query', sessionId, nearbyMode: false,
        settings: { language: 'en', currency: 'USD', distanceUnit: 'km' },
        context: {},
    };
    const t0 = Date.now();
    const res = await fetch(`${API}/api/ai/chat-stream-${ENGINE}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`chat-stream-${ENGINE} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const out = { text: '', cards: [], meta: null, events: {}, ms: 0 };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                let d; try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
                out.events[d.type] = (out.events[d.type] || 0) + 1;
                if (d.type === 'token' && d.content) out.text += d.content;
                else if (d.type === 'streaming_recommendation' && d.recommendation) out.cards.push(d.recommendation);
                else if (d.type === 'recommendations' && Array.isArray(d.recommendations)) out.cards = d.recommendations;
                else if (d.type === 'complete') { out.meta = d.metadata || null; if (Array.isArray(d.recommendations) && d.recommendations.length) out.cards = d.recommendations; out.contentParts = d.contentParts || null; }
            }
        }
    }
    out.ms = Date.now() - t0;
    return out;
}

function cardLine(c) {
    const lat = c.latitude ?? c.lat ?? c.geometry?.lat, lng = c.longitude ?? c.lng ?? c.geometry?.lng;
    const price = c.hotelPrice ? ` from ${c.hotelPrice.perNight} ${c.hotelPrice.currency}/night${c.bookingUrl ? ' (link)' : ''}` : (c.listedPrice ? ` listed ${c.listedPrice.min != null ? 'from ' + c.listedPrice.min : '≈ ' + c.listedPrice.average} ${c.listedPrice.currency}` : '');
    const ev = c.eventSchedule ? ` 📅 ${JSON.stringify(c.eventSchedule).slice(0, 70)}${c.eventPrice ? ` 🎫 ${c.eventPrice}` : ''}` : '';
    const img = (c.image || c.cachedImageUrl) ? '' : ' [no image]';
    return `${c.name}${c.category ? ` [${c.category}]` : ''}${c.distance ? ` ${c.distance}` : ''}${price}${ev}${img}${c.address || c.location ? ` — ${String(c.address || c.location).slice(0, 60)}` : ''}${Number.isFinite(lat) ? ` (${lat.toFixed(3)},${lng.toFixed(3)})` : ''}`;
}

function check(expect, r) {
    const results = [];
    if (!expect) return results;
    const qa = r.meta?.qa || {};
    const lane = qa.lane || null, path = qa.path || null;
    if (expect.v3lane && ENGINE === 'v3') results.push([`lane=${expect.v3lane}`, lane === expect.v3lane, `got ${lane || path || '?'}`]);
    // No lane = the controller did not answer and v3 fell back to the classic route; judge the path it took, and say so.
    if (expect.v3laneIn && ENGINE === 'v3') results.push([`lane in ${expect.v3laneIn.join('|')}`, expect.v3laneIn.includes(lane || path), `got ${lane || `${path} (controller fallback)`}`]);
    if (expect.cardsMax != null) results.push([`cards<=${expect.cardsMax}`, r.cards.length <= expect.cardsMax, `got ${r.cards.length}`]);
    if (expect.cardsMin != null) results.push([`cards>=${expect.cardsMin}`, r.cards.length >= expect.cardsMin, `got ${r.cards.length}`]);
    if (expect.allCardsWithinKm) {
        const { lat, lng, km: max } = expect.allCardsWithinKm;
        const far = r.cards.filter(c => { const a = c.latitude ?? c.lat ?? c.geometry?.lat, b = c.longitude ?? c.lng ?? c.geometry?.lng; return Number.isFinite(a) && km(lat, lng, a, b) > max; });
        results.push([`all cards within ${max} km of ${lat},${lng}`, far.length === 0, far.length ? `far: ${far.map(c => c.name).join(', ')}` : `${r.cards.length} card(s)`]);
    }
    if (expect.allCardsDatedEvents) {
        // Honest fallback is allowed: when NO dated event exists the deck may be
        // venues (the reply says so). Mixing venues INTO a dated deck is the fault.
        const undated = r.cards.filter(c => !c.eventSchedule);
        const dated = r.cards.length - undated.length;
        const ok = undated.length === 0 || dated === 0;
        results.push(['no venues mixed into a dated events deck', ok, dated === 0 && undated.length ? `no dated events — ${undated.length} venue(s) offered honestly` : (undated.length ? `venues/undated: ${undated.map(c => c.name).join(', ')}` : `${r.cards.length} event(s)`)]);
    }
    if (expect.cardsWithImageMin != null) {
        const withImg = r.cards.filter(c => c.image || c.cachedImageUrl).length;
        results.push([`cards with image>=${expect.cardsWithImageMin}`, withImg >= expect.cardsWithImageMin, `got ${withImg}/${r.cards.length}`]);
    }
    if (expect.cardsWithTimeMin != null) {
        // A start at exactly midnight is the hunter's "date known, time unknown" marker.
        const withTime = r.cards.filter(c => c.eventSchedule?.startDate && !/T00:00:00/.test(new Date(c.eventSchedule.startDate).toISOString())).length;
        results.push([`cards with a start time>=${expect.cardsWithTimeMin}`, withTime >= expect.cardsWithTimeMin, `got ${withTime}/${r.cards.length}`]);
    }
    if (expect.replyIncludes) results.push([`reply includes "${expect.replyIncludes}"`, r.text.toLowerCase().includes(String(expect.replyIncludes).toLowerCase()), '']);
    return results;
}

(async () => {
    const { scenarios } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qa', 'scenarios.json'), 'utf8'));
    const list = ONLY ? scenarios.filter(s => s.id === ONLY) : scenarios;
    const report = { api: API, engine: ENGINE, at: new Date().toISOString(), scenarios: [] };
    let pass = 0, fail = 0;
    for (const sc of list) {
        console.log(`\n══ ${sc.id} (${ENGINE}) — ${sc.why}`);
        const session = await json('POST', '/api/ai/chat-sessions', { title: `QA: ${sc.id} (${ENGINE})`, messages: [] });
        const sessionId = session._id;
        const messages = [];
        const rec = { id: sc.id, sessionId, turns: [] };
        for (const t of sc.turns) {
            let r;
            try { r = await turn(sessionId, t.say); } catch (err) { console.log(`  ✗ "${t.say}" → ${err.message}`); rec.turns.push({ say: t.say, error: err.message }); fail++; continue; }
            // Mirror the app: hotel cards that arrived without a price ask /hotel-prices (any engine, any turn).
            const wantPrice = r.cards.filter(c => /hotel/i.test(String(c.category || c.type || '')) && !c.hotelPrice && Number.isFinite(c.latitude ?? c.lat) && Number.isFinite(c.longitude ?? c.lng));
            if (wantPrice.length) {
                try {
                    const pr = await json('POST', '/api/ai/hotel-prices', { hotels: wantPrice.map(c => ({ name: c.name, latitude: c.latitude ?? c.lat, longitude: c.longitude ?? c.lng })), currency: 'USD', language: 'en' });
                    let n = 0;
                    for (const c of r.cards) { const m = pr?.prices?.[c.name]; if (m && Number.isFinite(m.perNight)) { c.hotelPrice = { perNight: m.perNight, currency: m.currency, url: m.url }; if (m.url) c.bookingUrl = m.url; n++; } }
                    console.log(`    (priced after render via /hotel-prices: ${n}/${wantPrice.length})`);
                } catch (err) { console.log(`    (/hotel-prices: ${err.message.slice(0, 120)})`); }
            }
            const qa = r.meta?.qa || {};
            console.log(`\n  ▶ "${t.say}"  ${r.ms} ms · lane=${qa.lane || '-'} path=${qa.path || '-'} centre=${r.meta?.searchCity || qa.city || '-'} r=${qa.radiusKm ?? '-'}km${r.meta?.statedAt ? ` statedAt=${r.meta.statedAt}` : ''}${r.meta?.emptyCause ? ` empty=${r.meta.emptyCause}` : ''}`);
            console.log(`    reply: ${r.text.replace(/\s+/g, ' ').slice(0, 260)}${r.text.length > 260 ? '…' : ''}`);
            if (r.meta?.followUpQuestion) console.log(`    question: ${r.meta.followUpQuestion}`);
            for (const c of r.cards) console.log(`    • ${cardLine(c)}`);
            for (const [name, ok, note] of check(t.expect, r)) { ok ? pass++ : fail++; console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` (${note})` : ''}`); }
            rec.turns.push({ say: t.say, ms: r.ms, qa, meta: r.meta, text: r.text, cards: r.cards.map(c => ({ name: c.name, category: c.category, distance: c.distance, address: c.address, lat: c.latitude ?? c.lat, lng: c.longitude ?? c.lng, hotelPrice: c.hotelPrice || null, listedPrice: c.listedPrice || null, bookingUrl: c.bookingUrl || null, eventSchedule: c.eventSchedule || null, eventPrice: c.eventPrice || null, image: c.image || c.cachedImageUrl || null, sourceUrl: c.sourceUrl || null, venueName: c.venueName || null })) });
            // Persist the transcript the way the app does, so the next turn has history.
            const now = new Date().toISOString();
            messages.push({ id: `u-${Date.now()}`, sender: 'user', text: t.say, timestamp: now });
            messages.push({ id: `a-${Date.now()}`, sender: 'ai', text: r.text, timestamp: now, recommendations: r.cards, ...(r.contentParts ? { contentParts: r.contentParts } : {}) });
            try { await json('PATCH', `/api/ai/chat-sessions/${sessionId}`, { title: `QA: ${sc.id} (${ENGINE})`, messages }); } catch (err) { console.log(`    (session save failed: ${err.message})`); }
        }
        report.scenarios.push(rec);
    }
    const file = path.join(__dirname, '..', 'qa', 'reports', `${report.at.replace(/[:.]/g, '-')}-${ENGINE}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n${pass} PASS · ${fail} FAIL · report ${path.relative(process.cwd(), file)}`);
    process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
