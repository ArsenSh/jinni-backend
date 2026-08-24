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
//   3. Nothing is written without an explicit yes on the next turn. Silence, a
//      new question, or an unclear reply all mean NO, because the safe default
//      when consent is ambiguous is to leave a person's settings alone.
//
// One ask, one answer, then the proposal is gone. Jinni does not nag.

// The vocabularies the app's own Preferences screen offers. Staying inside them
// means chat can never produce a setting the UI cannot show or the traveler
// cannot undo.
const PREF_VOCAB = {
    travelStyle: ['luxury', 'budget'],
    interests: ['family', 'romantic', 'nature', 'adventure', 'cultural',
        'history', 'art', 'food_drink', 'nightlife', 'relaxation'],
    currency: ['AED', 'USD', 'RUB', 'EUR', 'GBP'],
};

const MAX_BUDGET = 100000;

/**
 * A model's proposal → something safe to store and show, or null.
 * @returns {{field, value, label}|null} `label` is how the change is described
 *   to the traveler, so the sentence they approve is the change we make.
 */
function validateProposal(raw) {
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

module.exports = { validateProposal, isAffirmative, isNegative, applyProposal, PREF_VOCAB };
