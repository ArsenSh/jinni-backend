const axios = require('axios');
const { Client } = require("@googlemaps/google-maps-services-js");
const logger = require('../utils/logger');
const GoogleApiStats = require('../models/GoogleAPIStats');

// Geocoding API (reverse geocode) is NOT deprecated — keep legacy client for this only
const geoClient = new Client({});

const RATE_LIMIT = 100;
let requestCount = 0;
let lastReset = Date.now();

// ─── STAT TRACKING ────────────────────────────────────────────────────────────
let globalApiStats = { findPlaces: 0, getPlaceDetails: 0, reverseGeocode: 0, imageDownload: 0, calculateDistances: 0, prefetchSearch: 0, resetTime: Date.now() };
const requestApiCalls = new Map();
const callStack = new Map();

function trackApiCall(apiName, requestId = null) {
    globalApiStats[apiName]++;
    const stack = new Error().stack;
    const caller = stack.split('\n')[3]?.trim() || 'unknown';
    const callKey = `${apiName}-${requestId || 'no-id'}`;
    if (!callStack.has(callKey)) { callStack.set(callKey, []) }
    callStack.get(callKey).push({ timestamp: new Date().toISOString(), caller });
    if (requestId) {
        if (!requestApiCalls.has(requestId)) {requestApiCalls.set(requestId, {findPlaces: 0, getPlaceDetails: 0, reverseGeocode: 0, imageDownload: 0, calculateDistances: 0, prefetchSearch: 0, callDetails: []})}
        requestApiCalls.get(requestId)[apiName]++;
        requestApiCalls.get(requestId).callDetails.push({ api: apiName, timestamp: Date.now(), caller });
    }
    GoogleApiStats.track(apiName).catch(err => console.error('GoogleApiStats.track error:', err));
}

function getDetailedRequestStats(requestId) { return requestApiCalls.get(requestId) || null }
function getRequestStats(requestId) { return requestApiCalls.get(requestId) || { findPlaces: 0, getPlaceDetails: 0, reverseGeocode: 0, calculateDistances: 0, prefetchSearch: 0 } }
function clearRequestStats(requestId) { requestApiCalls.delete(requestId) }

setInterval(() => {
    console.log('📊 Hourly API Stats:', globalApiStats);
    globalApiStats = { findPlaces: 0, getPlaceDetails: 0, reverseGeocode: 0, calculateDistances: 0, prefetchSearch: 0, resetTime: Date.now() };
}, 60 * 60 * 1000);

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
async function withRateLimit(fn) {
    const now = Date.now();
    if (now - lastReset > 60000) { requestCount = 0; lastReset = now; }
    if (requestCount >= RATE_LIMIT) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return withRateLimit(fn);
    }
    requestCount++;
    return fn();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const PLACES_BASE = 'https://places.googleapis.com/v1';

function placesHeaders(fieldMask) { return {'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_API_KEY, 'X-Goog-FieldMask': fieldMask} }

// Places API (New) returns location as { latitude, longitude } — normalise to { lat, lng }
function normaliseLocation(location) {
    if (!location) return { lat: null, lng: null };
    const lat = location.latitude ?? location.lat ?? null;
    const lng = location.longitude ?? location.lng ?? null;
    return {lat: lat !== null && !isNaN(lat) ? parseFloat(lat) : null, lng: lng !== null && !isNaN(lng) ? parseFloat(lng) : null};
}

// ─── REVERSE GEOCODE (Geocoding API — unchanged, not deprecated) ───────────────
async function detectUserRegion(userLocation, requestId = null) {
    if (!userLocation?.lat || !userLocation?.lng) {return { country: 'Unknown', region: null, city: null }}
    trackApiCall('reverseGeocode', requestId);
    try {
        const response = await geoClient.reverseGeocode({params: { latlng: `${userLocation.lat},${userLocation.lng}`, key: process.env.GOOGLE_API_KEY }});
        const results = response.data.results;
        let country = null, region = null, city = null;
        for (const result of results) {
            for (const component of result.address_components) {
                if (component.types.includes('country')) country = component.long_name;
                if (component.types.includes('administrative_area_level_1')) region = component.long_name;
                if (component.types.includes('locality') || component.types.includes('administrative_area_level_2')) city = component.long_name;
            }
            if (country && region) break;
        }
        logger.info(`User location: ${city || 'Unknown'}, ${region || 'Unknown'}, ${country || 'Unknown'}`);
        return { country: country || 'Armenia', region, city, formatted: `${city ? city + ', ' : ''}${region ? region + ', ' : ''}${country}` };
    } catch (error) {
        logger.error('Error detecting user region:', error);
        return { country: 'Unknown', region: null, city: null };
    }
}

// ─── FIND PLACES — Text Search (New) ─────────────────────────────────────────
// Replaces: findPlaceFromText (legacy)
// Free quota: 10,000 requests/month
async function findPlaces(query, userLocation, requestId, options = {}) {
    return withRateLimit(async () => {
        trackApiCall('findPlaces', requestId);
        console.log('[findPlaces] query="' + query + '" loc=' + (userLocation ? userLocation.lat + ',' + userLocation.lng : 'none'));
        const body = {textQuery: query, languageCode: 'en', maxResultCount: 5};
        if (userLocation && userLocation.lat && userLocation.lng) {body.locationBias = {circle: {center: { latitude: userLocation.lat, longitude: userLocation.lng }, radius: 50000.0}}}
        else {body.locationBias = {circle: {center: { latitude: 40.1772, longitude: 44.50349 }, radius: 50000.0,}}}
        // Optional type BIAS (non-strict): nudges Google to resolve an
        // ambiguous name (e.g. "Nairi") to a place of the expected kind
        // (a restaurant, not the cinema). Non-strict so a legit restaurant
        // primarily typed 'bar'/'cafe' isn't excluded here; the caller still
        // verifies the resolved place's real types (placeMatchesActionType).
        if (options.includedType) { body.includedType = options.includedType; }
        console.log('[findPlaces] POSTing to ' + PLACES_BASE + '/places:searchText body=' + JSON.stringify(body));
        // A single 5s timeout used to drop a REAL place outright — e.g. "Amira
        // Palace" lost to one slow round-trip, never reaching the cache. Retry only
        // TRANSIENT failures (no HTTP response = timeout/network, or a 5xx) once,
        // with a longer deadline + small backoff. We do NOT retry a 4xx (bad query —
        // won't change) or an empty-but-OK result (place genuinely not found), so
        // this recovers slow/flaky responses without masking a true miss.
        const MAX_ATTEMPTS = 2;
        const TIMEOUTS = [6000, 9000];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const response = await axios.post(PLACES_BASE + '/places:searchText', body, { headers: placesHeaders('places.id,places.displayName,places.location,places.types,places.primaryType'), timeout: TIMEOUTS[attempt - 1] });
                console.log('[findPlaces] response status=' + response.status + ' places=' + (response.data.places || []).length + (attempt > 1 ? ' (attempt ' + attempt + ')' : ''));
                const places = response.data.places || [];
                return places.map(function(place) {
                    const coords = normaliseLocation(place.location);
                    // `name` (from displayName) lets callers verify the resolved place
                    // actually resembles what was asked for — Google's Text Search
                    // returns its CLOSEST match no matter how far off it is (a query
                    // "Amara" biased to the wrong city once resolved to a shooting
                    // range). Requesting displayName does not change the billing SKU:
                    // location/types already put this call in the Pro tier.
                    return { place_id: place.id, name: place.displayName?.text || null, geometry: { location: coords }, types: place.types || [], primaryType: place.primaryType || null };
                });
            } catch (error) {
                const httpStatus = error.response ? error.response.status : null;
                const status = error.response ? httpStatus : 'no-response';
                const data = error.response ? JSON.stringify(error.response.data) : error.message;
                const transient = (httpStatus === null) || (httpStatus >= 500 && httpStatus < 600);
                const willRetry = transient && attempt < MAX_ATTEMPTS;
                console.error('[findPlaces] FAILED query="' + query + '" status=' + status + ' error=' + data + (willRetry ? ' — retrying' : (attempt > 1 ? ' (gave up after ' + attempt + ' attempts)' : '')));
                if (!willRetry) return [];
                await new Promise(r => setTimeout(r, 400 * attempt));
            }
        }
        return [];
    });
}

// ─── PREFETCH SEARCH — Text Search (New), multi-result ───────────────────────
// Like findPlaces, but tuned for the quick-action prefetch: returns up to
// `maxResults` real candidates (id + name + coords + types + rating) in ONE
// call, so the model can rank/filter real places instead of inventing names.
// Filters out permanently-closed places. Quota note: Text Search is the pricier
// Places SKU — callers MUST cache the result set (see googlePrefetchService).
async function searchPlacesText(query, userLocation, radiusKm = 50, maxResults = 12, requestId = null) {
    return withRateLimit(async () => {
        trackApiCall('prefetchSearch', requestId);
        try {
            const center = (userLocation && userLocation.lat && userLocation.lng)
                ? { latitude: userLocation.lat, longitude: userLocation.lng }
                : { latitude: 40.1772, longitude: 44.50349 };
            const radiusM = Math.min(Math.max((radiusKm || 50) * 1000, 1000), 50000);
            const body = {
                textQuery: query,
                languageCode: 'en',
                maxResultCount: Math.min(Math.max(maxResults, 1), 20),
                locationBias: { circle: { center, radius: radiusM } },
            };
            const fieldMask = 'places.id,places.displayName,places.location,places.types,places.rating,places.businessStatus';
            console.log('[searchPlacesText] query="' + query + '" radius=' + radiusM + 'm max=' + body.maxResultCount);
            const response = await axios.post(PLACES_BASE + '/places:searchText', body, { headers: placesHeaders(fieldMask), timeout: 6000 });
            const places = response.data.places || [];
            return places
                .filter(function(p) { return p.businessStatus ? p.businessStatus === 'OPERATIONAL' : true; })
                .map(function(p) {
                    const coords = normaliseLocation(p.location);
                    return {
                        placeId: p.id,
                        name: p.displayName ? p.displayName.text : null,
                        lat: coords.lat,
                        lng: coords.lng,
                        types: p.types || [],
                        rating: p.rating || null,
                    };
                })
                .filter(function(p) { return p.placeId && p.name; });
        } catch (error) {
            const status = error.response ? error.response.status : 'no-response';
            const data = error.response ? JSON.stringify(error.response.data) : error.message;
            console.error('[searchPlacesText] FAILED query="' + query + '" status=' + status + ' error=' + data);
            return [];
        }
    });
}

// ─── GET PLACE DETAILS — Place Details (New) ─────────────────────────────────
// Replaces: placeDetails (legacy)
// Free quota: 5,000 requests/month (Pro tier)
async function getPlaceDetails(placeId, detailedInfo, requestId) {
    return withRateLimit(async () => {
        trackApiCall('getPlaceDetails', requestId);
        try {
            const fieldMask = [
                'id', 'displayName', 'formattedAddress', 'location',
                'rating', 'websiteUri', 'internationalPhoneNumber',
                'regularOpeningHours', 'nationalPhoneNumber', 'photos',
                'types', 'primaryType', 'priceLevel',
            ].join(',');
            const response = await axios.get(PLACES_BASE + '/places/' + placeId, { headers: placesHeaders(fieldMask), timeout: 10000 });
            const result = response.data;
            if (!result) {
                console.error('No result for place_id: ' + placeId);
                return null;
            }
            const coords = normaliseLocation(result.location);
            if (!coords.lat || !coords.lng) {
                console.error('Invalid coordinates for place_id: ' + placeId);
                return null;
            }
            return {
                place_id: result.id,
                name: result.displayName ? result.displayName.text : null,
                formatted_address: result.formattedAddress || null,
                geometry: { location: coords },
                rating: result.rating || null,
                website: result.websiteUri || null,
                international_phone_number: result.internationalPhoneNumber || null,
                formatted_phone_number: result.nationalPhoneNumber || null,
                opening_hours: result.regularOpeningHours ? {open_now: result.regularOpeningHours.openNow != null ? result.regularOpeningHours.openNow : null, weekday_text: result.regularOpeningHours.weekdayDescriptions || [],} : null,
                photos: result.photos || [],
                types: result.types || [],
                primaryType: result.primaryType || null,
                // Google price bucket (PRICE_LEVEL_INEXPENSIVE…VERY_EXPENSIVE). Well
                // populated for restaurants/food; usually absent for lodging &
                // attractions — the priceTier helper falls back to lodging `types`
                // there. Null when Google omits it.
                price_level: result.priceLevel || null,
            };
        } catch (error) {
            const status = error.response ? error.response.status : 'no-response';
            const data = error.response ? JSON.stringify(error.response.data) : error.message;
            console.error('[getPlaceDetails] FAILED placeId=' + placeId + ' status=' + status + ' error=' + data);
            return null;
        }
    });
}

// ─── CALCULATE DISTANCES (straight-line — no API call) ────────────────────────
async function calculateDistances(origin, destinations, requestId) {
    return withRateLimit(async () => {
        try {
            if (requestId) trackApiCall('calculateDistances', requestId);
            const valid = destinations.filter(function(d) { return d.lat && d.lng && !isNaN(d.lat) && !isNaN(d.lng); });
            if (!valid.length) { logger.warn('No valid destinations for distance calculation'); return []; }
            return valid.map(function(dest) {
                const R = 6371;
                const dLat = (dest.lat - origin.lat) * Math.PI / 180;
                const dLng = (dest.lng - origin.lng) * Math.PI / 180;
                const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(origin.lat * Math.PI/180) * Math.cos(dest.lat * Math.PI/180) * Math.sin(dLng/2) * Math.sin(dLng/2);
                const distanceKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
                const estimatedMinutes = Math.round((distanceKm / 25) * 60);
                let durationText;
                if (estimatedMinutes < 1) durationText = '< 1 min';
                else if (estimatedMinutes < 60) durationText = estimatedMinutes + ' mins';
                else {
                    const h = Math.floor(estimatedMinutes / 60);
                    const m = estimatedMinutes % 60;
                    durationText = m > 0 ? h + 'h ' + m + 'm' : h + 'h';
                }
                const distanceText = distanceKm < 0.1 ? '< 0.1 km' : distanceKm < 1 ? (Math.round(distanceKm * 100) / 100) + ' km' : distanceKm + ' km';
                return {destination: dest, distance: { text: distanceText, value: Math.round(distanceKm * 1000), km: distanceKm }, duration: { text: durationText, value: estimatedMinutes * 60 }, status: 'OK'};
            });
        } catch (error) {
            logger.error('Distance calculation error: ' + error.message);
            throw error;
        }
    });
}

// ─── PLACE PHOTO URL — Place Photo (New) ──────────────────────────────────────
function getPlacePhoto(photoRef, maxWidth) {
    if (!maxWidth) maxWidth = 400;
    if (!photoRef) return null;
    // New API: photo ref is an object with .name, or a string like "places/abc/photos/xyz"
    if (typeof photoRef === 'object' && photoRef.name) {return PLACES_BASE + '/' + photoRef.name + '/media?maxWidthPx=' + maxWidth + '&key=' + process.env.GOOGLE_API_KEY + '&skipHttpRedirect=false'}
    if (typeof photoRef === 'string' && photoRef.startsWith('places/')) {return PLACES_BASE + '/' + photoRef + '/media?maxWidthPx=' + maxWidth + '&key=' + process.env.GOOGLE_API_KEY + '&skipHttpRedirect=false'}
    // Fallback: legacy photo reference string
    return 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=' + maxWidth + '&photoreference=' + photoRef + '&key=' + process.env.GOOGLE_API_KEY;
}

// ─── ACTION ↔ GOOGLE TYPE MATCHING ────────────────────────────────────────────
// The AI proposes names; Google resolves each to its top match regardless of
// kind, so a "restaurants" search can surface a brandy house, a garden, or a
// hotel. These helpers gate a resolved place by its REAL Google types so only
// places that actually match the pressed action are shown.
//
// Google emits many cuisine-specific restaurant types (italian_restaurant,
// armenian_restaurant, …), so for food we match any type ending in
// 'restaurant' plus a base set, rather than enumerating them all.

// Single type used to BIAS findPlaces resolution (non-strict). null = no bias.
function actionIncludedType(action, subType = null) {
    if (action === 'restaurants') return 'restaurant';
    if (action === 'hotels')      return 'lodging';
    if (action === 'shopping') {
        const map = { jewelry: 'jewelry_store', mall: 'shopping_mall', clothing: 'clothing_store', market: 'market', souvenirs: 'gift_shop', food: 'store' };
        return map[subType] || null;
    }
    return null; // historical / hidden_gems / photo_spots / events: too varied to bias
}

const _RESTAURANT_BASE = ['restaurant', 'cafe', 'bar', 'bakery', 'food', 'meal_takeaway', 'meal_delivery', 'food_court', 'pub', 'wine_bar', 'coffee_shop', 'fine_dining_restaurant'];
// Primary types whose core identity is NOT dining. A place like the Noy brandy
// factory (a tourist attraction with a tasting/banquet hall) is tagged with a
// food type *secondarily*, so an "any food type matches" rule wrongly keeps it.
// If a place's PRIMARY type is one of these, it is not a restaurant even when a
// food type is present. Deliberately excludes art_gallery (e.g. "Dalan Art
// Gallery and Restaurant" is a real restaurant) and bar/pub/brewery/winery
// (e.g. Dargett Brewpub) so genuine dining venues are never dropped.
const _NONDINING_PRIMARY = new Set([
    'tourist_attraction', 'historical_landmark', 'historical_place', 'cultural_landmark', 'monument',
    'museum', 'park', 'national_park', 'state_park', 'amusement_park', 'zoo', 'aquarium', 'botanical_garden',
    'place_of_worship', 'church', 'mosque', 'synagogue', 'hindu_temple',
    'lodging', 'hotel', 'resort_hotel', 'motel', 'guest_house', 'bed_and_breakfast', 'hostel', 'campground', 'rv_park', 'cottage',
    'shopping_mall', 'department_store', 'supermarket', 'grocery_store', 'convenience_store', 'store',
    'stadium', 'arena', 'gym', 'fitness_center', 'sports_complex', 'spa',
    'school', 'university', 'hospital', 'pharmacy', 'bank', 'airport', 'train_station', 'bus_station', 'parking', 'gas_station',
    'distillery', 'factory',
]);
const _HOTEL_BASE = ['lodging', 'hotel', 'resort_hotel', 'motel', 'guest_house', 'bed_and_breakfast', 'inn', 'hostel', 'extended_stay_hotel', 'cottage', 'campground'];
// Primary types whose core identity is NOT lodging. Mirrors the restaurant
// denylist: a venue tagged 'hotel' secondarily (a hotel's in-house restaurant,
// or a landmark with rooms) shouldn't surface under "hotels" when its primary
// identity is something else. Excludes every lodging type so real hotels,
// resorts, guesthouses, hostels, etc. are never dropped.
const _NONLODGING_PRIMARY = new Set([
    'tourist_attraction', 'historical_landmark', 'historical_place', 'cultural_landmark', 'monument',
    'museum', 'park', 'national_park', 'state_park', 'amusement_park', 'zoo', 'aquarium', 'botanical_garden',
    'place_of_worship', 'church', 'mosque', 'synagogue', 'hindu_temple',
    'shopping_mall', 'department_store', 'supermarket', 'grocery_store', 'convenience_store', 'store',
    'stadium', 'arena', 'gym', 'fitness_center', 'sports_complex',
    'school', 'university', 'hospital', 'pharmacy', 'bank', 'airport', 'train_station', 'bus_station', 'parking', 'gas_station',
    'distillery', 'factory', 'night_club',
    // dining primaries (restaurant subtypes handled via endsWith('restaurant'))
    'cafe', 'bar', 'bakery', 'food_court', 'pub', 'wine_bar', 'coffee_shop', 'meal_takeaway', 'meal_delivery',
]);
// Landmark actions (historical / hidden_gems / photo_spots) have no single
// Google "type" to match on — a fortress, museum, monument, church, gallery and
// park all carry different primaryTypes — so an inclusion list would wrongly drop
// real sites. Instead we EXCLUDE the clearly-non-landmark venues: dining,
// lodging, retail, nightlife, and generic services. Everything else (including
// places we can't classify) is kept. This is what stops "Tavern Yerevan" or
// "Ararat Hotel" from showing under Historical.
const _LANDMARK_ACTIONS = new Set(['historical', 'hidden_gems', 'photo_spots']);
const _NONLANDMARK_PRIMARY = new Set([
    // dining (restaurant subtypes handled via endsWith('restaurant'))
    'cafe', 'bar', 'bakery', 'food_court', 'pub', 'wine_bar', 'coffee_shop', 'meal_takeaway', 'meal_delivery',
    'fast_food_restaurant', 'ice_cream_shop', 'dessert_shop', 'food',
    // nightlife
    'night_club',
    // lodging
    'lodging', 'hotel', 'resort_hotel', 'motel', 'guest_house', 'bed_and_breakfast', 'inn', 'hostel', 'extended_stay_hotel', 'campground', 'rv_park', 'cottage',
    // retail
    'store', 'shopping_mall', 'department_store', 'supermarket', 'grocery_store', 'convenience_store',
    'clothing_store', 'shoe_store', 'jewelry_store', 'electronics_store', 'hardware_store', 'furniture_store',
    'book_store', 'liquor_store', 'pet_store', 'home_goods_store',
    // services / civic / transit
    'bank', 'atm', 'pharmacy', 'gas_station', 'car_repair', 'car_dealer', 'car_rental',
    'gym', 'fitness_center', 'spa', 'beauty_salon', 'hair_salon', 'nail_salon',
    'hospital', 'doctor', 'dentist', 'school', 'university', 'parking', 'lawyer',
    'airport', 'train_station', 'bus_station', 'transit_station', 'subway_station',
    'real_estate_agency', 'insurance_agency', 'post_office', 'corporate_office',
]);
// Types that affirmatively mark a place AS a landmark — consulted ONLY when a
// place has no primaryType, so a place tagged 'restaurant','point_of_interest'
// is dropped while a 'museum','point_of_interest' (no primaryType) is kept.
const _LANDMARK_ALLOW = new Set([
    'tourist_attraction', 'historical_landmark', 'historical_place', 'cultural_landmark', 'monument',
    'museum', 'art_gallery', 'park', 'national_park', 'state_park', 'botanical_garden', 'garden',
    'place_of_worship', 'church', 'mosque', 'synagogue', 'hindu_temple',
    'plaza', 'town_square', 'observation_deck', 'archaeological_site', 'castle', 'fort',
    'natural_feature',
]);
const _SHOPPING_BASE = {
    jewelry:   ['jewelry_store'],
    mall:      ['shopping_mall', 'department_store'],
    clothing:  ['clothing_store', 'shoe_store', 'boutique'],
    market:    ['market', 'supermarket', 'grocery_store', 'food_store'],
    souvenirs: ['gift_shop', 'store', 'souvenir_store'],
    food:      ['store', 'grocery_store', 'food_store', 'market', 'liquor_store', 'candy_store'],
};

/**
 * True if a resolved place's types match the action.
 * Returns true (lenient) when the action has no defined type set (hidden_gems,
 * photo_spots, historical, events) or when no type info is available — so we
 * never wrongly drop a place we can't classify.
 */
function placeMatchesActionType(action, subType, types = [], primaryType = null) {
    const all = [primaryType, ...(Array.isArray(types) ? types : [])].filter(Boolean).map(t => String(t).toLowerCase());
    if (!all.length) return true; // unknown → don't drop (lenient, self-heals on re-fetch)

    if (action === 'restaurants') {
        // Reject when the PRIMARY identity is non-dining (factory, landmark,
        // hotel, store) even if a food type appears as a secondary tag.
        const pt = (primaryType ? String(primaryType).toLowerCase() : '');
        if (pt && _NONDINING_PRIMARY.has(pt)) return false;
        return all.some(t => t.endsWith('restaurant') || _RESTAURANT_BASE.includes(t));
    }
    if (action === 'hotels') {
        // Reject when the PRIMARY identity is non-lodging (a restaurant, a
        // landmark, a store) even if a 'hotel'/'lodging' tag appears secondarily.
        const pt = (primaryType ? String(primaryType).toLowerCase() : '');
        if (pt && (pt.endsWith('restaurant') || _NONLODGING_PRIMARY.has(pt))) return false;
        return all.some(t => t.includes('hotel') || _HOTEL_BASE.includes(t));
    }
    if (action === 'shopping') {
        const allowed = _SHOPPING_BASE[subType];
        if (!allowed) return true; // unknown sub-type → lenient
        return all.some(t => allowed.includes(t));
    }
    if (_LANDMARK_ACTIONS.has(action)) {
        // Exclusion gate (no inclusion list — see _LANDMARK_ACTIONS note above).
        const pt = (primaryType ? String(primaryType).toLowerCase() : '');
        if (pt) {
            // Known primary identity → drop the obvious non-landmark venues.
            if (pt.endsWith('restaurant') || _NONLANDMARK_PRIMARY.has(pt)) return false;
            return true;
        }
        // No primaryType → drop only when a non-landmark type is present AND no
        // recognised landmark type is; otherwise keep (lenient, self-heals).
        const hasNonLandmark = all.some(t => t.endsWith('restaurant') || _NONLANDMARK_PRIMARY.has(t));
        const hasLandmark = all.some(t => _LANDMARK_ALLOW.has(t) || t.endsWith('attraction'));
        if (hasNonLandmark && !hasLandmark) return false;
        return true;
    }
    return true; // no defined gate for this action
}

// True when an action has ANY type filter — an inclusion gate (restaurants /
// hotels / shopping) OR the landmark exclusion gate (historical / hidden_gems /
// photo_spots). Used by the live filter to decide whether to run
// placeMatchesActionType. (The cache backfill does NOT use this — it gates on the
// recorded `actions` category a place was shown under, not on type heuristics.)
function actionHasTypeFilter(action, subType = null) {
    return !!actionIncludedType(action, subType) || _LANDMARK_ACTIONS.has(action);
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
    trackApiCall,
    getRequestStats,
    clearRequestStats,
    getDetailedRequestStats,
    detectUserRegion,
    findPlaces,
    searchPlacesText,
    getPlaceDetails,
    placeMatchesActionType,
    actionIncludedType,
    actionHasTypeFilter,
    calculateDistances,
    getPlacePhoto,
    getGlobalStats: function() {return Object.assign({}, globalApiStats, { timeSinceReset: ((Date.now() - globalApiStats.resetTime) / 1000).toFixed(1) + 's' })}
};