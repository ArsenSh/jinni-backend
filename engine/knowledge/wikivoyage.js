// Wikivoyage ingester — the practical city knowledge Jinni has no database for.
// (Arsen 2026-08-23: "lets build wikivoyage and fcdo".)
//
// WHY this source: for a city like Yerevan there is NO open transit feed
// anywhere, at any price — so "which bus, which marshrutka, how do taxis work"
// can never come from routing data. Wikivoyage's "Get around" section is
// written by travelers who actually went, and it is one of the few free,
// commercially-usable sources that carries it.
//
// LICENCE: CC BY-SA 4.0 — attribution is a duty, not a nicety, so every row
// stores sourceName/sourceUrl/license and the answer shows them.
//
// RATE LIMITS (changed in 2026, and the trap here): an anonymous client with
// no identifying User-Agent gets 10 requests/minute; one that identifies
// itself properly gets 200. A single header is a 20x difference — so the UA is
// not optional.

const axios = require('axios');

const UA = 'JinniTravelBot/1.0 (+https://jinni.travel; travel assistant; contact via jinni.travel)';
const API = 'https://en.wikivoyage.org/w/api.php';
const TIMEOUT_MS = 10000;
const MAX_BODY = 4000;          // keeps prompts affordable; sections run long

// Section name → our topic. Wikivoyage headings are stable across articles.
const SECTION_TOPICS = [
    { heading: 'Get around', topic: 'get_around' },
    { heading: 'Get in', topic: 'get_in' },
    { heading: 'Stay safe', topic: 'safety' },
    { heading: 'Connect', topic: 'connect' },
    { heading: 'Buy', topic: 'money' },
];

async function _api(params, deps = {}) {
    const get = deps.get || axios.get;
    const res = await get(API, {
        params: { format: 'json', formatversion: 2, ...params },
        timeout: deps.timeoutMs || TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    return res?.data || null;
}

/** Wikitext → readable prose. Templates, links and markup are stripped; the
 *  traveler-facing sentences survive. */
function _wikitextToText(wt) {
    let t = String(wt || '');
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, '');
    // Listing templates carry the useful fields as name=value pairs; keep the
    // values, drop the scaffolding. Layout/map templates carry only coordinates
    // and styling, so they are dropped whole — otherwise Yerevan's "Get around"
    // opens with "40.17737 — 44.51265 — 13 — 470" (seen live 2026-08-23).
    const DROP_TEMPLATE = /^(mapframe|mapshape|map|geo|coord|pagebanner|routebox|climate|infobox|ispartof|\w*city|\w*region|disclaimer|cite|flag|nav|toc)\b/i;
    t = t.replace(/\{\{[^{}]*\}\}/g, (m) => {
        const inner = m.slice(2, -2);
        if (DROP_TEMPLATE.test(inner.trim())) return '';
        const fields = inner.split('|').slice(1)
            .map(f => f.includes('=') ? f.slice(f.indexOf('=') + 1).trim() : f.trim())
            .filter(v => v && v.length < 120);
        return fields.length ? fields.join(' — ') : '';
    });
    t = t.replace(/\{\{[\s\S]*?\}\}/g, '');            // any nested leftovers
    t = t.replace(/\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/g, '$1');
    t = t.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '');
    t = t.replace(/'''?/g, '').replace(/^[=]{2,}\s*(.*?)\s*[=]{2,}$/gm, '$1:');
    t = t.replace(/^[*#:;]+\s?/gm, '• ').replace(/<[^>]+>/g, '');
    // Residual parameter soup — a line with no real word in it is not prose.
    t = t.split('\n').filter(line => !line.trim() || /[A-Za-zА-Яа-яԱ-ֆ]{4,}/.test(line)).join('\n');
    return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Practical sections for one city.
 * @returns {Promise<Array<{topic,title,body,sourceUrl,sourceName,license}>>} [] fail-open.
 */
async function fetchCityKnowledge(city, deps = {}) {
    const page = String(city || '').trim();
    if (!page) return [];
    try {
        const list = await _api({ action: 'parse', page, prop: 'sections' }, deps);
        const sections = list?.parse?.sections;
        if (!Array.isArray(sections) || !sections.length) return [];
        const pageTitle = list.parse.title || page;
        const sourceUrl = `https://en.wikivoyage.org/wiki/${encodeURIComponent(String(pageTitle).replace(/ /g, '_'))}`;

        const out = [];
        for (const { heading, topic } of SECTION_TOPICS) {
            const sec = sections.find(s => String(s.line || '').trim().toLowerCase() === heading.toLowerCase());
            if (!sec) continue;
            const parsed = await _api({ action: 'parse', page, prop: 'wikitext', section: sec.index }, deps);
            const body = _wikitextToText(parsed?.parse?.wikitext).slice(0, MAX_BODY);
            // A heading with one sentence under it is a stub, not knowledge.
            if (body.length < 120) continue;
            out.push({
                topic, title: `${pageTitle} — ${heading}`, body,
                sourceName: 'Wikivoyage', sourceUrl, license: 'CC BY-SA 4.0',
            });
        }
        return out;
    } catch (err) {
        console.warn(`[wikivoyage] ${page}: ${err.message}`);
        return [];
    }
}

module.exports = { fetchCityKnowledge, _wikitextToText, SECTION_TOPICS };
