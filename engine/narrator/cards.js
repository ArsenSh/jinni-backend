// Jinni V2 Engine — card emission: retrieval candidates → v1's EXACT
// `recommendation` payload shape (copied from processStreamCompletion,
// aiRoutes ~3330–3372), so JinniChat renders v2 cards with ZERO frontend
// changes — photos, map coords, save/vote hydration and all.
//
// The v2 difference is upstream: every card here started as a retrieval
// candidate (owned corpus / cache), so a fake card is structurally impossible
// — no verification pass needed after the fact.

const CATEGORY_LABELS = {
    restaurants: 'Restaurant', hotels: 'Hotel', historical: 'Historical Site',
    hidden_gems: 'Hidden Gem', events: 'Event', photo_spots: 'Photo Spot',
    shopping: 'Shop', activities: 'Activity',
};

// Google place type → the word a traveler reads on the card.
//
// This table used to LEAD, and that was the v1 habit in new clothes: a human
// enumerating the world one row at a time, forever behind it (Arsen
// 2026-08-24 — "ai is leader not an employee, code just helps"). Naming what a
// place IS is a judgement, and judgements belong to the model. So the model
// names it now and code checks the answer against the vocabulary; this table
// is the FALLBACK for turns with no model answer — a fact-line deck, a failed
// stream, a salvaged tail. It is also where the vocabulary comes from, so the
// two can never drift apart.
const TYPE_LABELS = {
    // Sleep
    hotel: 'Hotel', motel: 'Hotel', resort_hotel: 'Hotel', extended_stay_hotel: 'Hotel', lodging: 'Hotel',
    hostel: 'Hostel', bed_and_breakfast: 'Guesthouse', guest_house: 'Guesthouse', cottage: 'Guesthouse',
    farmstay: 'Guesthouse', inn: 'Guesthouse', campground: 'Campsite', rv_park: 'Campsite',
    apartment_complex: 'Apartments', apartment_building: 'Apartments', condominium_complex: 'Apartments',
    housing_complex: 'Apartments', real_estate_agency: 'Rental agency',
    // Eat & drink
    restaurant: 'Restaurant', fine_dining_restaurant: 'Restaurant', steak_house: 'Restaurant',
    food_court: 'Food court', meal_takeaway: 'Takeaway', meal_delivery: 'Delivery',
    cafe: 'Cafe', coffee_shop: 'Cafe', tea_house: 'Tea house', bakery: 'Bakery',
    dessert_shop: 'Dessert shop', ice_cream_shop: 'Ice cream', juice_shop: 'Juice bar',
    bar: 'Bar', pub: 'Pub', bar_and_grill: 'Bar', wine_bar: 'Wine bar', night_club: 'Nightclub',
    // Culture
    museum: 'Museum', art_gallery: 'Gallery', performing_arts_theater: 'Theatre',
    opera_house: 'Opera house', concert_hall: 'Concert hall', auditorium: 'Concert hall',
    movie_theater: 'Cinema', cultural_center: 'Cultural centre', cultural_landmark: 'Landmark',
    library: 'Library', historical_landmark: 'Historical Site', historical_place: 'Historical Site',
    monument: 'Monument', church: 'Church', mosque: 'Mosque', synagogue: 'Synagogue',
    hindu_temple: 'Temple', place_of_worship: 'Place of worship',
    // Outdoors & play
    park: 'Park', national_park: 'National park', state_park: 'Park', dog_park: 'Park',
    garden: 'Garden', botanical_garden: 'Garden', plaza: 'Square', hiking_area: 'Trail',
    beach: 'Beach', zoo: 'Zoo', wildlife_park: 'Zoo', aquarium: 'Aquarium',
    amusement_park: 'Amusement park', water_park: 'Water park', casino: 'Casino',
    bowling_alley: 'Bowling', stadium: 'Stadium', arena: 'Arena', sports_complex: 'Sports complex',
    gym: 'Gym', fitness_center: 'Gym', spa: 'Spa', wellness_center: 'Spa',
    tourist_attraction: 'Attraction', observation_deck: 'Viewpoint', ferris_wheel: 'Attraction',
    // Shop
    shopping_mall: 'Shopping centre', department_store: 'Department store', market: 'Market',
    supermarket: 'Supermarket', grocery_store: 'Grocery', convenience_store: 'Convenience store',
    clothing_store: 'Clothes shop', shoe_store: 'Shoe shop', jewelry_store: 'Jewellery',
    book_store: 'Bookshop', gift_shop: 'Gift shop', electronics_store: 'Electronics',
    cell_phone_store: 'Phone shop', telecommunications_service_provider: 'Mobile operator',
    liquor_store: 'Wine shop', pharmacy: 'Pharmacy', drugstore: 'Pharmacy',
    // Move
    car_rental: 'Car rental', car_repair: 'Car repair', car_dealer: 'Car dealer',
    gas_station: 'Petrol station', electric_vehicle_charging_station: 'EV charging',
    airport: 'Airport', international_airport: 'Airport', train_station: 'Train station',
    light_rail_station: 'Metro station', subway_station: 'Metro station', bus_station: 'Bus station',
    bus_stop: 'Bus stop', transit_station: 'Transit stop', taxi_stand: 'Taxi rank',
    parking: 'Parking', ferry_terminal: 'Ferry terminal',
    // Errands a traveler actually runs
    bank: 'Bank', atm: 'ATM', post_office: 'Post office', hospital: 'Hospital',
    doctor: 'Clinic', dentist: 'Dentist', police: 'Police', embassy: 'Embassy',
    travel_agency: 'Travel agency', tourist_information_center: 'Tourist info',
    beauty_salon: 'Beauty salon', hair_salon: 'Hair salon', laundry: 'Laundry',
};

// Families Google names by suffix — catches the long tail (`greek_restaurant`,
// `sporting_goods_store`, `hamburger_restaurant`) without listing every member.
const TYPE_SUFFIXES = [
    [/_restaurant$/, 'Restaurant'], [/_museum$/, 'Museum'], [/_gallery$/, 'Gallery'],
    [/_(store|shop)$/, 'Shop'], [/_station$/, 'Transit stop'], [/_market$/, 'Market'],
    [/_hotel$/, 'Hotel'], [/_park$/, 'Park'], [/_temple$/, 'Temple'], [/_bar$/, 'Bar'],
];

/** Best label Google's own typing supports, or null when it says nothing useful. */
function labelForTypes(place) {
    const all = [place.primaryType, ...(Array.isArray(place.types) ? place.types : [])]
        .filter(Boolean).map(t => String(t).toLowerCase());
    for (const t of all) if (TYPE_LABELS[t]) return TYPE_LABELS[t];
    for (const t of all) for (const [re, label] of TYPE_SUFFIXES) if (re.test(t)) return label;
    return null;
}

// The words a card is allowed to wear. Derived from the tables above plus the
// kinds that have no Google type, so adding a label in one place adds it
// everywhere — a vocabulary, not a second list to keep in sync.
const CATEGORY_VOCABULARY = [...new Set([
    ...Object.values(TYPE_LABELS),
    ...TYPE_SUFFIXES.map(([, label]) => label),
    ...Object.values(CATEGORY_LABELS),
    'Place',
])].sort();
const _VOCAB_BY_LOWER = new Map(CATEGORY_VOCABULARY.map(v => [v.toLowerCase(), v]));

/** A proposed category → its canonical spelling, or null if it isn't one of ours.
 *  This is the brake: the model may name anything, and only a name in the
 *  vocabulary reaches a card. Nothing here rewrites a rejected answer — it is
 *  dropped, and the deterministic fallback takes the turn. */
function normalizeCategory(raw) {
    if (!raw || typeof raw !== 'string') return null;
    return _VOCAB_BY_LOWER.get(raw.trim().toLowerCase()) || null;
}

function categoryFor(place, action) {
    // A dated listing is an event whatever else it looks like — and 'Event' is
    // the exact string the frontend's isEventRec() matches on.
    if (place.eventSchedule) return 'Event';
    // The model's read of this specific place, having seen its name and its raw
    // types — it knows a "Rent House" is a rental agency and a caravanserai is
    // not an attraction. Only a vocabulary word gets through.
    const named = normalizeCategory(place._kind);
    if (named) return named;
    const typed = labelForTypes(place);
    if (typed) return typed;
    // The turn's category is a weaker signal than the place's own type: it
    // labelled every card in a "shopping" turn 'Shop', mobile operator or not.
    if (action && CATEGORY_LABELS[action]) return CATEGORY_LABELS[action];
    // Honest last resort. Calling an unknown row "Attraction" is a claim we
    // cannot support; "Place" says only what we know.
    return 'Place';
}

/** Factual one-liner card description — only facts the candidate carries. */
function factDescription(place, category) {
    // Events carry facts worth reading even when narration gives no blurb —
    // live 2026-08-23 five tomsarkgh cards all read just "Event" because the
    // model asked a clarifying question instead of emitting the card tail.
    const start = place.eventSchedule?.startDate;
    if (start) {
        const d = new Date(start);
        if (!Number.isNaN(d.getTime())) {
            const when = d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
            const timed = d.getUTCHours() || d.getUTCMinutes();
            const at = timed ? ` at ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : '';
            const venue = place.venueName || place.address || null;
            const price = place.price ? ` · ${place.price}` : '';
            return `${when}${at}${venue ? ` — ${venue}` : ''}${price}`;
        }
    }
    return [
        category,
        place.distanceKm != null ? `${place.distanceKm.toFixed(1)} km away` : null,
        place.rating ? `rated ${place.rating}` : null,
        place._openNow === true ? 'open now' : (place._openNow === false ? 'closed right now' : null),
    ].filter(Boolean).join(' · ');
}

/**
 * Candidate → v1 card payload. Field set mirrors v1's chat rec verbatim.
 * @param {object} place  retrieval candidate (canonicalStore shape)
 * @param {number} i      position (stable ids + originalPosition)
 * @param {object} opts   { action, nearbyMode }
 */
function toRecommendation(place, i, { action = 'general', nearbyMode = false, description = null } = {}) {
    const category = categoryFor(place, action);
    // Narrator blurb when provided (v1's hasAIDescription spirit); factual
    // one-liner as the fallback so a failed narration never blanks the card.
    const desc = description || factDescription(place, category);
    const cachedImageUrl = place.placeId ? `/api/ai/place-image/${place.placeId}/0` : null;
    return {
        id: `chat-rec-${Date.now()}-${i}`,
        name: place.name,
        category,
        type: category.toLowerCase().replace(' ', '_'),
        description: desc,
        region: place.city || place._town || 'Unknown',
        // Full street address when the candidate carries one (cache rows do);
        // city/country only as the fallback.
        location: (place.address
            ? (place._town && !String(place.address).toLowerCase().includes(String(place._town).toLowerCase())
                ? `${place.address}, ${place._town}` : place.address)
            : [place.city, place._town, place.country].filter(Boolean).join(', ')) || 'Location not specified',
        image: place.image || cachedImageUrl,
        cachedImageUrl,
        source: place.source === 'cache' ? 'cache' : 'database',
        verifiedId: place.verifiedId || null,
        isPartner: !!place.isPartner,
        partnerTier: place.tier || null,
        _verifiedModel: place.source === 'business' ? 'business'
                      : place.source === 'destination' ? 'destination' : null,
        placeId: place.placeId || null,
        // coords for the recommendation map
        latitude: place.geometry?.lat ?? null,
        longitude: place.geometry?.lng ?? null,
        website: place.website || null,
        phone: place.phone || null,
        isChatRecommendation: true,
        isLargeCard: true,
        appearsInline: true,
        isStreaming: false,
        ...(nearbyMode && place.distanceKm != null && { distance: `${place.distanceKm.toFixed(1)} km` }),
        // Present ⇒ the frontend's isEventRec() renders the date row on the
        // card (v1's exact contract). Event candidates carry it; places don't.
        eventSchedule: place.eventSchedule || null,
        // Ticket price EXACTLY as the listing printed it ("3000 AMD") — never
        // a guess, never converted. Read by the info modal; absent when the
        // page didn't say, which must keep looking absent.
        eventPrice: place.price || null,
        // The venue an event happens in. "More images" needs it: an event has
        // no photos of its own, and searching its title found strangers.
        venueName: place.venueName || null,
        // Source link shown below event cards (frontend rec.sourceUrl).
        sourceUrl: place.sourceUrl || null,
        _isExpired: false,
        _action: action || 'general',
        metadata: {
            hasAIDescription: true,
            sourceDescription: 'v2_grounded',
            originalName: place.name,
            originalDescription: desc,
            hasViewImagesText: true,
            usedPrefetchedData: place.source !== 'cache',
            originalPosition: i,
            detectedActionType: action || 'general',
        },
    };
}

/** The prose and the deck must AGREE: places the intro names by exact-ish name
 *  get hoisted to the front of the cards (stable order otherwise), blurbs
 *  riding along. Born from the live test where the narration starred DABOO and
 *  COBA while the cards led with an equestrian center. */
const { namesPlausiblyMatch } = require('../places/matching');
/* The narrator indexes its blurbs itself ({"i":N}) — and live 2026-09-04 it
 * numbered them in its PRAISE order, not the list order: Bamboo's card carried
 * Ginetun's blurb, Ginetun carried Bellagio's, Bellagio carried Bamboo's.
 * Each blurb names its subject, so the deterministic fix is to seat every
 * blurb that uniquely names ONE deck place on THAT card; the model's index is
 * only the fallback. Conservative: ambiguous or nameless blurbs never move. */
const _GENERIC_NAME_TOKENS = new Set(['restaurant', 'cafe', 'cafes', 'bar', 'hotel', 'museum', 'park',
    'tavern', 'grill', 'house', 'club', 'lounge', 'kitchen', 'garden', 'center', 'centre', 'place']);
function _distinctiveTokens(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 4 && !_GENERIC_NAME_TOKENS.has(t));
}
function realignBlurbs(places, blurbs = []) {
    const n = places?.length || 0;
    if (!n || !blurbs.some(Boolean)) return blurbs;
    const toks = places.map(p => _distinctiveTokens(p?.name));
    const out = new Array(n).fill(null);
    const claimed = new Set(), leftovers = [];
    for (let i = 0; i < Math.min(blurbs.length, n); i++) {
        const b = blurbs[i];
        if (!b) continue;
        const low = String(b).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        const hits = [];
        for (let j = 0; j < n; j++) if (toks[j].length && toks[j].some(t => low.includes(t))) hits.push(j);
        if (hits.length === 1 && !claimed.has(hits[0])) { out[hits[0]] = b; claimed.add(hits[0]); continue; }
        leftovers.push({ i, b });
    }
    // A blurb that named nothing (or something ambiguous) keeps its own seat
    // when free, else takes the first empty one — never dropped.
    for (const { i, b } of leftovers) {
        if (!out[i]) { out[i] = b; continue; }
        const free = out.findIndex(x => x === null);
        if (free !== -1) out[free] = b;
    }
    return out;
}

function hoistNarrated(intro, places, blurbs = []) {
    const text = String(intro || '');
    if (!text || !places?.length) return { places: places || [], blurbs };
    const paired = places.map((p, i) => ({ p, b: blurbs[i] ?? null, mentioned: false }));
    for (const item of paired) {
        // Cheap contains-check first, similarity guard second (word order,
        // native-script suffixes like "(Teryan) Պանդոկ Երևան" tolerated).
        const name = String(item.p.name || '');
        item.mentioned = !!name && (text.toLowerCase().includes(name.toLowerCase())
            || text.split(/[.!?\n]/).some(s => s.length > 6 && namesPlausiblyMatch(name, s) && s.toLowerCase().includes(name.split(' ')[0].toLowerCase())));
    }
    const ordered = [...paired.filter(x => x.mentioned), ...paired.filter(x => !x.mentioned)];
    return { places: ordered.map(x => x.p), blurbs: ordered.map(x => x.b) };
}

/** v1's complete-event shape: prose first, one part per card by index, and an
 *  optional trailing text part (v1's follow-up-question habit). */
function buildContentParts(prose, recCount, trailingText = null) {
    const parts = [{ type: 'text', content: prose }];
    for (let i = 0; i < recCount; i++) parts.push({ type: 'recommendation', index: i });
    if (trailingText) parts.push({ type: 'text', content: trailingText });
    return parts;
}

module.exports = { toRecommendation, buildContentParts, hoistNarrated, realignBlurbs, categoryFor, factDescription, CATEGORY_VOCABULARY, CATEGORY_LABELS, normalizeCategory };
