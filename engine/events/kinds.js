// Event KIND from title + description — a fact for the brain, never a filter.
// Founder 2026-09-19: "events to visit with my girlfriend" dealt five classical
// and folk performances; "romantic" meant something else to him. The agent
// could not see that all five were one kind. Keyword lists in the languages
// the shelf actually carries (en / hy / ru / fr); unknown ⇒ 'event'.
// Word lists per kind. Latin words match as whole words; Armenian and Russian
// words match as PREFIXES (the shelf carries inflected forms — "համերգային",
// "фестиваля") and JS's \b is ASCII-only, so they get a Unicode left boundary.
const WORDS = {
    party:      'disco|party|dj|rave|nightlife|afterparty|вечеринк|дискотек|диджей|դիսկո|երեկույթ|soirée',
    jazz:       'jazz|blues|джаз|ջազ',
    classical:  'opera|symphon|philharmon|orchestra|organ|choir|chamber|quartet|recital|baroque|ensemble|tchaikovsky|mozart|bach|опер|симфон|оркестр|орган|хор|камерн|օպերա|սիմֆոն|նվագախումբ|երգեհոն|երգչախումբ|համույթ|կամերային|opéra|symphonie|orchestre|chœur',
    theatre:    'theatre|theater|ballet|drama|musical|stand-up|standup|comedy|спектакл|театр|балет|стендап|комеди|թատրոն|բալետ|ներկայացում|կատակերգ|théâtre|humour',
    exhibition: 'exhibition|gallery|vernissage|выставк|галере|вернисаж|ցուցահանդես|պատկերասրահ|exposition|galerie',
    food_wine:  'wine|tasting|brunch|dinner|gastro|cocktail|дегустац|бранч|ужин|գինի|համտես|ընթրիք|dégustation|dîner',
    sports:     'match|football|basketball|marathon|tournament|матч|футбол|баскетбол|марафон|турнир|ֆուտբոլ|բասկետբոլ|մարաթոն|առաջնություն',
    family:     'kids|children|family|puppet|детск|семейн|մանկական|ընտանեկան|enfants|famille',
    outdoor:    'hike|hiking|trek|camping|open-air|picnic|sunset|поход|пикник|արշավ|պիկնիկ|randonnée',
    festival:   'festival|fest|фестивал|փառատոն',
    concert:    'concert|gig|singer|band|концерт|гастрол|համերգ|երգիչ|երգչուհի',
};
const _isLatin = (w) => /^[\x00-\x7F\u00C0-\u024F-]+$/.test(w);
const KINDS = Object.entries(WORDS).map(([kind, list]) => {
    const words = list.split('|');
    const latin = words.filter(_isLatin).map(w => w.replace(/[-]/g, '[- ]?'));
    const other = words.filter(w => !_isLatin(w));
    const parts = [];
    if (latin.length) parts.push(`\\b(?:${latin.join('|')})s?\\b`);   // plural too: "concerts"
    if (other.length) parts.push(`(?<!\\p{L})(?:${other.join('|')})`);
    return [kind, new RegExp(parts.join('|'), 'iu')];
});
function eventKind(title = '', description = '') {
    const text = `${title} ${description}`.normalize('NFC');
    for (const [kind, re] of KINDS) if (re.test(text)) return kind;
    return 'event';
}
module.exports = { eventKind, KINDS: KINDS.map(([k]) => k) };
