// Jinni V2 Engine — the agentic tool loop (ChatV2 §3, capped iterations).
// The model drives: it may call tools, gets the results appended, and answers
// when it has enough. Correctness by construction still holds — the model can
// only assert what a tool returned, and every executor result is data we
// verified ourselves. Iterations are CAPPED (v2 doc: "cap at 4") so a confused
// model can never loop the wallet.

const MAX_ITERATIONS = 4;

/**
 * @param {object} opts
 *   messages       provider-neutral [{role, content}] — system + history + user
 *   tools          OpenAI-style tool schema list
 *   execute        map { toolName: async (args) => resultObject }
 *   maxIterations  default 4
 *   maxTokens, temperature, model
 * @param {object} deps  { provider } — must implement completeWithTools()
 * @returns {{ text, toolCalls: [{name, args, result}], usage, iterations }}
 */
async function runToolLoop({ messages, tools, execute, maxIterations = MAX_ITERATIONS, maxTokens = 500, temperature = 0.4, model = null } = {}, deps = {}) {
    const provider = deps.provider;
    if (!provider || typeof provider.completeWithTools !== 'function') {
        throw new Error('[toolLoop] deps.provider.completeWithTools is required');
    }
    const convo = [...(messages || [])];
    const toolCalls = [];
    const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    let iterations = 0;

    while (iterations < maxIterations) {
        iterations++;
        // Last allowed round gets NO tools — forces a final answer instead of
        // a dangling tool call that would end the turn with silence.
        const allowTools = iterations < maxIterations;
        const res = await provider.completeWithTools({
            messages: convo,
            tools: allowTools ? tools : undefined,
            maxTokens,
            temperature,
            model,
        });
        usage.in += res.usage?.in || 0;
        usage.out += res.usage?.out || 0;
        const msg = res.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) {
            return { text: msg.content || '', toolCalls, usage, iterations };
        }
        convo.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
        for (const call of calls) {
            const name = call.function?.name;
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* junk args → {} */ }
            let result;
            const fn = execute?.[name];
            if (!fn) {
                result = { error: `unknown_tool: ${name}` };
            } else {
                try { result = await fn(args); }
                catch (err) { result = { error: `tool_failed: ${err.message}` }; }
            }
            toolCalls.push({ name, args, result });
            convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
    }
    // Cap reached with a still-dangling call — should be unreachable because the
    // final round runs without tools, but never return silence.
    return { text: '', toolCalls, usage, iterations };
}

module.exports = { runToolLoop, MAX_ITERATIONS };
