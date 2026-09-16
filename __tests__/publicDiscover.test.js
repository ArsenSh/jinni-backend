// Public discovery (founder 2026-09-16): cities are derived from the data,
// visibility mirrors Jinni's Discoveries, and nothing personal leaks.
const { clusterCities, publicVisible, slugify } = require('../routes/publicRoutes')._test;

const row = (id, lat, lng, extra = {}) => ({
    placeId: id, name: id, rating: 4.5, actions: ['restaurants'], photos: [{ url: 'x' }],
    details: { geometry: { location: { lat, lng } } }, ...extra,
});
const YEREVAN = { name: 'Yerevan', asciiName: 'Yerevan', lat: 40.18, lng: 44.51, countryCode: 'AM', countryName: 'Armenia', population: 1000000 };
const GYUMRI = { name: 'Gyumri', asciiName: 'Gyumri', lat: 40.79, lng: 43.85, countryCode: 'AM', countryName: 'Armenia', population: 120000 };

describe('publicVisible mirrors the Discoveries hide rules', () => {
    test('hidden, ai-blocked, closed, buried and low-rated rows are out', () => {
        expect(publicVisible(row('a', 40, 44))).toBe(true);
        expect(publicVisible(row('b', 40, 44, { explore: { status: 'hidden' } }))).toBe(false);
        expect(publicVisible(row('c', 40, 44, { aiBlocked: true }))).toBe(false);
        expect(publicVisible(row('d', 40, 44, { business_status: 'CLOSED_TEMPORARILY' }))).toBe(false);
        expect(publicVisible(row('e', 40, 44, { likes: 0, dislikes: 3 }))).toBe(false);
        expect(publicVisible(row('f', 40, 44, { rating: 3.1 }))).toBe(false);
    });
    test('a validator-verified row survives a low rating', () => {
        expect(publicVisible(row('g', 40, 44, { rating: 3.1, explore: { status: 'verified' } }))).toBe(true);
    });
    test('no coordinates → not shown', () => {
        expect(publicVisible({ placeId: 'h', details: {} })).toBe(false);
    });
});

describe('clusterCities', () => {
    test('a city gets a page only with enough places within its reach', () => {
        const rows = [];
        for (let i = 0; i < 12; i++) rows.push(row(`y${i}`, 40.18 + i * 0.001, 44.51));
        for (let i = 0; i < 3; i++) rows.push(row(`g${i}`, 40.79, 43.85 + i * 0.001));
        const out = clusterCities(rows, [YEREVAN, GYUMRI], { minPlaces: 12 });
        expect(out.map(c => c.slug)).toEqual(['yerevan']);
        expect(out[0].rows).toHaveLength(12);
        expect(out[0].city.countryName).toBe('Armenia');
    });
    // Founder 2026-09-17: Tavush's places were dropped because no 50k city
    // was near. A small town claims what lies within ITS reach (10 km), and
    // a village next to a metro still belongs to the metro.
    test('a small town keeps its own places; a hamlet under the minimum folds into the city that covers it', () => {
        const DILIJAN = { name: 'Dilijan', asciiName: 'Dilijan', lat: 40.74, lng: 44.86, countryCode: 'AM', countryName: 'Armenia', population: 17000 };
        const KANAKER = { name: 'Kanaker', asciiName: 'Kanaker', lat: 40.22, lng: 44.55, countryCode: 'AM', countryName: 'Armenia', population: 3000 };
        const rows = [];
        for (let i = 0; i < 6; i++) rows.push(row(`d${i}`, 40.74 + i * 0.01, 44.86));      // within ~6 km of Dilijan
        for (let i = 0; i < 3; i++) rows.push(row(`k${i}`, 40.22, 44.55 + i * 0.001));      // in Kanaker, 5 km from Yerevan — too few for a page
        for (let i = 0; i < 3; i++) rows.push(row(`y${i}`, 40.18, 44.51 + i * 0.001));      // central Yerevan
        const out = clusterCities(rows, [YEREVAN, DILIJAN, KANAKER], { minPlaces: 6 });
        expect(out.map(c => c.slug).sort()).toEqual(['dilijan', 'yerevan']);
        expect(out.find(c => c.slug === 'yerevan').rows).toHaveLength(6);
    });
    // Founder 2026-09-17: "I have many places in Tsaghkadzor but it is not
    // showing" — the resort town is 6 km from Hrazdan, whose 15 km reach
    // swallowed it. Nearest covering settlement wins when it has enough.
    test('a resort town inside a bigger neighbour\'s reach keeps its own page when it has enough places', () => {
        const HRAZDAN = { name: 'Hrazdan', asciiName: 'Hrazdan', lat: 40.498, lng: 44.766, countryCode: 'AM', countryName: 'Armenia', population: 52000 };
        const TSAGHKADZOR = { name: 'Tsaghkadzor', asciiName: 'Tsaghkadzor', lat: 40.532, lng: 44.719, countryCode: 'AM', countryName: 'Armenia', population: 1200 };
        const rows = [];
        for (let i = 0; i < 8; i++) rows.push(row(`t${i}`, 40.532 + i * 0.002, 44.719));   // in Tsaghkadzor
        for (let i = 0; i < 6; i++) rows.push(row(`h${i}`, 40.498, 44.766 + i * 0.002));   // in Hrazdan
        const out = clusterCities(rows, [HRAZDAN, TSAGHKADZOR], { minPlaces: 6 });
        expect(out.map(c => `${c.slug}:${c.rows.length}`).sort()).toEqual(['hrazdan:6', 'tsaghkadzor:8']);
    });
    test('a place far from every city belongs to none', () => {
        const out = clusterCities([row('far', 45.0, 44.5)], [YEREVAN], { minPlaces: 1 });
        expect(out).toEqual([]);
    });
    test('same slug in two countries keeps the fuller city', () => {
        const other = { ...YEREVAN, lat: 10, lng: 10, countryCode: 'XX', countryName: 'Elsewhere' };
        const rows = [row('a', 40.18, 44.51), row('b', 40.181, 44.51), row('c', 10, 10)];
        const out = clusterCities(rows, [YEREVAN, other], { minPlaces: 1 });
        expect(out).toHaveLength(1);
        expect(out[0].city.countryCode).toBe('AM');
    });
    test('slugify strips accents and punctuation', () => {
        expect(slugify('Saint-Étienne du Mont')).toBe('saint-etienne-du-mont');
    });
});

describe('ownedRow (Destinations and Businesses on the public page, 2026-09-17)', () => {
    const { ownedRow } = require('../routes/publicRoutes')._internals;
    const base = { _id: '5f1a2b3c4d5e6f7a8b9c0d1e', name: 'Lavash House', images: ['/api/media/x.jpg', 'https://cdn/y.jpg'],
        location: { coordinates: { lat: 40.18, lng: 44.51 }, address: '1 Abovyan St', city: 'Yerevan' }, contact: { website: 'https://l.am', phone: '+374' } };
    test('a business maps its types to rails, keeps its tier and ships its own photos', () => {
        const r = ownedRow({ ...base, type: ['restaurants', 'romantic', 'luxury', 'jewelry'], partnership: { tier: 'signature' } }, 'business');
        expect(r.placeId).toBe('biz_5f1a2b3c4d5e6f7a8b9c0d1e');
        expect(r.actions.sort()).toEqual(['restaurants', 'shopping']);
        expect(r.interests).toEqual(['romantic']);
        expect(r._styleTier).toBe(4);
        expect(r._owned.tier).toBe('signature');
        expect(r._owned.images).toHaveLength(2);
        expect(r.explore.status).toBe('verified');
    });
    test('a destination carries no partner tier; events-only or photo-less rows are skipped', () => {
        expect(ownedRow({ ...base, type: ['historical'] }, 'destination')._owned.tier).toBeNull();
        expect(ownedRow({ ...base, type: ['events'] }, 'destination')).toBeNull();
        expect(ownedRow({ ...base, type: ['historical'], images: [] }, 'destination')).toBeNull();
    });
});
