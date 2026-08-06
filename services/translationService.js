const translate = require('translate-google-api');

class UniversalTranslationService {
    constructor() { this.defaultLanguage = 'en' }

    /**
     * Detect if text needs translation and translate to English
     */
    async detectAndTranslate(text) {
        try {
            if (!text || typeof text !== 'string') { return { original: text, translated: text, isEnglish: true, confidence: 1 } }
            const cleanText = text.trim();
            if (cleanText.length < 2) { return { original: text, translated: text, isEnglish: true, confidence: 1 } }
            const isLikelyEnglish = this.isLikelyEnglish(cleanText);
            if (isLikelyEnglish) {
                // console.log(`\n✅ Text is already in English: "${cleanText}"`);
                return { original: text, translated: text, isEnglish: true, confidence: 0.9 };
            }
            // console.log(`\n🔄 Translating from detected language: "${cleanText}"`);
            const translatedText = await this.translateToEnglish(cleanText);
            return { original: text, translated: translatedText, isEnglish: false, originalLanguage: 'auto', confidence: 0.8 };
        } catch (error) {
            console.error('\n❌ Translation error:', error);
            return { original: text, translated: text, isEnglish: true, confidence: 0, error: error.message };
        }
    }

    /**
     * Simple English detection heuristic
     */
    isLikelyEnglish(text) {
        const englishIndicators = [
            'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'get',
            'hotel', 'restaurant', 'museum', 'park', 'street', 'avenue', 'square',
            'find', 'show', 'tell', 'recommend', 'suggest', 'where', 'what', 'how',
            'best', 'good', 'nice', 'beautiful', 'amazing', 'wonderful'
        ];
        const words = text.toLowerCase().split(/\s+/);
        let englishWordCount = 0;
        let totalWords = 0;
        words.forEach(word => {
            if (word.length > 2) { 
                totalWords++;
                if (englishIndicators.some(indicator => word.includes(indicator) || indicator.includes(word))) { englishWordCount++ }
            }
        });
        const confidence = totalWords > 0 ? englishWordCount / totalWords : 0;
        const isEnglish = confidence > 0.3;
        // console.log(`\n🔍 English detection: ${isEnglish} (confidence: ${confidence}) for: "${text.substring(0, 50)}"`);
        return isEnglish;
    }

    /**
     * Translate any language to English using Google Translate
     */
    async translateToEnglish(text) {
        try {
            // console.log(`🌐 Translating: "${text}"`);
            const result = await translate(text, { to: 'en' });
            const translatedText = Array.isArray(result) ? result[0] : result;
            // console.log(`✅ Translated: "${text}" → "${translatedText}"`);
            return translatedText;
        } catch (error) {
            console.error('❌ Google Translate error:', error);
            return text;
        }
    }

    /**
     * Extract place names from translated English text
     */
    extractPlaceNames(text) {
        const placeNames = [];
        // Strategy 1: Look for "in [place]" pattern
        const inPattern = /\b(?:in|at|near|around|close to|within)\s+([^,.!?]+?)(?=\s|$|,|\.)/gi;
        let match;
        while ((match = inPattern.exec(text)) !== null) {
            const potentialPlace = match[1].trim();
            if (this.isValidPlaceName(potentialPlace)) {
                //console.log(`Found place via "in" pattern: ${potentialPlace}`);
                placeNames.push(potentialPlace);
            }
        }
        // Strategy 2: Look for capitalized proper nouns (likely place names)
        const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
        const capitalizedMatches = text.match(capitalizedPattern) || [];
        capitalizedMatches.forEach(match => {
            if (this.isValidPlaceName(match) && !placeNames.includes(match)) {
                //console.log(`Found capitalized place: ${match}`);
                placeNames.push(match);
            }
        });
        // Strategy 3: Look for specific place name patterns
        const commonPlaceSuffixes = [
            'hotel', 'restaurant', 'museum', 'park', 'square', 'street', 'avenue',
            'temple', 'church', 'cathedral', 'monastery', 'fortress', 'palace',
            'bridge', 'tower', 'garden', 'market', 'airport', 'station'
        ];
        commonPlaceSuffixes.forEach(suffix => {
            const pattern = new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*)\\s+${suffix}\\b`, 'gi');
            let indicatorMatch;
            while ((indicatorMatch = pattern.exec(text)) !== null) {
                const potentialPlace = indicatorMatch[1].trim();
                if (this.isValidPlaceName(potentialPlace) && !placeNames.includes(potentialPlace)) {
                    // console.log(`📍 Found place with ${suffix}: ${potentialPlace}`);
                    placeNames.push(potentialPlace);
                }
            }
        });
        // Strategy 4: Look for known city/country names
        const knownPlaces = [
            'Yerevan', 'Erevan', 'Gyumri', 'Dilijan', 'Sevan', 'Garni', 'Geghard',
            'Armenia', 'Russia', 'Georgia', 'Turkey', 'Iran',
            'Moscow', 'Saint Petersburg', 'Tbilisi', 'Batumi', 'Istanbul', 'Tehran'
        ];
        knownPlaces.forEach(place => {
            if (text.includes(place) && !placeNames.includes(place)) {
                // console.log(`Found known place: ${place}`);
                placeNames.push(place);
            }
        });
        // console.log(`\nFinal extracted place names:`, placeNames);
        return placeNames;
    }

    /**
     * Check if a string is a valid place name
     */
    isValidPlaceName(name) {
        if (!name || name.length < 2) return false;
        const commonWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'about', 'into', 'through', 'during',
            'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our',
            'tell', 'show', 'find', 'recommend', 'suggest', 'want', 'need', 'me',
            'best', 'good', 'nice', 'beautiful', 'amazing', 'wonderful', 'please',
            'where', 'what', 'how', 'when', 'why', 'which',
            // Greetings/acks — Strategy 2 treats any capitalized word as a place
            // candidate, so without these "Hi" became a Places API lookup (and
            // could recenter the session on a random business named "Hi").
            // Only reachable via the fallback tier now, but keep the net anyway.
            'hi', 'hello', 'hey', 'yo', 'ok', 'okay', 'thanks', 'thank', 'thx',
            'yes', 'no', 'yep', 'nope', 'yeah', 'sure', 'cool', 'great', 'nice',
            'bye', 'goodbye', 'morning', 'evening', 'night', 'today', 'tomorrow',
            'yesterday', 'wow', 'hmm', 'lol'
        ]);
        const isCommonWord = commonWords.has(name.toLowerCase());
        const hasNumbers = /\d/.test(name);
        const isTooShort = name.length < 2;
        return !isCommonWord && !hasNumbers && !isTooShort;
    }
    /**
     * Sophisticated travel query detection
     */
    isTravelQuery(message) {
        const lowerMessage = message.toLowerCase();
        const primaryKeywords = [
            'restaurant', 'cafe', 'hotel', 'accommodation', 'stay', 
            'attraction', 'landmark', 'museum', 'monument', 'temple',
            'destination', 'travel', 'vacation', 'trip', 'visit',
            'tourist', 'sightseeing', 'things to do', 'places to see'
        ];
        const secondaryKeywords = [
            'suggest', 'recommend', 'best', 'good', 'popular',
            'looking for', 'find a', 'show me', 'what to', 'where to',
            'near me', 'around here', 'in this area'
        ];
        const contextPatterns = [
            /(restaurant|hotel|place).*(suggest|recommend|find)/i,
            /(best|good).*(restaurant|hotel|place to)/i,
            /(things to do|places to visit).*(in|near)/i,
            /(looking for|need).*(accommodation|place to stay|place to eat)/i
        ];
        const hasPrimary = primaryKeywords.some(keyword => lowerMessage.includes(keyword));
        const hasSecondary = secondaryKeywords.some(keyword => lowerMessage.includes(keyword) && message.length > 10);        
        const hasContext = contextPatterns.some(pattern => pattern.test(message));
        const result = hasPrimary || hasSecondary || hasContext;
        // console.log(`🧭 Travel query detection: "${message.substring(0, 50)}..." → ${result} (primary: ${hasPrimary}, secondary: ${hasSecondary}, context: ${hasContext})`);
        // console.log('\n');
        return result;
    }

    /**
     * Extract keywords from user message for preferences
     */
    extractKeywordsForPreferences(text, excludePlaceNames = []) {
        const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !this.isCommonWord(word) && !excludePlaceNames.some(place => place.toLowerCase().includes(word) || word.includes(place.toLowerCase())) );
        const keywords = words.filter(word => !/^\d+$/.test(word) && word.length >= 3 && !['want', 'need', 'looking', 'find', 'show', 'tell', 'me', 'you', 'please'].includes(word) );
        // console.log(`🔑 Extracted keywords for preferences:`, keywords);
        return [...new Set(keywords)]; 
    }
    isCommonWord(word) {
        const commonWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'about', 'into', 'through', 'during',
            'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our',
            'tell', 'show', 'find', 'recommend', 'suggest', 'want', 'need', 'me'
        ]);
        return commonWords.has(word.toLowerCase());
    }

    
}

module.exports = new UniversalTranslationService();