// Characterization tests for the V2 engine's matching modules.
// Every case below is a REAL production incident or verified behavior recorded in
// the docs (JinniAI-Events-Handoff.md rounds 42–47, ChatStream-Testbook.md).
// These pin the copied v1 logic; if a test breaks, the engine copy drifted from
// documented production behavior — fix the copy, not the test, unless a doc'd
// decision changed.

const { normalizePlaceName, namesPlausiblyMatch, messageNamesPlace } = require('../engine/places/matching');
const { isPlaceholderVenue, eventNamesMatch, cleanEventTitle, _decodeEntities, _extractOgImage } = require('../engine/events/matching');

describe('normalizePlaceName', () => {
    test('folds diacritics — the Shéné case (round 42: rejecting a CORRECT venue)', () => {
        expect(normalizePlaceName('Shéné')).toBe(normalizePlaceName('Shene'));
    });
    test('strips punctuation, collapses whitespace, lowercases', () => {
        expect(normalizePlaceName('  The  "Lichk"   Lodge! ')).toBe('the lichk lodge');
    });
    test('non-Latin scripts pass through', () => {
        expect(normalizePlaceName('Զանգեզուր')).toBe('զանգեզուր');
    });
    test('number words fold to digits — the "7 Visions"≡"Seven Visions" dedupe slip', () => {
        expect(normalizePlaceName('Seven Visions')).toBe(normalizePlaceName('7 Visions'));
        expect(normalizePlaceName('Seven Visions Hotel')).toBe('7 visions hotel');
        expect(normalizePlaceName('One Republic Cafe')).toBe('1 republic cafe');
        expect(normalizePlaceName('Someone\'s Place')).toBe('someones place');   // no mid-word folding
    });
    test('empty/null safe', () => {
        expect(normalizePlaceName(null)).toBe('');
        expect(normalizePlaceName('')).toBe('');
    });
});

describe('namesPlausiblyMatch (hallucination-rescue guard)', () => {
    test('drops the documented hallucination rescue: "Liqstum Hotel" vs "The Lichk Lodge"', () => {
        expect(namesPlausiblyMatch('Liqstum Hotel', 'The Lichk Lodge')).toBe(false);
    });
    test('cross-script SKIPS the check (keeps): "Zangezur Cafe" vs "Զանգեզուր"', () => {
        expect(namesPlausiblyMatch('Zangezur Cafe', 'Զանգեզուր')).toBe(true);
    });
    test('word-order tolerant via shared distinctive token: "Garni Temple" vs "Temple of Garni"', () => {
        expect(namesPlausiblyMatch('Garni Temple', 'Temple of Garni')).toBe(true);
    });
    test('generic-word-only names cannot be judged → keep', () => {
        expect(namesPlausiblyMatch('The Hotel', 'Grand Resort')).toBe(true);
    });
    test('missing side → keep', () => {
        expect(namesPlausiblyMatch(null, 'Anything')).toBe(true);
        expect(namesPlausiblyMatch('Anything', '')).toBe(true);
    });
    test('same distinctive token with generic tail matches: "Uzbechka" vs "Uzbechka Restaurant"', () => {
        expect(namesPlausiblyMatch('Uzbechka', 'Uzbechka Restaurant')).toBe(true);
    });
});

describe('messageNamesPlace (dislike direct-ask exception)', () => {
    test('the documented Paphos case: wording differs from stored name', () => {
        expect(messageNamesPlace('is paphos gardens hotel any good?', 'Paphos Gardens Holiday Resort')).toBe(true);
    });
    test('plain substring still counts', () => {
        expect(messageNamesPlace('tell me about uzbechka please', 'Uzbechka')).toBe(true);
    });
    test('unrelated message does not name the place', () => {
        expect(messageNamesPlace('best hotels in yerevan', 'Hilton Yerevan')).toBe(false);
    });
    test('empty inputs → false', () => {
        expect(messageNamesPlace('', 'X')).toBe(false);
        expect(messageNamesPlace('x', null)).toBe(false);
    });
});

describe('isPlaceholderVenue (round 42b/44 — cities and vagueness are not venues)', () => {
    test('classic placeholders', () => {
        expect(isPlaceholderVenue('Various venues')).toBe(true);
        expect(isPlaceholderVenue('TBA')).toBe(true);
        expect(isPlaceholderVenue('Online')).toBe(true);
        expect(isPlaceholderVenue('Armenian Apostolic Churches')).toBe(true);   // trailing "churches"
        expect(isPlaceholderVenue('')).toBe(true);
        expect(isPlaceholderVenue(null)).toBe(true);
    });
    test('bare city name is a placeholder WHEN cityNames provided (the 10-Tamanyan bug)', () => {
        expect(isPlaceholderVenue('Yerevan', ['Yerevan'])).toBe(true);
        expect(isPlaceholderVenue('Yerevan city centre', ['Yerevan'])).toBe(true);
    });
    test('city + real remainder is a genuine venue', () => {
        expect(isPlaceholderVenue('Yerevan Opera House', ['Yerevan'])).toBe(false);
    });
    test('real venue passes', () => {
        expect(isPlaceholderVenue('Altezza by Armenian Helicopters', ['Yerevan'])).toBe(false);
    });
    test('KNOWN LIMITATION (round 44): empty cityNames list means the city check cannot fire', () => {
        // This is why venueCityNames must come from userRegion, not effectiveLocation —
        // documented root cause in Events-Handoff round 44.
        expect(isPlaceholderVenue('Yerevan', [])).toBe(false);
    });
});

describe('eventNamesMatch (rounds 44 + 46 — the LOBODA/Spleen and Symphonic bugs)', () => {
    test('same event through shop wording: "LOBODA Concert" vs "Loboda Concert Tickets"', () => {
        expect(eventNamesMatch('LOBODA Concert', 'Loboda Concert Tickets')).toBe(true);
    });
    test('round-44 bug pinned: LOBODA must NOT match Spleen via shared "concert" boilerplate', () => {
        expect(eventNamesMatch('LOBODA Concert', 'Spleen Concert Tickets')).toBe(false);
    });
    test('round-46 bug pinned: multi-word pairs need TWO shared distinctive tokens', () => {
        expect(eventNamesMatch(
            'Symphonic Yerevan International Music Festival',
            'Symphonic Hayko. Ararat in the Heart'
        )).toBe(false);
    });
    test('single-token side needs only one shared token: "Spleen" vs its listing', () => {
        expect(eventNamesMatch('Spleen', 'Tickets for the Spleen concert')).toBe(true);
    });
    test('possessive stripping keeps the real pairing (round 46 tokenizer fix)', () => {
        expect(eventNamesMatch("Grisha Asatryan's Concert", 'Grisha Asatryan Live')).toBe(true);
    });
    test('boilerplate-only titles refuse to guess', () => {
        expect(eventNamesMatch('Concert', 'Show Tickets')).toBe(false);
        expect(eventNamesMatch('', 'Anything')).toBe(false);
    });
});

describe('cleanEventTitle (round 44 — shop copy → event name)', () => {
    test('the documented Grisha case: entities + "Tickets for" wrapper', () => {
        expect(cleanEventTitle('Tickets for Grisha Asatryan&apos;s concert')).toBe("Grisha Asatryan's concert");
    });
    test('trailing "Tickets" stripped', () => {
        expect(cleanEventTitle('Loboda Concert Tickets')).toBe('Loboda Concert');
    });
    test('trailing "in Yerevan" stripped', () => {
        expect(cleanEventTitle('Jazz Evening in Yerevan')).toBe('Jazz Evening');
    });
    test('quoted title unwrapped', () => {
        expect(cleanEventTitle('concert «Symphonic Hayko. Ararat in the Heart»')).toBe('Symphonic Hayko. Ararat in the Heart');
    });
    test('never returns empty — falls back to decoded raw', () => {
        expect(cleanEventTitle('Tickets')).toBe('Tickets');
    });
});

describe('_decodeEntities / _extractOgImage', () => {
    test('numeric, hex and named entities', () => {
        expect(_decodeEntities('Caf&#233; &quot;Ararat&quot; &amp; Co &#x2019;')).toBe('Café "Ararat" & Co ’');
    });
    test('og:image both attribute orders; rejects non-http', () => {
        expect(_extractOgImage('<meta property="og:image" content="https://x.am/p.jpg">')).toBe('https://x.am/p.jpg');
        expect(_extractOgImage('<meta content="https://x.am/q.jpg" property="og:image">')).toBe('https://x.am/q.jpg');
        expect(_extractOgImage('<meta property="og:image" content="/relative.jpg">')).toBe(null);
        expect(_extractOgImage('<html></html>')).toBe(null);
    });
});

describe('messageNamesPlace geo-token exclusion (the "Cafe #2 Dilijan" hijack, 2026-08-30)', () => {
    const { messageNamesPlace } = require('../engine/places/matching');
    const geo = new Set(['dilijan']);
    test('a card whose only distinctive token is the city never matches a city mention', () => {
        expect(messageNamesPlace('can you suggest 6 hotels, all in dilijan?', 'Cafe #2 Dilijan', geo)).toBe(false);
        expect(messageNamesPlace('best restaurants in dilijan', 'Hotel Dilijan', geo)).toBe(false);
    });
    test('genuinely distinctive names still match with geo exclusion active', () => {
        expect(messageNamesPlace('is dilijazz open tonight?', 'Dilijazz Restaurant', geo)).toBe(true);
        expect(messageNamesPlace('tell me about toon armeni', 'Toon Armeni Restaurant', geo)).toBe(true);
    });
    test('typing the full card name verbatim always counts as a reference', () => {
        expect(messageNamesPlace('what are the hours of cafe #2 dilijan?', 'Cafe #2 Dilijan', geo)).toBe(true);
    });
    test('without excludeTokens the old behavior is unchanged', () => {
        expect(messageNamesPlace('what about dilijan?', 'Cafe #2 Dilijan')).toBe(true);
    });
});

// Plural-fold dedupe (live 2026-08-31): "Seven Visions Hotels" (Google cache
// twin) and "7 Visions Hotel" (curated Destination) shipped as TWO cards in
// one Yerevan hotel deck — the numeral fold matched but the trailing s on the
// TYPE word kept the keys distinct. Type-word plurals now fold to singular;
// distinctive name words never do.
describe('normalizePlaceName — generic type-word plural fold', () => {
    test('the live twin pair collapses to one key', () => {
        expect(normalizePlaceName('Seven Visions Hotels'))
            .toBe(normalizePlaceName('7 Visions Hotel'));
    });
    test('distinct real hotels sharing a name word stay distinct', () => {
        expect(normalizePlaceName('Republica Hotel'))
            .not.toBe(normalizePlaceName('Republica Suites'));
    });
    test('distinctive plural words are never singularized', () => {
        expect(normalizePlaceName('Seven Visions Hotel'))
            .not.toBe(normalizePlaceName('Seven Vision Hotel'));
    });
});

// Street-twin pass (live 2026-08-31): "Grand Hotel Yerevan" (curated) and
// "Grand Hotel Yerevan, an SLH Hotel" (Google cache twin) both at 14 Abovyan
// shipped as two cards — different name keys, same hotel. mergeAndDedupe's
// second pass drops a candidate whose street signature matches a kept one
// AND whose distinctive name tokens are subset-related. Curated wins (listed
// first); different venues in one building survive (no token subset).
describe('mergeAndDedupe — street-twin pass', () => {
    const { mergeAndDedupe } = require('../engine/places/canonicalStore');
    const curated = { placeId: 'dest_1', name: 'Grand Hotel Yerevan', address: '14 Abovyan St,' };
    const cacheTwin = { placeId: 'ChIJ54jQ', name: 'Grand Hotel Yerevan, an SLH Hotel', address: '14 Abovyan poxoc, Yerevan 0001, Armenia' };
    test('the live Grand Hotel pair collapses to the curated card', () => {
        const out = mergeAndDedupe([curated], [cacheTwin]);
        expect(out).toHaveLength(1);
        expect(out[0].placeId).toBe('dest_1');
    });
    test('different venues at the same address both survive', () => {
        const cafe = { placeId: 'p1', name: 'Louvre Cafe', address: '14 Abovyan St' };
        const gallery = { placeId: 'p2', name: 'Dalan Art Gallery', address: '14 Abovyan St' };
        expect(mergeAndDedupe([cafe], [gallery])).toHaveLength(2);
    });
    test('same-name places with different street numbers both survive', () => {
        const a = { placeId: 'p1', name: 'Tufenkian Heritage Hotels', address: '48 Hanrapetutyan pokhots' };
        const b = { placeId: 'p2', name: 'Tufenkian Heritage Hotel Dilijan', address: '9 Sharambeyan St' };
        expect(mergeAndDedupe([a], [b])).toHaveLength(2);
    });
    test('candidates without addresses fall back to the classic keys only', () => {
        const a = { placeId: 'p1', name: 'Grand Hotel Yerevan' };
        const b = { placeId: 'p2', name: 'Grand Hotel Yerevan, an SLH Hotel' };
        expect(mergeAndDedupe([a], [b])).toHaveLength(2);
    });
});

// Typo tolerance (live 2026-08-31): "Tufenkisn heritage hotel" — one-letter
// slip — broke the route bridge (exact substring check) and the answer lost
// its See-route button. looseTokenMatch allows ONE edit on 5+ char words.
describe('looseTokenMatch / typo-tolerant naming', () => {
    const { looseTokenMatch } = require('../engine/places/matching');
    test('one-letter typos match on long words', () => {
        expect(looseTokenMatch('how to go to tufenkisn heritage hotel', 'tufenkian')).toBe(true);
        expect(looseTokenMatch('the elegent hotel please', 'elegant')).toBe(true);
    });
    test('short words stay exact — no fuzzy on 4-char tokens', () => {
        expect(looseTokenMatch('cafe near me', 'card')).toBe(false);
    });
    test('two edits never match', () => {
        expect(looseTokenMatch('tufenksn hotel', 'tufenkian')).toBe(false);
    });
    test('messageNamesPlace survives the live typo end-to-end', () => {
        expect(messageNamesPlace('how to go to tufenkisn heritage hotel?', 'Tufenkian Heritage Hotels')).toBe(true);
    });
});
