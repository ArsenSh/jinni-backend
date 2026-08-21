// Jinni V2 Engine — delimiter-split streaming (pure).
// The streamed narration format is: prose first (streams live to the user),
// then a delimiter line, then a private JSON tail (card blurbs + follow-up
// question). This splitter forwards prose deltas as they arrive while HOLDING
// BACK any suffix that could be the start of the delimiter — so the delimiter
// never leaks to the user even when it arrives split across chunks (the same
// class of bug as v1's SSE chunk-boundary lesson, aiRoutes ~1870).

const CARDS_DELIMITER = '<<<CARDS>>>';

class DelimitedSplitter {
    /**
     * @param {(text: string) => void} onText  called with safe-to-show prose
     * @param {string} [delimiter]
     */
    constructor(onText, delimiter = CARDS_DELIMITER) {
        this.onText = onText;
        this.delimiter = delimiter;
        this._buf = '';        // held-back text (possible partial delimiter)
        this._tail = null;     // everything after the delimiter (null = not seen)
        this.prose = '';       // all prose emitted so far
    }

    /** Longest suffix of s that is a prefix of the delimiter (0 = none). */
    _partialSuffixLen(s) {
        const max = Math.min(s.length, this.delimiter.length - 1);
        for (let len = max; len > 0; len--) {
            if (s.endsWith(this.delimiter.slice(0, len))) return len;
        }
        return 0;
    }

    feed(chunk) {
        if (this._tail !== null) { this._tail += chunk; return; }
        this._buf += chunk;
        const at = this._buf.indexOf(this.delimiter);
        if (at !== -1) {
            const prose = this._buf.slice(0, at);
            this._tail = this._buf.slice(at + this.delimiter.length);
            this._buf = '';
            if (prose) { this.prose += prose; this.onText(prose); }
            return;
        }
        const hold = this._partialSuffixLen(this._buf);
        const safe = this._buf.slice(0, this._buf.length - hold);
        this._buf = this._buf.slice(this._buf.length - hold);
        if (safe) { this.prose += safe; this.onText(safe); }
    }

    /** Flush; returns the JSON tail (trimmed) or null when no delimiter came. */
    finalize() {
        if (this._tail === null && this._buf) {
            // No delimiter — the held-back suffix was ordinary prose after all.
            this.prose += this._buf;
            this.onText(this._buf);
            this._buf = '';
        }
        return this._tail !== null ? this._tail.trim() : null;
    }
}

module.exports = { DelimitedSplitter, CARDS_DELIMITER };
