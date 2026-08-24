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
    currency: ['AED', 'USD', 'RUB', 'EUR', 'GBP'],
    // The only destination value we accept is "where I am now". A city NAME
    // would have to be geocoded to be stored, and a guessed coordinate saved as
    // someone's destination is the kind of wrong that is hard to notice — the
    // 0,0 Gulf of Guinea problem with extra steps. Code fills in every field
    // from the position the app already reported.
    destination: ['current'],
};

const MAX_BUDGET = 100000;

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

    if (field === 'travelStyle') {
        const v = String(raw.value || '').trim().toLowerCase();
        if (!PREF_VOCAB.travelStyle.includes(v)) return null;
        return { field, value: v, label: `travel style to ${v}` };
    }

    if (field === 'interests') {
        const list = (Array.isArray(raw.value) ? raw.value : [raw.value])
            .map(v => String(v || '').trim().toLowerCase().replace(/[\s&]+/g, '_'))
            .filter(v => PREF_VOCAB.interests.includes(v));
        const unique = [...new Set(list)];
        if (!unique.length) return null;
        return { field, value: unique, label: `interests to ${unique.join(', ')}` };
    }

    if (field === 'budget') {
        const v = raw.value || {};
        const min = Number(v.min);
        const max = Number(v.max);
        const currency = String(v.currency || 'USD').trim().toUpperCase();
        if (!PREF_VOCAB.currency.includes(currency)) return null;
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        if (min < 0 || max <= 0 || max < min || max > MAX_BUDGET) return null;
        return { field, value: { min, max, currency }, label: `budget to ${min}–${max} ${currency}` };
    }

    if (field === 'destination') {
        // IDEMPOTENT. applyProposal re-validates as a safety net — a pending
        // proposal comes back out of the database, so re-checking it is right —
        // and it has no position context to hand. So an already-resolved
        // destination must validate on its own coordinates, or the write could
        // never happen (caught by the test below before it shipped).
        const already = raw.value && typeof raw.value === 'object' ? raw.value : null;
        if (already) {
            const lat0 = Number(already.coordinates?.lat);
            const lng0 = Number(already.coordinates?.lng);
            if (!Number.isFinite(lat0) || !Number.isFinite(lng0) || (lat0 === 0 && lng0 === 0)) return null;
            const where0 = [already.city, already.countryName].filter(Boolean).join(', ');
            return {
                field,
                value: {
                    country: String(already.country || ''),
                    countryName: String(already.countryName || ''),
                    city: String(already.city || ''),
                    coordinates: { lat: lat0, lng: lng0 },
                },
                label: where0 ? `destination to ${where0}` : 'destination to where you are now',
            };
        }
        const v = String(raw.value || '').trim().toLowerCase();
        if (!PREF_VOCAB.destination.includes(v)) return null;
        const where = [ctx.currentPlace?.city, ctx.currentPlace?.country].filter(Boolean).join(', ');
        const lat = Number(ctx.currentPlace?.lat);
        const lng = Number(ctx.currentPlace?.lng);
        // No position, nothing to save. Refusing beats storing 0,0.
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
        return {
            field,
            value: {
                country: ctx.currentPlace?.countryCode || '',
                countryName: ctx.currentPlace?.country || '',
                city: ctx.currentPlace?.city || '',
                coordinates: { lat, lng },
            },
            label: where ? `destination to ${where}` : 'destination to where you are now',
        };
    }

    return null;                                   // any other field is not ours to touch
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
        const res = await User.updateOne({ _id: userId }, { $set: { [`preferences.${valid.field}`]: valid.value } });
        const ok = !!(res?.acknowledged ?? res?.modifiedCount ?? res?.matchedCount);
        if (ok) console.log(`[prefs] ${userId}: ${valid.label} (approved by the traveler)`);
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

module.exports = { validateProposal, isAffirmative, isNegative, applyProposal, isExplicit, PREF_VOCAB };
