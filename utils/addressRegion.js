// Parse country / city out of a Google `formatted_address`.
//
// Google formatted addresses end with the country ("91 Teryan St, Yerevan
// 0009, Armenia"); the city is the second-to-last comma component with any
// postal code stripped. This is a heuristic for scoping staff moderation
// queues — NOT a geocoder — and matching downstream is case-insensitive
// regex (same contract as Business.location matching), so minor formatting
// noise is tolerable. Unparseable → nulls, which simply leaves the place
// outside every staff scope until an admin re-runs the backfill.
function parseAddressRegion(formattedAddress) {
    if (!formattedAddress || typeof formattedAddress !== 'string') return { country: null, city: null };
    // Google emits comma-separated addresses almost everywhere, but some
    // regions (notably the UAE) come dash-separated: "Gate Village - DIFC -
    // Dubai - United Arab Emirates". With no comma to split on, the WHOLE
    // string used to land in `country`, which is how full addresses ended up
    // as country names in the coverage table. Split on " - " when there are
    // no commas. Also strip Plus Codes ("44J8+5V") — they masquerade as
    // address components.
    const raw = formattedAddress.replace(/\b[A-Z0-9]{4,8}\+[A-Z0-9]{2,3}\b/g, ' ');
    const parts = (raw.includes(',') ? raw.split(',') : raw.split(/\s+-\s+/))
        .map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { country: null, city: null };
    const country = parts[parts.length - 1] || null;
    let city = null;
    if (parts.length >= 2) {
        // Strip postal codes ("Yerevan 0009" → "Yerevan", "Paris 75001" → "Paris").
        city = parts[parts.length - 2].replace(/\b[A-Z]{0,2}[- ]?\d{3,8}\b/g, '').trim() || null;
        // Prefer a Latin-script variant when the tail segments are local-script
        // duplicates ("… - نخلة جميرا - دبي - United Arab Emirates"): walk back
        // for the nearest segment containing Latin letters that is not a street.
        if (city && !/[A-Za-z]/.test(city)) {
            for (let i = parts.length - 3; i >= 0; i--) {
                const cand = parts[i].replace(/\b[A-Z]{0,2}[- ]?\d{3,8}\b/g, '').trim();
                if (/[A-Za-z]/.test(cand) && !/\b(st|street|rd|road|ave|avenue|blvd)\b/i.test(cand)) { city = cand; break; }
            }
        }
    }
    return { country, city };
}

module.exports = { parseAddressRegion };
