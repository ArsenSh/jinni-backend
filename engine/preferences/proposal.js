// Jinni V2 Engine — changing a saved preference, by asking first.
//
// Arsen 2026-08-24: "if i ask something different preference let it change user
// preferences from settings … it can stop and notify then ask to change, if
// user says yes then changes."
//
// The shape follows the same split as everything else. NOTICING that an ask
// contradicts a saved setting is a judgement, and the model makes it — it has
// the message and the preference rows in front of it. DECIDING to overwrite
// what a person set is not a judgement at all, and the model never gets it:
//
//   1. The model may only PROPOSE, in a fixed field, one change at a time.
//   2. Code checks the proposal against the vocabulary. Anything else is
//      dropped, never repaired — a preference is the traveler's own word, and
//      guessing what they meant is how you end up rewriting it wrongly.
//   3. An INFERRED change is written only after an explicit yes on the next
//      turn. Silence, a new question, or an unclear reply all mean NO, because
//      the safe default when consent is ambiguous is to leave a person's
//      settings alone.
//
// One ask, one answer, then the proposal is gone. Jinni does not nag.
//
// But a change the traveler ASKED FOR is different, and treating it the same
// was wrong: "can you set to current location, gps one?" got "I can't set that
// for you" (live 2026-08-24). Arsen: "it should simply set and save, same
// things user can do from onboarding page." An instruction IS the consent —
// asking "shall I?" after someone said "set it" is friction, not care. So a
// proposal carries `explicit`: the model judges whether it was ASKED or merely
// implied, code still validates every field, and only an asked-for change is
// written on the spot.

// The vocabularies the app's own Preferences screen offers. Staying inside them
// means chat can never produce a setting the UI cannot show or the traveler
// cannot undo.
const PREF_VOCAB = {
    travelStyle: ['luxury', 'budget'],
    interests: ['family', 'romantic', 'nature', 'adventure', 'cultural',
        'history', 'art', 'food_drink', 'nightlife', 'relaxation'],
    currency: ['AED', 'USD', 'RUB', 'EUR', 'GBP', 'AMD'],
    // The Discovery/Nearby toggle. Stored as a boolean, but the model proposes
    // the WORD — a boolean has no meaning to read back to the traveler, and
    // "searchMode: true" is exactly the kind of value that gets inverted by
    // accident. Code does the conversion, once, here.
    searchMode: ['nearby', 'discovery'],
};


// Search radii, in km — BOUNDS ONLY, no path: nothing here writes them any more
// (see READ_ONLY below). The numbers are the User schema's own, so the one place
// that reads a saved radius can clamp against the same limits the Preferences
// slider enforces, instead of typing 1/20/10/100 a second time somewhere else.
const RADIUS_LIMITS = {
    nearby: { min: 1, max: 20, dflt: 5 },
    discovery: { min: 10, max: 100, dflt: 50 },
};

/** A saved radius → a number the search can trust. Junk, missing or out-of-range
 *  rows fall back to the schema default rather than turning a 5 km walk into a
 *  country-wide sweep. `mode` is 'nearby' | 'discovery'. */
function radiusKmFor(mode, searchRadius = {}) {
    const { min, max, dflt } = RADIUS_LIMITS[mode] || RADIUS_LIMITS.discovery;
    const n = Number((searchRadius || {})[mode]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// The budget cap is a SANITY bound — "is this number insane for a daily
// budget" — not a conversion, so a static order-of-magnitude scale per
// currency is correct and keeps this module pure (no live-rate dependency).
// Flat 100000 refused 200,000 AMD (≈$550/day, entirely sane) while the
// Preferences form accepted it (live 2026-08-30); RUB had the same latent
// trap. Roughly ≈$100k/day equivalent everywhere.
const MAX_BUDGET_USD = 100000;
const _BUDGET_CAP_SCALE = { USD: 1, EUR: 1, GBP: 1, AED: 4, RUB: 100, AMD: 500 };
const maxBudgetFor = (currency) => MAX_BUDGET_USD * (_BUDGET_CAP_SCALE[currency] || 1);

// ── ONE REGISTRY ─────────────────────────────────────────────────────────────
//
// What Jinni may change used to be written down four separate times: a vocab
// map, a paths map, a chain of if-blocks in validateProposal, and an English
// sentence in the prompt reading "exactly these five". Four copies of one fact
// drift, and every drift found this month was that same shape — the prompt went
// on offering `location` after code stopped writing it, and it advertised a
// radius the search never read.
//
// So the fact is stated ONCE, here, and everything else is derived: the
// validator dispatches on it, the writer takes its path from it, the prompt
// sentence is generated from `says`, and a refusal line comes from READ_ONLY.
// Removing a setting is now a single deletion that cannot leave a stale promise
// behind, because there is no second place for one to hide.
//
// `parse` returns {value, label} or null — the whole rule for that field.
// `store` (optional) converts the validated value on its way into Mongo.
const SETTINGS = {
    travelStyle: {
        path: 'preferences.travelStyle',
        says: 'travel style (luxury or budget)',
        parse: (raw) => {
            const v = String(raw ?? '').trim().toLowerCase();
            if (!PREF_VOCAB.travelStyle.includes(v)) return null;
            return { value: v, label: `travel style to ${v}` };
        },
    },
    interests: {
        path: 'preferences.interests',
        says: 'interests',
        parse: (raw) => {
            const list = (Array.isArray(raw) ? raw : [raw])
                .map(v => String(v ?? '').trim().toLowerCase().replace(/[\s&]+/g, '_'))
                .filter(v => PREF_VOCAB.interests.includes(v));
            const unique = [...new Set(list)];
            if (!unique.length) return null;
            return { value: unique, label: `interests to ${unique.join(', ')}` };
        },
    },
    budget: {
        path: 'preferences.budget',
        says: 'budget',
        parse: (raw) => {
            const v = raw || {};
            const min = Number(v.min);
            const max = Number(v.max);
            const currency = String(v.currency || 'USD').trim().toUpperCase();
            // max === min is REFUSED, not stored. "from 10 to 10" is not a range,
            // and saving it looked like agreement while quietly gating retrieval
            // to a single price point (Arsen 2026-08-25: "it will set like that
            // instead of notifing you are giving incorrect"). Onboarding's own
            // isBudgetValid is looser (min <= max), so a band entered on the FORM
            // may still be flat; chat refuses and says why.
            if (!PREF_VOCAB.currency.includes(currency)) return null;
            if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
            if (min < 0 || max <= 0 || max <= min || max > maxBudgetFor(currency)) return null;
            return { value: { min, max, currency }, label: `budget to ${min}–${max} ${currency}` };
        },
    },
    searchMode: {
        path: 'settings.nearbyMode',
        says: 'the search MODE (nearby or discovery)',
        // Kept as the WORD all the way through validation, because a proposal is
        // re-validated on its way out of the database and a boolean would not
        // survive that round trip. This is the one conversion.
        store: (v) => v === 'nearby',
        parse: (raw) => {
            const v = String(raw ?? '').trim().toLowerCase();
            if (!PREF_VOCAB.searchMode.includes(v)) return null;
            return { value: v, label: `search mode to ${v}` };
        },
    },
};

// Settings Jinni may READ and talk about but never write. Being in this table is
// what makes a refusal actionable: the traveler is told where to do it himself
// instead of getting a bare field name.
//
// `location` came out on 2026-08-26 — one edit there moves the search centre,
// the GPS/destination mode and every surface that reads them (Arsen: "it can say
// open preferences and change … but not do by himself").
//
// The two radii joined it the same day (Arsen: "for radius it can say user to do
// from settings manually"). They had been writable, and the value went nowhere
// anyway — v2's search hardcoded 5/50 km and never read it — so the honest
// options were to wire it up or stop pretending. The READ still works: a radius
// the traveler sets in Preferences now reaches the query.
// `screen` is PER SETTING, because they genuinely live on different ones and a
// refusal naming the wrong screen sends the traveler hunting (Arsen 2026-08-26:
// "radius change is from settings, not preferences"). The radius sliders are in
// the chat Settings modal (JinniChat.vue ~1282-1299); the saved location is on
// the Preferences screen, which carries no radius control at all.
const READ_ONLY = {
    location: { says: 'their saved location', screen: 'Preferences' },
    nearbyRadius: { says: 'the nearby search radius', screen: 'Settings' },
    discoveryRadius: { says: 'the discovery search radius', screen: 'Settings' },
};

// Every screen a READ_ONLY setting points at. The chat frontend turns these
// exact words into tappable buttons, so they are a contract, not prose.
const SELF_SERVE_SCREENS = [...new Set(Object.values(READ_ONLY).map(r => r.screen))];

const PREF_PATHS = Object.fromEntries(
    Object.entries(SETTINGS).map(([field, s]) => [field, s.path])
);

const _list = (names) => names.length > 1
    ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
    : (names[0] || '');

/** The prompt's "what you can change" sentence, generated from the registry so
 *  it can never advertise a field the validator would refuse. */
function settableSentence() { return _list(Object.values(SETTINGS).map(s => s.says)); }

/** The prompt's "what you cannot change" sentence, same trick. */
function readOnlySentence() {
    // Each one names ITS OWN screen, so the sentence stays true even though the
    // radius and the saved location live in different places.
    return _list(Object.values(READ_ONLY).map(r => `${r.says} (${r.screen})`));
}

/**
 * A model's proposal → something safe to store and show, or null.
 * @param {object} raw the model's proposal
 * @param {{currentPlace?: {city, country, countryCode, lat, lng}}} ctx facts the
 *   model is not allowed to supply — where the traveler actually is
 * @returns {{field, value, label, explicit}|null} `label` is how the change is
 *   described to the traveler, so the sentence they see is the change we make.
 *   `explicit` true means they ASKED for it, so it needs no further consent.
 */
function validateProposal(raw, ctx = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const field = String(raw.field || '').trim();

    // One dispatch. A field that is not in the registry is not ours to touch —
    // which is the same sentence the prompt is generated from, so the two can
    // no longer disagree about what Jinni can do.
    // hasOwn, not a bare lookup: SETTINGS['constructor'] resolves to a function
    // off Object.prototype, and `if (!entry)` waves it straight through — a
    // proposal for a field nobody defined would reach entry.parse and throw
    // inside the turn. The registry answers only for keys it actually owns.
    const entry = Object.hasOwn(SETTINGS, field) ? SETTINGS[field] : null;
    if (!entry) return null;
    const parsed = entry.parse(raw.value);
    return parsed ? { field, value: parsed.value, label: parsed.label } : null;
}

// Consent must be UNAMBIGUOUS, and it is an ANSWER — not a sentence that
// happens to begin with "ok". Both ends are anchored, so "okay so what about
// hotels" is a new question, not permission to rewrite a setting. Word
// boundaries are avoided entirely: \b is ASCII-only in JS, so it silently
// failed after "այո", "ոչ" and "好的".
const _clean = (m) => String(m || '').toLowerCase().normalize('NFC')
    .replace(/[!.,;:¡¿?"'’`]+/g, ' ').replace(/\s+/g, ' ').trim();

const POLITE = '( please| thanks| thank you)?';
const YES_RE = new RegExp('^(yes|yep|yeah|ok|okay|sure|confirm|do it|go ahead|please do|change it|update it|save it'
    + '|да|ага|давай|конечно|обнови|измени|այո|լավ|oui|d accord|نعم|是|好的|好)' + POLITE + '$');
const NO_RE = new RegExp('^(no|nope|nah|don t|do not|leave it|keep it|cancel|never mind|nevermind|no thanks'
    + '|нет|не надо|оставь|ոչ|non|لا|不|不要)' + POLITE + '$');

/** A clear yes and nothing else. Anything longer or vaguer is not consent. */
function isAffirmative(message) {
    const t = _clean(message);
    if (!t || NO_RE.test(t)) return false;         // a "no" is never a yes
    return YES_RE.test(t);
}

function isNegative(message) {
    return NO_RE.test(_clean(message));
}

/**
 * Write the approved change. Touches ONLY the proposed field — a preferences
 * document is not ours to rewrite wholesale, and a single-path update cannot
 * lose a setting the traveler made somewhere else.
 * @returns {Promise<boolean>} whether anything was actually stored.
 */
async function applyProposal(userId, proposal, deps = {}) {
    const valid = validateProposal(proposal);
    if (!userId || !valid) return false;
    const User = deps.User || require('../../models/User');
    try {
        let $set;
        {
            const entry = SETTINGS[valid.field];
            if (!entry || !Object.hasOwn(SETTINGS, valid.field)) return false;   // a field with no home is not writable
            $set = { [entry.path]: entry.store ? entry.store(valid.value) : valid.value };
            // Budget figures are not a standalone setting — they belong to the
            // budget style. OnboardingPage.vue's selectStyle() clears them for
            // any other style, and the inputs only render while 'budget' is
            // chosen (Arsen 2026-08-25: "when user selects luxury and if he had
            // budget in before, app drops budget min max numbers").
            //
            // Writing only travelStyle left a luxury traveler carrying their old
            // 10–200 band, and that band is not decoration: it gates retrieval,
            // so they kept being filtered to budget places by a number the
            // screen no longer shows them. Same reset as the screen performs,
            // currency included.
            if (valid.field === 'travelStyle' && valid.value !== 'budget') {
                $set['preferences.budget'] = { min: 0, max: 0, currency: 'USD' };
            }
        }
        const res = await User.updateOne({ _id: userId }, { $set });
        // `acknowledged` means "the server received the write", NOT "a document
        // changed" — it is true even when matchedCount is 0. Reading it first
        // meant a write that touched nothing still logged "approved by the
        // traveler", so a silent no-op looked exactly like success (Arsen
        // 2026-08-24: "it is not editing in user settings, it is editing in his
        // mind only"). A MATCH is the proof: matched-but-unmodified just means
        // the value was already that.
        const matched = Number(res?.matchedCount ?? res?.n ?? 0);
        const modified = Number(res?.modifiedCount ?? res?.nModified ?? 0);
        const ok = matched > 0 || modified > 0;
        if (!ok) console.warn(`[prefs] ${userId}: ${valid.label} matched no document — nothing was written`);
        if (ok) console.log(`[prefs] ${userId}: ${valid.label} (approved by the traveler) `
            + `matched=${matched} modified=${modified}`);
        return ok;
    } catch (err) {
        console.warn(`[prefs] update failed for ${userId}: ${err.message}`);
        return false;
    }
}

/** Was this change ASKED for, rather than inferred? Read from the proposal but
 *  normalised here, so only a real boolean true counts — a model writing
 *  "explicit": "maybe" does not get to skip the confirmation. */
function isExplicit(raw) {
    return raw?.explicit === true || raw?.explicit === 'true';
}

/**
 * WHY a budget was refused, in the traveler's terms — so the reply can say what
 * is wrong instead of "I couldn't do that". validateProposal returns null for
 * every failure, which is right for a gate and useless for an explanation.
 * @returns {string|null} a short reason, or null when the value is fine.
 */
function budgetRefusalReason(raw) {
    const v = (raw && typeof raw === 'object') ? raw : {};
    const min = Number(v.min);
    const max = Number(v.max);
    const currency = String(v.currency || 'USD').trim().toUpperCase();
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'the budget needs both a minimum and a maximum number';
    if (min < 0) return 'a budget cannot be negative';
    if (max <= 0) return 'the maximum has to be above zero';
    if (max === min) return 'the minimum has to be LOWER than the maximum — the two given were the same';
    if (max < min) return 'the minimum was higher than the maximum';
    if (max > maxBudgetFor(currency)) return 'that maximum is far too large to be a daily budget';
    if (!PREF_VOCAB.currency.includes(currency)) return `the currency must be one of ${PREF_VOCAB.currency.join(', ')}`;
    return null;
}

// Currency words as a traveler actually types them, mapped to the five codes the
// Preferences screen offers. Symbols included: "$10-200" is a currency answer.
const _CURRENCY_WORDS = [
    ['USD', /\b(usd|dollars?|bucks?)\b|\$/i],
    ['EUR', /\b(eur|euros?)\b|€/i],
    ['GBP', /\b(gbp|pounds?|sterling)\b|£/i],
    ['AED', /\b(aed|dirhams?|dhs)\b/i],
    ['RUB', /\b(rub|roubles?|rubles?)\b|₽|\bруб/i],
    // AMD joined 2026-08-29 (Arsen: the core Yerevan user thinks in drams;
    // the budget gate already normalizes every currency via convertToUSD,
    // and the rates table has carried AMD since the currencyService fix).
    ['AMD', /\b(amd|drams?)\b|֏|драм|դրամ/i],
];

// Currencies a traveler in these markets might reasonably name that Jinni cannot
// store. Listed so they are REFUSED loudly rather than silently replaced.
const _OTHER_CURRENCY_RE = /\b(gel|try|kzt|inr|jpy|cny|chf|sek|pln|uah|azn|lari|lira|tenge|rupees?|yen|yuan|francs?)\b/i;

/**
 * The traveler's ANSWER to "what is your min and max budget?" → a budget value.
 *
 * Jinni asks that question, so the reply is often just "10-200" or "50 to 300" —
 * a fragment with no verb, which the intent model does not always recognise as a
 * settings command. Then the style stayed unswitched while the traveler believed
 * they had answered (Arsen 2026-08-26: "if user only gives min max without
 * currency it seems it is not setting").
 *
 * Same split as everywhere else: the brain decides first, this is the fallback
 * when it abstains. Only called while a budget question is actually open, so a
 * bare pair of numbers cannot be mistaken for one in ordinary conversation.
 *
 * The currency is INHERITED when unstated — their saved one, else USD — because
 * a person answering "10-200" has not changed their mind about the currency.
 * A currency they DO name but we cannot store (AMD, say) is left in place so
 * validateProposal refuses it and the reply explains why: quietly swapping it
 * for USD would save a band they never agreed to.
 *
 * @returns {{min, max, currency}|null}
 */
function parseBudgetReply(message, fallbackCurrency = 'USD') {
    const text = String(message || '');
    // Two numbers, in order. Thousands separators tolerated; decimals ignored,
    // since a daily budget of 10.50 is not what this question is asking.
    const nums = (text.match(/\d[\d\s,]*/g) || [])
        .map(n => Number(n.replace(/[\s,]/g, '')))
        .filter(n => Number.isFinite(n) && n > 0);
    if (nums.length < 2) return null;
    const [min, max] = nums;
    const named = _CURRENCY_WORDS.find(([, re]) => re.test(text));
    if (named) return { min, max, currency: named[0] };
    // A currency they DID name that we cannot store. Returned as written so
    // validateProposal refuses it and the reply says which five are available —
    // inheriting USD here would save a band in a currency they never agreed to,
    // which is the exact class of silent-wrong-write this module exists to stop.
    const other = text.match(_OTHER_CURRENCY_RE);
    if (other) return { min, max, currency: (other[1] || other[0]).toUpperCase() };
    const inherited = PREF_VOCAB.currency.includes(String(fallbackCurrency || '').toUpperCase())
        ? String(fallbackCurrency).toUpperCase() : 'USD';
    return { min, max, currency: inherited };
}

/**
 * WHY a change was refused, as a line the traveler can act on.
 *
 * The settings reply is written from these strings — buildSettingsMessages tells
 * the model to report the lines it is given and add nothing — so an actionable
 * refusal needs no prompt sentence to explain it. That is the whole reason this
 * function exists rather than a paragraph telling the model what it cannot do:
 * the sentence is generated where the decision is made.
 *
 * @returns {string} a phrase for the NOT-changed line; never empty.
 */
function refusalReason(field, value) {
    if (Object.hasOwn(READ_ONLY, field)) {
        const { says, screen } = READ_ONLY[field];
        return `${says} — that one is theirs to set in ${screen}, and you cannot do it for them`;
    }
    if (field === 'budget') {
        const why = budgetRefusalReason(value);
        return why ? `budget — ${why}` : 'budget';
    }
    // An unknown field, or a value outside the vocabulary. Name the field so the
    // traveler at least learns which part of what they asked did not land.
    return String(field || 'that setting');
}

module.exports = {
    validateProposal, isAffirmative, isNegative, applyProposal, isExplicit,
    budgetRefusalReason, refusalReason,
    PREF_VOCAB, PREF_PATHS, SETTINGS, READ_ONLY, SELF_SERVE_SCREENS,
    settableSentence, readOnlySentence, RADIUS_LIMITS, radiusKmFor, parseBudgetReply,
};
