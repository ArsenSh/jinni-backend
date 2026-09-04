// Tests for the V2 narrator v0: grounded prompt builders (pure) and the
// stream contract with an injected fake provider — no API keys, no network.

const { buildGroundedMessages, buildChitchatMessages, buildNarrationJson, parseNarrationJson, placeFactLine, parseCardsTail } = require('../engine/narrator/prompts/grounded');
const narrator = require('../engine/narrator');

describe('parseCardsTail robustness (battery row 7 — the fact-line fallback)', () => {
    test('clean tail parses; trailing commas repaired', () => {
        const clean = parseCardsTail('{"cards":[{"i":0,"blurb":"Great spot"}],"question":"More?"}', 2);
        expect(clean.blurbs).toEqual(['Great spot', null]);
        expect(clean.question).toBe('More?');
        const trailing = parseCardsTail('{"cards":[{"i":1,"blurb":"Nice"},],"question":"Q?",}', 2);
        expect(trailing.blurbs).toEqual([null, 'Nice']);
    });
    test('truncated tail salvages the intact card fragments', () => {
        const cut = '{"cards":[{"i":0,"blurb":"First blurb"},{"i":1,"blurb":"Second one"},{"i":2,"blu';
        const r = parseCardsTail(cut, 3);
        expect(r.blurbs).toEqual(['First blurb', 'Second one', null]);
    });
    test('escapes survive salvage; hopeless garbage stays null', () => {
        const esc = parseCardsTail('broken {"i":0,"blurb":"He said \\"hi\\""} nonsense', 1);
        expect(esc.blurbs[0]).toBe('He said "hi"');
        expect(parseCardsTail('no json here at all', 3)).toBeNull();
        expect(parseCardsTail('', 3)).toBeNull();
    });
});

describe('placeFactLine', () => {
    test('renders only the facts we actually hold', () => {
        const line = placeFactLine({
            name: 'Uzbechka', primaryType: 'restaurant', distanceKm: 1.234,
            rating: 4.4, _openNow: true, source: 'cache',
        });
        expect(line).toBe('- Uzbechka (restaurant, 1.2 km away, rated 4.4, open now)');
    });
    test('unknown open state is simply absent — never asserted', () => {
        expect(placeFactLine({ name: 'X', source: 'cache' })).toBe('- X');
    });
    test('validator/partner provenance is stated', () => {
        expect(placeFactLine({ name: 'Matenadaran', source: 'destination' })).not.toContain('verified');   // founder 2026-08-30: curation is internal, never narrated
        // Decision 2026-08-22: the partner relationship is disclosed by the
        // card badge, NEVER told to the model — prose must sell the
        // experience, not the tier.
        expect(placeFactLine({ name: 'Tashir', source: 'business' })).not.toContain('partner');
    });
});

describe('buildGroundedMessages', () => {
    const msgs = buildGroundedMessages({
        query: 'uzbek restaurant',
        places: [{ name: 'Uzbechka', distanceKm: 1, rating: 4.4, source: 'cache' }],
        langName: 'Russian',
        timeNote: 'late night (03:00 local)',
    });
    test('system prompt carries the grounding rules and the reply language', () => {
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('ONLY from the list');
        expect(msgs[0].content).toContain('Reply in Russian');
        expect(msgs[0].content).toContain('say so honestly');
    });
    test('user message carries the query, the time note and the fact lines', () => {
        expect(msgs[1].content).toContain('uzbek restaurant');
        expect(msgs[1].content).toContain('late night (03:00 local)');
        expect(msgs[1].content).toContain('- Uzbechka');
    });
});

describe('buildChitchatMessages', () => {
    test('no venue names, but invites place asks inward and owns its history', () => {
        const msgs = buildChitchatMessages({ message: 'Hi', langName: 'English' });
        expect(msgs[0].content).toContain('Do not invent or name any specific real venue');
        expect(msgs[0].content).toContain('never claim you cannot');
        expect(msgs[0].content).toContain('Never describe yourself as unable to name places');
        expect(msgs[1].content).toMatch(/^Hi\n\n\[reply in English/)   // recency language tag + no-restate tail (2026-09-05);
    });
});

describe('buildNarrationJson / parseNarrationJson (structured narration)', () => {
    test('prompt demands JSON-only, indexes the facts, forbids invented hard facts', () => {
        const msgs = buildNarrationJson({ query: 'romantic dinner',
            places: [{ name: 'Nairi', rating: 4.9 }, { name: 'Persona' }], langName: 'English' });
        expect(msgs[0].content).toContain('ONLY with JSON');
        expect(msgs[0].content).toContain('Never state prices');
        expect(msgs[1].content).toContain('0. Nairi');
        expect(msgs[1].content).toContain('1. Persona');
    });
    test('parses a valid reply into intro + indexed blurbs + question', () => {
        const parsed = parseNarrationJson(
            '{"intro":"Nairi is lovely tonight.","cards":[{"i":0,"blurb":"Elegant and calm."},{"i":1,"blurb":"Lively bar vibe."}],"question":"Quiet or lively?"}', 2);
        expect(parsed.intro).toBe('Nairi is lovely tonight.');
        expect(parsed.blurbs).toEqual(['Elegant and calm.', 'Lively bar vibe.']);
        expect(parsed.question).toBe('Quiet or lively?');
    });
    test('tolerates fenced/wrapped JSON; out-of-range or junk card entries dropped', () => {
        const parsed = parseNarrationJson(
            'Sure! ```json\n{"intro":"Ok.","cards":[{"i":5,"blurb":"x"},{"i":0,"blurb":"Good."},null],"question":null}\n```', 2);
        expect(parsed.intro).toBe('Ok.');
        expect(parsed.blurbs).toEqual(['Good.', null]);
        expect(parsed.question).toBe(null);
    });
    test('malformed answers return null (caller falls back to prose)', () => {
        expect(parseNarrationJson('no json here', 2)).toBe(null);
        expect(parseNarrationJson('{"cards":[]}', 2)).toBe(null);        // missing intro
        expect(parseNarrationJson('{broken', 2)).toBe(null);
        expect(parseNarrationJson(null, 2)).toBe(null);
    });
});

describe('narrator.stream (contract, fake provider)', () => {
    test('pseudo-streams the text through onToken and returns real usage', async () => {
        const chunks = [];
        const fake = { complete: async () => ({ text: 'Hello traveler, welcome to Yerevan tonight.', usage: { in: 10, out: 8, cacheRead: 0, cacheWrite: 0 }, searches: [], searchCount: 0 }) };
        const out = await narrator.stream({ messages: [], onToken: (c) => chunks.push(c) }, { provider: fake });
        expect(chunks.join('')).toBe('Hello traveler, welcome to Yerevan tonight.');
        expect(out.usage).toEqual({ in: 10, out: 8, cacheRead: 0, cacheWrite: 0 });
    });
    test('tool-use is honestly unimplemented', async () => {
        await expect(narrator.stream({ messages: [], tools: [{}] })).rejects.toThrow(/tool-use loop not implemented/);
    });
});

// ── Self-knowledge as evidence (Arsen 2026-08-24) ────────────────────────────
// Jinni claimed the traveler liked "cozy, low-key spots" while their saved
// travelStyle was 'luxury', and announced it was "made by Withlocals". Both
// holes are now filled with rows, and an empty row set must read as "unknown"
// rather than licence to improvise.
describe('selfBlock', () => {
    const { selfBlock, buildChitchatMessages } = require('../engine/narrator/prompts/grounded');

    test('saved settings become quotable rows', () => {
        const b = selfBlock({ travelStyle: 'luxury', interests: ['food', 'history'],
            budget: { min: 50, max: 200, currency: 'USD' }, destination: { city: 'Yerevan', countryName: 'Armenia' } });
        expect(b).toContain('travel style: luxury');
        expect(b).toContain('interests: food, history');
        expect(b).toContain('budget: 50–200 USD');
        expect(b).toContain('location saved in their settings (where they plan to go, NOT where they are): Yerevan, Armenia');
    });

    test('no saved settings reads as unknown, not as freedom to invent', () => {
        for (const empty of [null, undefined, {}, { interests: [], languages: [] }]) {
            const b = selfBlock(empty);
            expect(b).toContain('none — they have saved no preferences');
            expect(b).toContain('Do NOT describe any taste, style or budget');
            expect(b).not.toContain('travel style:');
        }
    });

    test('a field with no value contributes no row', () => {
        const b = selfBlock({ travelStyle: 'luxury' });
        expect(b).toContain('travel style: luxury');
        expect(b).not.toContain('budget:');
        expect(b).not.toContain('interests:');
    });

    // Live 2026-08-24: "a budget of $0–0 USD". Zero is the untouched default.
    test('a zero budget is the default, not a preference', () => {
        expect(selfBlock({ travelStyle: 'luxury', budget: { min: 0, max: 0, currency: 'USD' } })).not.toContain('budget:');
        expect(selfBlock({ budget: { min: 50, max: 200, currency: 'USD' } })).toContain('budget: 50–200 USD');
    });

    // The rows were meant to stop invention, and instead became a script the
    // model recited at the top of every reply — "who made you" opened with
    // luxury/family/romantic/Yerevan before answering anything.
    test('the rows are background, not an announcement', () => {
        const b = selfBlock({ travelStyle: 'luxury' });
        expect(b).toMatch(/BACKGROUND/);
        expect(b).toMatch(/never announce them/);
        expect(b).toMatch(/only if the CURRENT message asks/);
    });

    test('identity rows name no company and no model, and forbid guessing one', () => {
        const b = selfBlock({});
        expect(b).toContain('jinni.travel');
        expect(b).toMatch(/never name a company or a model/i);
        expect(b).not.toMatch(/withlocals|anthropic|openai|claude|deepseek|gpt/i);
    });

    test('the block reaches the chit-chat prompt, where the invention happened', () => {
        const sys = buildChitchatMessages({ message: 'what are my preferences?', preferences: { travelStyle: 'luxury' } })[0].content;
        expect(sys).toContain('travel style: luxury');
        expect(sys).toContain('ROWS ABOUT YOU');
    });
});

// ── No events from memory (Arsen 2026-08-24) ─────────────────────────────────
// Asked for Dubai events with an Armenian deck on screen, Jinni said it had no
// Dubai cards and then listed two real-sounding conferences with date ranges,
// plus "Dubai Summer Surprises through August 30". Nothing fetched any of it.
describe('no remembered events', () => {
    const g = require('../engine/narrator/prompts/grounded');
    const builders = [
        ['chit-chat', () => g.buildChitchatMessages({ message: 'events in dubai?' })],
        ['getting-around', () => g.buildGettingAroundMessages({ message: 'how do I get there' })],
        ['no-match', () => g.buildNoMatchMessages({ message: 'events in dubai?' })],
        ['tool-answer', () => g.buildToolAnswerMessages({ message: 'tell me about it' })],
        ['streamed narration', () => g.buildStreamedNarrationMessages({ query: 'events', places: [{ name: 'A' }] })],
    ];
    test.each(builders)('%s forbids naming an unlisted event', (_name, build) => {
        const sys = build()[0].content;
        expect(sys).toMatch(/Never name an event, festival, exhibition, concert, fair or conference/);
        expect(sys).toMatch(/a date nobody verified is a guess a traveler can act on/);
    });
    test('the reply opens on the question asked, not on an earlier topic', () => {
        for (const build of [
            () => g.buildChitchatMessages({ message: 'who made you' }),
            () => g.buildGettingAroundMessages({ message: 'how do I get there' }),
            () => g.buildNoMatchMessages({ message: 'x' }),
            () => g.buildStreamedNarrationMessages({ query: 'x', places: [{ name: 'A' }] }),
        ]) {
            const sys = build()[0].content;
            expect(sys).toMatch(/START with the answer to the current message/);
            expect(sys).toMatch(/Do not preface it with the traveler's preferences/);
        }
    });

    test('and forbids softening the gap by listing one anyway', () => {
        const sys = g.buildStreamedNarrationMessages({ query: 'events', places: [] })[0].content;
        expect(sys).toMatch(/do not soften it by listing something anyway/);
    });
});

// ── Evidence is the list, not the search (Arsen 2026-08-24) ──────────────────
// The narrator was given its own web search on card turns, so it announced
// "Dubai Fashion Week runs September 1–5 at Dubai Design District" — a real
// sounding claim with a date, on no card, checked by nobody. The hunt already
// searches, and everything it finds becomes a card; the narrator narrates.
describe('evidence is the list', () => {
    const g = require('../engine/narrator/prompts/grounded');

    test.each([
        ['streamed narration', () => g.buildStreamedNarrationMessages({ query: 'events', places: [{ name: 'A' }] })],
        ['chit-chat', () => g.buildChitchatMessages({ message: 'events?' })],
        ['no-match', () => g.buildNoMatchMessages({ message: 'events?' })],
    ])('%s says what evidence is, and excludes search', (_n, build) => {
        const sys = build()[0].content;
        expect(sys).toMatch(/EVIDENCE means the listed items in this prompt and nothing else/);
        expect(sys).toMatch(/not anything you find by searching/);
        expect(sys).toMatch(/a date nobody verified is a guess a traveler can act on/);
    });
});

describe('buildEmptyDeckMessages (localized empty decks — the Dilijan lesson, 2026-08-30)', () => {
    const g = require('../engine/narrator/prompts/grounded');
    const sys = (o) => g.buildEmptyDeckMessages({ message: 'x', ...o })[0].content;
    test('speaks the traveler language, names the searched city, never names venues', () => {
        const s = sys({ langName: 'Armenian', cause: 'all_closed', cityLabel: 'Dilijan' });
        expect(s).toContain('Reply in Armenian');
        expect(s).toContain('in Dilijan');
        expect(s).toContain('CLOSED');
        expect(s).toMatch(/Never name a specific venue/);
    });
    test('cause picks the fixed meaning: closed ≠ seen-everything ≠ came-up-dry', () => {
        expect(sys({ cause: 'all_closed' })).toContain('for tomorrow');
        expect(sys({ cause: 'all_filtered' })).toContain('already been shown everything');
        expect(sys({ cause: 'empty' })).toContain('found nothing');
        expect(sys({ cause: 'all_filtered', isEvents: true })).toContain('every upcoming event');
        expect(sys({ cause: 'empty', isEvents: true })).toContain('no verified event listings');
    });
});

describe('buildEmptyDeckMessages no_web cause (honest no-internet reply, 2026-08-30)', () => {
    const g = require('../engine/narrator/prompts/grounded');
    test('no_web meaning: cannot browse, offers verified data, localized', () => {
        const s = g.buildEmptyDeckMessages({ message: 'search the web', langName: 'Russian', cause: 'no_web' })[0].content;
        expect(s).toContain('Reply in Russian');
        expect(s).toContain('CANNOT browse the web');
        expect(s).toContain('verified places');
        expect(s).toMatch(/Never name a specific venue/);
    });
});

describe("curator descriptions as context (founder 2026-08-30: understand, don't copy)", () => {
    const g = require('../engine/narrator/prompts/grounded');
    test('placeFactLine carries a trimmed about-note', () => {
        const line = g.placeFactLine({ name: 'Cabinet', description: '  A hidden   cellar cafe with live jazz  ' + 'x'.repeat(300) });
        expect(line).toContain('about: "A hidden cellar cafe with live jazz');
        expect(line.length).toBeLessThan(230);        // 160-char cap holds
        expect(g.placeFactLine({ name: 'NoDesc' })).not.toContain('about:');
    });
    test('both narration builders forbid copying the about-note', () => {
        const streamed = g.buildStreamedNarrationMessages({ query: 'cafes', places: [{ name: 'A' }] })[0].content;
        const json = g.buildNarrationJson({ query: 'cafes', places: [{ name: 'A' }] })[0].content;
        for (const s of [streamed, json]) {
            expect(s).toContain('NEVER copy or closely paraphrase');
            expect(s).toContain('UNDERSTAND the place');
        }
    });
    test('curation is never narrated (verified-by-staff stays gone)', () => {
        expect(g.placeFactLine({ name: 'X', source: 'destination', description: 'quiet garden' })).not.toContain('verified');
    });
});

describe('battery fixes 2026-08-30 (second-person empty replies, current-message language)', () => {
    const g = require('../engine/narrator/prompts/grounded');
    test('empty-deck prompt orders direct address, never "they"', () => {
        const sys = g.buildEmptyDeckMessages({ message: '10 examples please', cause: 'all_filtered' })[0].content;
        expect(sys).toContain('always "you", never "they"');
    });
    test('streamed narration pins the CURRENT message language against history drift', () => {
        const sys = g.buildStreamedNarrationMessages({ query: 'restaurants', places: [{ name: 'A' }], langName: 'English' })[0].content;
        expect(sys).toContain('STRICTLY in English — the language of the CURRENT message');
    });
    test("ChatTurn accepts the no_web branch (turnlog validation failed live)", () => {
        const ChatTurn = require('../models/ChatTurn');
        const doc = new ChatTurn({ branch: 'no_web' });
        expect(doc.validateSync('branch')).toBeUndefined();
    });
});
