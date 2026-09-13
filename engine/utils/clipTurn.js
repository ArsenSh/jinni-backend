// Jinni V2 Engine — clip an earlier turn for a prompt WITHOUT losing its ending.
//
// The question Jinni asks sits at the END of its reply. A flat "first 300
// characters" cut — which lived in TWO places, the narrator's history and the
// intent classifier's recent turns — dropped it twice on 2026-09-13: the
// narrator re-listed four fares on "yes please", and the fast path filed a
// bare "yes" as small talk because the pending-question guard never saw the
// "?" it was looking for. Head keeps the topic, tail keeps the ask.
function clipTurn(text, max = 300) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    const head = 140, sep = ' … ';
    return `${s.slice(0, head).trimEnd()}${sep}${s.slice(-(max - head - sep.length - 2)).trimStart()}`;
}

module.exports = { clipTurn };
