// Jinni V2 Engine — deterministic leading-greeting strip (pure).
// The prompts already order "never open with a greeting mid-chat"
// (ANSWER_ONLY_CURRENT), but the habit survives the instruction: live
// 2026-08-30 a mid-chat English deck turn opened with "Привет! 😊" before the
// English body. A prompt reduces a model habit; only code removes it. This is
// the brake pedal: a STANDALONE greeting opener ("Привет!", "Hi there! 👋")
// is stripped from the reply before the traveler sees it — and only when the
// conversation already has turns AND the traveler's own message didn't greet
// (echoing a greeting back is natural, not bleed).
//
// Deliberately narrow: the greeting must be terminated by ! . … ՜ ։ or an
// emoji to be stripped. "Привет, вот рестораны…" keeps flowing prose intact;
// "Hello Kitty Café is lovely" never matches (no terminator after the word).

const GREETING_WORDS = [
    'hi', 'hello', 'hey', 'greetings',
    'привет', 'приветик', 'здравствуй', 'здравствуйте',
    'барев', 'բարև', 'բարեւ', 'ողջույն', 'салам', 'salam',
    'hola', 'bonjour', 'salut', 'ciao', 'hallo', 'merhaba',
];
const EMOJI = '(?:\\s*(?:😊|😃|😄|🙂|😉|👋|✨|🌟|🧞|🧞‍♂️|❤️))';
// word (+ optional "there"/"ձեզ"/"ջան" tail) then a REQUIRED terminator:
// punctuation or an emoji; trailing emoji/punctuation runs are swept too.
const GREETING_RE = new RegExp(
    '^\\s*(?:' + GREETING_WORDS.join('|') + ')'
    + '(?:\\s+(?:there|again|ձեզ|ջան|jan))?'
    + '(?:\\s*[!.…՜։]+' + EMOJI + '*|' + EMOJI + '+)'
    + '[\\s!.…՜։]*',
    'iu'
);

/** True when the traveler's OWN message opens with / contains a greeting —
 *  then a greeting in the reply is an echo, and the gate stays off. */
function messageGreets(text) {
    const head = String(text || '').trim().slice(0, 40).toLowerCase();
    return GREETING_WORDS.some(w => new RegExp('(^|[\\s,!.])' + w + '([\\s,!.…՜։]|$)', 'iu').test(head));
}

/** Strip a standalone leading greeting (repeatedly — "Привет! Здравствуйте!").
 *  Never blanks a reply: a greeting-only text comes back unchanged. */
function stripLeadingGreeting(text) {
    const original = String(text || '');
    let s = original, prev;
    do { prev = s; s = s.replace(GREETING_RE, ''); } while (s !== prev);
    return s.trim() ? s : original;
}

/**
 * Streaming wrapper: holds back the first ~64 chars so a greeting split
 * across deltas ("Прив", "ет! ") is still caught, strips once, then passes
 * everything through untouched. Call finalize() after the stream ends so a
 * short reply held in the buffer still reaches the traveler.
 * @param {(text: string) => void} onText
 * @param {{enabled?: boolean, holdChars?: number}} opts
 */
function makeGreetingGate(onText, { enabled = true, holdChars = 64 } = {}) {
    if (!enabled) return { feed: onText, finalize: () => {} };
    let buf = '', open = false;
    const openUp = () => {
        const out = stripLeadingGreeting(buf);
        buf = '';
        open = true;
        if (out) onText(out);
    };
    return {
        feed(chunk) {
            if (open) { onText(String(chunk)); return; }
            buf += String(chunk);
            if (buf.length >= holdChars) openUp();
        },
        finalize() { if (!open && buf) openUp(); },
    };
}

module.exports = { stripLeadingGreeting, makeGreetingGate, messageGreets };
