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
    const parts = formattedAddress.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { country: null, city: null };
    const country = parts[parts.length - 1] || null;
    let city = null;
    if (parts.length >= 2) {
        // Strip postal codes ("Yerevan 0009" → "Yerevan", "Paris 75001" → "Paris").
        city = parts[parts.length - 2].replace(/\b[A-Z]{0,2}[- ]?\d{3,8}\b/g, '').trim() || null;
    }
    return { country, city };
}

module.exports = { parseAddressRegion };
