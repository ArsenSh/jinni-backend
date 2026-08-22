// Jinni V2 Engine — weather context (fail-open, cached, pure note builder).
//
// Copied from v1's getCurrentWeather (aiRoutes.js ~line 52, WITH its shape) per
// the copy-not-cut rule; v1 stays byte-identical. Open-Meteo is free and
// keyless. Differences from v1, both deliberate:
//   1. 10-minute in-memory cache per rounded coordinate — v1 fetches only on
//      needs_weather turns; v2 wants weather on EVERY grounded turn (the
//      ChatGPT-essay §15 "Jinni knows your situation" moment), so repeat turns
//      must cost zero latency and zero API calls.
//   2. Hard 2.5s timeout — weather may improve an answer, never delay it much
//      or fail it. null on any error; callers must treat null as "no note".

const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map();   // "lat,lng" (2dp ≈ 1km) → { at, data }

const WEATHER_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail',
};

async function getWeather(lat, lng, deps = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const nowFn = deps.nowFn || Date.now;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = _cache.get(key);
    if (hit && nowFn() - hit.at < CACHE_TTL_MS) return hit.data;
    try {
        const fetchImpl = deps.fetchImpl || fetch;
        const response = await fetchImpl(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
            + `&current=temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
            + `&wind_speed_unit=kmh&timezone=auto`,
            { signal: AbortSignal.timeout(2500) });
        const data = await response.json();
        const current = data.current;
        const result = {
            temperature: current.temperature_2m,
            humidity: current.relative_humidity_2m,
            rainProbability: current.precipitation_probability,
            condition: WEATHER_CODES[current.weather_code] || 'Unknown',
            windSpeed: current.wind_speed_10m,
        };
        _cache.set(key, { at: nowFn(), data: result });
        return result;
    } catch (err) {
        console.warn('[weather] fetch failed (fail-open):', err.message);
        return null;
    }
}

/** One short model-facing sentence: the facts, then ONE piece of advice the
 *  narrator can act on. Pure; '' when weather is unknown (no note beats a
 *  wrong note — same trust rule as opening hours). */
function weatherNote(w) {
    if (!w || !Number.isFinite(w.temperature)) return '';
    const t = Math.round(w.temperature);
    let advice = '';
    if (/rain|drizzle|thunder|snow/i.test(w.condition) || (w.rainProbability ?? 0) >= 60) {
        advice = 'favor indoor options';
    } else if (t >= 30) {
        advice = 'hot — favor shade and indoor comfort';
    } else if (t <= 0) {
        advice = 'freezing — favor indoor warmth';
    } else if (/clear|partly cloudy/i.test(w.condition) && t >= 15) {
        advice = 'great weather for outdoor spots';
    }
    return `weather ${w.condition}, ${t}°C${advice ? ` — ${advice}` : ''}`;
}

/** Test hook: clear the coordinate cache. */
function _resetWeatherCache() { _cache.clear(); }

module.exports = { getWeather, weatherNote, _resetWeatherCache };
