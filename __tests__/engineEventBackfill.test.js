// Nightly poster/time back-fill for stored events (founder 2026-09-19).
const { backfillEventDetails } = require('../engine/events/hunt');

test('reads each poor row\'s own page and stores the poster it finds', async () => {
    const future = new Date(Date.now() + 3 * 864e5); future.setUTCHours(0, 0, 0, 0);   // midnight = time unknown
    const docs = [
        { _id: 'a', name: 'Organ festival', image: null, startDate: future, sourceUrl: 'https://allevents.in/yerevan/organ/1' },
        { _id: 'b', name: 'Disco legends', image: 'https://cdn/poster.jpg', price: '5000 AMD', venueName: 'Arena', startDate: new Date(future.getTime() + 19 * 3600e3), sourceUrl: 'https://allevents.in/yerevan/disco/2' },
    ];
    const updates = [];
    const Model = {
        find: () => ({ sort: () => ({ limit: () => ({ lean: async () => docs }) }) }),
        updateOne: async (q, u) => { updates.push([q._id, u.$set]); },
    };
    const fetchHtml = async (url) => url.includes('/organ/') ? '<html><head><meta property="og:image" content="https://cdn/organ-poster.jpg"></head><body>Organ festival</body></html>' : null;
    const out = await backfillEventDetails({ AiFoundEvent: Model, fetchHtml, budget: 5 });
    expect(out.checked).toBe(2);
    expect(out.updated).toBe(1);
    expect(updates[0][0]).toBe('a');
    expect(updates[0][1].image).toBe('https://cdn/organ-poster.jpg');
});
