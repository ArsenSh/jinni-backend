// One-shot check of the liteAPI hotel price provider — run it where the key
// is (server, or a laptop with the key in the env):
//   HOTEL_PRICES_TOKEN=sand_… node scripts/hotelPricesCheck.js "Sevan" AM 40.55 44.95
//   HOTEL_PRICES_TOKEN=sand_… node scripts/hotelPricesCheck.js "Dubai" AE 25.08 55.14 2026-10-10 2026-10-12
// Prints pool size, priced count, HTTP failures and the first rows. Never prints the key.
const hotels = require('../engine/travel/hotels');
const [name = 'Sevan', cc = 'AM', lat = '40.55', lng = '44.95', checkIn = null, checkOut = null] = process.argv.slice(2);
(async () => {
    if (!hotels.hotelsEnabled()) { console.error('HOTEL_PRICES_TOKEN is not set'); process.exit(1); }
    const out = await hotels.hotelPrices({ centre: { name, countryCode: cc, lat: +lat, lng: +lng }, checkIn, checkOut, currency: 'USD', guestNationality: cc, radiusKm: 25 });
    console.log(JSON.stringify({ ok: out.ok, reason: out.reason, stay: `${out.check_in} → ${out.check_out}`, diag: out.diag, first: (out.hotels || []).slice(0, 5).map(h => ({ name: h.name, stars: h.stars, per_night: h.price_per_night, link: !!h.booking_url })) }, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
