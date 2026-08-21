// Jinni V2 Engine — DeepSeek provider (the default narrator, per cost routing).
// Thin wrapper over config/openai — the SAME axios client v1 uses, lazy-required
// so jest can import the narrator without env keys. Non-streaming call; the
// narrator pseudo-streams the text to the client in chunks. True token
// streaming (v1's SSE-chunk parser, done right) is a later upgrade.

async function complete({ messages, model = null, maxTokens = 600, temperature = 0.5 }) {
    const openai = require('../../../config/openai');
    const res = await openai.chat.completions.create({
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
    });
    const text = res?.choices?.[0]?.message?.content || '';
    return {
        text,
        usage: {
            in: res?.usage?.prompt_tokens || 0,
            out: res?.usage?.completion_tokens || 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        searches: [],
        searchCount: 0,
    };
}

module.exports = { complete };
