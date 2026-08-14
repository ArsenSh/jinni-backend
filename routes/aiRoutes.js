const express = require('express');
const User = require('../models/User');
const Business = require('../models/Business');
const TravelQuery = require('../models/TravelQuery');
const Analytics = require('../models/Analytics');
const Destination = require('../models/Destination');
const AiFoundEvent = require('../models/AiFoundEvent');
const openai = require('../config/openai');
const googleService = require('../services/googleService');
const proximityService = require('../services/proximityService');
const { priceTier, tierFit, tierMismatch, isPriceAction } = require('../services/priceTier');
const googlePrefetch = require('../services/googlePrefetchService');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const { premiumTermEnd } = require('../utils/premium');
const { parseAddressRegion } = require('../utils/addressRegion');
const mongoose = require('mongoose');
const ChatSession = require('../models/ChatSession');
const Itinerary = require('../models/Itinerary');
const SavedPlace = require('../models/SavedPlace');
const translationService = require('../services/translationService');
const intentService = require('../services/intentService');
const PlaceCache = require('../models/PlaceCache');
const PlaceFeedback = require('../models/PlaceFeedback');
const imageStorageService = require('../services/imageStorageService');
const { usageTracker, estimateTokens } = require('../middleware/usageTracker');
const UserAILimit = require('../models/UserAILimit');
const AiDailyStats = require('../models/AiDailyStats');
const currencyService = require('../services/currencyService');
const emailService = require('../services/emailService');
const zoneAuction = require('../services/zoneAuction');
// ── Claude provider (parallel to DeepSeek; selected via AppConfig toggle) ──
const AppConfig = require('../models/AppConfig');
const claudeService = require('../services/claudeService');
const AiProviderDailyStats = require('../models/AiProviderDailyStats');
function getCurrentDateTime(userTimezone = 'UTC') {
    const date = new Date();
    const options = { timeZone: userTimezone };
    return {
        fullDate: date.toLocaleDateString('en-US', { ...options, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        time: date.toLocaleTimeString('en-US', { ...options, hour: '2-digit', minute: '2-digit', hour12: true }),
        month: date.toLocaleDateString('en-US', { ...options, month: 'long', year: 'numeric' }),
        timezone: userTimezone,
        isoDate: date.toISOString(),
        unixTimestamp: Date.now()
    };
}

async function getCurrentWeather(lat, lng) {
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&wind_speed_unit=kmh&timezone=auto`);
        const data = await response.json();
        const current = data.current;
        const weatherCodes = {
            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
            45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Drizzle',
            61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
            71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
            80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
            95: 'Thunderstorm', 96: 'Thunderstorm with hail'
        };
        const daily = data.daily;
        const weekForecast = daily.time.map((date, i) => ({
            date,
            max: daily.temperature_2m_max[i],
            min: daily.temperature_2m_min[i],
            rainProbability: daily.precipitation_probability_max[i],
            condition: weatherCodes[daily.weather_code[i]] || 'Unknown'
        }));
        return {
            temperature: current.temperature_2m,
            humidity: current.relative_humidity_2m,
            rainProbability: current.precipitation_probability,
            condition: weatherCodes[current.weather_code] || 'Unknown',
            windSpeed: current.wind_speed_10m,
            weekForecast
        };
    } catch (error) {
        console.error('Weather fetch failed:', error);
        return null;
    }
}

class JinniContextManager {
    constructor() {
        this.TOKEN_LIMITS = {chat_stream: 3000, quick_action: 1200, view_more: 800, general_query: 2500, max_response: 1000};
        this.MESSAGE_LIMITS = {chat_stream: 10, quick_action: 4, view_more: 3, short_conversation: 6, long_conversation: 8};
        this.STRATEGY_THRESHOLDS = {short_conversation: 15, medium_conversation: 30, long_conversation: 31};
        this.SESSION_LIMITS = {WARNING_THRESHOLD: 20, MAX_MESSAGES: 23, TOKEN_ESTIMATE_PER_MESSAGE: 250};
    }
    checkSessionHealth(session) {
        if (!session || !session.messages) { return { shouldWarn: false, shouldBlock: false, messageCount: 0 } }
        const messageCount = session.messages.length;
        const shouldWarn = messageCount >= this.SESSION_LIMITS.WARNING_THRESHOLD;
        const shouldBlock = messageCount >= this.SESSION_LIMITS.MAX_MESSAGES;        
        const estimatedTokens = messageCount * this.SESSION_LIMITS.TOKEN_ESTIMATE_PER_MESSAGE;
        // console.log(`📊 Session Health Check:`, {messageCount,shouldWarn,shouldBlock,estimatedTokens,warningThreshold: this.SESSION_LIMITS.WARNING_THRESHOLD,maxMessages: this.SESSION_LIMITS.MAX_MESSAGES});
        return {shouldWarn, shouldBlock, messageCount, estimatedTokens, remainingMessages: this.SESSION_LIMITS.MAX_MESSAGES - messageCount};
    }
    /**
     * Main method to get optimized context for any chat scenario, now changed, loads conversation and gives to systemMessage
     */
    async getOptimizedContext(sessionId, actionType = 'chat_stream', currentMessage = '', userPreferences = {}, nearbyMode = false, effectiveLocation = null, userTimezone = 'UTC', destinationInfo = null, weatherData = null, replyLangName = null) {
        try {
            const session = await ChatSession.findById(sessionId);
            const healthCheck = this.checkSessionHealth(session);
            if (healthCheck.shouldBlock) {
                console.log('🚫 Session blocked - too many messages');
                return {blocked: true, reason: 'session_too_long', messageCount: healthCheck.messageCount, maxMessages: this.SESSION_LIMITS.MAX_MESSAGES};
            }
            if (healthCheck.shouldWarn && !session.isNearLimit) {
                await ChatSession.findByIdAndUpdate(sessionId, { isNearLimit: true });
                console.log('⚠️ Session marked as near limit');
            }
            const previousMessages = session?.messages || [];            
            // ── Itinerary grounding ─────────────────────────────────────────
            // History messages only carry itineraryId — a pointer. Without
            // dereferencing it, the model can't answer "is the stop on day 2
            // worth it?" about a trip IT generated. Load the referenced trips
            // (capped to the 2 most recent — token control) and render a
            // compact day-by-day summary into the history at the message where
            // each itinerary was created. Field-selected + lean; failures are
            // swallowed so a broken itinerary can never break chat.
            let itinSummaries = {};
            let itinPlaceNames = [];
            try {
                const itinIds = [...new Set(previousMessages.map(m => m && m.itineraryId).filter(Boolean))].slice(-2);
                if (itinIds.length > 0) {
                    const itinDocs = await Itinerary.find({ _id: { $in: itinIds } })
                        .select('title destination.name daysCount days.dayNumber days.title days.slots.time days.slots.name days.slots.category days.slots.place.name')
                        .lean();
                    for (const it of itinDocs) {
                        const lines = [`[Generated trip itinerary "${it.title || it.destination?.name || 'Trip'}" — ${it.daysCount} day(s) in ${it.destination?.name || 'the destination'}. When the user asks about this trip or its stops, answer from THIS plan:]`];
                        for (const d of (it.days || [])) {
                            const stops = (d.slots || [])
                                .map(s => `${s.time ? s.time + ' ' : ''}${(s.place && s.place.name) || s.name}${s.category ? ' (' + s.category + ')' : ''}`)
                                .join('; ');
                            lines.push(`Day ${d.dayNumber}${d.title ? ` — ${d.title}` : ''}: ${stops || '(empty)'}`);
                            for (const s of (d.slots || [])) {
                                const n = (s.place && s.place.name) || s.name;
                                if (n) itinPlaceNames.push(String(n).trim());
                            }
                        }
                        itinSummaries[String(it._id)] = lines.join('\n');
                    }
                }
            } catch (itinErr) {
                console.warn('[context] itinerary grounding skipped:', itinErr.message);
            }
            let conversationContext = '';
            if (previousMessages.length > 0) {
                const formattedHistory = previousMessages.map(msg => {
                    const sender = msg.sender === 'user' ? 'User' : 'Jinni';
                    let content = '';                
                    if (msg.text && msg.text.trim()) {content = msg.text.trim()}                
                    if (msg.recommendations && msg.recommendations.length > 0) {
                        const cardDescriptions = msg.recommendations
                            .filter(rec => rec.description && rec.description.trim())
                            .map(rec => {
                                let desc = rec.description;
                                desc = desc.replace(/→/g, 'to').replace(/←/g, '');
                                return `Recommended ${rec.category || 'place'}: ${rec.name} - ${desc}`;
                            })
                            .join('\n');
                        if (cardDescriptions) {content += (content ? '\n' : '') + cardDescriptions}
                    }
                    if (msg.itineraryId && itinSummaries[msg.itineraryId]) {
                        content += (content ? '\n' : '') + itinSummaries[msg.itineraryId];
                    }
                    return `${sender}: ${content}`;
                }).join('\n');
                conversationContext = formattedHistory;
            }
            // Names already recommended earlier in THIS session, so the model can be
            // told explicitly not to repeat them. Without this the model keeps
            // returning its top-of-mind list ("suggest others" → same hotels again),
            // because the prior recs are only buried in the history text, not called
            // out as an exclusion. De-duplicated; most-recent-last.
            const alreadyRecommended = [...new Set([
                ...previousMessages
                    .filter(m => m.sender === 'ai' && Array.isArray(m.recommendations))
                    .flatMap(m => m.recommendations.map(r => r && r.name).filter(Boolean))
                    .map(n => n.trim()),
                // Stops already placed in a generated itinerary count as "shown"
                // too — "suggest something else" shouldn't re-offer trip stops.
                ...itinPlaceNames,
            ])];
            const systemMessage = this.getSystemMessage(actionType, userPreferences, nearbyMode, conversationContext, effectiveLocation, currentMessage, userTimezone, destinationInfo, weatherData, replyLangName, alreadyRecommended);
            // Stable placeIds of everything shown earlier in THIS session. The prompt
            // exclusion above is by NAME, which the model dodges with variants ("Hotel
            // Alexander" vs "The Alexander…" vs "Alexander") that all resolve to the
            // same Google place. The placeId is the reliable key, used by the post-
            // resolution filter to guarantee no repeat regardless of the name used.
            const alreadyRecommendedPlaceIds = [...new Set(
                previousMessages
                    .filter(m => m.sender === 'ai' && Array.isArray(m.recommendations))
                    .flatMap(m => m.recommendations.map(r => r && r.placeId).filter(Boolean))
            )];
            // Center of the MOST RECENT prior recommendations. Lets follow-up turns
            // that name no new place ("how many stars are these?") keep using the
            // established destination as the search center instead of snapping back to
            // the user's GPS — which otherwise re-resolves the same names near the user
            // and returns look-alikes (a Yerevan "Seasons Hotel" for Cyprus's "Four
            // Seasons"). Uses stored rec coords, so no extra geocoding.
            let lastRecommendationCenter = null;
            for (let i = previousMessages.length - 1; i >= 0; i--) {
                const m = previousMessages[i];
                if (m.sender !== 'user' && Array.isArray(m.recommendations) && m.recommendations.length) {
                    const pts = m.recommendations.filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
                    if (pts.length) {
                        lastRecommendationCenter = {
                            lat: pts.reduce((s, r) => s + r.latitude, 0) / pts.length,
                            lng: pts.reduce((s, r) => s + r.longitude, 0) / pts.length
                        };
                        break;
                    }
                }
            }
            // console.log(`✅ Using system message WITH conversation context (including card descriptions)`);
            return {messages: [systemMessage], healthCheck, alreadyRecommendedPlaceIds, lastRecommendationCenter, alreadyRecommendedNames: alreadyRecommended};
        } catch (error) {
            console.error('Context generation failed:', error);
            return {messages: [this.getSystemMessage(actionType)], healthCheck: { shouldWarn: false, shouldBlock: false, messageCount: 0 }};
        }
    }
    /**
     * Convert Jinni database messages to OpenAI chat format
     */
    formatMessagesForAI(messages) { return messages.filter(msg => msg.text && msg.text.trim() && !msg.hidden).map(msg => ({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text.trim() })) }
    /**
     * Strategy 1: Full context for short conversations (â‰¤8 messages)
     */
    getFullContext(messages, systemMessage) {
        console.log('Using full context strategy');
        return [systemMessage, ...messages];
    }
    /**
     * Strategy 2: Minimal context for quick actions
     */
    getMinimalContext(messages, systemMessage, actionType) {
        const limit = this.MESSAGE_LIMITS[actionType];
        const recentMessages = messages.slice(-limit);
        console.log(`âš¡ Using minimal context strategy (${recentMessages.length} messages)`);
        return [systemMessage, ...recentMessages];
    }
    /**
     * Strategy 3: Rolling window for medium conversations (9-20 messages)
     */
    getRollingWindow(messages, systemMessage, actionType) {
        const messageLimit = this.MESSAGE_LIMITS[actionType];
        const tokenLimit = this.TOKEN_LIMITS[actionType];
        let context = [systemMessage];
        let tokenCount = this.estimateTokens(systemMessage.content);        
        const recentMessages = messages.slice(-4);
        recentMessages.forEach(msg => {
            context.push(msg);
            tokenCount += this.estimateTokens(msg.content);
        });        
        const remainingMessages = messages.slice(0, -4).reverse();
        for (const msg of remainingMessages) {
            const msgTokens = this.estimateTokens(msg.content);
            if (tokenCount + msgTokens <= tokenLimit && context.length < messageLimit + 1) {
                context.splice(1, 0, msg);
                tokenCount += msgTokens;
            } else { break }
        }
        console.log(`Using rolling window: ${context.length-1} COMPLETE messages, ~${tokenCount} tokens`);
        return context;
    }
    /**
     * Strategy 4: Compressed context for long conversations (21+ messages)
     */
    getCompressedContext(messages, systemMessage, actionType, currentInput) {
        const tokenLimit = this.TOKEN_LIMITS[actionType];
        const recentMessages = messages.slice(-4);
        const olderMessages = messages.slice(0, -4);
        const summary = this.createConversationSummary(olderMessages, currentInput);
        let context = [systemMessage];
        let tokenCount = this.estimateTokens(systemMessage.content);
        if (summary && tokenCount + this.estimateTokens(summary) < tokenLimit * 0.3) {
            context.push({ role: 'system', content: `Previous conversation context: ${summary}` });
            tokenCount += this.estimateTokens(summary);
        }
        for (const msg of recentMessages) {
            const msgTokens = this.estimateTokens(msg.content);
            if (tokenCount + msgTokens <= tokenLimit) {
                context.push(msg);
                tokenCount += msgTokens;
            }
        }
        console.log(`Using compressed context strategy (${context.length-1} messages + summary, ~${tokenCount} tokens)`);
        return context;
    }
    /**
     * Create intelligent summary of older conversation parts
     */
    createConversationSummary(messages) {
        if (messages.length === 0) return '';
        const summary = {topics: new Set(), locations: new Set(), preferences: new Set(), questions: []};
        messages.forEach(msg => {
            const content = msg.content.toLowerCase();
            if (content.includes('restaurant') || content.includes('dining')) summary.topics.add('dining');
            if (content.includes('hotel') || content.includes('accommodation')) summary.topics.add('accommodation');
            if (content.includes('museum') || content.includes('historical')) summary.topics.add('culture');
            if (content.includes('hidden gem')) summary.topics.add('hidden gems');
            if (content.includes('event') || content.includes('activity')) summary.topics.add('activities');
            if (content.includes('transport') || content.includes('travel')) summary.topics.add('transportation');
            const locationMatches = msg.content.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(Hotel|Restaurant|Museum|Park|Square|Street|Avenue|Temple|Monastery)\b/g);
            if (locationMatches) { locationMatches.forEach(loc => summary.locations.add(loc)); }
            if (content.includes('budget')) summary.preferences.add('budget-conscious');
            if (content.includes('luxury')) summary.preferences.add('luxury');
            if (content.includes('family')) summary.preferences.add('family-friendly');
            if (content.includes('romantic')) summary.preferences.add('romantic');
            if (content.includes('adventure')) summary.preferences.add('adventure');
            if (msg.role === 'user' && (content.includes('?') || content.includes('how') || content.includes('what') || content.includes('where'))) { summary.questions.push(content.substring(0, 50)); }
        });
        const summaryParts = [];
        if (summary.topics.size > 0) { summaryParts.push(`Discussed topics: ${Array.from(summary.topics).join(', ')}`); }
        if (summary.locations.size > 0) { summaryParts.push(`Mentioned places: ${Array.from(summary.locations).slice(0, 4).join(', ')}`); }
        if (summary.preferences.size > 0) { summaryParts.push(`User preferences: ${Array.from(summary.preferences).join(', ')}`); }
        if (summary.questions.length > 0) { summaryParts.push(`Recent questions: ${summary.questions.slice(-2).join('; ')}`); }
        return summaryParts.join('. ') + '.';
    }
    /**
     * Get system message based on action type and maintain Jinni's personality
     */
    getSystemMessage(actionType = 'chat_stream', userPreferences = {}, nearbyMode = false, conversationContext = '', effectiveLocation = null, userMessage = '', userTimezone = 'UTC', destinationInfo = null, weatherData = null, replyLangName = null, alreadyRecommended = [])  {
        const hasPreferences = userPreferences && ((userPreferences.interests && userPreferences.interests.length > 0) || userPreferences.travelStyle ||(userPreferences.budget && userPreferences.budget.min && userPreferences.budget.max));
        let preferenceText = '';
        const dateTime = getCurrentDateTime(userTimezone);
        const isGPS = effectiveLocation?.source === 'real_time';
        const isPrivacyMode = effectiveLocation?.privacyMode === true || destinationInfo?.mode === 'privacy_destination';
        const destCity = effectiveLocation?.city || destinationInfo?.city || '';
        const destCountry = effectiveLocation?.country || destinationInfo?.country || '';
        let timeContext;
        if (isGPS) {timeContext = `- Time: ${dateTime.time} (${dateTime.timezone}) — this matches the user's physical location`} 
        else if (isPrivacyMode) {timeContext = `- Device time: ${dateTime.time} (${dateTime.timezone})\n- User is privately browsing destination: ${destCity}${destCountry ? ', ' + destCountry : ''}. You do NOT know their physical location. Never imply or guess where they physically are.`} 
        else {timeContext = `- Device time: ${dateTime.time} (${dateTime.timezone})\n- User is exploring: ${destCity}${destCountry ? ', ' + destCountry : ''}. Use local time at the destination for opening hours and recommendations.`}
        let locationContext = '';
        if (effectiveLocation && !effectiveLocation.error) {
            const locationLabel = isGPS ? "User's current location" : isPrivacyMode ? "User's chosen destination (not their physical location)" : "User's selected destination";
            if (effectiveLocation.city) {locationContext = `[${locationLabel}: ${effectiveLocation.city}${effectiveLocation.country ? ', ' + effectiveLocation.country : ''}]`} 
            else {locationContext = `[${locationLabel} set at coordinates ${effectiveLocation.lat}, ${effectiveLocation.lng}]`}
        } else {locationContext = `[No destination or GPS location is set. If the user asks anything travel-related AND has not mentioned place name in request, remind them to set a destination in Settings or enable GPS.]`}
        // console.log('Sending date/time to AI:', {fullDate: dateTime.fullDate,time: dateTime.time,month: dateTime.month,timezone: dateTime.timezone,isoDate: dateTime.isoDate,timestamp: dateTime.unixTimestamp});
        const weatherContext = weatherData ? `
            CURRENT WEATHER AT DESTINATION:
            - Condition: ${weatherData.condition}
            - Temperature: ${weatherData.temperature}°C
            - Humidity: ${weatherData.humidity}%
            - Rain probability: ${weatherData.rainProbability}%
            - Wind: ${weatherData.windSpeed} km/h
            7-DAY FORECAST:
            ${weatherData.weekForecast.map(d => `- ${d.date}: ${d.condition}, ${d.min}°C - ${d.max}°C, rain ${d.rainProbability}%`).join('\n')}
            Use this to give practical advice about best days to visit, what to wear, activities to avoid on rainy days, etc.
        ` : '';
        let modeContext = '';
        if (nearbyMode) { modeContext = `- NEARBY MODE: User wants places within short distance ` }
        let preferenceConflictNotice = '';
        if (hasPreferences && userMessage) {
            const conflicts = detectPreferenceConflict(userMessage, userPreferences);
            if (conflicts.length > 0) {
                const styleConflict = conflicts.find(c => c.type === 'travelStyle');
                const interestConflict = conflicts.find(c => c.type === 'interest');  
                const clusterConflict = conflicts.find(c => c.type === 'cluster_overload');
                const scatteredConflict = conflicts.find(c => c.type === 'too_scattered');
                const broadQueryConflict = conflicts.find(c => c.type === 'query_too_broad');
                const outdoorConflict = conflicts.find(c => c.type === 'conflicting_outdoor');          
                if (styleConflict) {
                    preferenceConflictNotice += `\nPREFERENCE NOTICE: User's query mentions "${styleConflict.detected}" style, but their saved preference is "${styleConflict.saved}". `;
                    preferenceConflictNotice += `After answering their question, gently remind them: "I noticed you're looking for ${styleConflict.detected} options, but your saved preference is set to ${styleConflict.saved}. If you want more tailored ${styleConflict.detected} recommendations in the future, please update your travel style in Preferences."`;
                }            
                if (interestConflict && !styleConflict) {
                    const detectedList = interestConflict.interests || [interestConflict.detected];
                    if (detectedList.length === 1) {
                        preferenceConflictNotice += `\nPREFERENCE NOTICE: User is asking about "${detectedList[0]}" which isn't in their saved interests. `;
                        preferenceConflictNotice += `After providing recommendations, casually mention: "If you enjoy ${detectedList[0]}, consider adding it to your interests in Preferences section for more personalized suggestions."`;
                    } else {
                        const interestsList = detectedList.join(', ');
                        preferenceConflictNotice += `\nPREFERENCE NOTICE: User is asking about multiple new interests: "${interestsList}" which aren't in their saved preferences. `;
                        preferenceConflictNotice += `After providing recommendations, casually mention: "I noticed you're interested in ${interestsList}. Consider adding these to your interests in Preferences section for better recommendations."`;
                    }
                }
                if (clusterConflict) {
                    preferenceConflictNotice += `\nPREFERENCE NOTICE: User has too many interests in the ${clusterConflict.cluster} category (${clusterConflict.saved.join(', ')}). `;
                    preferenceConflictNotice += `After answering, remind them: "You have many cultural interests selected (${clusterConflict.saved.join(', ')}). Consider narrowing to 1-2 main cultural interests in Preferences for better recommendations."`;
                }
                if (scatteredConflict) {
                    preferenceConflictNotice += `\nPREFERENCE NOTICE: User has ${scatteredConflict.savedCount} saved interests but is asking about ${scatteredConflict.detectedCount} new ones (${scatteredConflict.detected.join(', ')}). This is too broad. `;
                    preferenceConflictNotice += `After answering, remind them: "You have ${scatteredConflict.savedCount} interests saved and are asking about ${scatteredConflict.detectedCount} new ones. This makes it hard to give personalized recommendations. Please update your Preferences to focus on your main 2-3 interests."`;
                }
                if (broadQueryConflict) {
                    preferenceConflictNotice += `\nPREFERENCE NOTICE: User's query spans too many categories (${broadQueryConflict.categories.join(', ')}). `;
                    preferenceConflictNotice += `After answering, remind them: "Your query covers many different interests (${broadQueryConflict.detected.join(', ')}). For better recommendations, try narrowing to 1-2 main interests in Preferences."`;
                }
                if (outdoorConflict) {
                    preferenceConflictNotice += `\nPREFERENCE NOTICE: User has ${outdoorConflict.saved.join(' + ')} in preferences but is asking about ${outdoorConflict.detected}. These can conflict. `;
                    preferenceConflictNotice += `After answering, mention: "I noticed you have ${outdoorConflict.saved.join(' and ')} in your Preferences, but you're asking about ${outdoorConflict.detected}. These outdoor styles can conflict. Consider updating Preferences to clarify your preferred outdoor experience."`;
                }
            }
        }
        if (hasPreferences) {
            preferenceText = 'USER PREFERENCES:\n';
            if (userPreferences.interests && userPreferences.interests.length > 0) { preferenceText += `- Interests: ${userPreferences.interests.join(', ')}\n` }
            if (userPreferences.travelStyle) { preferenceText += `- Travel Style: ${userPreferences.travelStyle}\n` }
            if (userPreferences.budget && userPreferences.budget.min && userPreferences.budget.max) {
                const userCurrency = userPreferences.budget.currency || 'USD';
                const budgetMin = userPreferences.budget.min;
                const budgetMax = userPreferences.budget.max;                
                const currencySymbols = { 'USD': '$', 'EUR': '€', 'GBP': '£', 'RUB': '₽' };
                const symbol = currencySymbols[userCurrency] || userCurrency;
                preferenceText += `- Budget: ${symbol}${budgetMin.toLocaleString()} - ${symbol}${budgetMax.toLocaleString()} ${userCurrency}\n`;                
                if (userCurrency !== 'USD') {
                    const normalizedBudget = currencyService.normalizeBudgetToUSD(userPreferences.budget);
                    preferenceText += `  (Converted to USD: $${normalizedBudget.min.toFixed(2)} - $${normalizedBudget.max.toFixed(2)} for accurate filtering)\n`;
                }
            }
            preferenceText += preferenceConflictNotice;
        } else { preferenceText = 'USER HAS NOT SET PREFERENCES YET. If the user asks for recommendations, suggest they set their preferences for better personalized suggestions.' }
        
        let conversationText = '';
        if (conversationContext) { conversationText = `CONVERSATION CONTEXT (What we've discussed so far):\n${conversationContext}\n\n` + `CURRENT QUERY: You are now answering the user's latest question.\n` } 
        else { conversationText = `NEW CONVERSATION: This is the first message in this chat.\n` }

        // When the caller resolved a concrete reply language, pin it by NAME — a
        // named directive ("Respond ONLY in Russian") is followed far more reliably
        // by smaller models than "the same language as the user", and it removes the
        // English-context bias that made replies drift. Callers that don't supply a
        // language keep the old self-detect behaviour.
        const languageRule = replyLangName
            ? `- LANGUAGE (most important): Respond ONLY in ${replyLangName}. Every sentence of your reply MUST be in ${replyLangName}, regardless of the language of these instructions or of the bracketed [verified places] data (those are English for internal use only). Do NOT switch to English. IMPORTANT: place names inside **...** must stay in their original Latin form even when the rest of the sentence is in ${replyLangName} — this is required for the map lookup to work.`
            : `- LANGUAGE (most important): Write your ENTIRE reply in the same language as the user's actual question. Detect that language from the user's own words only — ignore the language of these instructions and of any bracketed [verified places] data, which are always in English for internal use. Never default to English unless the user's question is in English. (Place names inside **...** stay in their original Latin form regardless.)`;

        // Hard "don't repeat" instruction. Far more effective than leaving the prior
        // recs buried in the history text. Capped to the most recent names to keep the
        // prompt lean. When the user asks for "more / others", the model MUST return
        // places not in this list.
        const exclusionRule = (Array.isArray(alreadyRecommended) && alreadyRecommended.length)
            ? `\n                - NO REPEATS (critical): You have ALREADY recommended these places earlier in THIS conversation — do NOT suggest any of them again, and do not merely reword them: ${alreadyRecommended.slice(-40).join(', ')}. Every place in this reply MUST be new and absent from that list. If you genuinely run out of strong new options, say so honestly instead of repeating.`
            : '';

        const systemMessage = `You are Jinni, professional AI travel assistant. You're enthusiastic and knowledgeable.
                ${modeContext}
                CRITICAL RULES:
                ${languageRule}${exclusionRule}
                - Avoid using emojis in responses
                - STAY ON TOPIC - if user asks about a specific place, focus ONLY on that place
                - When providing recommendations, format as: **Place Name** → description ← (inside ARROW, one arrow INITIALLY other at the END)
                - NEVER invent contact details. Do not state phone numbers, email addresses, exact street numbers, or booking URLs unless they were explicitly provided in your context — models guess these and wrong numbers harm users. For reservations, say to check the place's Google Maps listing or official website instead. Price estimates given AS ranges and clearly approximate are fine.
                - The arrows are REQUIRED for every recommended place. Never write a place name in **bold** without immediately following it with → its description ←. Example of the ONLY correct form: **Grand Hotel Yerevan** → Central hotel with a rooftop pool. ←
                - Each **Name** → description ← block must stand ALONE as its own paragraph. NEVER embed it in the middle of a sentence — the block is replaced by a visual card, so any words around it become broken fragments. WRONG: "It offers easy access to the **Akamas Peninsula** → a protected nature reserve. ← You can also explore…" (renders as "It offers easy access to the" followed by a card). CORRECT: finish the sentence in plain prose first ("It offers easy access to the Akamas Peninsula."), then put the card block on its own line, and write the description as a COMPLETE standalone sentence ("A protected nature reserve perfect for hiking and spotting sea turtles."), not a lowercase sentence fragment.
                - Places already shown to the user earlier in this chat may be FREELY discussed, compared, ranked, and referenced in plain prose — the user knows them, that is normal conversation. The only restriction is presentation: do not format an already-shown place as a NEW **Name** → … ← card again. If the user asks to compare or choose among places you already recommended, do it directly in prose and give a clear answer. NEVER refuse such a request, and NEVER mention internal lists, rules, or that a place "was in the already recommended list" — those are system internals, invisible to the user.
                - Card format (**Name** → description ←) is for a SPECIFIC, mappable place: a named hotel, restaurant, museum, attraction or business — and ALSO for a city, town, region or natural area WHEN the user is choosing between destinations/areas (e.g. "which area of Cyprus should I visit" → Paphos, Limassol and Troodos Mountains may each be a card). When the destination is already settled and you are recommending venues WITHIN it, the city name stays in plain prose and only the individual venues are cards. Whole countries (Cyprus, Armenia) are NEVER cards.
                - Reserve **bold** for place names ONLY. Do not use bold for emphasis on ordinary words (write luxury, not **luxury**), so bold always signals a recommendation.
                - Do NOT number or bullet the recommendations. Put each on its own line starting exactly with ** — never prefix them with "1.", "2.", "-", or "•". The numbering is added automatically.
                - The **Name** → description ← card format is ONLY for introducing NEW places the user has not seen yet. When the user asks a question ABOUT places already shown in this conversation — their star rating, price, which is closest, comparing them, etc. — answer in plain prose and write each place name in PLAIN TEXT, never in **bold**. Bold is reserved exclusively for a NEW place being introduced as a card; using it for an already-shown place makes the system re-render its card, which is wrong. Example — correct: "The Four Seasons is rated 5 stars, and the Amara is also 5 stars." Wrong: "**Four Seasons** is rated 5 stars."
                - Focus on practical information: prices, hours, key features
                - Google verifiable names only, use official, real place names that exist on Google Maps/search. Never invent or combine names
                - PLACE NAME FORMAT: If a place name exists in multiple countries or cities, add the city name so Google returns the correct location. Example: use "Central Park, New York" not just "Central Park". For unique landmarks (Taj Mahal, Stonehenge), name only is fine.
                CURRENT DATE & TIME:
                - Today: ${dateTime.fullDate}
                ${timeContext}
                - Current month: ${dateTime.month}
                ${weatherContext}
                ${preferenceText}
                ${locationContext}
                'CONVERSATION GUIDELINES
                - Answer the above question directly and concisely. Don't reference previous messages.
                - When users ask for travel suggestions or recommendations, provide 3 specific options
                - Ask follow-up questions to better understand user needs
                - Keep responses engaging but concise
                ${conversationText}`;
        // console.log('🗺️ Location context for AI:', locationContext);
        return { role: 'system', content: systemMessage };
    }
    createStructuredResponse(text, recommendations) {
        const sections = [];
        let currentText = text;
        for (const rec of recommendations) {
            const namePattern = new RegExp(`\\b${rec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            const matchIndex = currentText.search(namePattern);
            if (matchIndex !== -1) {
                if (matchIndex > 0) { sections.push({ type: 'text', content: currentText.substring(0, matchIndex) }) }
                sections.push({ type: 'recommendation', data: rec });
                currentText = currentText.substring(matchIndex + rec.name.length);
            }
        }
        if (currentText.length > 0) { sections.push({ type: 'text', content: currentText }) }
        return sections;
    }
    /**
     * Estimate token count (rough approximation)
     */
    estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / 3.5);
    }
}

const router = express.Router();

async function resolveEffectiveLocation(user, requestLocation = null, messages = 'en') {
    const privacy = user?.settings?.privacy;
    const settingsLocation = user?.settings?.location;
    // console.log('\n📍 LOCATION RESOLUTION:');
    // console.log(`  Privacy - Auto-detect: ${privacy?.autoDetectLocation}`);
    // console.log(`  Privacy - Permission granted: ${privacy?.locationPermissionGranted}`);
    // console.log(`  Settings Location: ${settingsLocation?.city}, ${settingsLocation?.countryName}`);
    // console.log(`  Settings Coords: ${settingsLocation?.coordinates?.lat}, ${settingsLocation?.coordinates?.lng}`);
    // console.log(`  Request Location: ${requestLocation ? `${requestLocation.lat}, ${requestLocation.lng}` : 'none'}`);
    // console.log(`  Radius Settings - Nearby: ${user?.settings?.searchRadius?.nearby}km`);
    // console.log(`  Radius Settings - Discovery: ${user?.settings?.searchRadius?.discovery}km`);
    const hasValidCoords = (coords) => { return coords && typeof coords.lat === 'number' && typeof coords.lng === 'number' && coords.lat !== 0 && coords.lng !== 0 && Math.abs(coords.lat) <= 90 && Math.abs(coords.lng) <= 180 };
    // CASE 1: User disabled auto-detect location (privacy conscious)
    if (privacy?.autoDetectLocation === false) {
        // console.log('  ⚠️ Auto-detect DISABLED - must use settings location');
        if (hasValidCoords(settingsLocation?.coordinates)) {
            // console.log('  ✅ Using settings location (privacy mode)');
            return {
                lat: settingsLocation.coordinates.lat,
                lng: settingsLocation.coordinates.lng,
                source: 'user_settings',
                city: settingsLocation.city,
                country: settingsLocation.countryName,
                privacyMode: true,
                nearbyRadius: user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: user?.settings?.searchRadius?.discovery || 50
            };
        } else {
            console.log('  ❌ No valid location in settings - USER ACTION REQUIRED');
            return {error: 'location_required', message: messages.location_no_coordinates, requiresUserAction: true};
        }
    }
    // CASE 2: Auto-detect enabled - prefer real-time location if available
    if (privacy?.autoDetectLocation !== false) {
        if (hasValidCoords(requestLocation)) {
            // console.log('✅ Using real-time request location');
            return {
                lat: requestLocation.lat,
                lng: requestLocation.lng,
                source: 'real_time',
                privacyMode: false,
                nearbyRadius: user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: user?.settings?.searchRadius?.discovery || 50
            };
        }
        if (hasValidCoords(settingsLocation?.coordinates)) {
            // console.log('✅ Using settings location (fallback)');
            return {
                lat: settingsLocation.coordinates.lat,
                lng: settingsLocation.coordinates.lng,
                source: 'user_settings',
                city: settingsLocation.city,
                country: settingsLocation.countryName,
                privacyMode: false,
                nearbyRadius: user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: user?.settings?.searchRadius?.discovery || 50
            };
        }
        console.log('⚠️ No valid location available');
        return {error: 'location_required', message: messages.location_gps_unavailable, requiresUserAction: true};
    }
    // CASE 3: No location available at all
    console.log('❌ No valid location found\n');
    return {error: 'location_required', message: messages.location_required, requiresUserAction: true};
}

router.post('/chat-stream', auth, usageTracker, async (req, res) => {
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    let messages = '';
    // console.log('\n\n\n============ CHAT-STREAM DEBUG START ============');
    // console.log(`📊 Request ID: ${requestId}`);
    let streamAborted = false;
    function cleanupStream() {
        streamAborted = true;
        if (!res.writableEnded) {
            try { 
                res.write(`data: ${JSON.stringify({ type: 'stream_interrupted', partialText: fullResponse })}\n\n`);
                res.end();
            } catch (e) { console.log('Stream already closed') }
        }
    }
    const isClientDisconnected = setupConnectionMonitoring(req, res, () => {
        try {
            // console.log('🛑 Client disconnected from chat stream');
            cleanupStream();
        } catch (error) { console.error('Error in disconnect handler:', error.message) }
    });
    let effectiveLocation = null;
    try {
        // === STEP 1: Extract and validate request data ===
        const { message, actionType = 'chat_stream', sessionId, location, nearbyMode = false, userTimezone = 'UTC', destinationInfo = null } = req.body;
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required and must be a string.' });
        }
        if (message.length > 2000) {
            console.log(`🚫 Input rejected - ${message.length} chars exceeds 2000 limit`);
            return res.status(400).json({ error: 'Message too long. Maximum 2000 characters allowed.' });
        }
        const userId = req.user.id;
        let detectedActionType = 'general';
        let estimatedTokens = 0;
        let actualTokensUsed = 0;
        // Load the user + their language BEFORE the usage gate. Previously `messages`
        // was still '' at the cooldown check below, so a limited user got a 429 with
        // message: undefined. `messages` is (re)loaded from the resolved reply
        // language further down once we've detected the language of this message.
        const user = await User.findById(userId).select('preferences settings');
        const userPreferences = user?.preferences || {};
        const userLanguage = user?.settings?.language || 'en';
        messages = getAllMessages(userLanguage);
        // console.log('\n📊 USAGE TRACKING - INITIAL STATE:');
        // console.log(`   User ID: ${userId}`);
        // console.log(`   Has userLimit: ${!!req.userLimit}`);
        // if (req.userLimit) {
        //     const initialStatus = await req.userLimit.getUsageStatus();
        //     console.log(`   Daily Tokens: ${initialStatus.daily.tokens.used}/${initialStatus.daily.tokens.limit} (${initialStatus.daily.tokens.percentage}%)`);
        //     console.log(`   Daily Places: ${initialStatus.daily.places.viewed}/${initialStatus.daily.places.limit} (${initialStatus.daily.places.percentage}%)`);
        //     console.log(`   Is Premium: ${initialStatus.isPremium}`);
        //     console.log(`   On Cooldown: ${initialStatus.cooldown.active}`);
        // }
        try {
            const userLimit = req.userLimit;
            if (userLimit) {
                estimatedTokens = estimateTokens(message) + 500; 
                // console.log(`\n🔍 USAGE CHECK:`);
                // console.log(`   Estimated tokens for this request: ${estimatedTokens}`);
                // console.log(`   Message length: ${message.length} chars`);
                const usageStatus = await userLimit.checkAndUpdateUsage(estimatedTokens, 0, 1);   // 3rd arg counts the query — was 0, so avgTokensPerQuery never updated from chat
                // console.log(`\n✅ USAGE CHECK PASSED:`);
                // console.log(`   Tokens used this request: ${estimatedTokens}`);
                // console.log(`   Total daily tokens: ${usageStatus.dailyTokensUsed}/${usageStatus.dailyTokensUsed + usageStatus.dailyTokensRemaining}`);
                // console.log(`   Remaining tokens: ${usageStatus.dailyTokensRemaining}`);
                // console.log(`   Daily places: ${usageStatus.dailyPlacesViewed}`);
                // console.log(`   On cooldown: ${usageStatus.onCooldown}`);               
                res.set('X-Usage-Tokens-Used', usageStatus.dailyTokensUsed.toString());
                res.set('X-Usage-Tokens-Remaining', usageStatus.dailyTokensRemaining.toString());
                res.set('X-Usage-Places-Viewed', usageStatus.dailyPlacesViewed.toString());
                res.set('X-Usage-Places-Remaining', usageStatus.dailyPlacesRemaining.toString());
                if (usageStatus.estimatedRequestsRemaining != null) { res.set('X-Usage-Requests-Remaining', usageStatus.estimatedRequestsRemaining.toString()); }
                if (usageStatus.onCooldown) {
                    // console.log(`\n⏸️ USER ON COOLDOWN until ${usageStatus.cooldownUntil}`);
                    return res.status(429).json({type: 'cooldown', message: messages.cooldown_simple, cooldownUntil: usageStatus.cooldownUntil, reason: 'daily_limit_exceeded'});
                }
            }
        } catch (limitError) {
            console.log(`\n🚫 USAGE LIMIT EXCEEDED: ${limitError.message}`);
            return res.status(429).json({ type: 'cooldown', message: limitError.message, cooldownUntil: req.userLimit?.cooldownUntil });
        }
        // (user, userPreferences, userLanguage, messages already loaded above,
        //  before the usage gate — do not re-fetch here.)
        // console.log('\nREQUEST DATA:');
        // console.log(`  - Message: ${message}`);
        // console.log(`  - Session ID: ${sessionId}`);
        // console.log(`  - Location: `, location); 
        if (isClientDisconnected()) return;
        const originalMessage = message;
        // === STEP 1.5: Intent pre-pass ==========================================
        // One structured classification replaces the old heuristic pile:
        //   detectAndTranslate (Google Translate fired on "Hi"/"Ok"/"Thanks"),
        //   extractPlaceNames (capitalized greetings geocoded via Places, which
        //   could recenter the session on a random business named "Hi"),
        //   isTravelQuery keyword lists ("best way to learn Python" → travel),
        //   the detectedActionType regex chain, and the weather regex.
        // Greetings short-circuit for free; the LLM tier sees recent turns so
        // follow-ups like "any cheaper ones?" classify correctly; on LLM
        // error/timeout intentService falls back to the ORIGINAL keyword logic.
        //
        // SECURITY: the session is peeked here (ownership + last turns in ONE
        // query) because the classifier needs recent context. The ownership 403
        // that used to sit just before getOptimizedContext moved up to this
        // point — history must never be read into ANY prompt (intent or chat)
        // for a session this user doesn't own. A not-yet-persisted session (new
        // chat) is still allowed.
        let recentTurns = [];
        const [appCfg, sessionPeek] = await Promise.all([
            AppConfig.getConfig().catch(() => ({})),
            sessionId
                ? ChatSession.findById(sessionId).select({ userId: 1, activeDestination: 1, messages: { $slice: -6 } }).lean().catch(() => null)
                : Promise.resolve(null)
        ]);
        if (sessionPeek && String(sessionPeek.userId) !== String(userId)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this conversation.' });
        }
        if (sessionPeek && Array.isArray(sessionPeek.messages) && sessionPeek.messages.length > 0) {
            recentTurns = sessionPeek.messages
                .filter(m => m && m.text)
                .slice(-4)
                .map(m => ({ sender: m.sender, text: String(m.text).slice(0, 300) }));
        }
        const intent = await intentService.classify({ message, recentTurns, userLanguage, appCfg });
        const processedMessage = intent.translated || message;

        // ── Resolve the reply language ─────────────────────────────────────────
        // The model used to be asked to re-detect the language itself, which drifts
        // toward English because the whole prompt is English. Instead we pin it here.
        // Policy: the user's SETTING is the floor; a confident, substantive sentence
        // in another language overrides it. So a Russian-setting user who types a full
        // English question gets English, but a short/place-name query ("hotels in
        // Yerevan?") stays on their setting rather than flipping to English.
        const LANG_NAMES = { en: 'English', ru: 'Russian', zh: 'Chinese', hy: 'Armenian', fr: 'French', ar: 'Arabic' };
        let replyLang = userLanguage;
        {
            // Language now comes from the intent pre-pass: proper detection on
            // the LLM tier; script-based guess on the fastpath/fallback tiers
            // (those tiers are treated as not-confident, so they keep the
            // user's setting rather than flipping the reply language).
            const detected = intent.language ? String(intent.language).slice(0, 2).toLowerCase() : null;
            let confident = intent.source === 'llm';
            // Script sanity: the classifier sometimes labels an English message
            // with the CONVERSATION's language ("compare the first two" -> ru in
            // a Russian-heavy chat), which flipped the reply into Russian. A
            // non-Latin language may only flip the reply if the message actually
            // contains that script.
            const SCRIPT_OF = { ru: /[\u0400-\u04FF]/, hy: /[\u0530-\u058F]/, ar: /[\u0600-\u06FF]/, zh: /[\u4E00-\u9FFF]/, el: /[\u0370-\u03FF]/, he: /[\u0590-\u05FF]/, ja: /[\u3040-\u30FF\u4E00-\u9FFF]/, ko: /[\uAC00-\uD7AF]/ };
            if (confident && detected && SCRIPT_OF[detected] && !SCRIPT_OF[detected].test(message || '')) { confident = false; }
            const wordCount = (message || '').trim().split(/\s+/).filter(w => /\p{L}/u.test(w)).length;
            if (detected && LANG_NAMES[detected] && detected !== userLanguage && confident && wordCount >= 4) {
                replyLang = detected;
            }
        }
        const replyLangName = LANG_NAMES[replyLang] || 'the user\'s language';
        // Align conversational/error strings with the language we'll answer in.
        messages = getAllMessages(replyLang);
        
        // console.log(`  - Processed Message: ${processedMessage}`);
        // console.log(`  - Was Translated: ${!translationResult.isEnglish}`);
        // console.log(`  - Translation Confidence: ${translationResult.confidence}`);
        if (isClientDisconnected()) return;
        // Only destinations the user explicitly named in THIS message (validated
        // by intentService) — no more geocoding of capitalized greetings.
        const placeNames = Array.isArray(intent.placeNames) ? intent.placeNames : [];
        let placeCoordinates = null;
        let primaryPlaceName = null;
        // Only GEOGRAPHIC places may change the search center. The intent
        // classifier sometimes puts VENUE names into place_names ("Tell me about
        // The Harbour" → places=["The Harbour"]); geocoding that, biased to the
        // user's GPS, once matched a harbour near Yerevan and HIJACKED a Paphos
        // session to Armenia — wrong proximity results, wrong partner cards, and
        // the wrong point was even saved as the session's activeDestination.
        // Asking about a restaurant is not a destination change.
        const venueAskCandidates = [];   // venues the user asked about by name this turn
        const GEO_DESTINATION_TYPES = new Set(['locality', 'sublocality', 'postal_town', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'administrative_area_level_4', 'country', 'natural_feature', 'archipelago', 'colloquial_area', 'political', 'continent']);
        if (placeNames.length > 0) {
            for (const placeName of placeNames) {
                // console.log(`\nLooking up coordinates for: ${placeName}`);
                const candidate = await getCoordinatesForPlace(placeName, location, requestId);
                if (!candidate) continue;
                const isGeographic = !Array.isArray(candidate.types) || candidate.types.length === 0   // legacy/memo shape without types → keep old behavior
                    || candidate.types.some(t => GEO_DESTINATION_TYPES.has(String(t).toLowerCase()));
                if (!isGeographic) {
                    console.log(`[destination] "${placeName}" resolved to a venue ("${candidate.placeName}", types=${JSON.stringify(candidate.types)}) — not recentering the session`);
                    // …but DON'T waste the resolution: the user is asking ABOUT this
                    // venue, so remember it for the verified-grounding fetch below.
                    venueAskCandidates.push({ askedName: placeName, resolvedName: candidate.placeName, placeId: candidate.placeId });
                    continue;
                }
                placeCoordinates = candidate;
                primaryPlaceName = candidate.placeName;
                break;
            }
        } else { // console.log(`\n- 🚫 No place names extracted from message`) 
        }
        effectiveLocation = await resolveEffectiveLocation(user, location, messages);
        // If the user named a destination in the message ("hotels in Cyprus" while
        // physically in Yerevan), THAT destination — not their GPS/settings location —
        // is the search center for discovery. Previously placeCoordinates was geocoded
        // and then discarded here: resolveEffectiveLocation only ever returns the
        // physical location, so enrichment, the cache lookup, and distance filtering
        // all anchored on the wrong city (a Cyprus query pulling a Moscow cache hit,
        // legitimate Cyprus results filtered out). The DB business query already used
        // placeCoordinates (line below), so the two halves disagreed. Unify them here.
        // In nearbyMode the user explicitly wants results around themselves, so keep GPS.
        if (placeCoordinates && !nearbyMode) {
            effectiveLocation = {
                lat: placeCoordinates.lat,
                lng: placeCoordinates.lng,
                source: 'message_destination',
                city: primaryPlaceName || placeCoordinates.placeName || null,
                privacyMode: effectiveLocation?.privacyMode || false,
                nearbyRadius: effectiveLocation?.nearbyRadius || user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: effectiveLocation?.discoveryRadius || user?.settings?.searchRadius?.discovery || 50
            };
            // Remember the named destination ON THE SESSION (fire-and-forget).
            if (sessionId) {
                ChatSession.updateOne({ _id: sessionId }, { $set: { activeDestination: {
                    name: effectiveLocation.city || placeCoordinates.placeName || null,
                    latitude: placeCoordinates.lat,
                    longitude: placeCoordinates.lng,
                    placeId: placeCoordinates.placeId || null,
                    updatedAt: new Date()
                } } }).catch(err => console.warn('[session] activeDestination save failed:', err.message));
            }
        }
        // ── Session destination fallback ─────────────────────────────────────
        // No place named THIS turn + not nearby mode → reuse the session's
        // established destination. Before this, staying centered on Paphos
        // worked only by accident: the intent classifier kept leaking "Pafos"
        // into place_names, so the SAME city was re-geocoded via Google on
        // EVERY message. This runs before the location_required check (a
        // Paphos conversation can never wrongly 400) and before the system
        // prompt is built (the model is told the right city too). Unlike the
        // lastRecommendationCenter fallback further down, it needs no prior
        // cards, costs zero Google calls, and carries the city NAME.
        if (!placeCoordinates && !nearbyMode && sessionPeek && sessionPeek.activeDestination &&
            sessionPeek.activeDestination.latitude != null && sessionPeek.activeDestination.longitude != null) {
            effectiveLocation = {
                lat: sessionPeek.activeDestination.latitude,
                lng: sessionPeek.activeDestination.longitude,
                source: 'session_destination',
                city: sessionPeek.activeDestination.name || effectiveLocation?.city || null,
                privacyMode: effectiveLocation?.privacyMode || false,
                nearbyRadius: effectiveLocation?.nearbyRadius || user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: effectiveLocation?.discoveryRadius || user?.settings?.searchRadius?.discovery || 50
            };
            console.log(`[session] using saved destination "${effectiveLocation.city}" as search center`);
        }
        // console.log('\n🎯 EFFECTIVE LOCATION:', effectiveLocation);

        // Pre-pass decides if weather data is actually needed (the old regex
        // matched \b(week|days|hot|wear|pack)\b — "what should I wear tonight"
        // fetched a forecast). Fallback tier still uses the old regex.
        const isWeatherQuery = !!intent.needsWeather;
        let weatherData = null;
        if (isWeatherQuery && effectiveLocation && !effectiveLocation.error) {weatherData = await getCurrentWeather(effectiveLocation.lat, effectiveLocation.lng)}

        let lastProcessedLength = 0;
        let currentRecommendations = [];
        let emittedRecommendations = new Set();
        let inArrowBlock = false;
        let arrowBuffer = '';
        let currentDescriptionRec = null;
        let pendingName = '';
        const DETECTION_THROTTLE_MS = 400;
        let lastDetectionTimeRef = { current: 0 };
        let lastExtractedRecsRef = { current: [] };
        // === STEP 2: Determine conversation strategy ===
        const isTravelQuery = !!intent.isTravel;
        // Action type from the same classification (context-aware: "any cheaper
        // ones?" after a hotel list resolves to 'hotels'). Replaces the regex
        // chain that lived inside the business-data block below.
        if (intent.actionType && intent.actionType !== 'general') { detectedActionType = intent.actionType; }
        if (isTravelQuery && !placeCoordinates && (!effectiveLocation || effectiveLocation.error === 'location_required')) {
            console.log('❌ LOCATION REQUIRED: Travel query without destination mentioned');
            return res.status(400).json({
                success: false,
                error: 'location_required',
                message: messages.location_required_details,
                userMessage: messages.location_set_destination,
                action: 'configure_location',
                suggestions: [messages.location_suggestion_1, messages.location_suggestion_2]
            });
        }
        // ── Itinerary intent → hand off to the clarifier (no model call) ──────
        // The itinerary is NEVER built directly from a chat sentence: the chat
        // stream only detects the intent and tells the client to open the SAME
        // sequential clarifier (days → hotel) the quick-action button uses,
        // prefilled with whatever the message already answered ("plan 3 days in
        // Paris" → days=3, destination=Paris). One build path, one usage gate,
        // zero drift between the two entry points.
        //   • Primary signal: intent.actionType === 'itinerary' — add this label
        //     to intentService's LLM classifier for robust multilingual coverage.
        //   • Fallback: creation-verb + trip-noun regex on the (translated)
        //     message. Creation verbs are required on purpose: "what's on my
        //     itinerary for day 2?" must go to the NORMAL chat path, where the
        //     itinerary-grounding summary lets the model answer it.
        //   • Context-aware tier: in a session that already built an itinerary,
        //     a creation verb + a geographic destination counts even WITHOUT a
        //     trip-noun ("Can you build now for Limassol instead?") — the noun
        //     is implied by the conversation.
        // The most recent itinerary in the session's visible tail (newest last).
        const latestItineraryId = (sessionPeek && Array.isArray(sessionPeek.messages))
            ? (sessionPeek.messages.filter(m => m && m.itineraryId).map(m => m.itineraryId).pop() || null)
            : null;

        // ── "Update day N" → regenerate that day of the EXISTING itinerary ────
        // "can you update the second day of the trip?" must not become a plain
        // chat answer with stray rec cards: the user is editing the trip they
        // can see. Hand the client the itineraryId + day so it drives the SAME
        // regenerate-day flow the button uses (locked slots survive, geofence
        // and pace reused). Verb+day are both required, so "what's on day 2?"
        // still goes to the normal grounded-chat path.
        if (latestItineraryId) {
            const src = `${String(processedMessage || '')} ${String(originalMessage || '')}`;
            const REGEN_VERB_RE = /\b(?:update|change|regenerat\w*|redo|re-?build|refresh|re-?plan|re-?do|remake|improve|new\s+plan\s+for|swap\s+out)\b/i;
            let regenDay = null;
            const dNum = /\bday\s*(\d{1,2})\b/i.exec(src);
            if (dNum) regenDay = parseInt(dNum[1], 10);
            if (!regenDay) {
                const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
                const dOrd = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+day\b/i.exec(src);
                if (dOrd) regenDay = ORDINALS[dOrd[1].toLowerCase()];
            }
            if (regenDay >= 1 && regenDay <= 14 && REGEN_VERB_RE.test(src)) {
                const intro = (messages.itinerary_regen_day && messages.itinerary_regen_day.replace('{day}', regenDay))
                    || `Sure — regenerating day ${regenDay} of your itinerary now. Your kept (locked) stops stay in place; watch the trip update.`;
                res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8','Cache-Control': 'no-cache','Connection': 'keep-alive','Access-Control-Allow-Origin': '*','Access-Control-Allow-Headers': 'Cache-Control, Authorization, Content-Type','Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining'});
                res.write(`data: ${JSON.stringify({ type: 'token', content: intro })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'itinerary_day_regen', itineraryId: latestItineraryId, dayNumber: regenDay })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'complete', contentParts: [{ type: 'text', content: intro, index: 0 }], recommendations: [], metadata: {} })}\n\n`);
                return res.end();
            }
        }

        const ITINERARY_CREATE_RE = /\b(?:make|create|build|generate|plan|prepare|design|organi[sz]e)\b[^.?!\n]{0,60}\b(?:itinerar\w*|trip|travel\s+plan)\b|\bday[- ]by[- ]day\s+(?:plan|itinerar\w*)\b/i;
        const BARE_CREATE_VERB_RE = /\b(?:make|create|build|re-?build|generate|plan|re-?plan)\b/i;
        // Follow-up shorthand: right after building a trip, "now for Yerevan
        // please" / "what about Paris?" means "same itinerary, new destination"
        // — there is no verb to match. It fires ONLY when the message contains
        // essentially nothing but the destination plus connective filler:
        // "hotels in Paris" keeps its meaning because "hotels" survives the
        // stripping, and "is Yerevan safe?" survives via "is"/"safe".
        const isItineraryFollowUpShorthand = () => {
            if (!latestItineraryId || !placeCoordinates) return false;
            let residue = ` ${String(processedMessage || originalMessage || '').toLowerCase()} `;
            const placeStrings = [primaryPlaceName, placeCoordinates.placeName, ...(Array.isArray(intent.placeNames) ? intent.placeNames : [])];
            for (const pn of placeStrings) {
                if (pn) residue = residue.split(String(pn).toLowerCase()).join(' ');
            }
            residue = residue.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            const FILLER = new Set(['now', 'for', 'please', 'pls', 'what', 'about', 'how', 'and', 'also', 'then', 'next', 'same', 'one', 'again', 'instead', 'of', 'in', 'to', 'the', 'a', 'an', 'do', 'can', 'you', 'it', 'me', 'thanks', 'thank', 'ok', 'okay', 'lets', 'let', 's', 'go', 'with']);
            const leftovers = residue.split(' ').filter(w => w && !FILLER.has(w));
            return leftovers.length === 0;
        };
        const wantsItinerary = intent.actionType === 'itinerary'
            || ITINERARY_CREATE_RE.test(String(processedMessage || ''))
            || ITINERARY_CREATE_RE.test(String(originalMessage || ''))
            // Context tier: itinerary already in this session + creation verb +
            // a geographic destination geocoded from THIS message. A venue name
            // never reaches placeCoordinates (the geo-type gate above), so
            // "make a reservation at X" can't trigger this.
            || (!!latestItineraryId && !!placeCoordinates
                && (BARE_CREATE_VERB_RE.test(String(processedMessage || '')) || BARE_CREATE_VERB_RE.test(String(originalMessage || ''))))
            || isItineraryFollowUpShorthand();
        if (wantsItinerary) {
            // Days, if stated ("3 days", "3-day trip") — clamped to the schema's 1–14.
            const daysM = /(\d{1,2})\s*-?\s*days?\b/i.exec(String(processedMessage || ''))
                || /(\d{1,2})\s*-?\s*days?\b/i.exec(String(originalMessage || ''));
            let prefillDays = daysM ? parseInt(daysM[1], 10) : null;
            if (!(prefillDays >= 1 && prefillDays <= 14)) prefillDays = null;
            // Destination only when THIS message named one (geocoded + validated
            // above). Otherwise null → the build uses the same effective location
            // as the quick-action button, exactly as before.
            const prefillDestination = (placeCoordinates && Number.isFinite(placeCoordinates.lat) && Number.isFinite(placeCoordinates.lng))
                ? { name: primaryPlaceName || placeCoordinates.placeName || null, lat: placeCoordinates.lat, lng: placeCoordinates.lng }
                : null;
            const intro = messages.itinerary_lets_plan
                || (prefillDestination && prefillDestination.name
                    ? `Great — let's plan your trip to ${prefillDestination.name}. Answer the quick questions below and I'll build the day-by-day itinerary.`
                    : `Great — let's plan your trip. Answer the quick questions below and I'll build the day-by-day itinerary.`);
            res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8','Cache-Control': 'no-cache','Connection': 'keep-alive','Access-Control-Allow-Origin': '*','Access-Control-Allow-Headers': 'Cache-Control, Authorization, Content-Type','Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining'});
            res.write(`data: ${JSON.stringify({ type: 'token', content: intro })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'itinerary_clarifier', prefill: { daysCount: prefillDays, destination: prefillDestination } })}\n\n`);
            // Same completion shape as the normal path, so the client finalizes
            // the message (streaming=false, contentParts persisted) identically.
            res.write(`data: ${JSON.stringify({ type: 'complete', contentParts: [{ type: 'text', content: intro, index: 0 }], recommendations: [], metadata: {} })}\n\n`);
            return res.end();
        }
        // console.log('CONVERSATION ANALYSIS:');
        // console.log(`  - Travel query: ${isTravelQuery}`);
        // console.log(`  - Primary place: ${primaryPlaceName || 'None'}`);
        // console.log(`  - Location source: ${effectiveLocation?.source || 'user_provided'}\n`);
        // console.log('CHECKING SESSION HEALTH...');
        const contextManager = new JinniContextManager();
        // SECURITY: session ownership is verified in STEP 1.5 above — the same
        // single fetch that supplies the intent classifier's recent-turn context.
        // Any foreign sessionId was already refused with a 403 before ANY history
        // could be read into a prompt.
        const contextResult = await contextManager.getOptimizedContext(sessionId, actionType, message, userPreferences, nearbyMode, effectiveLocation, userTimezone, destinationInfo, weatherData, replyLangName);
        if (contextResult.blocked) {
            console.log('🚫 Session blocked - suggesting new chat');
            return res.status(400).json({
                success: false,
                error: 'session_limit_reached',
                message: `This conversation has reached ${contextResult.messageCount} messages. For better performance, please start a new chat.`,
                action: 'start_new_chat',
                metadata: {
                    currentMessages: contextResult.messageCount, 
                    maxMessages: contextResult.maxMessages, 
                    reason: 'Too many messages can slow down responses and consume lots of tokens'
                }
            });
        }
        const contextMessages = contextResult.messages;
        // ── App-capability framing ────────────────────────────────────────────
        // The provider model (DeepSeek/Claude) doesn't know it's embedded in an
        // app that verifies places live through Google. Left to itself it lectures
        // users about being "a fixed dataset" that "can't browse the internet" —
        // which is false of the APP (the user just watched it serve verified
        // phone numbers and live photos) and makes the product look inconsistent.
        // Pin the framing here, next to the grounding injection it complements.
        if (contextMessages[0] && typeof contextMessages[0].content === 'string') {
            contextMessages[0].content += `\n\nIMPORTANT — about your own capabilities: you are part of a travel app that verifies places through live Google data. NEVER describe your own architecture, training data, or knowledge cutoff, and NEVER tell the user you "cannot browse the internet", "have a fixed dataset", or "cannot access real-time information". If a specific detail (phone, hours, price) was provided to you as VERIFIED PLACE DATA, use it exactly. If it was NOT provided, simply say that detail isn't in your verified data right now and suggest the place's official website or Google Maps listing — nothing more.`;
        }
        // ── Verified place grounding ──────────────────────────────────────────────────────────
        // When the user asks about a SPECIFIC place — by typing its name or via a
        // card's "Ask" button (which sends a plain message, so name-matching here
        // covers it with no client change) — fetch that place's REAL details
        // through the same path the "More" button uses (cache-first; the data is
        // usually already in PlaceCache from card enrichment, so this often costs
        // zero Google calls) and hand the model the facts. Without this, DeepSeek
        // confidently INVENTED phone numbers for reservation questions; with it,
        // the model relays verified data instead of guessing.
        try {
            if (isTravelQuery) {
                const focusVenues = [];
                const msgLowerA = String(message || '').toLowerCase();
                const msgLowerB = String(processedMessage || '').toLowerCase();
                // (a) already-shown recommendations named in this message
                if (sessionPeek && Array.isArray(sessionPeek.messages)) {
                    for (const m of sessionPeek.messages) {
                        for (const r of (m.recommendations || [])) {
                            if (!r || !r.name) continue;
                            if (messageNamesPlace(msgLowerA, r.name) || messageNamesPlace(msgLowerB, r.name)) {
                                focusVenues.push({ askedName: r.name, resolvedName: r.name, placeId: r.placeId || null });
                            }
                        }
                    }
                }
                // (b) venue-ask candidates the destination gate resolved this turn
                for (const v of venueAskCandidates) focusVenues.push(v);
                // (c) contact-info question fallback ─────────────────────────────
                // "What's the phone number of St Raphael Resort?" produced NO focus
                // venue when the card wasn't in the last-6-message window (trigger a)
                // and the intent classifier returned places=[] (trigger b) — so the
                // model answered "I don't have it" while PlaceCache held the number.
                // When the message is clearly a contact-detail question, pull the
                // name after of/for/at and hand it to the SAME cache-first lookup.
                // Safe by construction: getCachedPlaceDetails already gates on name
                // plausibility, so a garbage extraction just returns null and the
                // block below skips it — behaviour identical to no trigger at all.
                if (focusVenues.length === 0) {
                    const CONTACT_ASK = /\b(?:phone(?:\s+number)?|telephone|number|call|contact|website|address|hours|opening\s+hours|open(?:ing)?\s+times?|email|book(?:ing)?|reserve|reservation)s?\b[^?.!]*?\b(?:of|for|at|to)\s+(?:the\s+)?([^?.!,\n]{3,60})/i;
                    for (const src of [message, processedMessage]) {
                        const m = CONTACT_ASK.exec(String(src || ''));
                        if (!m) continue;
                        let candidateName = m[1].trim().replace(/\s+/g, ' ')
                            .replace(/\s+(?:please|pls|thanks|thank you)\s*$/i, '');   // politeness tail
                        // Must look like a name: has letters, and is either multi-word
                        // or carries a capital — rejects generics the pattern can grab
                        // from phrasings like "call X to reserve" (→ "reserve").
                        if (!/\p{L}/u.test(candidateName)) continue;
                        const looksLikeName = /\s/.test(candidateName) || /\p{Lu}/u.test(candidateName);
                        if (!looksLikeName) continue;
                        focusVenues.push({ askedName: candidateName, resolvedName: candidateName, placeId: null });
                        console.log(`[grounding] contact-question fallback extracted venue: "${candidateName}"`);
                        break;
                    }
                }
                // dedupe (by placeId, else normalized name), cap at 2
                const seen = new Set();
                const unique = focusVenues.filter(v => {
                    const key = v.placeId || String(v.resolvedName || v.askedName).toLowerCase().trim();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }).slice(0, 2);
                if (unique.length > 0) {
                    const lines = [];
                    for (const v of unique) {
                        const d = await getCachedPlaceDetails(v.resolvedName || v.askedName, true, requestId, effectiveLocation, v.placeId || null);
                        if (!d) continue;
                        const phone = d.formatted_phone_number || d.international_phone_number || null;
                        const hoursArr = d.opening_hours && (d.opening_hours.weekday_text || d.opening_hours.weekdayDescriptions);
                        const hours = Array.isArray(hoursArr) ? hoursArr.join('; ').slice(0, 300) : null;
                        lines.push(`• ${d.name}${d.formatted_address ? ' — ' + d.formatted_address : ''}` +
                            `${phone ? ' — Phone: ' + phone : ' — Phone: not listed on Google'}` +
                            `${d.website ? ' — Website: ' + d.website : ''}` +
                            `${d.rating ? ' — Google rating: ' + d.rating : ''}` +
                            `${hours ? ' — Hours: ' + hours : ''}`);
                        console.log(`[grounding] injected verified data for "${d.name}" (phone: ${phone ? 'yes' : 'no'})`);
                    }
                    if (lines.length > 0 && contextMessages[0] && typeof contextMessages[0].content === 'string') {
                        contextMessages[0].content += `\n\nVERIFIED PLACE DATA (live from Google — when answering about these places use EXACTLY these facts; if a phone number is marked "not listed", say to check the place's Google Maps listing instead of guessing):\n${lines.join('\n')}`;
                    }
                }
            }
        } catch (groundingErr) {
            console.warn('[grounding] skipped:', groundingErr.message);   // grounding must never break chat
        }
        const healthCheck = contextResult.healthCheck;
        // Places already shown earlier in this session — used by the post-resolution
        // dedup in processStreamCompletion to drop repeats the model reintroduces
        // under a different name.
        const alreadyShownPlaceIds = contextResult.alreadyRecommendedPlaceIds || [];
        // Names already shown, used to suppress LIVE streaming cards for repeats (the
        // placeId isn't known until enrichment, so streaming can't dedup by id). Without
        // this, a follow-up's repeat cards stream in, then vanish at completion when the
        // placeId filter drops them — a jarring "appeared then disappeared".
        const alreadyShownNames = contextResult.alreadyRecommendedNames || [];
        // ── Per-user place votes (PlaceFeedback) ─────────────────────────────────
        // Quick-action-stream already hides this user's dislikes; free chat never
        // did, so a disliked place could reappear in a chat reply. Free chat has no
        // quick-action category, so the hide can't be scoped by action the way the
        // backfill's is. Mirror /my-votes semantics instead: collapse this user's
        // rows to ONE current vote per placeId (most recently updated row wins) and
        // hide a place only when that latest vote is 'dislike'. A museum disliked
        // under 'events' but later liked under 'historical' is therefore NOT hidden.
        //   • userDislikedIds   — Google placeId or verified _id (whichever the vote
        //     was stored under); the authoritative filter, applied post-enrichment in
        //     processStreamCompletion where both ids are known.
        //   • userDislikedNames — denormalized vote names: (a) told to the model so
        //     it doesn't waste card slots on places that will be dropped anyway, and
        //     (b) used to suppress the LIVE streaming card (placeId isn't known until
        //     enrichment) — same trick as alreadyShownNames above. Cosmetic; the id
        //     filter at completion is authoritative.
        //   • userLikedNames    — taste signal only. Liked places are NEVER filtered
        //     or force-inserted; the model just gets a hint of what this user enjoys
        //     so free-chat suggestions skew toward their taste. Card like-highlight
        //     is already handled client-side via /my-votes hydration.
        // Direct-ask exception: a dislike means "stop suggesting this", not "refuse
        // to discuss it" — if THIS message names the place, it is not hidden.
        let userDislikedIds = new Set();
        let userDislikedNames = [];
        let userLikedNames = [];
        try {
            const voteRows = await PlaceFeedback.find({ userId })
                .sort({ updatedAt: -1 })
                .select('placeId vote name updatedAt')
                .lean();
            const latestByPlace = new Map(); // placeId → { vote, name } (newest row wins)
            for (const r of voteRows) {
                if (!latestByPlace.has(r.placeId)) latestByPlace.set(r.placeId, { vote: r.vote, name: r.name || '' });
            }
            const msgLowerForVotes = (message || '').toLowerCase();
            for (const [pid, v] of latestByPlace) {
                if (v.vote === 'dislike') {
                    userDislikedIds.add(pid);
                    // Don't tell the model to avoid a place the user is asking about
                    // right now — the direct-ask exception applies to the prompt too.
                    if (v.name && !messageNamesPlace(msgLowerForVotes, v.name)) userDislikedNames.push(v.name);
                } else if (v.vote === 'like' && v.name && userLikedNames.length < 10) {
                    userLikedNames.push(v.name); // rows are newest-first → 10 most recent likes
                }
            }
        } catch (pfErr) {
            console.warn('[chat] PlaceFeedback vote load failed:', pfErr.message);
        }
        // Validator-suppressed places fold into the dislike set, so the
        // existing suppression paths hide them for EVERY user:
        //   • aiBlocked        — staff "Block AI" button
        //   • explore hidden   — staff "Hide": per product decision, hiding a
        //     place suppresses it EVERYWHERE (Explore + chat + quick-action),
        //     not just on the browse page.
        try {
            (await PlaceCache.find({ $or: [{ aiBlocked: true }, { 'explore.status': 'hidden' }] }).select('placeId').lean())
                .forEach(b => b.placeId && userDislikedIds.add(b.placeId));
        } catch (abErr) { console.warn('[chat] suppression-set load failed:', abErr.message); }
        // Persist the destination across turns. If THIS message named no new place and
        // we're not in nearby mode, but the conversation already produced
        // recommendations somewhere (e.g. Cyprus hotels), keep centering on that
        // established destination rather than the user's GPS. Without this, a follow-up
        // like "how many stars are these?" re-resolves the Cyprus hotel names biased to
        // the user's city and returns local look-alikes (a Yerevan "Seasons Hotel", an
        // "Amara Realty" office). A new place named in the message still wins (handled
        // above via placeCoordinates); nearby mode still uses GPS.
        if (!placeCoordinates && !nearbyMode && contextResult.lastRecommendationCenter && (!effectiveLocation || effectiveLocation.source !== 'session_destination')) {
            const c = contextResult.lastRecommendationCenter;
            effectiveLocation = {
                lat: c.lat,
                lng: c.lng,
                source: 'session_destination',
                city: effectiveLocation?.city || null,
                privacyMode: effectiveLocation?.privacyMode || false,
                nearbyRadius: effectiveLocation?.nearbyRadius || user?.settings?.searchRadius?.nearby || 5,
                discoveryRadius: effectiveLocation?.discoveryRadius || user?.settings?.searchRadius?.discovery || 50
            };
        }
        // console.log(`\n✅ CONTEXT BUILT: ${contextMessages.length} messages total`);
        // === STEP 3: Setup streaming response headers ===
        res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8','Cache-Control': 'no-cache','Connection': 'keep-alive','Access-Control-Allow-Origin': '*','Access-Control-Allow-Headers': 'Cache-Control, Authorization, Content-Type','Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining'});
        // console.log('\nSTREAMING: Connection established...\n');        
        // === STEP 5: Load business data (only for travel queries) ===
        let businesses = [];
        let destinations = [];
        if (isTravelQuery) {
            // console.log('\nLOADING BUSINESS DATA...');
            try {
                const user = await User.findById(userId);
                const excludedPlaceNames = placeNames.map(name => name.toLowerCase());
                const messageWords = processedMessage.toLowerCase().split(/\s+/).filter(word => word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been', 'what'].includes(word) && !excludedPlaceNames.includes(word));
                const temporaryPreferences = { ...user?.preferences || {}, interests: [ ...(user?.preferences?.interests || []), ...messageWords ] };
                // console.log(`🎯 TEMPORARY PREFERENCES:`, temporaryPreferences);
                // console.log(`📝 MESSAGE WORDS ADDED:`, messageWords);
                // console.log(`🚫 EXCLUDED PLACE NAMES:`, excludedPlaceNames);
                const locationToUse = placeCoordinates ? { lat: placeCoordinates.lat, lng: placeCoordinates.lng } : effectiveLocation;
                if (locationToUse) {
                    // console.log(`\n📍 Using extracted location: [${locationToUse.lng}, ${locationToUse.lat}]\n`);
                    // console.log(`   Source: ${locationToUse.source || 'extracted'}`);
                    // if (locationToUse.city) { console.log(`   City: ${locationToUse.city}, ${locationToUse.country}`) }
                    // if (locationToUse.privacyMode) { console.log(`   🔒 Privacy mode active`) }
                    //console.log('');
                    // detectedActionType is set by the intent pre-pass (STEP 1.5).
                    // The per-keyword regex chain that lived here was folded into
                    // intentService (LLM tier decides; fallback tier keeps the
                    // identical regexes).
                    const userRadius = effectiveLocation ? (nearbyMode ? effectiveLocation.nearbyRadius : effectiveLocation.discoveryRadius) : (nearbyMode ? 5 : 50);
                    const searchOptions = {radius: userRadius, maxResults: nearbyMode ? 6 : 10};
                    // console.log(`📏 Using radius: ${userRadius}km (${nearbyMode ? 'nearby' : 'discovery'} mode)`);
                    const smartProximityResults = await proximityService.findSmartProximityPlaces( locationToUse, temporaryPreferences, detectedActionType, searchOptions.radius, searchOptions.maxResults, null, requestId );
                    businesses = smartProximityResults.businesses;
                    destinations = smartProximityResults.destinations;                    
                    // console.log(`\n🔍 FOUND BUSINESSES`);
                    // businesses.forEach((biz, index) => { console.log(`  ${index + 1}. ${biz.name}`) });
                    // console.log(`\n🔍 FOUND DESTINATIONS`);
                    // destinations.forEach((dest, index) => { console.log(`  ${index + 1}. ${dest.name}`) });
                } else {
                    // console.log('\nNO LOCATION: Using fallback database query');
                    // Even when we can't do proximity search (no user location),
                    // we still need the same status+freshness gate so AI doesn't
                    // surface pending/frozen/rejected/expired listings or ended
                    // events. Same helper as the proximity path uses.
                    const discFilter = proximityService.discoverabilityFilter();
                    businesses = await Business.find({
                        isActive: true,
                        status: discFilter.status,
                        $and: discFilter.$and
                    }).sort({ 'ratings.average': -1 }).limit(5);
                    destinations = await Destination.find({ isActive: true }).sort({ popularity: -1 }).limit(5);
                    // console.log('Fallback businesses:', businesses.map(b => b.name));
                    // console.log('Fallback destinations:', destinations.map(d => d.name));
                }
            } catch (error) {
                console.error('SMART DATA LOADING ERROR:', error.message);
                businesses = [];
                destinations = [];
            }
            // console.log(`\nSMART DATA LOADED: ${businesses.length} businesses, ${destinations.length} destinations`);
        } else { console.log('\nSKIPPING BUSINESS DATA: Not a travel query') }        
        // === STEP 6: Call OpenAI API ===
        // console.log('\nCALLING OPENAI API...');
        let enhancedMessage = originalMessage;
        if (isTravelQuery && (businesses.length > 0 || destinations.length > 0)) {
            const nearbyContext = nearbyMode ? `[NEARBY MODE: User wants places close to their current location. ` + `Focus on these verified nearby options.]` : `[Found ${businesses.length + destinations.length} verified places. ` + `Prioritize these in recommendations.]`;
            enhancedMessage += `\n\n${nearbyContext}`;
            // ── Interleave businesses and destinations so neither starves the other ─
            // Previously this used [...businesses, ...destinations].slice(0, 4),
            // which meant when businesses.length >= 4 the AI never saw any
            // destinations and would never recommend them by name (so no card
            // could ever be built for a destination).
            const interleaved = [];
            const maxLen = Math.max(businesses.length, destinations.length);
            for (let i = 0; i < maxLen; i++) {
                if (businesses[i])    interleaved.push({ ...businesses[i],    _kind: 'business' });
                if (destinations[i])  interleaved.push({ ...destinations[i],  _kind: 'destination' });
            }
            const picks = interleaved.slice(0, 8);
            if (picks.length > 0) {
                enhancedMessage += `\nAvailable verified places (use these EXACT names in **Name** → description ← format when relevant):`;
                picks.forEach(p => {
                    const label = p._kind === 'destination' ? 'destination' : 'business';
                    enhancedMessage += `\n- [${p.name}] (${label})`;
                });
            }
        }
        // ── Per-user vote context for the model ─────────────────────────────────
        // Dislikes: name them so the model doesn't spend card slots on places the
        // completion filter will drop anyway (fewer dropped cards = fuller replies).
        // Belt-and-braces — the authoritative hide is the id filter at completion.
        // Likes: taste signal only. Explicitly told NOT to just repeat the liked
        // places — the point is "more like these", not "these again".
        if (isTravelQuery) {
            if (userDislikedNames.length > 0) {
                enhancedMessage += `\n\n[User has disliked these places — do NOT suggest them: ${userDislikedNames.slice(0, 20).join(', ')}]`;
            }
            if (userLikedNames.length > 0) {
                enhancedMessage += `\n\n[User previously liked: ${userLikedNames.join(', ')}. When relevant, prefer places with a similar character or vibe — but do not simply repeat these unless the user's request genuinely calls for them.]`;
            }
        }
        // ── What we already know about this category here ────────────────────────
        // Parity with the quick-action "cache curation" block: when the intent
        // pre-pass resolved a concrete category and we have a search center, show
        // the model the places we already hold WITH their traveler feedback, and
        // ask it to go beyond them. Skipped for free chat ('general'), for
        // non-travel turns and when no location is known, so ordinary conversation
        // is untouched. Best-effort — an empty list simply omits the block.
        if (isTravelQuery && detectedActionType && detectedActionType !== 'general' && effectiveLocation) {
            try {
                const knownRadiusKm = nearbyMode
                    ? (effectiveLocation.nearbyRadius || 5)
                    : (effectiveLocation.discoveryRadius || 50);
                const center = placeCoordinates
                    ? { lat: placeCoordinates.lat, lng: placeCoordinates.lng }
                    : { lat: effectiveLocation.lat, lng: effectiveLocation.lng };
                const known = await loadKnownCachedPlaces({ center, radiusKm: knownRadiusKm, action: detectedActionType, limit: 12 });
                if (known.length) {
                    enhancedMessage += `\n\n[ALREADY IN OUR SYSTEM nearby, with how our travelers received them — INTERNAL context, never quote these numbers or labels back to the user:\n`
                        + known.map(k => describeKnownPlace(k.doc, k.distanceKm)).join('\n')
                        + `\nTreat this as evidence about the area, then do better: prefer strong real places NOT listed here so the traveler discovers something new, never re-suggest one travelers received poorly, and include a listed place only when it is genuinely among the best answers — a staff-verified or well-liked one is a safe choice. Never invent names.]`;
                    console.log(`[chat] known-cache context: ${known.length} place(s) shown to the model (action=${detectedActionType})`);
                }
            } catch (kcErr) { console.warn('[chat] known-cache context failed:', kcErr.message); }
        }
        const messagesForAI = [ ...contextMessages, { role: 'user', content: enhancedMessage } ];
        // console.log(`Sending ${messagesForAI.length} messages to OpenAI`);
        // console.log(`User message includes ${businesses.length + destinations.length} database places`);
        // Estimate input tokens from all messages being sent to the AI
        const inputTokens = Math.ceil(messagesForAI.reduce((sum, m) => sum + (m.content?.length || 0), 0) / 4);
        try {
            // ── Provider selection (DeepSeek default, Claude if toggled) ──────
            const cfg = await AppConfig.getConfig();
            const useClaudeChat = cfg.aiProviderChat === 'claude';
            if (location) { req.body.location = { lat: parseFloat(location.lat), lng: parseFloat(location.lng), source: location.source || 'unknown' } }

            // ── Shared stream state (used by BOTH providers) ──────────────────
            let fullResponse = '';
            let hasData = false;
            let potentialNameBuffer = '';
            let isBufferingName = false;
            // True once a **name** bold has CLOSED and we're waiting one token to
            // see whether a → follows (card) or plain prose does (just bold text).
            let nameBufferClosed = false;
            let completionFired = false;
            // Holds a token that is ONLY a list marker ("1." / "-" / "•"). We defer
            // emitting it until we know what follows: if a **name** recommendation
            // comes next the marker belongs to the card (dropped); if ordinary prose
            // follows, the marker was real numbering and is flushed back out.
            let pendingListMarker = '';
            let chatSearchCount = 0;   // Claude web-search count for this chat turn (0 for DeepSeek)
            /* Real billed tokens for this chat turn, when the provider reports them.
             * The chat path has always billed the admin dashboard from a
             * characters/4 ESTIMATE (inputTokens below, plus the response length in
             * processStreamCompletion) and thrown the streamed usage block away —
             * so the quick-action fix from the previous round never applied here.
             * null when unknown, in which case the estimate still stands in. */
            let chatRealTokens = null;

            // Per-content-token parser — IDENTICAL logic for DeepSeek and Claude.
            // Each provider simply calls feedChunk(textChunk). (Original `continue`
            // statements become `return` because this runs once per token.)
            const feedChunk = (content) => {
                if (streamAborted || isClientDisconnected()) return;
                if (!content) return;
                fullResponse += content;

                // CASE 1: Inside arrow block - stream description
                if (inArrowBlock) {
                    if (content.includes('←')) {
                        const arrowEndIndex = content.indexOf('←');
                        arrowBuffer += content.substring(0, arrowEndIndex);
                        if (pendingName && !currentDescriptionRec) {
                            currentDescriptionRec = pendingName.trim();
                            pendingName = '';
                        }
                        lastRecommendationEndPosition = fullResponse.length + arrowEndIndex;
                        res.write(`data: ${JSON.stringify({ type: 'description_complete', recommendationName: currentDescriptionRec, timestamp: new Date() })}\n\n`);
                        const afterArrow = content.substring(arrowEndIndex + 1);
                        const trimmedAfterArrow = afterArrow.replace(/^\s+/, '');
                        if (trimmedAfterArrow.trim()) { res.write(`data: ${JSON.stringify({ type: 'token', content: trimmedAfterArrow })}\n\n`) }
                        inArrowBlock = false;
                        currentDescriptionRec = null;
                        arrowBuffer = '';
                    } else {
                        if (!currentDescriptionRec && content.includes('**')) {
                            const nameMatch = content.match(/\*\*(\[?[^*\]]+\]?)\*\*/);
                            if (nameMatch) {
                                currentDescriptionRec = nameMatch[1].trim();
                                pendingName = '';
                            }
                        }
                        const cleanContent = content.replace(/→|←|\*\*/g, '');
                        arrowBuffer += content;
                        res.write(`data: ${JSON.stringify({ type: 'description_token', recommendationName: currentDescriptionRec, content: cleanContent })}\n\n`);
                    }
                    return;
                }
                // CASE 2: Check if arrow start is in this token
                if (content.includes('→')) {
                    const arrowIndex = content.indexOf('→');
                    const beforeArrow = content.substring(0, arrowIndex);
                    const fullTextBeforeArrow = potentialNameBuffer + beforeArrow;
                    const nameMatch = fullTextBeforeArrow.match(/\*\*(\d+\.\s*)?(\[?[^*\]]+\]?)\*\*\s*$/);
                    if (nameMatch) {
                        currentDescriptionRec = nameMatch[2].trim();
                        const textBeforeName = fullTextBeforeArrow.replace(/\*\*(\d+\.\s*)?(\[?[^*\]]+\]?)\*\*\s*$/, '');
                        if (textBeforeName.trim()) { res.write(`data: ${JSON.stringify({ type: 'token', content: textBeforeName })}\n\n`) }
                    } else { if (fullTextBeforeArrow.trim()) { res.write(`data: ${JSON.stringify({ type: 'token', content: fullTextBeforeArrow })}\n\n`) } }
                    potentialNameBuffer = '';
                    isBufferingName = false;
                    nameBufferClosed = false;
                    inArrowBlock = true;
                    arrowBuffer = content.substring(arrowIndex);
                    return;
                }
                // CASE 3: Normal text - but check if it might be part of a name
                if (content === '**' && !isBufferingName) {
                    // A list marker sitting just before a **name** belongs to the
                    // recommendation, not to the prose — drop it so it never streams.
                    pendingListMarker = '';
                    isBufferingName = true;
                    nameBufferClosed = false;
                    potentialNameBuffer = content;
                    return;
                }
                if (isBufferingName) {
                    // The bold closed on a PREVIOUS token and this token carries real
                    // content with no arrow → it was ordinary bold text ("**Limassol
                    // Promenade**" + description), NOT a card name. Flush it NOW.
                    // Without this, the parser sat in buffering mode swallowing the
                    // description that followed — the "invisible middle content" bug
                    // where bold paragraphs only reappeared at completion, 30s later.
                    // (An arrow token never reaches here: CASE 2 above consumes it.)
                    if (nameBufferClosed) {
                        if (!content.trim()) {
                            // whitespace only — keep waiting; the arrow may be next
                            potentialNameBuffer += content;
                            return;
                        }
                        res.write(`data: ${JSON.stringify({ type: 'token', content: potentialNameBuffer + content })}\n\n`);
                        potentialNameBuffer = '';
                        isBufferingName = false;
                        nameBufferClosed = false;
                        return;
                    }
                    potentialNameBuffer += content;
                    if (content === '**' && potentialNameBuffer.length > 4) {
                        nameBufferClosed = true;
                        return;
                    }
                    if (potentialNameBuffer.length > 100) {
                        res.write(`data: ${JSON.stringify({ type: 'token', content: potentialNameBuffer })}\n\n`);
                        potentialNameBuffer = '';
                        isBufferingName = false;
                        nameBufferClosed = false;
                    }
                    return;
                }
                if (potentialNameBuffer && !content.includes('→')) {
                    res.write(`data: ${JSON.stringify({ type: 'token', content: potentialNameBuffer })}\n\n`);
                    potentialNameBuffer = '';
                    isBufferingName = false;
                    nameBufferClosed = false;
                }
                if (!inArrowBlock && !isBufferingName && !content.includes('→')) {
                    // A token that is nothing but a list marker may precede a **name**
                    // recommendation — hold it rather than emit a stray "1." above the card.
                    if (/^\s*(?:\d+[.)]|[-*•])\s*$/.test(content)) {
                        pendingListMarker += content;
                        return;
                    }
                    // Ordinary prose: the held marker (if any) was genuine numbering — flush it.
                    let out = content;
                    if (pendingListMarker) { out = pendingListMarker + out; pendingListMarker = ''; }
                    res.write(`data: ${JSON.stringify({ type: 'token', content: out })}\n\n`);
                }
                const newContent = fullResponse.slice(lastProcessedLength);
                lastProcessedLength = fullResponse.length;
                if (newContent.trim()) { detectAndEmitRecommendations(fullResponse, currentRecommendations, emittedRecommendations, res, lastDetectionTimeRef, DETECTION_THROTTLE_MS, lastExtractedRecsRef, nearbyMode, alreadyShownNames, userDislikedNames).catch(error => console.error('Detection error:', error)) }
            };

            // Flush any trailing name buffer, then run the same completion pipeline.
            const finishStream = () => {
                if (completionFired) return;
                completionFired = true;
                // A marker held to the very end had no recommendation after it — emit it.
                if (pendingListMarker) {
                    res.write(`data: ${JSON.stringify({ type: 'token', content: pendingListMarker })}\n\n`);
                    pendingListMarker = '';
                }
                if (potentialNameBuffer) {
                    res.write(`data: ${JSON.stringify({ type: 'token', content: potentialNameBuffer })}\n\n`);
                    potentialNameBuffer = '';
                }
                if (!isClientDisconnected()) { processStreamCompletion(fullResponse, businesses, destinations, message, userId, res, null, effectiveLocation, userPreferences, [], new Set(), requestId, detectedActionType, nearbyMode, healthCheck, inputTokens, useClaudeChat ? 'claude' : 'deepseek', chatSearchCount, alreadyShownPlaceIds, userDislikedIds, chatRealTokens) }
            };

            // Token-usage correction (runs once the model finishes).
            const applyTokenCorrection = async () => {
                actualTokensUsed = inputTokens;
                if (actualTokensUsed > 0 && req.userLimit) {
                    const correction = actualTokensUsed - estimatedTokens;
                    if (correction > 0) { await req.userLimit.checkAndUpdateUsage(correction, 0, 0) }
                }
            };

            if (useClaudeChat) {
                // ================= CLAUDE PROVIDER (web search optional) =========
                const claudeWebSearch = cfg.claudeWebSearch &&
                    (Array.isArray(cfg.claudeWebSearchActions) && cfg.claudeWebSearchActions.includes(detectedActionType));
                const controller = new AbortController();
                try {
                    for await (const ev of claudeService.streamChat({
                        messages: messagesForAI,
                        model: cfg.claudeModel,
                        maxTokens: contextManager.TOKEN_LIMITS.max_response,
                        temperature: 0.5,
                        webSearch: claudeWebSearch,
                        webSearchMaxUses: cfg.claudeWebSearchMaxUses,
                        // Never sent before: the search ran unrestricted, so the model read
                        // whatever ranked — a travel blog over the ticket seller's own page.
                        allowedDomains: cfg.claudeWebSearchAllowedDomains,
                        blockedDomains: cfg.claudeWebSearchBlockedDomains,
                        cacheSystem: true,
                        signal: controller.signal,
                    })) {
                        if (streamAborted || isClientDisconnected()) { try { controller.abort() } catch (e) {} break; }
                        if (ev.type === 'text') {
                            hasData = true;
                            feedChunk(ev.content);
                        } else if (ev.type === 'search_start') {
                            // Surface a "searching" state so the UI doesn't look frozen
                            // during the web-search pause. Safe to ignore client-side.
                            res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
                        } else if (ev.type === 'done') {
                            chatSearchCount = ev.searchCount || 0;
                            chatRealTokens = claudeService.billableTokens(ev.usage) || null;
                            console.log(`[provider] chat=claude model=${cfg.claudeModel} searches=${ev.searchCount} tokens=${chatRealTokens ?? 'estimate'} (in=${ev.usage?.input_tokens || 0} out=${ev.usage?.output_tokens || 0} cacheRead=${ev.usage?.cache_read_input_tokens || 0} cacheWrite=${ev.usage?.cache_creation_input_tokens || 0})`);
                            await applyTokenCorrection();
                            finishStream();
                        } else if (ev.type === 'error') {
                            console.error('CLAUDE STREAM ERROR:', ev.error?.message || ev.error);
                            if (!streamAborted && !isClientDisconnected() && !completionFired) {
                                res.write(`data: ${JSON.stringify({ type: 'error', message: messages.stream_interrupted })}\n\n`);
                                res.end();
                            }
                        }
                    }
                    // Safety net if the stream ended without an explicit 'done'.
                    if (!completionFired && fullResponse && !streamAborted && !isClientDisconnected()) {
                        await applyTokenCorrection();
                        finishStream();
                    }
                } catch (claudeErr) {
                    if (streamAborted) { return }
                    console.error('CLAUDE ERROR:', claudeErr.message);
                    if (!completionFired) {
                        res.write(`data: ${JSON.stringify({ type: 'error', message: messages.connection_error })}\n\n`);
                        res.end();
                    }
                }
            } else {
                // ================= DEEPSEEK PROVIDER (unchanged behaviour) =======
                console.log('[provider] chat=deepseek');
                const streamResponse = await openai.chat.completions.create({
                    model: process.env.OPENAI_MODEL || "deepseek-v4-pro",
                    messages: messagesForAI,
                    temperature: 0.5,
                    max_tokens: contextManager.TOKEN_LIMITS.max_response,
                    stream: true,
                    frequency_penalty: 0.6,
                    presence_penalty: 0.4
                });

                // SSE lines can be split across chunk boundaries — a chunk may end
                // mid-JSON. Splitting each chunk independently silently dropped that
                // token (the "Parse error" logs) and could truncate a place name
                // mid-stream. Buffer the trailing partial line until its newline arrives.
                let sseBuffer = '';
                streamResponse.data.on('data', (chunk) => {
                    if (streamAborted || isClientDisconnected()) {
                        streamResponse.data.destroy();
                        return;
                    }
                    hasData = true;
                    sseBuffer += chunk.toString();
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() ?? '';   // keep the last (possibly incomplete) line
                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line) continue;
                        if (isClientDisconnected()) return;
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') {
                                finishStream();
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices?.[0]?.delta?.content || '';
                                if (content) { feedChunk(content); }
                            } catch (parseError) { console.warn('Parse error:', data) }
                        }
                    }
                });
                streamResponse.data.on('end', async () => {
                    if (streamAborted) { return }
                    await applyTokenCorrection();
                    if (fullResponse && !res.headersSent) { finishStream(); }
                });
                streamResponse.data.on('error', (error) => {
                    if (streamAborted) { return }
                    console.error('STREAM ERROR:', error.message);
                    if (!res.headersSent) {
                        res.write(`data: ${JSON.stringify({ type: 'error', message: messages.stream_interrupted })}\n\n`);
                        res.end();
                    }
                });
                setTimeout(() => {
                    if (!hasData && !res.headersSent) {
                        console.log('\nSTREAM TIMEOUT - sending fallback');
                        res.write(`data: ${JSON.stringify({ type: 'token', content: "I'm happy to help you discover magic! What would you like to explore? " })}\n\n`);
                        res.write(`data: ${JSON.stringify({ type: 'complete', recommendations: [], metadata: { timestamp: new Date() } })}\n\n`);
                        res.end();
                    }
                }, 15000);
            }
        } catch (aiError) {
            if (streamAborted) {return}
            console.error('OPENAI ERROR:', aiError.message);
            res.write(`data: ${JSON.stringify({ type: 'error', message: messages.connection_error })}\n\n`);
            res.end();
        }
    } catch (error) {
        if (error.name === 'AbortError' || isClientDisconnected()) {
            console.log('⏹️ Request aborted by client');
            return;
        }
        console.error('MAIN ERROR:', error);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', message: 'Failed to process chat message' }));
        }
    } finally { 
        // console.log('\n\n========= CHAT-STREAM DEBUG END =========\n\n\n') 
    }
});

function getDisplayTypeFromEnum(typeArray) {
    if (!typeArray || !Array.isArray(typeArray) || typeArray.length === 0) return 'Attraction';
    const types = typeArray.map(t => String(t).toLowerCase());
    const has = (...keys) => keys.some(k => types.includes(k));
    // Order matters: specific signals first, generic (point_of_interest/establishment)
    // last. Handles BOTH Google Place types (lodging, natural_feature, locality, …)
    // and the internal action keywords (hotels, restaurants, …) DB records may carry.
    // Fixes destinations/regions/mountains being mislabelled "Hotel" via the old
    // action-type fallback — a city or a mountain is a Destination/Nature, not a venue.
    if (has('hotels', 'lodging', 'resort_hotel', 'motel', 'guest_house')) return 'Hotel';
    if (has('restaurants', 'restaurant', 'cafe', 'coffee_shop', 'bar', 'bakery', 'food', 'meal_takeaway', 'meal_delivery')) return 'Restaurant';
    if (has('locality', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'sublocality', 'colloquial_area', 'political', 'country')) return 'Destination';
    if (has('natural_feature')) return 'Nature';
    if (has('national_park', 'park', 'campground', 'hiking_area')) return 'Park';
    if (has('museum')) return 'Museum';
    if (has('art_gallery')) return 'Gallery';
    if (has('church', 'mosque', 'hindu_temple', 'synagogue', 'place_of_worship')) return 'Landmark';
    if (has('amusement_park', 'theme_park', 'zoo', 'aquarium', 'water_park')) return 'Attraction';
    if (has('shopping_mall', 'department_store', 'store', 'market')) return 'Shopping';
    if (has('night_club', 'casino')) return 'Nightlife';
    if (has('historical', 'historical_landmark', 'historical_place')) return 'Historical Site';
    if (has('hidden_gems')) return 'Hidden Gem';
    if (has('events', 'event')) return 'Event';
    if (has('tourist_attraction', 'point_of_interest', 'establishment', 'landmark')) return 'Attraction';
    return 'Attraction';
}

// Great-circle distance (km) between two lat/lng points (haversine).
function _haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Preference fit (0..1): do the place's Google types align with the CURRENT
// user's interests? Computed at QUERY time, never stored on the shared place doc.
// Neutral (0.5) when the user has no interests set, so it neither helps nor hurts.
function _prefFitScore(types, primaryType, preferences) {
    const t = [...(types || []), primaryType].filter(Boolean).map(x => String(x).toLowerCase());
    const interestsRaw = Array.isArray(preferences?.interests) ? preferences.interests.join(' ') : (preferences?.interests || '');
    const interests = String(interestsRaw).toLowerCase();
    const want = [];
    if (/food|drink|gourmet|culinary/.test(interests)) want.push('restaurant', 'cafe', 'bakery', 'bar', 'food', 'meal_takeaway', 'coffee_shop', 'wine_bar', 'pub');
    if (/nature|outdoor/.test(interests)) want.push('park', 'garden', 'natural_feature', 'national_park', 'botanical_garden');
    if (/relax|wellness|spa/.test(interests)) want.push('spa', 'park', 'garden', 'resort_hotel');
    if (/family|kid/.test(interests)) want.push('zoo', 'aquarium', 'amusement_park', 'park', 'museum');
    if (/art|culture|histor/.test(interests)) want.push('museum', 'art_gallery', 'tourist_attraction', 'historical_landmark');
    if (!want.length) return 0.5;                       // no interests → neutral
    return t.some(tt => want.some(w => tt.includes(w))) ? 1 : 0;
}

// ── Community hard-hide thresholds + gate (shared) ───────────────────────────
// A place is hidden from EVERYONE's automatic surfacing — both the cache backfill
// AND the model's own named results — only when ALL THREE hold:
//   1. net ≤ −COMMUNITY_HIDE_MARGIN   (dislikes exceed likes by ≥3: absolute floor)
//   2. total votes ≥ COMMUNITY_MIN_VOTES   (enough sample to judge)
//   3. dislikes ≥ COMMUNITY_HIDE_RATIO of all votes   (proportional rejection)
// Requiring all three keeps small samples and genuinely popular places safe. NOT a
// delete — it only suppresses automatic surfacing and self-heals if sentiment
// recovers. Defined once here so findCachedBackfill and the model-name dislike gate
// apply byte-identical rules.
const COMMUNITY_HIDE_MARGIN = 3;     // net ≤ −3
const COMMUNITY_MIN_VOTES   = 3;     // need at least this many total votes to judge
const COMMUNITY_HIDE_RATIO  = 0.6;   // dislikes must be ≥60% of all feedback
function isCommunityRejected(likes = 0, dislikes = 0) {
    const net = (likes || 0) - (dislikes || 0);
    const totalVotes = (likes || 0) + (dislikes || 0);
    const dislikeShare = totalVotes > 0 ? (dislikes || 0) / totalVotes : 0;
    return net <= -COMMUNITY_HIDE_MARGIN
        && totalVotes >= COMMUNITY_MIN_VOTES
        && dislikeShare >= COMMUNITY_HIDE_RATIO;
}

/**
 * Backfill candidates from PlaceCache — real, in-area places that have previously
 * been SHOWN under this same quick-action category, ranked by community feedback
 * (likes - dislikes), Google rating, the CURRENT user's preference fit, in-app
 * popularity (capped useCount), and closeness. Makes NO Google calls.
 *
 * Category membership is ground truth, not a guess: a place is eligible only if
 * its `actions` array contains the requested action — i.e. it was actually shown
 * to a user under that category before (recorded at request time, after it passed
 * every filter). This is why a resolved-but-dropped place (a school that came back
 * for a Historical query then got filtered out) is never served as backfill, and
 * why a Historical place can never surface under Events: it was never tagged with
 * that action. No per-action type heuristics are needed here.
 *
 * Preferences are applied as a query-time SCORE — never written onto the shared
 * place document (a place is shared across users; preferences are per-user).
 * Honors the same hard gates a fresh result would: in-radius (measured from the
 * search center, so trip-planning to another city works), freshness, a usable
 * stored image, and the exclude lists. Returns [{ doc, distanceKm }].
 */
async function findCachedBackfill({ center, radiusKm, action, subType = null, preferences = {}, excludePlaceIds = [], excludeNames = [], limit = 8 }) {
    if (!center || center.lat == null || center.lng == null || !radiusKm || !action) return [];
    /* ── Events are never served from the place cache ────────────────────────
     * The cache stores PLACES. An event is a moment in time, and what the cache
     * holds for one is merely the venue it happened at — with no date, and no
     * way to know the event has passed. Serving those back produced grids of
     * undated "Event" cards (a rooftop lounge, a zoo, a concert hall) that were
     * never events at all. Events come from the model and from validator-curated
     * destinations, or the grid is simply shorter — which is the honest outcome
     * and also hides "View More" when there is genuinely nothing left to show.
     */
    if (action === 'events') return [];
    const CACHE_VALIDITY_DAYS = 30;
    const freshnessCutoff = new Date(Date.now() - CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180)));

    // Indexed bounding-box prefilter, gated to places shown under THIS action;
    // exact circular cap is applied in JS below.
    const query = {
        actions: action,                               // ground-truth category match
        imagesStored: true,
        // Staff suppression, enforced at the SOURCE. The streaming routes fold
        // "Block AI" and Explore-hidden into their dislike set, but that set is
        // built late — the early "View More" refill (and the curation list) call
        // this helper before it exists, so a suppressed place could still be
        // served straight from cache. Both flags are indexed; `$ne` also matches
        // legacy docs that carry neither field.
        aiBlocked: { $ne: true },
        'explore.status': { $ne: 'hidden' },
        lastFetched: { $gte: freshnessCutoff },
        'details.geometry.location.lat': { $gte: center.lat - latDelta, $lte: center.lat + latDelta },
        'details.geometry.location.lng': { $gte: center.lng - lngDelta, $lte: center.lng + lngDelta }
    };
    if (excludePlaceIds.length) query.placeId = { $nin: excludePlaceIds };

    const docs = await PlaceCache.find(query)
        .select('placeId name rating likes dislikes useCount types primaryType priceLevel details photos explore interests')
        .limit(200)                                    // hard ceiling so a big cache never blows up the scan
        .lean();

    const excludeLower = new Set((excludeNames || []).map(n => (n || '').toLowerCase().trim()));
    const HIT_CAP = 25;                                // cap popularity so a few places can't ossify the list
    // Community hard-hide thresholds live at module level (COMMUNITY_HIDE_*) and are
    // applied below via isCommunityRejected() — the SAME gate the model-name dislike
    // filter uses, so backfill and AI-named results reject identical places.
    const scored = [];
    for (const d of docs) {
        const lat = d?.details?.geometry?.location?.lat;
        const lng = d?.details?.geometry?.location?.lng;
        if (lat == null || lng == null) continue;
        if (!d.photos || !d.photos[0]) continue;        // must render a card
        if (excludeLower.has((d.name || '').toLowerCase().trim())) continue;
        const distanceKm = _haversineKm(center.lat, center.lng, lat, lng);
        if (distanceKm > radiusKm) continue;
        const net = (d.likes || 0) - (d.dislikes || 0);
        // ── Hard community-reject gate (floor + ratio) ───────────────────────
        // Hide a place from EVERYONE's backfill only when the community has BOTH
        // clearly AND proportionally rejected it. Three conditions must ALL hold:
        //
        //   1. FLOOR (absolute evidence):   net ≤ −COMMUNITY_HIDE_MARGIN
        //        At least this many more dislikes than likes. This is the
        //        minimum-evidence gate — it is what makes the small-sample cases
        //        safe. 1 dislike (net −1) or 2 dislikes (net −2) never reach the
        //        gate at all, so a place shown to one or two people who happened to
        //        dislike it can NEVER be hidden from everyone. The ratio below is
        //        only ever consulted once this floor is already cleared.
        //
        //   2. MIN VOTES (sample size):      likes + dislikes ≥ COMMUNITY_MIN_VOTES
        //        A second guard against thin samples — a ratio computed from a
        //        couple of votes is noise, not signal. (With MARGIN 3 the floor
        //        already implies ≥3 dislikes, so this is satisfied in practice; it
        //        is kept explicit so MARGIN can be lowered later without reopening
        //        the small-sample hole.)
        //
        //   3. RATIO (proportional rejection): dislikes ≥ COMMUNITY_HIDE_RATIO of
        //        total feedback. This is the future-proofing: at high volume a bare
        //        net −3 can be noise on a place with hundreds of likes, so we ALSO
        //        require dislikes to be a real share of the votes. A genuinely
        //        popular place (50 likes / 4 dislikes → 7% dislikes) is never hidden
        //        no matter how many absolute dislikes accrue.
        //
        // Because all three are required, this is ALWAYS stricter than the floor
        // alone — adding the ratio can only ever keep MORE places visible, never
        // hide a place the old rule would have kept. Behaviour at today's low
        // volume is therefore identical to the plain net≤−3 rule. NOT a delete:
        // the cache doc/photos stay; it is backfill-only and self-healing — if
        // sentiment recovers and any condition stops holding, the place returns.
        if (isCommunityRejected(d.likes, d.dislikes)) continue;
        // Price-tier gate (Step 3): for the price-relevant actions, drop a cached
        // place whose KNOWN tier is the clear opposite of the user's style (luxury
        // user vs a budget hostel, etc.). Unknown tier → kept (tierMismatch false).
        const dTier = isPriceAction(action) ? priceTier(d.types, d.primaryType, d.priceLevel).tier : null;
        if (isPriceAction(action) && tierMismatch(dTier, preferences.travelStyle)) continue;
        const rating = d.rating || 0;
        const pref = _prefFitScore(d.types, d.primaryType, preferences);
        const hits = Math.min(d.useCount || 0, HIT_CAP) / HIT_CAP;
        const closeness = 1 - (distanceKm / radiusKm);
        // Feedback is the strongest soft signal; rating + preference fit next;
        // popularity + closeness are gentle tiebreakers. Negative feedback bites
        // HARDER than positive feedback rewards (asymmetric weighting): a place the
        // community actively dislikes should sink quickly toward the bottom of the
        // backfill pool, while likes only gently lift. This is a community-wide
        // soft penalty — it never deletes a place and never hard-excludes it (that
        // is handled per-user via PlaceFeedback); it just makes a poorly-received
        // place the last thing we fall back to.
        const feedbackScore = net >= 0 ? (3 * net) : (8 * net);
        // Tier fit (Step 3): nudge places toward the user's luxury/budget style.
        // 0 for unpriced places or no style, so it only reorders where we have signal.
        const tierScore = isPriceAction(action) ? tierFit(dTier, preferences.travelStyle) : 0;
        const score = feedbackScore + (1 * rating) + (2 * pref) + (2 * tierScore) + (1 * hits) + (1 * closeness);
        scored.push({ doc: d, distanceKm, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

/* ── What we already know, told to the model ─────────────────────────────────
 *
 * The cache holds far more than names: a Google rating, how our own travelers
 * voted, how often the place was served, its price bucket, whether staff
 * verified it, and the interest tags staff curated onto it. All of that was
 * being used only AFTER the model spoke, as a filter. Handing it over BEFORE
 * gives the model a real picture of the area instead of a bare word list.
 *
 * The framing is deliberately "here is the evidence, now do better": the model
 * is asked to prefer places NOT on the list, to skip the poorly-received ones
 * outright, and to reuse a listed place only when it genuinely is the best fit.
 * That way each request widens the catalogue instead of recycling the same
 * local top-ten — while the places travelers actually liked keep their edge.
 *
 * The counters are INTERNAL context. The prompt says so explicitly: no reply
 * should ever quote our like/dislike numbers back at the traveler.
 */
function describeKnownPlace(doc, distanceKm = null) {
    const bits = [];
    if (Number.isFinite(doc.rating)) bits.push(`rated ${doc.rating.toFixed(1)}`);
    const likes = doc.likes || 0, dislikes = doc.dislikes || 0;
    if (likes || dislikes) bits.push(`${likes} liked / ${dislikes} disliked by our travelers`);
    else bits.push('no traveler votes yet');
    if (doc.explore?.status === 'verified') bits.push('staff-verified');
    if (doc.useCount) bits.push(`shown ${doc.useCount}x`);
    const tier = priceTier(doc.types, doc.primaryType, doc.priceLevel).tier;
    if (tier) bits.push(tier);
    if (Array.isArray(doc.interests) && doc.interests.length) bits.push(`suits: ${doc.interests.slice(0, 4).join(', ')}`);
    if (Number.isFinite(distanceKm)) bits.push(`${Math.round(distanceKm)}km away`);
    return `- ${doc.name} (${bits.join('; ')})`;
}

/**
 * Light read of the places we already hold for a category near a point — the
 * same membership rule and staff suppressions findCachedBackfill applies, but
 * WITHOUT pulling `photos` (those carry the stored image bytes, which must
 * never be loaded just to write a prompt). Ranked by how our own travelers
 * received the place, then rating. Best-effort: returns [] on any failure.
 */
async function loadKnownCachedPlaces({ center, radiusKm, action, limit = 12 }) {
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !radiusKm) return [];
    if (!CURATED_GATE_ACTIONS.has(action)) return [];
    try {
        const latDelta = radiusKm / 111.32;
        const lngDelta = radiusKm / (111.32 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180)));
        const docs = await PlaceCache.find({
            actions: action,
            imagesStored: true,
            aiBlocked: { $ne: true },
            'explore.status': { $ne: 'hidden' },
            'details.geometry.location.lat': { $gte: center.lat - latDelta, $lte: center.lat + latDelta },
            'details.geometry.location.lng': { $gte: center.lng - lngDelta, $lte: center.lng + lngDelta }
        })
            .select('placeId name rating likes dislikes useCount types primaryType priceLevel interests explore details.geometry.location')
            .limit(120)
            .lean();
        const scored = [];
        for (const d of docs) {
            const loc = d?.details?.geometry?.location;
            if (!loc) continue;
            const distanceKm = _haversineKm(center.lat, center.lng, loc.lat, loc.lng);
            if (distanceKm > radiusKm) continue;
            if (isCommunityRejected(d.likes, d.dislikes)) continue;   // community-buried: not worth showing the model either
            const net = (d.likes || 0) - (d.dislikes || 0);
            const verified = d.explore?.status === 'verified' ? 2 : 0;
            scored.push({ doc: d, distanceKm, score: verified + (net >= 0 ? 3 * net : 8 * net) + (d.rating || 0) });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    } catch (err) {
        console.warn('[known-cache] lookup failed:', err.message);
        return [];
    }
}

/* ── Validator-curated category gate ─────────────────────────────────────────
 *
 * A validator can VERIFY a place and at the same time correct the category the
 * AI filed it under — a monastery the model kept serving as an 'events' venue
 * gets re-tagged 'historical' from the staff Explore queue. That edit sets
 * `actionsCurated`, which so far only LOCKED the array against runtime
 * re-tagging: the model could still name the place on an events request and the
 * card shipped anyway, because nothing ever compared the two.
 *
 * This closes that half. For a request under a concrete category, a place a
 * validator has curated OUT of that category is rejected however the AI arrived
 * at it. The positive half needs no code: a place curated INTO 'historical' is
 * already eligible on historical requests via findCachedBackfill and Explore,
 * both of which read `actions` directly.
 *
 * Deliberately narrow, so nothing else changes:
 *   • ONLY curated docs participate. On an uncurated doc `actions` means "has
 *     been shown under", NOT "belongs to" — gating on that would reject every
 *     place that simply hasn't been served in the category yet.
 *   • ONLY concrete categories. Free chat ('general') is never gated.
 *   • An EMPTY curated array rejects everywhere: a validator who cleared every
 *     category is saying the place belongs under none of them.
 *   • Places with no placeId (date-cards, unresolved names, DB-only rows) are
 *     never matched, so they are never affected.
 */
const CURATED_GATE_ACTIONS = new Set(['restaurants', 'hotels', 'historical', 'events', 'photo_spots', 'hidden_gems', 'shopping']);

/**
 * Batch verdict: which of these placeIds has a validator curated OUT of `action`.
 * One indexed query (placeId $in). Returns an empty set for uncurated places,
 * unknown actions and on any failure — the gate can only ever REMOVE places it
 * is certain about.
 */
async function loadCuratedRejects(placeIds, action) {
    if (!CURATED_GATE_ACTIONS.has(action)) return new Set();
    const ids = [...new Set((placeIds || []).filter(Boolean))];
    if (!ids.length) return new Set();
    try {
        const rows = await PlaceCache.find({ placeId: { $in: ids }, actionsCurated: true })
            .select('placeId actions').lean();
        return new Set(rows.filter(r => !(r.actions || []).includes(action)).map(r => r.placeId));
    } catch (err) {
        // Fail OPEN — a lookup failure must never empty a reply. Worst case this
        // one request behaves exactly as it did before the gate existed.
        console.warn('[curated-gate] batch lookup failed:', err.message);
        return new Set();
    }
}

/**
 * Single-place verdict, for callers that resolve places one at a time (the
 * itinerary enricher). Folds in the two staff suppressions the streaming routes
 * already apply as a prefetched set — "Block AI" and Explore-hidden — so one
 * lookup answers "may the AI serve this place under this category at all?".
 * Returns 'ai_blocked' | 'hidden' | 'wrong_category', or null when allowed.
 */
async function placeBlockedForAction(placeId, action) {
    if (!placeId) return null;
    try {
        const doc = await PlaceCache.findOne({ placeId })
            .select('aiBlocked explore.status actions actionsCurated').lean();
        if (!doc) return null;
        if (doc.aiBlocked === true) return 'ai_blocked';
        if (doc.explore?.status === 'hidden') return 'hidden';
        if (CURATED_GATE_ACTIONS.has(action) && doc.actionsCurated === true && !(doc.actions || []).includes(action)) {
            return 'wrong_category';
        }
        return null;
    } catch (err) {
        console.warn('[curated-gate] single lookup failed:', err.message);
        return null;   // fail open, same reasoning as above
    }
}

// Escape a user/model-supplied string so it can be safely embedded in a RegExp.
// Model names routinely contain (), [], +, etc. (e.g. "Yerevan Wine Days (June
// 5-7)"); without escaping, `new RegExp(name)` throws "Unterminated group" and
// the whole place lookup fails, silently dropping otherwise-valid results.
const escapeRegExp = (s) => String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Best-candidate selection for name resolution ─────────────────────────────
// Google Text Search ranks by PROMINENCE, not by name fidelity: querying
// "Limassol" (the city) returned "Parklane, a Luxury Collection Resort & Spa,
// Limassol" as result #1 — a huge resort outranks the locality itself. The old
// selection took the FIRST candidate that plausibly matched, and the hotel
// plausibly matches ("Limassol" appears in its name), so a card the model
// wrote about a CITY silently morphed into a HOTEL. Fix: score every plausible
// candidate and take the best — exact name match beats prefix beats
// containment — with a bonus for geographic types (locality / region /
// natural feature) when neither the query nor the caller asked for an
// establishment. So "Limassol"-the-locality (exact match + geo bonus) now
// beats "Parklane …, Limassol" (containment), while "Annabelle Hotel" still
// resolves to the hotel because establishment queries skip the geo bonus.
const GEOGRAPHIC_PLACE_TYPES = new Set(['locality', 'sublocality', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'country', 'political', 'natural_feature', 'park', 'national_park', 'tourist_attraction']);
const ESTABLISHMENT_QUERY_WORDS = /\b(hotel|hotels|resort|spa|restaurant|cafe|bistro|bar|pub|club|museum|gallery|shop|store|market|mall|casino|lodge|inn|hostel|guesthouse|winery|brewery|zoo|aquarium|theatre|theater|cinema|bakery|pizzeria|taverna|tavern|grill|steakhouse|diner|eatery|buffet)\b/i;

function pickBestPlaceCandidate(query, places, includedType = null) {
    // Apostrophes are DELETED (not spaced) so "St. Georges" === "St. George's" —
    // a typographic apostrophe was enough to make an exact match fail and
    // trigger a needless fresh Google resolution.
    const norm = s => String(s || '').toLowerCase().trim().replace(/['\u2019\u2018\u0060]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(query);
    // Geo bonus only when nothing signals an establishment: neither the query
    // text (…"hotel", "restaurant"…) nor the caller (quick actions pass
    // includedType when they expect a business).
    const allowGeoBonus = !includedType && !ESTABLISHMENT_QUERY_WORDS.test(String(query || ''));
    let best = null, bestScore = -1;
    for (const p of places || []) {
        // Junk-name guard: Google occasionally hosts places literally named "."
        // or "-". Normalization strips those to an empty string, so the
        // plausibility check passes vacuously — which once put a stop named "."
        // into a generated itinerary. A name with fewer than 2 real characters
        // can never be a legitimate pick.
        if (p.name != null && norm(p.name).replace(/ /g, '').length < 2) continue;
        if (p.name && !namesPlausiblyMatch(query, p.name)) continue;    // existing hard gate unchanged
        if (!p.name) { if (bestScore < 0) { best = p; bestScore = 0; } continue; }  // legacy shape: keep first
        const r = norm(p.name);
        const rc = r.replace(/ /g, ''), qc2 = q.replace(/ /g, '');
        let score;
        if (r === q || rc === qc2) score = 100;
        else if (r.startsWith(q) || q.startsWith(r) || rc.startsWith(qc2) || qc2.startsWith(rc)) score = 90;
        else if (r.includes(q) || q.includes(r) || rc.includes(qc2) || qc2.includes(rc)) score = 80;
        else score = 60;                                                 // token-level plausible only
        if (allowGeoBonus) {
            const types = [p.primaryType, ...(p.types || [])].filter(Boolean).map(t => String(t).toLowerCase());
            if (types.some(t => GEOGRAPHIC_PLACE_TYPES.has(t))) score += 15;
        } else if (includedType) {
            // Caller explicitly expects a business (quick actions pass
            // includedType): a same-named DISTRICT/CITY must not beat it on an
            // exact-name tie — "Nairi" the sublocality vs "Nairi Restaurant".
            // Only strictly administrative geography is penalized; natural
            // features / attractions are left alone (a historical quick action
            // legitimately resolves to those).
            const types = [p.primaryType, ...(p.types || [])].filter(Boolean).map(t => String(t).toLowerCase());
            if (types.some(t => ['locality', 'sublocality', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'country', 'political'].includes(t))) score -= 15;
        }
        if (score > bestScore) { bestScore = score; best = p; }          // ties keep Google's order
    }
    return best;
}

// Cache-read counterpart of pickBestPlaceCandidate. A poisoned mapping (the
// pre-fix resolver once cached searchName "limassol" → the Parklane resort)
// keeps serving the wrong place FOREVER unless the read side also judges the
// hit — the resolver fix alone can't help because a cache hit returns before
// fresh resolution ever runs. Rule: exact/prefix name matches are always fine
// ("Annabelle" → "Annabelle Hotel Paphos"); but when a PLAIN-name query (no
// hotel/restaurant word, no includedType) hits a row whose name merely
// CONTAINS the query and whose stored types say ESTABLISHMENT, that is the
// Limassol-inside-"Parklane …, Limassol" pattern → treat as a MISS so the
// (fixed) fresh resolution finds the real locality and caches it properly.
const CACHE_ESTABLISHMENT_TYPES = ['lodging', 'hotel', 'resort_hotel', 'motel', 'restaurant', 'bar', 'cafe', 'store', 'shopping_mall', 'supermarket', 'casino', 'spa', 'gym', 'night_club', 'car_rental', 'gas_station'];
function cachedHitAcceptable(query, cachedName, cachedTypes, cachedPrimaryType, includedType = null) {
    const norm = s => String(s || '').toLowerCase().trim().replace(/['\u2019\u2018\u0060]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(query), r = norm(cachedName);
    if (!q || !r) return true;                                        // nothing to judge → keep old behavior
    const qc = q.replace(/ /g, ''), rc = r.replace(/ /g, '');
    if (r === q || rc === qc || r.startsWith(q) || q.startsWith(r) || rc.startsWith(qc) || qc.startsWith(rc)) return true;   // exact / prefix (space-insensitive) → same place
    if (includedType || ESTABLISHMENT_QUERY_WORDS.test(String(query || ''))) return true; // caller wants a business → old behavior
    const types = [cachedPrimaryType, ...(cachedTypes || [])].filter(Boolean).map(t => String(t).toLowerCase());
    const isEstablishment = types.some(t => CACHE_ESTABLISHMENT_TYPES.includes(t) || t.endsWith('_store') || t.endsWith('restaurant') || t.endsWith('hotel'));
    return !isEstablishment;
}

async function getCachedPlaceDetails(placeIdOrName, detailedInfo = false, requestId = null, userLocation = null, knownPlaceId = null, includedType = null) {
    try {
        // console.log(`\n🔍 getCachedPlaceDetails called for: ${placeIdOrName}`);
        const CACHE_VALIDITY_DAYS = 30;
        let cached = null;
        let placeId = null;
        // ── Fast path: caller already has the Google placeId (quick-action
        // Google prefetch). Look up cache by ID directly and, on miss, skip the
        // findPlaces name→ID resolution call below (Step 3) entirely — go
        // straight to getPlaceDetails. Saves one Text Search call per place.
        if (knownPlaceId) {
            placeId = knownPlaceId;
            cached = await PlaceCache.findOne({ placeId: knownPlaceId });
        }
        // Step 1: Try to find in cache by ID or name
        if (!cached && placeIdOrName.startsWith('ChIJ')) {
            cached = await PlaceCache.findOne({ placeId: placeIdOrName });
            placeId = placeIdOrName;
            // console.log(`   Cache lookup by placeId: ${cached ? 'FOUND' : 'NOT FOUND'}`);
        }
        if (!cached && !knownPlaceId) {
            const normalizedName = placeIdOrName.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
            const nameFilter = { $or: [{ searchName: normalizedName }, { name: { $regex: new RegExp(escapeRegExp(placeIdOrName), 'i') } }, { searchName: { $regex: new RegExp(normalizedName.replace(/\s+/g, '.*'), 'i') } }] };
            const cLat = userLocation?.lat, cLng = userLocation?.lng;
            const hasCenter = Number.isFinite(cLat) && Number.isFinite(cLng);
            if (hasCenter) {
                // Location-aware cache match. A name-only lookup returns ANY same-named
                // place — e.g. a cached "Four Seasons" in Moscow served for a Cyprus
                // search — because location was never part of the key. Pull the name
                // matches and keep the one NEAREST the search center, and only if it's
                // plausibly the same area (<= MAX_CACHE_KM). Otherwise treat it as a MISS
                // so the location-biased Google resolution below finds the correct local
                // place instead of returning the wrong city from cache.
                // Also gate on name plausibility: the fuzzy regex above can match on a
                // single shared word, which otherwise pulls back an UNRELATED nearby
                // place (even a non-hotel) as the "nearest" hit. namesPlausiblyMatch
                // requires the significant tokens to actually correspond.
                const MAX_CACHE_KM = 300;
                const candidates = await PlaceCache.find(nameFilter).limit(10);
                let best = null, bestKm = Infinity;
                for (const c of candidates) {
                    if (!namesPlausiblyMatch(placeIdOrName, c.name)) continue;
                    if (!cachedHitAcceptable(placeIdOrName, c.name, c.types, c.primaryType, includedType)) {
                        console.log(`[cache] rejected poisoned mapping "${placeIdOrName}" → "${c.name}" (establishment cached under a plain place name); resolving fresh`);
                        // Self-clean: repoint the stale searchName to the row's own real
                        // name so this poisoned mapping stops matching (and stops being
                        // rejected + logged) on every future lookup. The row itself stays
                        // valid — it is still a perfectly good cache entry for ITS place.
                        if (c.name) {
                            PlaceCache.updateOne({ _id: c._id, searchName: normalizedName }, { $set: { searchName: c.name.toLowerCase().trim() } })
                                .catch(err => console.warn('[cache] searchName self-clean failed:', err.message));
                        }
                        continue;
                    }
                    const lat = c.details?.geometry?.location?.lat, lng = c.details?.geometry?.location?.lng;
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                    const km = _haversineKm(cLat, cLng, lat, lng);
                    if (km < bestKm) { bestKm = km; best = c; }
                }
                if (best && bestKm <= MAX_CACHE_KM) { cached = best; }
                else if (best) { console.log(`[cache] ignored name match "${placeIdOrName}" — nearest plausible cached copy is ${Math.round(bestKm)}km from search center; resolving fresh`); }
            } else {
                const c = await PlaceCache.findOne(nameFilter);
                cached = (c && namesPlausiblyMatch(placeIdOrName, c.name) && cachedHitAcceptable(placeIdOrName, c.name, c.types, c.primaryType, includedType)) ? c : null;
            }
            placeId = cached?.placeId;
            // console.log(`   Cache lookup by name: ${cached ? 'FOUND' : 'NOT FOUND'}`);
        }
        // Step 2: Check if cache is valid and complete
        // For type-gated actions (includedType set), also REQUIRE stored types —
        // otherwise an entry cached before type-checking existed (empty types)
        // would be served and silently pass the lenient type filter, letting old
        // non-restaurants (a brandy house, a resort) keep showing. Forcing a
        // refresh re-fetches details once (images are reused, no re-download),
        // populates types, and lets the filter classify it. Self-heals the cache.
        const typeKnown = !includedType || (Array.isArray(cached?.types) && cached.types.length > 0);
        const isCacheValid = cached && cached.photos && cached.photos.length > 0 && cached.imagesStored === true && cached.details?.geometry?.location?.lat && cached.details?.geometry?.location?.lng && (Date.now() - cached.lastFetched) < (CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000) && (!detailedInfo || cached.hasDetailedInfo) && typeKnown;
        if (isCacheValid) {
            // console.log(`✅ CACHE HIT - Returning without API calls`);
            PlaceCache.updateOne({ _id: cached._id }, { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } }).catch(err => console.error('Cache update failed:', err));
            return {
                name: cached.name,
                place_id: cached.placeId,
                formatted_address: cached.details.formatted_address,
                photos: cached.photos,
                photoUrls: cached.photos.map((photo, index) => `/api/ai/place-image/${cached.placeId}/${index}`),
                geometry: cached.details.geometry,
                rating: cached.rating,
                website: cached.website,
                formatted_phone_number: cached.formatted_phone_number,
                international_phone_number: cached.international_phone_number,
                opening_hours: cached.opening_hours,
                types: cached.types || [],
                primaryType: cached.primaryType || null,
                _fromCache: true
            };
        }
        // ✅ FIX: If we have cache with images but missing detailed info, only fetch details
        if (detailedInfo && cached && cached.imagesStored && !cached.hasDetailedInfo) {
            // console.log(`⚠️ Cache has images but missing detailed info - fetching ONLY details`);
            placeId = cached.placeId;
            const details = await googleService.getPlaceDetails(placeId, true, requestId);
            if (!details) {
                console.log(`❌ Failed to fetch detailed info for ${placeId}`);
                return null;
            }
            // console.log(`✅ Got detailed info: ${details.name}`);
            await PlaceCache.findOneAndUpdate(
                { placeId },
                { 
                    $set: { 
                        rating: details.rating,
                        website: details.website,
                        formatted_phone_number: details.formatted_phone_number,
                        international_phone_number: details.international_phone_number,
                        opening_hours: details.opening_hours,
                        types: details.types || [],
                        primaryType: details.primaryType || null,
                        priceLevel: details.price_level || null,
                        hasDetailedInfo: true,
                        lastFetched: new Date()
                    },
                    $inc: { fetchCount: 1 }
                }
            );
            // console.log(`✅ Updated cache with detailed info - images PRESERVED, no download needed`);
            return {
                name: cached.name,
                place_id: cached.placeId,
                formatted_address: cached.details.formatted_address,
                photos: cached.photos,
                photoUrls: cached.photos.map((photo, index) => `/api/ai/place-image/${cached.placeId}/${index}`),
                geometry: cached.details.geometry,
                rating: details.rating,
                website: details.website,
                formatted_phone_number: details.formatted_phone_number,
                international_phone_number: details.international_phone_number,
                opening_hours: details.opening_hours,
                types: details.types || cached.types || [],
                primaryType: details.primaryType || cached.primaryType || null,
                _fromCache: true
            };
        }
        if (detailedInfo && cached && !cached.hasDetailedInfo) {console.log(`⚠️ Cache exists but missing detailed info - will fetch from Google`)}
        // Step 3: Need to fetch from Google - get place_id if needed
        if (!placeId) {
            // NOTE: we intentionally do NOT pass includedType to Google here.
            // In Text Search (New), includedType is a HARD filter, not a bias —
            // includedType:'restaurant' excludes places Google types as 'cafe' /
            // 'bar' / 'bakery', returning 0 results for real cafés and bistros.
            // We resolve broadly and let placeMatchesActionType() (which allows the
            // full food family) gate the result after the fact.
            const places = await googleService.findPlaces(placeIdOrName, userLocation, requestId);
            if (!places || places.length === 0) {
                console.log(`⚠️ No places found for: ${placeIdOrName}`);
                return null;
            }
            // ── Name-similarity guard on FRESH resolution ─────────────────────
            // Google's Text Search returns its closest match no matter how far
            // off it is, so a name resolved with a wrong/GPS-biased center can
            // come back as a completely unrelated place — a chat card for
            // "Amara" (Limassol) once morphed into "N1 Armenian Shooting Range"
            // (Yerevan) at completion, because the streaming card shows the
            // model's name but the final card takes the RESOLVED name. The
            // cache path above already checks namesPlausiblyMatch; the fresh
            // path took places[0] blindly. Pick the first candidate whose name
            // plausibly matches instead; none → treat as NOT FOUND, so the chat
            // caller falls back to an AI-only card that keeps the model's name
            // (no wrong photo/address/coords), and nothing junk gets cached
            // under this searchName. Candidates without a name (older
            // deployments of findPlaces) are accepted, preserving old behavior.
            // Cross-script resolutions (Latin query → native-script name) are
            // kept by namesPlausiblyMatch itself.
            const plausible = pickBestPlaceCandidate(placeIdOrName, places, includedType);
            if (!plausible) {
                console.log(`[resolve] rejected all ${places.length} candidate(s) for "${placeIdOrName}" — best was "${places[0].name}" (implausible name match)`);
                return null;
            }
            if (places[0] && plausible !== places[0]) {
                console.log(`[resolve] "${placeIdOrName}" → picked "${plausible.name}" over Google's #1 "${places[0].name}" (better name/type match)`);
            }
            placeId = plausible.place_id;
            // console.log(`   Found place_id: ${placeId}`);
            const cachedById = await PlaceCache.findOne({placeId, imagesStored: true, 'details.geometry.location.lat': { $exists: true }});
            const cachedByIdTypeKnown = !includedType || (Array.isArray(cachedById?.types) && cachedById.types.length > 0);
            if (cachedById && cachedByIdTypeKnown && (Date.now() - cachedById.lastFetched) < (CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)) {
                if (!detailedInfo || cachedById.hasDetailedInfo) {
                    // console.log(`✅ Found complete cache by place_id - avoiding getPlaceDetails call!`);
                    return {
                        name: cachedById.name,
                        place_id: placeId,
                        formatted_address: cachedById.details.formatted_address,
                        photos: cachedById.photos,
                        photoUrls: cachedById.photos.map((photo, index) => `/api/ai/place-image/${placeId}/${index}`),
                        geometry: cachedById.details.geometry,
                        rating: cachedById.rating,
                        website: cachedById.website,
                        formatted_phone_number: cachedById.formatted_phone_number,
                        international_phone_number: cachedById.international_phone_number,
                        opening_hours: cachedById.opening_hours,
                        types: cachedById.types || [],
                        primaryType: cachedById.primaryType || null,
                        _fromCache: true
                    };
                }
            }
        }
        // Step 4: Get place details (geometry + photos)
        const details = await googleService.getPlaceDetails(placeId, detailedInfo, requestId);
        if (!details || !details.geometry?.location?.lat) {
            console.log(`❌ Invalid details received for ${placeId}`);
            return null;
        }
        // console.log(`✅ Got details: ${details.name}`);
        // Step 5: Save place info to cache
        const photosWithReferences = (details.photos || []).slice(0, 3).map(photo => ({
            // Places API (New) uses photo.name; legacy used photo.photo_reference
            photoReference: photo.name || photo.photo_reference,
            width: photo.widthPx || photo.width,
            height: photo.heightPx || photo.height
        }));
        // Whether the cached entry ALREADY has a usable image byte in slot 0.
        // Computed from the pre-write `cached` doc. When true, this Step-4 pass is
        // only here to backfill metadata (e.g. types for the sanity filter), so we
        // must NOT clobber the stored photo bytes with byte-less references —
        // doing so (and then skipping the re-download below) is what silently
        // emptied images on type-refreshed entries.
        const alreadyHasImages = !!(cached && cached.imagesStored && cached.photos && cached.photos[0] && cached.photos[0].imageData);
        const { country: parsedCountry, city: parsedCity } = parseAddressRegion(details.formatted_address);
        const updateData = {
            placeId,
            searchName: placeIdOrName.toLowerCase().trim(),
            name: details.name,
            details: {formatted_address: details.formatted_address, geometry: details.geometry},
            country: parsedCountry,
            city: parsedCity,
            rating: details.rating,
            website: details.website,
            formatted_phone_number: details.formatted_phone_number,
            international_phone_number: details.international_phone_number,
            opening_hours: details.opening_hours,
            types: details.types || [],
            primaryType: details.primaryType || null,
            priceLevel: details.price_level || null,
            hasDetailedInfo: true, 
            lastFetched: new Date(),
        };
        // Only (re)write the photo references + reset the stored flag when we don't
        // already have bytes — otherwise preserve the existing downloaded image.
        if (!alreadyHasImages) {
            updateData.photos = photosWithReferences;
            updateData.imagesStored = false;
        }
        await PlaceCache.findOneAndUpdate({ placeId }, { $set: updateData, $inc: { fetchCount: 1 } }, { upsert: true, new: true });
        // console.log(`💾 Saved place info to cache (images not yet downloaded)`);
        // Step 6: Download and store images (1 image only) - ONLY IF NOT ALREADY STORED
        if (details.photos && details.photos.length > 0) {
            try {
                // alreadyHasImages was computed BEFORE the cache write above, so it
                // reflects the real prior state (the write no longer clobbers bytes).
                if (!alreadyHasImages) {
                    // console.log('📥 Images not in cache - downloading...');
                    if (requestId) { googleService.trackApiCall('imageDownload', requestId) }
                    await imageStorageService.downloadAndStoreImages(placeId, details.photos.slice(0, 1), 1, requestId);
                    // console.log('✅ Images downloaded and stored');
                } else {console.log('✅ Images already in cache - skipping download (saved 1 API call!)')}
                const updatedCache = await PlaceCache.findOne({ placeId });
                const photosWithServerUrls = updatedCache.photos.map((photo, index) => ({photoReference: photo.photoReference, width: photo.width, height: photo.height, imageData: true, url: `/api/ai/place-image/${placeId}/${index}`}));
                return {
                    name: updatedCache.name,
                    place_id: placeId,
                    formatted_address: updatedCache.details.formatted_address,
                    photos: photosWithServerUrls,
                    photoUrls: photosWithServerUrls.map(p => p.url),
                    geometry: details.geometry,
                    rating: updatedCache.rating,
                    website: updatedCache.website,
                    formatted_phone_number: updatedCache.formatted_phone_number,
                    international_phone_number: updatedCache.international_phone_number,
                    opening_hours: updatedCache.opening_hours,
                    types: details.types || updatedCache.types || [],
                    primaryType: details.primaryType || updatedCache.primaryType || null,
                    _fromCache: false
                };
            } catch (downloadError) {
                console.error(`❌ Image download failed:`, downloadError.message);
                return {
                    name: details.name,
                    place_id: placeId,
                    formatted_address: details.formatted_address,
                    photos: [],
                    photoUrls: [],
                    geometry: details.geometry,
                    rating: details.rating,
                    website: details.website,
                    formatted_phone_number: details.formatted_phone_number,
                    international_phone_number: details.international_phone_number,
                    opening_hours: details.opening_hours,
                    types: details.types || [],
                    primaryType: details.primaryType || null,
                    _fromCache: false
                };
            }
        }
        return {
            name: details.name,
            place_id: placeId,
            formatted_address: details.formatted_address,
            photos: [],
            photoUrls: [],
            geometry: details.geometry,
            rating: details.rating,
            website: details.website,
            formatted_phone_number: details.formatted_phone_number,
            international_phone_number: details.international_phone_number,
            opening_hours: details.opening_hours,
            types: details.types || [],
            primaryType: details.primaryType || null,
            _fromCache: false
        };
    } catch (error) {
        console.error('❌ getCachedPlaceDetails error:', error);
        return null;
    }
}

async function getGooglePlaceImages(placeName, location = null) {
    try {
        const places = await googleService.findPlaces(placeName, location);
        if (places.length === 0) {
            console.log(`No places found for: ${placeName}`);
            return [];
        }
        const placeDetails = await getCachedPlaceDetails( places[0].place_id, false );
        if (!placeDetails || !placeDetails.photos) {
            console.log(`No photos found for: ${placeName}`);
            return [];
        }
        if (placeDetails._fromCache) {
            const cached = await PlaceCache.findOne({ placeId: places[0].place_id });
            return cached.photos.map((photo, index) => ({
                url: photo.url,
                title: `${placeName} - View ${index + 1}`,
                caption: generateImageCaption(placeName, index),
                source: 'google_places_cached'
            }));
        }
        const images = placeDetails.photos.slice(0, 8).map((photo, index) => ({
            // Proxy through the backend — never a direct Google URL, which would
            // leak the API key to the browser AND fail the key's IP restriction.
            url: `/api/ai/place-image/${places[0].place_id}/${index}`,
            title: `${placeName} - View ${index + 1}`,
            caption: generateImageCaption(placeName, index),
            source: 'google_places'
        }));
        return images;
    } catch (error) {
        console.error('Failed to get Google place images:', error);
        return [];
    }
}

function setupConnectionMonitoring(req, res, onDisconnect) {
  let disconnected = false;
  const handleDisconnect = () => {
    if (!disconnected) {
      disconnected = true;
      onDisconnect();
    }
  };
  req.on('close', handleDisconnect);
  req.on('error', handleDisconnect);  
  if (req.socket) {
    req.socket.on('close', handleDisconnect);
    req.socket.on('error', handleDisconnect);    
    const heartbeat = setInterval(() => {
        if (req.socket.destroyed || disconnected) {
            clearInterval(heartbeat);
            handleDisconnect();
        }
    }, 1000);   
    res.on('finish', () => {clearInterval(heartbeat)});
  }
  return () => disconnected;
}

// In-process geocode memo. The intent classifier tends to repeat the
// conversation's destination in place_names on every turn, which used to
// re-geocode the SAME city via Google on every message. Successful lookups
// are remembered for 6h; failures are not memoized (could be transient).
const _geocodeMemo = new Map();
const GEOCODE_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
async function getCoordinatesForPlace(placeName, userLocation = null, requestId = null) {
    const memoKey = `${String(placeName).toLowerCase().trim()}|${(userLocation && userLocation.lat != null) ? Number(userLocation.lat).toFixed(1) + ',' + Number(userLocation.lng).toFixed(1) : 'none'}`;
    const memoHit = _geocodeMemo.get(memoKey);
    if (memoHit && (Date.now() - memoHit.ts) < GEOCODE_MEMO_TTL_MS) {
        return memoHit.value;
    }
    try {
        // console.log(`\nGetting coordinates for: ${placeName}`);
        const places = await googleService.findPlaces(placeName, userLocation, requestId);
        if (places.length === 0) {
            console.log(`\n❌ No places found for: ${placeName}`);
            return null;
        }
        const firstPlace = places[0];
        const coordinates = firstPlace.geometry?.location;
        if (coordinates && coordinates.lat && coordinates.lng) {
            // console.log(`\n✅ Found coordinates for ${placeName}: ${coordinates.lat}, ${coordinates.lng}`);
            const geo = {lat: coordinates.lat, lng: coordinates.lng, placeName: firstPlace.name, formattedAddress: firstPlace.formatted_address, placeId: firstPlace.place_id, types: [firstPlace.primaryType, ...(firstPlace.types || [])].filter(Boolean), confidence: 'high'};
            if (_geocodeMemo.size >= 500) { _geocodeMemo.delete(_geocodeMemo.keys().next().value); }   // cap memory
            _geocodeMemo.set(memoKey, { value: geo, ts: Date.now() });
            return geo;
        }
        console.log(`\n❌ No coordinates in place data for: ${placeName}`);
        return null;
    } catch (error) {
        console.error(`\n❌ Error getting coordinates for ${placeName}:`, error);
        return null;
    }
}

async function detectAndEmitRecommendations(fullResponse, currentRecommendations, emittedRecommendations, res, lastDetectionTimeRef, DETECTION_THROTTLE_MS, lastExtractedRecsRef, nearbyMode = false, alreadyShownNames = [], userDislikedNames = []) {
  const now = Date.now();
  if (now - lastDetectionTimeRef.current < DETECTION_THROTTLE_MS) return;
  if (!fullResponse.trim()) return;
  lastDetectionTimeRef.current = now;
  try {
    // Only detect GENUINE arrow-format recommendations while streaming. (Earlier this
    // normalized arrow-less text too, but that misread the model's prose — e.g.
    // "**Annabelle** is a 5-star hotel" — as a recommendation and streamed a card that
    // then vanished at completion. Arrow-less recs are recovered at completion instead,
    // where the full text is available and nothing flickers.)
    const bracketedNames = extractChatRecommendations(fullResponse);
    const previousRecs = lastExtractedRecsRef.current || [];
    const previousRecNames = new Set(previousRecs.map(r => r.name));
    const newlyExtractedRecs = bracketedNames.filter(rec => !previousRecNames.has(rec.name));
    if (newlyExtractedRecs.length > 0) {
        // console.log(`\n🔍 Found ${newlyExtractedRecs.length} NEW recommendation(s):`);
        // newlyExtractedRecs.forEach(rec => {console.log(`   + ${rec.position}. ${rec.name}`)});
    }    
    lastExtractedRecsRef.current = bracketedNames;    
    // Disliked-name check mirrors alreadyShownNames: streaming cards are emitted by
    // NAME before the placeId is known, so without this a disliked place's card
    // would stream in and then vanish at completion — the same jarring "appeared
    // then disappeared" the alreadyShownNames suppression exists to prevent.
    const newRecommendations = newlyExtractedRecs.filter(rec => !emittedRecommendations.has(rec.name) && rec.format === 'arrow' && looksLikePlaceName(rec.name) && rec.hasViewImages && !(alreadyShownNames || []).some(n => namesPlausiblyMatch(rec.name, n)) && !(userDislikedNames || []).some(n => namesPlausiblyMatch(rec.name, n)));
    for (const nameObj of newRecommendations) {
      if (currentRecommendations.some(rec => rec.name === nameObj.name)) { continue }
      // console.log(`Streaming recommendation detected: ${nameObj.name}`);
      const streamingRecommendation = {
        id: `stream-rec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: nameObj.name,
        description: '',  
        category: 'Searching...',
        region: 'Searching location...',
        location: 'Searching...',
        distance: nearbyMode ? '...' : undefined,
        image: null,
        source: 'ai',
        placeId: null,
        isChatRecommendation: true,
        isLargeCard: true,
        appearsInline: true,
        isStreaming: true,
        metadata: {
          hasAIDescription: true,
          sourceDescription: 'ai_generated',
          originalDescription: nameObj.description,
          hasViewImagesText: true,
          streaming: true,
          enrichmentDeferred: true,
          originalPosition: nameObj.position - 1,
        }
      };
      const streamingEvent = { type: 'streaming_recommendation', recommendation: streamingRecommendation, metadata: { timestamp: new Date(), isPartial: true } };
      res.write(`data: ${JSON.stringify(streamingEvent)}\n\n`);
      // console.log(`Emitted streaming recommendation: ${nameObj.name}`);
      emittedRecommendations.add(nameObj.name);
      currentRecommendations.push(nameObj);
      /* No replay. The description already streamed LIVE as description_token
       * events while the block was open, and the client now creates the card at
       * arrow-open and catches them — replaying it here (the old 20ms/word fake
       * typing) would print every description twice. */
    }
  } catch (error) { console.error('Error detecting streaming recommendations:', error) }
}

async function streamDescriptionToCard(description, recommendationId, recommendationName, res) {
  if (!description) return;
  const words = description.split(' ');
  for (const word of words) {
    res.write(`data: ${JSON.stringify({ type: 'description_token', recommendationId: recommendationId, recommendationName: recommendationName, content: word + ' ' })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// ── Guards against prose masquerading as place names ────────────────────────
// The salvage below rewrites paragraph-leading bold into cards. That is right
// for "**Annabelle Hotel**  description" but WRONG for bold SECTION HEADERS in
// comparison answers: "**For luxury and convenience:** The south is best…"
// became a card, its header text was sent to Google text search, and Google —
// a search engine, not a validator — returned a convenience & cigar shop for
// it. These helpers stop non-place strings BEFORE a card exists and BEFORE any
// Google money is spent on them.
const NON_PLACE_LEADERS = /^(for|if|when|why|how|what|where|whether|option|options|tip|tips|note|pros?|cons?|summary|overall|in short|first|second|third|finally|next|also|however|additionally|alternatively|day \d|step \d|the best|best for)\b/i;
// Section-header vocabulary across the app's UI languages (en/ru/fr/hy/ar/zh).
// A bold name consisting ONLY of these words is a heading, never a venue.
const SECTION_HEADER_WORDS = new Set([
    'atmosphere', 'ambience', 'ambiance', 'menu', 'location', 'summary', 'conclusion', 'verdict', 'comparison',
    'recommendation', 'recommendations', 'overview', 'highlights', 'amenities', 'rooms', 'dining', 'service',
    'cuisine', 'price', 'prices', 'pricing', 'overall', 'pros', 'cons', 'features', 'facilities', 'access',
    'атмосфера', 'меню', 'расположение', 'итог', 'вывод', 'сравнение', 'рекомендация', 'рекомендации',
    'кухня', 'обслуживание', 'персонал', 'цены', 'цена', 'интерьер', 'плюсы', 'минусы', 'заключение', 'резюме',
    'emplacement', 'résumé', 'recommandation', 'prix', 'avantages', 'inconvénients',
    'մթնոլորտ', 'մենյու', 'ամփոփում', 'եզրակացություն', 'խոհանոց',
    'الأجواء', 'القائمة', 'الموقع', 'الخلاصة', 'التوصية', 'المطبخ', 'الخدمة', 'الأسعار',
    '氛围', '菜单', '位置', '总结', '推荐', '服务', '价格', '结论'
]);
const PLACE_NAME_FUNCTION_WORDS = new Set(['for','and','the','of','to','a','an','or','with','in','on','is','are','your','you','it','this','that','most','more','both','how','what','when','where','why','if','best']);

function looksLikePlaceName(raw) {
    const name = String(raw || '').trim();
    if (name.length < 2 || name.length > 90) return false;
    if (/[:;.!?,]$/.test(name)) return false;                        // section headers end with punctuation
    // Count only substantive words: "&", "-", "a" etc. don't make a name long.
    // ("Parklane, a Luxury Collection Resort & Spa" is a REAL hotel — 7 raw
    // tokens once "&" is split, which the old cap of 6 wrongly rejected.)
    const words = name.split(/\s+/).filter(w => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2);
    if (words.length > 8) return false;                              // real place names are short-ish
    if (NON_PLACE_LEADERS.test(name)) return false;                  // "For …", "Option 1 …", "Tips …"
    // Multilingual section headers: the leader regex is English-only, so a
    // Russian reply with bold "Атмосфера"/"Меню"/"Итог" headers sailed through,
    // fired Google searches for the words "Atmosphere"/"Menu"/"Summary", and an
    // air-conditioner cleaning company got a card because its name contained
    // "Обслуживание". Reject names made ENTIRELY of header vocabulary.
    const normWords = words.map(w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
    if (normWords.length > 0 && normWords.every(w => SECTION_HEADER_WORDS.has(w))) return false;
    if (words.length >= 3) {
        const stops = words.filter(w => PLACE_NAME_FUNCTION_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, ''))).length;
        if (stops / words.length > 0.5) return false;                // strictly-more-than: "The Bunch of Grapes" (2/4) is a REAL pub
    }
    return true;
}

// Runs AFTER normalizeRecommendationFormat: any **Name** → desc ← block whose
// "name" fails looksLikePlaceName is demoted back to readable prose
// ("**Name** desc"), so it is never extracted, never enriched via Google, and
// never becomes a card — but the sentence the model wrote is fully preserved
// in the reply text for the user.
function demoteNonPlaceRecs(text) {
    if (!text || text.indexOf('→') === -1) return text;
    return text.replace(/\*\*([^*\n]{2,90}?)\*\*\s*→\s*([^←]*?)\s*←/g, (block, name, desc) => {
        if (looksLikePlaceName(name)) return block;
        console.log(`   🚷 Demoted non-place bold header to prose: "${String(name).trim().slice(0, 60)}"`);
        return `**${name.trim()}** ${desc.trim()}`;
    });
}

// Recover recommendations when the model omits the arrow syntax. DeepSeek
// intermittently writes "**Place Name**  description" per paragraph with NO
// "→ … ←", which yields ZERO cards (the "No arrow-formatted names" case).
// This rewrites each paragraph-leading bold name + its description into the
// canonical **Name** → description ← form so the existing extractor and
// placeholder logic work unchanged. Guards against false positives:
//   • only bold that STARTS a line/paragraph is treated as a name (emphasis
//     bold like **luxury** is mid-sentence and is never matched),
//   • a real description (≥15 chars) must follow,
//   • if the text already contains arrow-formatted recs, it's returned as-is.
function normalizeRecommendationFormat(text) {
    if (!text) return text;
    let found = false;
    // Rewrite each paragraph-leading "**Name** [→] description [←]" into the exact
    // canonical **Name** → description ← form. Handles all of DeepSeek's deviations:
    //   • no arrows at all           ("**Name**  description")
    //   • opening arrow, no closer   ("**Name** → description")   ← caused a leaked "→"
    //   • already fully correct      (idempotent — produces the same string)
    // A stray leading → / trailing ← inside the captured description is stripped so a
    // double arrow can never reach the extractor. Only bold that STARTS a line is
    // treated as a name (mid-sentence emphasis like **luxury** is never matched), and
    // a real description (≥15 chars) must follow.
    const out = text.replace(
        /(^|\n[ \t]*\n)[ \t]*(?:\d+[.)]|[-*•])?[ \t]*\*\*([^*\n]{2,90}?)\*\*([ \t]*[:\-–—]?[ \t]*(?:\r?\n[ \t]*)?)(?:→[ \t]*)?([^\n]{15,}?)(?:←[ \t]*)?(?=\n[ \t]*\n|\n[ \t]*(?:\d+[.)]|[-*•])?[ \t]*\*\*|$)/g,
        (m, brk, name, gap, desc) => {
            // Name and description split across a line break ("**The Bishops**\n
            // description") used to be skipped entirely, so whether a place got
            // a card depended on the model's line-wrapping. Promote across ONE
            // newline too — but only for plausible place names, so bold section
            // headers followed by bullet lists ("**Clothing:**\n• …") keep
            // their original formatting untouched.
            if (/\n/.test(gap)) {
                const wc = name.trim().split(/\s+/).filter(w => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).length;
                // Single bold words on their own line are section headers far
                // more often than venues; only multi-word names cross the break.
                if (wc < 2 || !looksLikePlaceName(name)) return m;
            }
            const n = name.trim();
            let d = desc.trim().replace(/^→\s*/, '').replace(/\s*←$/, '').trim();
            if (!n || d.length < 15) return m;
            // When the model writes "**Paphos** is a fantastic blend…" the bold
            // name was the SUBJECT of the sentence, so the captured description
            // is a headless fragment ("is a fantastic blend…"). The card shows
            // the name separately in its header, so give the fragment a subject
            // to read as a complete sentence ("It is a fantastic blend…").
            if (/^(is|are|was|were|has|have|had|offers|offered|boasts|features|provides|remains|sits|lies|combines|blends|serves|delivers|stands|hosts)\b/i.test(d)) {
                d = 'It ' + d.charAt(0).toLowerCase() + d.slice(1);
            }
            found = true;
            return `${brk}**${n}** → ${d} ←`;
        }
    );
    return found ? out : text;
}

function cleanMainText(aiResponse, bracketedNames) {
    // console.log('🧹 (cleanMainText) Cleaning main text with exact formatting...');
    let result = aiResponse;
    for (let i = bracketedNames.length - 1; i >= 0; i--) {
        const nameObj = bracketedNames[i];
        const namePattern = nameObj.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Absorb an optional leading list marker ("1." / "1)" / "-" / "•") and a
        // single leading newline+indent immediately before the **name**. DeepSeek
        // wraps recommendations in a numbered/bulleted list even though the format
        // contract doesn't ask for one; without swallowing the marker here it
        // survives into the text part and renders as a stray "1." above the card.
        // The marker is only consumed when it sits right before a real
        // **name** → … ← block, so genuine prose numbering is left intact.
        const arrowPattern = new RegExp(`[ \\t]*(?:\\r?\\n)?[ \\t]*(?:\\d+[.)]|[-*•])?[ \\t]*\\*\\*${namePattern}\\*\\*\\s*→[^←]*←\\s*`, 'g');
        result = result.replace(arrowPattern, `{{RECOMMENDATION_${i}}}`);
    }
    // console.log(`Text length: ${result.length} (original: ${aiResponse.length})`);
    return result;
}

/* Resolve `promise`, or fall back after `ms`. Completion enrichment must be
 * bounded: a place-details lookup that stalls (e.g. Mongo server-selection
 * during a connection blip — the observed 30s "silent gap" before 'complete')
 * should degrade THAT ONE card to prose, not freeze the entire reply. Errors
 * also resolve to the fallback so Promise.all never rejects wholesale. */
const withEnrichTimeout = (promise, ms = 8000, fallback = null) => Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
        const t = setTimeout(() => resolve(fallback), ms);
        if (typeof t.unref === 'function') t.unref();
    }),
]);

async function processStreamCompletion(aiResponse, businesses, destinations, message, userId, res, req = null, effectiveLocation = null, userPreferences = {}, currentRecommendations = [], emittedRecommendations = new Set(), requestId = null, detectedActionType = 'general', nearbyMode = false, healthCheck = null, inputTokens = 0, provider = 'deepseek', searchCount = 0, alreadyShownPlaceIds = [], userDislikedIds = new Set(), realTokens = null) {
    try {
        currentRecommendations = currentRecommendations || [];
        emittedRecommendations = emittedRecommendations || new Set();
        // Recover cards when the model dropped the arrow syntax (see helper above).
        // No-op when the output is already arrow-formatted or has no recommendations.
        aiResponse = normalizeRecommendationFormat(aiResponse);
        // …then demote anything the salvage promoted that is NOT a place name
        // (bold section headers like "**For luxury and convenience:**") back to
        // plain prose before extraction/enrichment ever sees it.
        aiResponse = demoteNonPlaceRecs(aiResponse);
        // console.log('\n🤖 AI Response:\n', aiResponse);
        // console.log('\n');
        // console.log(`🎯 Detected action type in processStreamCompletion: ${detectedActionType}`);
        let recommendations = [];
        let mainText = aiResponse;
        let textParts = [];
        let uniquePlaces = new Set();
        
        const shouldSuggestPreferences = !userPreferences || ( (!userPreferences.interests || userPreferences.interests.length === 0) && !userPreferences.travelStyle && (!userPreferences.budget || !userPreferences.budget.min || !userPreferences.budget.max) );
        if (shouldSuggestPreferences && isTravelRelatedQuery(message)) {
            const suggestionMessage = { type: 'preference_suggestion', message: "I notice you haven't set your travel preferences yet. You can set them in your profile.", timestamp: new Date() };
            res.write(`data: ${JSON.stringify(suggestionMessage)}\n\n`);
        }
        // console.log('🔍 Looking for names in AI response...');
        const bracketedNames = extractChatRecommendations(aiResponse);
        // console.log('Names: ', bracketedNames);
        // Validator-curated category rejects for THIS turn's category — places staff
        // filed under a different category than the one the user is asking about.
        // Declared at function scope because BOTH the live card list (inside the
        // branch below) and the authoritative drop pass (after it) must agree;
        // otherwise a wrong-category card flashes on screen and then vanishes.
        // Stays empty when the response carries no cards, and when the intent
        // pre-pass resolved no concrete category ('general' free chat is never gated).
        let curatedRejects = new Set();

        if (bracketedNames.length > 0) {
            // console.log(`\n📊 Pre-fetched data available: ${businesses.length} businesses, ${destinations.length} destinations`);
            const streamedRecMap = new Map();
            currentRecommendations.forEach(rec => { if (rec && rec.name) { streamedRecMap.set(rec.name.toLowerCase().trim(), rec) } });            
            // Enrich all places in PARALLEL. Each iteration is independent (no reads of
            // the shared recommendations array), and every new place triggers Google
            // calls + an image download; running them sequentially was the multi-second
            // silent gap between the stream ending and 'complete'. Promise.all collapses
            // that to roughly one round-trip. Results are collected in order so the
            // contentParts index alignment is preserved.
            // Tell the client enrichment has begun — the text stream is done but
            // 'complete' is still seconds away (Google lookups + images). Unknown
            // event types are safely ignored by older clients; the UI can use this
            // to show a "verifying places…" state instead of silence.
            res.write(`data: ${JSON.stringify({ type: 'status', stage: 'verifying_places', count: bracketedNames.length })}\n\n`);
            const builtRecs = await Promise.all(bracketedNames.map(async (nameObj, i) => {
                try {
                    // console.log(`\n🔄 Processing recommendation ${i + 1}/${bracketedNames.length}: ${nameObj.name}`);
                    // console.log(`   Original AI position: ${i}`);
                    // console.log(`   Original AI description: "${nameObj.description.substring(0, 50) + '...'}"`);
                    // console.log(`   Format: ${nameObj.format}, Need to show card? ${nameObj.hasViewImages}`);
                    // 🔥 STEP 0: Check if this was already streamed to the client
                    const normalizedSearchName = nameObj.name.toLowerCase().trim();
                    let existingRec = streamedRecMap.get(normalizedSearchName);
                    if (existingRec) {
                        existingRec.description = nameObj.description || existingRec.description;
                        existingRec.metadata.hasViewImagesText = nameObj.hasViewImages;
                        existingRec.metadata.originalPosition = i;
                        return existingRec;
                    }
                    // 🔥 STEP 1: Try to find in pre-fetched businesses FIRST
                    let entityDetails = null;
                    // console.log(`   🔍 Searching for: "${nameObj.name}"`);
                    const fuzzyMatch = (str1, str2) => {
                        const s1 = str1.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
                        const s2 = str2.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');                        
                        if (s1 === s2) return 100;                        
                        if (s1.includes(s2) || s2.includes(s1)) return 80;                        
                        const words1 = s1.split(' ');
                        const words2 = s2.split(' ');
                        const commonWords = words1.filter(w => words2.includes(w) && w.length > 2);
                        if (commonWords.length > 0) return 60;
                        return 0;
                    };
                    let bestMatch = null;
                    let bestScore = 0;
                    for (const b of businesses) {
                        const score = fuzzyMatch(nameObj.name, b.name);
                        if (score > bestScore && score >= 80) {
                            bestScore = score;
                            bestMatch = { type: 'business', data: b };
                        }
                    }                    
                    if (bestScore < 100) {
                        for (const d of destinations) {
                            const score = fuzzyMatch(nameObj.name, d.name);
                            if (score > bestScore && score >= 80) {
                                bestScore = score;
                                bestMatch = { type: 'destination', data: d };
                            }
                        }
                    }
                    if (bestMatch) {
                        // console.log(`   ✅ Found match (score: ${bestScore}): ${bestMatch.data.name}`);
                        if (bestMatch.type === 'business') { entityDetails = formatBusinessDetails(bestMatch.data) } 
                        else { entityDetails = formatDestinationDetails(bestMatch.data) }
                        entityDetails.source = 'database';
                        entityDetails.matchScore = bestScore;
                    } else { 
                        // console.log(`   ❌ No match found in pre-fetched data (best score: ${bestScore})`) 
                    }
                    // 🔥 STEP 2: Only call getCachedPlaceDetail if not found in pre-fetched data
                    if (!entityDetails) {
                        // console.log(`⚠️ Not in pre-fetched data, using getCachedPlaceDetails for: ${nameObj.name}`);
                        let cachedDetails = await withEnrichTimeout(getCachedPlaceDetails(nameObj.name, false, requestId, effectiveLocation), 8000, null);
                        // ── Identity check ──────────────────────────────────────
                        // Google text search returns SOMETHING for almost any
                        // string. Only accept the result if its name plausibly
                        // matches what we asked for (fuzzyMatch ≥ 80 = exact or
                        // one-contains-the-other). A shared-word-only match (60)
                        // means a DIFFERENT place — e.g. asking for a hallucinated
                        // hotel and getting a random local business back. On
                        // rejection behave exactly as if Google found nothing:
                        // plain AI mention, no wrong identity, no wrong photo.
                        if (cachedDetails && cachedDetails.name) {
                            const score = fuzzyMatch(nameObj.name, cachedDetails.name);
                            // Word-order tolerance: "Garni Temple" vs Google's
                            // "Temple of Garni" scores only 60 on fuzzyMatch, but
                            // every content word of OUR query appears in Google's
                            // name — that's the same place, keep it. The cigar
                            // shop fails this ("luxury" never appears in its name).
                            const googleNameLower = cachedDetails.name.toLowerCase();
                            const queryWords = nameObj.name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
                                .filter(w => w.length > 2 && !PLACE_NAME_FUNCTION_WORDS.has(w));
                            const allQueryWordsPresent = queryWords.length > 0 && queryWords.every(w => googleNameLower.includes(w));
                            if (score < 80 && !allQueryWordsPresent) {
                                console.log(`   🚫 Enrichment rejected: asked "${nameObj.name}" but Google returned "${cachedDetails.name}" — name mismatch, keeping plain AI mention`);
                                cachedDetails = null;
                            }
                        }
                        if (cachedDetails) {
                            entityDetails = {
                                source: cachedDetails._fromCache ? 'cache' : 'google',
                                name: cachedDetails.name,
                                place_id: cachedDetails.place_id,
                                description: nameObj.description,
                                address: cachedDetails.formatted_address,
                                images: cachedDetails.photoUrls || [],
                                geometry: cachedDetails.geometry,
                                website: cachedDetails.website || null,
                                phone: cachedDetails.formatted_phone_number || cachedDetails.international_phone_number || null,
                                types: cachedDetails.types || [],
                                primaryType: cachedDetails.primaryType || null,
                                _fromCache: cachedDetails._fromCache
                            };
                            if (effectiveLocation && cachedDetails.geometry?.location) {
                                try {
                                    const placeLocation = {lat: cachedDetails.geometry.location.lat, lng: cachedDetails.geometry.location.lng, id: cachedDetails.place_id, name: cachedDetails.name};
                                    const distanceResults = await googleService.calculateDistances(effectiveLocation, [placeLocation], `${requestId}-ai-rec-dist`);
                                    if (distanceResults.length > 0 && distanceResults[0].status === 'OK') {
                                        entityDetails.distance = distanceResults[0].distance.text;
                                        entityDetails.distanceKm = distanceResults[0].distance.km;
                                        entityDetails.duration = distanceResults[0].duration.text;
                                        // console.log(`   📏 Calculated distance: ${entityDetails.distance} (${entityDetails.duration})`);
                                    }
                                } catch (distError) { console.warn(`   ⚠️ Distance calculation failed:`, distError.message) }
                            }
                        } else { entityDetails = { source: 'ai', name: nameObj.name, description: nameObj.description, notFound: false } }
                    }
                    const aiDescription = nameObj.description || nameObj.name;
                    const shouldShowCard = nameObj.hasViewImages;
                    let category = 'Attraction';
                    if (entityDetails.type) {
                        if (Array.isArray(entityDetails.type)) { category = getDisplayTypeFromEnum(entityDetails.type) } 
                        else { category = getDisplayTypeFromEnum([entityDetails.type]) }
                    } 
                    else if (entityDetails.types && Array.isArray(entityDetails.types)) { category = getDisplayTypeFromEnum(entityDetails.types) }
                    else {
                        category = getCategoryFromActionType(detectedActionType);
                        const nameLower = nameObj.name.toLowerCase();
                        if (nameLower.includes('hotel') || nameLower.includes('inn') || nameLower.includes('resort')) { category = 'Hotel' } 
                        else if (nameLower.includes('restaurant') || nameLower.includes('cafe') || nameLower.includes('bistro')) { category = 'Restaurant' } 
                        else if (nameLower.includes('museum') || nameLower.includes('gallery')) { category = 'Museum' } 
                        else if (nameLower.includes('park') || nameLower.includes('garden')) { category = 'Park' }
                    }
                    // console.log(`   Should show card: ${shouldShowCard}`);

                    let distanceInfo = null;
                    if (entityDetails.distance || entityDetails.distanceKm) {
                        distanceInfo = {distance: entityDetails.distanceKm ? `${entityDetails.distanceKm} km` : entityDetails.distance, distanceKm: entityDetails.distanceKm};
                        // console.log(`   📏 Found distance: ${distanceInfo.distance}`);
                    }

                    if (!entityDetails.notFound) {
                        // console.log(`   ✅ Entity details ready for: ${nameObj.name}`);
                        let firstImage = null;
                        // 🔥 PRIORITY 1: Database images (from pre-fetched businesses/destinations)
                        if (entityDetails.images && entityDetails.images.length > 0) {
                            firstImage = entityDetails.images[0];
                            // console.log(`   📸 Got image from database: ${firstImage.substring(0, 50) + '...'}`);
                            // console.log(`   🎯 Using database image - NO GOOGLE API CALL!`);
                        }
                        // 🔥 PRIORITY 2: Try PlaceCache if we have a place_id
                        else if (entityDetails.place_id) {
                            const cached = await PlaceCache.findOne({ placeId: entityDetails.place_id });
                            if (cached && cached.imagesStored) {
                                firstImage = `/api/ai/place-image/${entityDetails.place_id}/0`;
                                // console.log(`   📸 Using cached server image: ${firstImage}`);
                                // console.log(`   🎯 Using PlaceCache - NO GOOGLE API CALL!`);
                            }
                        }
                        // ── Reuse the fuzzy bestMatch we already computed above ──
                        //    The previous version did a *second* lookup using
                        //    exact-equality on lowercased names, which would
                        //    fail any time the AI's spelling differed from the
                        //    DB (e.g. "Garni Temple" vs "Temple of Garni"). When
                        //    that lookup failed, verifiedId stayed null and the
                        //    frontend treated the card as an unverified AI rec
                        //    — no partner label, no DB analytics, no save link.
                        const matchedBusiness    = bestMatch?.type === 'business'    ? bestMatch.data : null;
                        const matchedDestination = bestMatch?.type === 'destination' ? bestMatch.data : null;
                        const matchedDb = matchedBusiness || matchedDestination;
                        const recommendation = {
                            id: `chat-rec-${Date.now()}-${i}`,
                            name: entityDetails.name || nameObj.name,
                            category: category,
                            type: category.toLowerCase().replace(' ', '_'),
                            description: aiDescription,
                            region: entityDetails.region || entityDetails.location || 'Unknown',
                            location: entityDetails.location || entityDetails.address || 'Location not specified',
                            image: firstImage,
                            cachedImageUrl: entityDetails.place_id ? `/api/ai/place-image/${entityDetails.place_id}/0` : null,
                            source: entityDetails.source || 'ai',
                            verifiedId: matchedDb?._id?.toString() || null,
                            isPartner: matchedBusiness?.partnership?.isPartner || false,
                            partnerTier: matchedBusiness?.partnership?.tier || null,
                            _verifiedModel: matchedBusiness ? 'business' : matchedDestination ? 'destination' : null,
                            placeId: entityDetails.place_id || null,
                            // ── coords for the recommendation map ──
                            latitude:  entityDetails.geometry?.location?.lat ?? null,
                            longitude: entityDetails.geometry?.location?.lng ?? null,
                            // contact for the map popup
                            website: entityDetails.website || null,
                            phone:   entityDetails.phone || null,
                            isChatRecommendation: true,
                            isLargeCard: true,
                            appearsInline: true,
                            isStreaming: false,
                            ...(nearbyMode && distanceInfo && {distance: distanceInfo.distance}),
                            // Event-specific. Forwarded from formatBusinessDetails; null
                            // for non-events or for AI/Google-fallback recs that don't
                            // map to a DB business. JinniChat's isEventRec() guards
                            // the rec card and info-modal additions on this.
                            eventSchedule: entityDetails.eventSchedule || null,
                            _isExpired: entityDetails._isExpired || false,
                            // Action this chat rec was produced under — the type detected
                            // from the message ('hotels', 'restaurants', …) or 'general'.
                            // Quick-action recs have carried this since the PlaceFeedback
                            // work; chat recs never did, so the client echoed action:null
                            // on votes and the /feedback handler SKIPPED the PlaceFeedback
                            // write entirely — chat votes were never stored per-user, and
                            // the chat-stream dislike filter had nothing to filter.
                            _action: detectedActionType || 'general',
                            metadata: { hasAIDescription: true, sourceDescription: 'ai_generated', originalName: nameObj.name, originalDescription: aiDescription, hasViewImagesText: shouldShowCard, usedPrefetchedData: entityDetails.source === 'database', originalPosition: i, detectedActionType: detectedActionType }
                        };
                        // console.log(`   ✅ Created recommendation at position ${i}: ${recommendation.name}`);
                        return recommendation;
                    } else {
                        // console.log(`   ❌ Entity not found: ${nameObj.name}`);
                        const fallbackRec = {
                            id: `chat-rec-${Date.now()}-${i}`,
                            name: nameObj.name,
                            category: getCategoryFromActionType(detectedActionType),
                            type: getCategoryFromActionType(detectedActionType).toLowerCase().replace(' ', '_'),
                            description: aiDescription,
                            region: 'Unknown',
                            location: 'Location not specified',
                            image: null,
                            source: 'ai',
                            isChatRecommendation: true,
                            isLargeCard: true,
                            appearsInline: true,
                            metadata: { hasAIDescription: true, sourceDescription: 'ai_generated', originalName: nameObj.name, originalDescription: aiDescription, hasViewImagesText: shouldShowCard, usedPrefetchedData: false, originalPosition: i, detectedActionType: detectedActionType }
                        };
                        return fallbackRec;
                    }
                } catch (error) {
                    console.error(`   ❌ Failed to process recommendation ${nameObj.name}:`, error);
                    const fallbackRec = {
                        id: `chat-rec-${Date.now()}-${i}`,
                        name: nameObj.name,
                        category: 'Attraction',
                        description: nameObj.description || nameObj.name,
                        region: 'Unknown',
                        location: 'Location not specified',
                        image: null,
                        source: 'ai',
                        isChatRecommendation: true,
                        isLargeCard: true,
                        appearsInline: true,
                        metadata: {
                            hasAIDescription: true,
                            sourceDescription: 'ai_generated',
                            originalDescription: nameObj.description || nameObj.name,
                            hasViewImagesText: (nameObj.description || '').includes('→') || nameObj.name.includes('→'),
                            usedPrefetchedData: false,
                            originalPosition: i 
                        }
                    };
                    return fallbackRec;
                }
            }));
            recommendations = (builtRecs || []).filter(Boolean);
            uniquePlaces.clear();
            recommendations.forEach(rec => { if (rec.name) uniquePlaces.add(rec.name) }); 
            // console.log(`\n📊 USAGE TRACKING - PLACES COUNT:`);
            // console.log(`   Total recommendations: ${recommendations.length}`);
            // console.log(`   Unique places to track: ${uniquePlaces.size}`);
            // console.log(`   Places: ${Array.from(uniquePlaces).join(', ')}`);           
            let userLimit = null;
            try {
                userLimit = await UserAILimit.findOne({ userId: userId });
                // console.log(`✅ Found userLimit for places tracking: ${userLimit ? 'YES' : 'NO'}`);
            } catch (error) { console.warn(`⚠️ Could not find userLimit: ${error.message}`) }
            try {
                if (userLimit && uniquePlaces.size > 0) {
                    // console.log(`\n🔄 Updating places count...`);
                    const beforeStatus = await userLimit.getUsageStatus();
                    // console.log(`   Before: ${beforeStatus.daily.places.viewed} places viewed`);
                    const updateResult = await userLimit.checkAndUpdateUsage(0, uniquePlaces.size, 1);
                    // console.log(`\n✅ PLACES UPDATE SUCCESSFUL:`);
                    // console.log(`   Places added: ${uniquePlaces.size}`);
                    // console.log(`   New daily total: ${updateResult.dailyPlacesViewed}`);
                    // console.log(`   Remaining: ${updateResult.dailyPlacesRemaining}`);
                    // console.log(`   On cooldown: ${updateResult.onCooldown}`);                    
                    if (res && !res.headersSent) {
                        res.set('X-Usage-Places-Viewed', updateResult.dailyPlacesViewed.toString());
                        res.set('X-Usage-Places-Remaining', updateResult.dailyPlacesRemaining.toString());
                    }
                } else {
                    console.log(`\n⚠️ PLACES NOT TRACKED:`);
                    console.log(`   Has userLimit: ${!!userLimit}`);
                    console.log(`   Unique places: ${uniquePlaces.size}`);
                }
            } catch (error) { console.warn(`\n❌ FAILED TO UPDATE PLACES COUNT: ${error.message}`) }
            const _shownIds = new Set(Array.isArray(alreadyShownPlaceIds) ? alreadyShownPlaceIds : []);
            const _cLat = effectiveLocation?.lat, _cLng = effectiveLocation?.lng;
            const _hasC = Number.isFinite(_cLat) && Number.isFinite(_cLng);
            const _msgLower = (message || '').toLowerCase();
            const _disliked = (userDislikedIds instanceof Set) ? userDislikedIds : new Set(userDislikedIds || []);
            // Resolve the curated rejects once, now that every rec carries its
            // placeId (declared at function scope above — see the note there).
            curatedRejects = await loadCuratedRejects(
                recommendations.map(r => r && r.placeId).filter(Boolean),
                detectedActionType
            );
            const _streamList = recommendations.filter(rec => {
                if (!rec) return false;
                if (rec.source === 'ai' && !rec.placeId && !rec.verifiedId) return false;   // unverified shell — demoted to prose below
                if (rec.placeId && _shownIds.has(rec.placeId)) return false;
                // Wrong category per staff curation — unless the message names it.
                if (rec.placeId && curatedRejects.has(rec.placeId) && !(rec.name && _msgLower.includes(rec.name.toLowerCase()))) return false;
                // Disliked (this user's latest vote) — hide unless the message itself
                // names the place; same rule as the authoritative drop pass below.
                const _isDisliked = (rec.placeId && _disliked.has(rec.placeId)) || (rec.verifiedId && _disliked.has(String(rec.verifiedId)));
                if (_isDisliked && !(rec.name && _msgLower.includes(rec.name.toLowerCase()))) return false;
                if (_hasC && Number.isFinite(rec.latitude) && Number.isFinite(rec.longitude) && _haversineKm(_cLat, _cLng, rec.latitude, rec.longitude) > 300) return false;
                return true;
            });
            const streamingRecs = { type: 'recommendations', recommendations: (_streamList.length ? _streamList : recommendations.filter(rec => rec !== null)), isStreaming: true };
            res.write(`data: ${JSON.stringify(streamingRecs)}\n\n`);
            // console.log(`\n✅ Final recommendations count: ${recommendations.length}`);
            // console.log('📊 Recommendations Summary (in order):');
            // recommendations.forEach((rec, idx) => {
            //     console.log(`${idx + 1}. ${rec.name} (original pos: ${rec.metadata?.originalPosition || idx})`);
            //     console.log(`   Source: ${rec.source} ${rec.metadata.usedPrefetchedData ? '(PRE-FETCHED ✅)' : ''}`);
            //     console.log(`   Has Image: ${!!rec.image}`);
            // });
            const prefetchedCount = recommendations.filter(r => r.metadata?.usedPrefetchedData).length;
            // console.log(`\n🎯 Used pre-fetched data for ${prefetchedCount}/${recommendations.length} recommendations`);
            mainText = cleanMainText(aiResponse, bracketedNames);
            let currentText = mainText;
            for (let i = 0; i < recommendations.length; i++) {
                const placeholder = `{{RECOMMENDATION_${i}}}`;
                const parts = currentText.split(placeholder);
                if (parts.length > 1) {
                    // Defensive: if the text segment right before a card still ends in a
                    // dangling list marker ("…\n1. ") — e.g. a rec whose arrows were
                    // malformed so cleanMainText couldn't absorb it — strip it so it
                    // never renders as a stray number above the card.
                    const head = parts[0].replace(/(?:\r?\n)?[ \t]*(?:\d+[.)]|[-*•])[ \t]*$/, '');
                    if (head.trim()) { textParts.push({type: 'text', content: head}) }
                    textParts.push({type: 'recommendation', index: i});
                    currentText = parts.slice(1).join(placeholder);
                }
            }
            if (currentText.trim()) { textParts.push({ type: 'text', content: currentText }) }
            // console.log('\n📝 Text parts structure:', textParts.map(p => p.type).join(' -> '));
        } else {
            mainText = aiResponse.replace(/→/g, '').replace(/←/g, '');
            textParts = [{ type: 'text', content: mainText }];
            console.log(`❌ No arrow-formatted names found in AI response`);
        }
        // ── Drop session repeats (by placeId) and out-of-area resolutions ────────
        //  • placeId repeat: the name-based prompt exclusion misses variants that
        //    resolve to the same Google place (e.g. "Alexander" already shown).
        //  • out-of-area: chat resolves model-named places on Google with only a
        //    location BIAS, so a same-named place in another city/country can come
        //    back — a Yerevan query surfacing a Moscow hotel. Drop anything
        //    implausibly far from the resolved search center.
        // Recommendations and contentParts are index-aligned, so drop from BOTH and
        // re-index. Guarded: a stale/wrong search center or an all-repeat batch can't
        // empty the response (we keep everything rather than send nothing).
        if (recommendations.length) {
            const shown = new Set(Array.isArray(alreadyShownPlaceIds) ? alreadyShownPlaceIds : []);
            const centerLat = effectiveLocation?.lat, centerLng = effectiveLocation?.lng;
            const hasCenter = Number.isFinite(centerLat) && Number.isFinite(centerLng);
            // The out-of-area radius comes from the USER'S OWN mode settings —
            // the app already has a scope system (Nearby: settings.searchRadius.nearby,
            // default 5km; Discovery: settings.searchRadius.discovery, default 50km),
            // and effectiveLocation carries the resolved values. Rules:
            //   • user named a destination this turn → the center IS that place, so
            //     the mode radius applies exactly (Discovery 50km around "Pafos"
            //     keeps Pissouri at 45km but drops Limassol at 60km);
            //   • otherwise → mode radius × 1.5 tolerance (GPS/geocode center fuzz),
            //     floor 10km so a tight Nearby setting doesn't drop everything.
            // Wrong resolutions (a same-named place on another continent) are far
            // beyond any of these, so that protection is unchanged.
            const userRadiusKm = effectiveLocation
                ? (nearbyMode ? (effectiveLocation.nearbyRadius || 5) : (effectiveLocation.discoveryRadius || 50))
                : (nearbyMode ? 5 : 50);
            const MAX_KM = (effectiveLocation && (effectiveLocation.source === 'message_destination' || effectiveLocation.source === 'session_destination'))
                ? userRadiusKm
                : Math.max(10, Math.round(userRadiusKm * 1.5));
            const repeatIdx = new Set();
            const tooFarIdx = new Set();
            const dislikedIdx = new Set();
            // Places a validator curated OUT of this turn's category (see the
            // curated-gate comment block above findCachedBackfill). Kept as its own
            // set rather than folded into dislikedIdx so the log, the drop guard and
            // the text-restoration rule below can each treat it on its own terms.
            const miscategorizedIdx = new Set();
            // Cards with NO verified identity — enrichment found neither a DB
            // match nor an acceptable Google place. Two ways to get here: the
            // model bolded a NON-place ("A crisp white blouse or a silk
            // camisole" — lexically indistinguishable from a boutique name, so
            // looksLikePlaceName can't catch it), or it named a place Google
            // rejected/can't find. Either way the card is an empty shell
            // (placeholder icon, "Location not specified", default type) —
            // demote it to prose via the restoration below instead of rendering.
            const unverifiedIdx = new Set();
            const dislikedSet = (userDislikedIds instanceof Set) ? userDislikedIds : new Set(userDislikedIds || []);
            const msgLower = (message || '').toLowerCase();
            recommendations.forEach((r, idx) => {
                if (!r) return;
                if (r.placeId && shown.has(r.placeId)) repeatIdx.add(idx);
                if (hasCenter && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
                    const km = _haversineKm(centerLat, centerLng, r.latitude, r.longitude);
                    if (km > MAX_KM) { tooFarIdx.add(idx); console.log(`[chat] dropped out-of-area rec "${r.name}" (${Math.round(km)}km from search center)`); }
                }
                // Disliked by THIS user (latest vote per place, /my-votes semantics).
                // Votes were stored under the verified _id for DB places, else the
                // Google placeId — check both, same as quick-action does.
                // Direct-ask exception: if THIS message names the place, the user is
                // asking about it on purpose; a dislike suppresses suggestions, it
                // doesn't ban the place from conversation.
                const isDisliked = (r.placeId && dislikedSet.has(r.placeId)) ||
                                   (r.verifiedId && dislikedSet.has(String(r.verifiedId)));
                const directlyAsked = r.name && messageNamesPlace(msgLower, r.name);
                if (isDisliked && !directlyAsked) {
                    dislikedIdx.add(idx);
                    console.log(`[chat] dropped disliked rec "${r.name}" (user's current vote is dislike)`);
                }
                // Validator-curated category mismatch: staff filed this place under a
                // different category than the one this turn is about (e.g. a historical
                // site the model offered as an event). Same direct-ask exception as
                // dislikes — if the user named the place, we still answer about it.
                if (r.placeId && curatedRejects.has(r.placeId) && !directlyAsked) {
                    miscategorizedIdx.add(idx);
                    console.log(`[chat] dropped rec "${r.name}" — staff curated it out of "${detectedActionType}"`);
                }
                if (r.source === 'ai' && !r.placeId && !r.verifiedId) {
                    unverifiedIdx.add(idx);
                    console.log(`[chat] unverified card "${r.name}" demoted to prose (no Google/DB identity)`);
                }
            });
            const hasText = textParts.some(p => p.type === 'text' && (p.content || '').trim());
            // Too-far: keep all if EVERY rec is too far (usually a wrong search center,
            // not genuinely bad places); otherwise drop the far ones.
            const dropFar = tooFarIdx.size > 0 && tooFarIdx.size < recommendations.length;
            // Repeats: drop even when ALL are repeats, as long as the reply still has
            // prose — a follow-up like "how many stars are these?" should answer in
            // text, not re-render cards the user already sees above. Only when dropping
            // them would leave nothing at all (no cards AND no text) do we keep them.
            const dropRepeats = repeatIdx.size > 0 && (repeatIdx.size < recommendations.length || hasText);
            // Dislikes: same guard as repeats — drop them as long as the reply keeps
            // SOMETHING (other cards or prose); only when dropping would leave a
            // completely empty response do we keep them rather than send nothing.
            const dropDisliked = dislikedIdx.size > 0 && (dislikedIdx.size < recommendations.length || hasText);
            // Wrong-category: same "never send an empty reply" guard as dislikes. If
            // every card is miscategorized and there is no prose, keeping them beats
            // answering with nothing — the validator's correction is about WHERE a
            // place belongs, not about whether it exists.
            const dropMiscategorized = miscategorizedIdx.size > 0 && (miscategorizedIdx.size < recommendations.length || hasText);
            const keptOldIdx = [];
            recommendations.forEach((r, idx) => {
                const drop = (repeatIdx.has(idx) && dropRepeats) || (tooFarIdx.has(idx) && dropFar) || (dislikedIdx.has(idx) && dropDisliked) || (miscategorizedIdx.has(idx) && dropMiscategorized) || unverifiedIdx.has(idx);
                if (!drop) keptOldIdx.push(idx);
            });
            if (keptOldIdx.length < recommendations.length) {
                const remap = new Map(keptOldIdx.map((oldIdx, newIdx) => [oldIdx, newIdx]));
                // ── Restore dropped card TEXT as prose ────────────────────────
                // The salvage absorbs the model's sentences INTO the card as its
                // description; dropping a repeat card therefore used to DELETE
                // those sentences from the reply (a "compare these 3" answer lost
                // its entire comparison because all 3 were already-shown places).
                // A repeat drop means "don't render the card again", not "delete
                // what the model said" — so put the text back as bold-name prose,
                // which is exactly the form the prompt asks the model to use for
                // already-shown places. Disliked places stay fully suppressed.
                //
                // OUT-OF-AREA drops are suppressed too (not restored): unlike a
                // repeat — where the card is redundant but the TEXT is still true —
                // an out-of-area drop means the place's only verified identity is
                // in the wrong city (Pyxida resolved 61km away in Nicosia;
                // "Mavrommatis" resolved to Paris). Restoring that text made the
                // reply confidently recommend a place the pipeline had just judged
                // wrong, with no card and no caveat. The model was answering for
                // the wrong search center (e.g. a nearby-mode city switch), so its
                // sentences about the place are not trustworthy prose — drop them.
                const restoredText = new Map();   // oldIdx → prose
                recommendations.forEach((r, idx) => {
                    if (!r || remap.has(idx)) return;                          // kept → nothing to restore
                    if (dislikedIdx.has(idx) && dropDisliked) return;          // dislikes: intentional suppression
                    // Wrong category — suppressed like out-of-area, and for the same
                    // reason: the model's sentences describe the place AS the thing it
                    // isn't ("this festival runs all June" for a monastery). Restoring
                    // that prose would keep the false claim in the reply, minus the card.
                    if (miscategorizedIdx.has(idx) && dropMiscategorized) {
                        console.log(`[chat] wrong-category card "${(r.metadata && r.metadata.originalName) || r.name}" suppressed (text NOT restored)`);
                        return;
                    }
                    if (tooFarIdx.has(idx) && dropFar) {                       // out-of-area: wrong place — suppress, don't restore
                        console.log(`[chat] out-of-area card "${(r.metadata && r.metadata.originalName) || r.name}" suppressed (text NOT restored)`);
                        return;
                    }
                    // Restore the MODEL'S name, not the resolved one — otherwise a
                    // Russian header "Меню" that mis-resolved to the "Muse" restaurant
                    // comes back as an English "Muse" heading in a Russian reply.
                    const dispName = (r.metadata && r.metadata.originalName) || r.name;
                    const desc = (r.description || r.metadata?.originalDescription || '').trim();
                    // ⁣ (invisible separator) marks this bold as a PLACE NAME the
                    // pipeline verified-then-demoted — the frontend linkifier turns
                    // marked bolds into click-to-search without any guessing. Invisible
                    // if a client renders it raw, survives session persistence.
                    restoredText.set(idx, desc ? `**⁣${dispName}**\n${desc}` : `**⁣${dispName}**`);
                    console.log(`[chat] card "${dispName}" dropped — its text restored as prose`);
                });
                recommendations = keptOldIdx.map(oldIdx => recommendations[oldIdx]);
                textParts = textParts
                    .map(p => {
                        if (p.type !== 'recommendation') return p;
                        if (remap.has(p.index)) return { ...p, index: remap.get(p.index) };
                        const restored = restoredText.get(p.index);
                        return restored ? { type: 'text', content: restored } : null;
                    })
                    .filter(Boolean);
                // Merge adjacent text parts (restoration can create neighbours)
                // so the reply renders as continuous prose, not choppy fragments.
                const mergedParts = [];
                for (const p of textParts) {
                    const last = mergedParts[mergedParts.length - 1];
                    if (p.type === 'text' && last && last.type === 'text') {
                        last.content = `${last.content}\n\n${p.content}`;
                    } else { mergedParts.push(p); }
                }
                textParts = mergedParts;
            }
        }
        await Analytics.create({
            type: 'ai_chat_interaction',
            userId,
            metadata: {
                message: message.substring(0, 100),
                actionType: 'stream_chat',
                sessionId: 'stream_session',
                recommendationsCount: recommendations.length,
                recommendationsWithCards: recommendations.filter(r => r.description && (r.description.includes('→') || r.description.includes('←'))).length,
                usedPrefetchedData: recommendations.filter(r => r.metadata?.usedPrefetchedData).length
            }
        });
        /* Track daily AI usage for the admin chart.
         * Prefer the provider's REAL billed token count (cached input included)
         * over the characters/4 estimate. The estimate cannot see cached input,
         * web-search results injected into context, or the system prompt — which
         * is why the dashboard read ~10× low against the Anthropic console. */
        const responseTokens = Math.ceil(aiResponse.length / 4);
        const totalTokens = realTokens != null ? realTokens : (inputTokens + responseTokens);
        AiDailyStats.track(totalTokens, 1).catch(err => console.error('AiDailyStats error:', err));
        AiProviderDailyStats.track(provider, { tokens: totalTokens, queries: 1, searches: searchCount, endpoint: 'chat' }).catch(err => console.error('AiProviderDailyStats error:', err));
        await User.findByIdAndUpdate(userId, { $inc: { 'analytics.totalQueries': 1 }, $set: { 'analytics.lastActive': new Date() } });
        const currentUsageStatus = req?.userLimit ? req.userLimit.getUsageStatus() : null;
        const responseData = {
            type: 'complete',
            content: textParts, 
            contentParts: textParts, 
            recommendations: recommendations,
            finalText: mainText,
            isChatRecommendation: true,
            nearbyMode: nearbyMode,
            metadata: {
                timestamp: new Date(),
                confidence: 0.85,
                userPreferencesUsed: true,
                recommendationsWithCards: recommendations.filter(r => r.metadata?.hasViewImagesText).length,
                totalRecommendations: recommendations.length,
                uniquePlacesCounted: uniquePlaces.size,
                originalAIRecsWithCards: bracketedNames?.length ? bracketedNames.filter(nameObj => nameObj.hasViewImages).length : 0,
                usedPrefetchedData: recommendations.filter(r => r.metadata?.usedPrefetchedData).length,
                nearbyMode: nearbyMode,
                recommendationsWithDistance: recommendations.filter(r => r.distance).length,
                usageTracking: currentUsageStatus ? {
                    dailyTokensRemaining: currentUsageStatus.daily.tokens.remaining,
                    dailyPlacesRemaining: currentUsageStatus.daily.places.remaining,
                    placesCounted: uniquePlaces.size
                } : null,
                sessionHealth: healthCheck.shouldWarn ? {
                    messageCount: healthCheck.messageCount,
                    remainingMessages: healthCheck.remainingMessages,
                    shouldWarn: true
                } : null
            }
        };
        // console.log('\n📤 Sending completion response with:', {
        //     contentParts: textParts.length,
        //     finalTextLength: mainText.length,
        //     recommendationsCount: recommendations.length,
        //     uniquePlacesCounted: uniquePlaces?.size || 0,
        //     prefetchedDataUsed: responseData.metadata.usedPrefetchedData,
        //     structurePreview: textParts.map(p => p.type).join(' -> ')
        // });
        // console.log(`\n\n📊 [${requestId}] API CALLS SUMMARY (FINAL):`);
        const apiStats = googleService.getRequestStats(requestId);
        const totalCalls = (apiStats.findPlaces || 0) + (apiStats.getPlaceDetails || 0) + (apiStats.imageDownload || 0);
        // console.log(`   Total Google Place API Calls: ${totalCalls}`);
        // console.log(`   findPlaces: ${apiStats.findPlaces || 0}`);
        // console.log(`   getPlaceDetails: ${apiStats.getPlaceDetails || 0}`);
        // console.log(`   imageDownload (Photos): ${apiStats.imageDownload || 0}`);
        // console.log(`   Other calls`);
        // console.log(`   reverseGeocode: ${apiStats.reverseGeocode || 0}`);
        // console.log(`   calculateDistances: ${apiStats.calculateDistances || 0}`);
        googleService.clearRequestStats(requestId);
        // TRACK VIEWS
        const verifiedRecs = recommendations.filter(r => r.verifiedId);
        if (verifiedRecs.length > 0) {
            const businessIds = verifiedRecs.filter(r => r._verifiedModel === 'business').map(r => r.verifiedId);
            const destinationIds = verifiedRecs.filter(r => r._verifiedModel === 'destination').map(r => r.verifiedId);
            if (businessIds.length > 0) { Business.updateMany({ _id: { $in: businessIds } }, { $inc: { 'analytics.views': 1 } }).catch(err => console.error('Business view tracking error:', err)) }
            if (destinationIds.length > 0) { Destination.updateMany({ _id: { $in: destinationIds } }, { $inc: { 'analytics.views': 1 } }).catch(err => console.error('Destination view tracking error:', err)) }
        }
        // ── Feed the shared PlaceCache from CHAT serves (parity with quick-action) ──
        // Quick-action-stream stamps every Google/cache place it SHOWS with the
        // action ($addToSet: actions) and bumps useCount/lastUsed — that array is
        // the ground truth findCachedBackfill filters on, and useCount is its
        // popularity signal. Chat ran the same enrichment (details + stored image
        // land in PlaceCache) but never tagged, so chat-discovered places were
        // invisible to every quick-action refill and accrued zero popularity.
        // Rules, mirroring the quick-action semantics exactly:
        //   • SURVIVORS ONLY — `recommendations` here is post-drop-pass (repeats,
        //     out-of-area, dislikes, unverified shells already removed), same as
        //     quick-action tagging only places that passed every filter.
        //   • CONCRETE ACTION ONLY — tag only when the intent pre-pass resolved a
        //     real quick-action category. 'general' is NEVER written: `actions`
        //     is trustworthy precisely because it is recorded, not guessed, and a
        //     'general' tag would be a guess. (intentService's vocabulary —
        //     hotels/restaurants/historical/hidden_gems/events — is a subset of
        //     the quick-action categories, so every tag written here is one the
        //     backfill can legitimately serve.)
        //   • useCount/lastUsed bump runs regardless of action (even 'general'):
        //     a chat serve is a real serve, and popularity/freshness must reflect
        //     it. This matches quick-action, which bumps on every serve too.
        //   • Fire-and-forget with .catch — must never delay or break the reply.
        // 'events' is deliberately absent — see the note at the quick-action tagger:
        // an event's card carries its VENUE, so tagging turns venues into permanent
        // "events" that later backfill as undated Event cards.
        const CHAT_TAGGABLE_ACTIONS = new Set(['hotels', 'restaurants', 'historical', 'hidden_gems', 'photo_spots', 'shopping']);
        const chatShownPlaceIds = [...new Set(recommendations.map(r => r.placeId).filter(Boolean))];
        if (chatShownPlaceIds.length > 0) {
            // Popularity/freshness bump for every shown place…
            PlaceCache.updateMany({ placeId: { $in: chatShownPlaceIds } }, { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } })
                .catch(err => console.warn('[chat] PlaceCache useCount update failed:', err.message));
            // …but category tagging skips validator-curated docs (curation lock).
            if (detectedActionType && CHAT_TAGGABLE_ACTIONS.has(detectedActionType)) {
                PlaceCache.updateMany({ placeId: { $in: chatShownPlaceIds }, actionsCurated: { $ne: true } }, { $addToSet: { actions: detectedActionType } })
                    .catch(err => console.warn('[chat] PlaceCache tag update failed:', err.message));
            }
        }
        res.write(`data: ${JSON.stringify(responseData)}\n\n`);
        res.end();
        // console.log('\n✅ Completion sent successfully\n');
    } catch (error) {
        console.error('Stream completion error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process completion', details: error.message })}\n\n`);
        res.end();
    }
}

function extractChatRecommendations(aiResponse) {
    const names = [];
    const arrowPattern = /\*\*([^*]+)\*\*\s*→\s*([^←]+)←/g;
    let match;
    let position = 1;
    while ((match = arrowPattern.exec(aiResponse)) !== null) {
        const [, name, description] = match;
        if (name && description) {
            // Defensive: never let a stray leading "→" (e.g. from a doubled arrow)
            // survive into the card description.
            const cleanDesc = description.trim().replace(/^→\s*/, '').trim();
            const existingIndex = names.findIndex(n => n.name === name.trim());
            if (existingIndex === -1) { names.push({ name: name.trim(), description: cleanDesc, position: position++, hasViewImages: true, format: 'arrow', complete: true }) }
        }
    }
    return names;
}

// Normalize a place name for cross-source matching (AI output ↔ Google
// prefetch shortlist ↔ dedup). Lowercase, strip punctuation, collapse
// whitespace. Unicode-aware so non-Latin names match.
const normalizePlaceName = (s) => (s || '')
    .toLowerCase()
    .trim()
    // Fold diacritics before stripping punctuation: decompose to base letter +
    // combining mark, then drop the marks. Without this, "Shene" and "Shéné" are
    // different words and the name guard rejects a CORRECT venue — which is what
    // happened to a real Yerevan open-air venue, and would happen to any accented
    // French, Turkish or transliterated Armenian name. Latin-script only by
    // construction: Armenian and Cyrillic letters carry no combining marks here,
    // so they pass through untouched.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── Name-similarity guard ─────────────────────────────────────────────────────
// The model proposes a NAME; Google's text search returns its closest real match
// regardless of how close that match actually is, so a hallucinated name
// ("Liqstum Hotel") gets rescued with an unrelated real place ("The Lichk
// Lodge"). namesPlausiblyMatch() compares the requested name to the resolved one
// and is used to drop these rescues.
//
// SCRIPT SAFEGUARD: Google often returns a place's native-script name
// (e.g. "Զանգեզուր" for a query "Zangezur Cafe"). A naive Latin token compare
// would wrongly drop those, so when the two names are written in DIFFERENT
// scripts we SKIP the check entirely (treat as a match) and rely on the type +
// radius filters instead. The guard only ever fires when both names share a
// script and still have nothing in common.
const _GENERIC_PLACE_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'at', 'in', 'on', 'by', 'de', 'la', 'le',
    'hotel', 'hotels', 'restaurant', 'cafe', 'café', 'bar', 'pub', 'resort', 'lodge', 'inn', 'house', 'tavern',
    'garden', 'gardens', 'grill', 'kitchen', 'bistro', 'lounge', 'club', 'spa', 'suites', 'guesthouse', 'hostel',
    'company', 'co', 'place', 'yerevan', 'armenia']);
const _scriptOf = (s) => {
    if (/[\u0530-\u058F]/.test(s)) return 'armenian';
    if (/[\u0400-\u04FF]/.test(s)) return 'cyrillic';
    if (/[\u0370-\u03FF]/.test(s)) return 'greek';
    if (/[a-z]/i.test(s)) return 'latin';
    return 'other';
};
const _sigTokens = (s) => normalizePlaceName(s).split(' ').filter(t => t.length >= 3 && !_GENERIC_PLACE_WORDS.has(t));
const _lev = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[m][n];
};
const _tokensSimilar = (x, y) => x === y
    || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)))
    || (x.length >= 5 && y.length >= 5 && _lev(x, y) <= 1);
// "Did THIS message name this place?" — used by the dislike direct-ask
// exception. The old check was strict substring (msg.includes(fullName)),
// which fails whenever the user's wording differs from the stored/resolved
// name: user types "paphos gardens hotel", the vote was stored as "Paphos
// Gardens Holiday Resort" → no substring hit → treated as NOT asked → the
// place the user explicitly asked about got suppressed. Token rule: every
// DISTINCTIVE word of the place name (generic hotel-words excluded) must
// appear in the message; the old substring check is kept as a fallback.
const GENERIC_PLACE_WORDS = new Set(['hotel', 'hotels', 'resort', 'resorts', 'holiday', 'suites', 'apartments', 'apartment', 'inn', 'guesthouse', 'hostel', 'restaurant', 'cafe', 'bar', 'spa', 'beach', 'luxury', 'collection', 'grand', 'royal', 'the', 'by', 'and', 'of', 'a', 'an']);
function messageNamesPlace(msgLower, placeName) {
    if (!msgLower || !placeName) return false;
    const nameLower = String(placeName).toLowerCase();
    if (msgLower.includes(nameLower)) return true;                    // old behavior still counts
    const sig = nameLower.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !GENERIC_PLACE_WORDS.has(w));
    return sig.length > 0 && sig.every(w => msgLower.includes(w));
}

function namesPlausiblyMatch(requested, resolved) {
    if (!requested || !resolved) return true;            // nothing to compare → keep
    if (_scriptOf(requested) !== _scriptOf(resolved)) return true; // cross-script → skip (keep)
    const a = _sigTokens(requested), b = _sigTokens(resolved);
    if (!a.length || !b.length) return true;             // only generic words → can't judge → keep
    return a.some(x => b.some(y => _tokensSimilar(x, y)));
}

const extractBracketedNames = (text) => {
    const matches = [];
    const pattern = /\*\*([^*]+)\*\*\s*\>/g;
    let match;
    while ((match = pattern.exec(text)) !== null) { matches.push({ name: match[1].trim(), placeId: null }) }
    if (matches.length === 0) {
        const bracketRegex = /\[([^\]]+)]/g;
        while ((match = bracketRegex.exec(text)) !== null) {
            const content = match[1].trim();
            if (content.toLowerCase() !== 'view images' && content.length > 0) { matches.push({ name: content, placeId: null }) }
        }
    }
    return matches;
};

function isTravelRelatedQuery(message) {
    const travelKeywords = ['recommend', 'suggest', 'where should', 'what should', 'best places','hotel', 'restaurant', 'attraction', 'things to do', 'visit', 'travel','vacation', 'trip', 'destination'];
    return travelKeywords.some(keyword => message.toLowerCase().includes(keyword.toLowerCase()));
}

async function handleImageRequestOnly(req, res) {
    const { imageRequest } = req.body;
    const userId = req.user.id;
    try {
        let userLimit = await UserAILimit.findOne({ userId });
        if (!userLimit) {
            userLimit = new UserAILimit({ userId, isPremium: req.user.isPremium || false });
            await userLimit.save();
        }        
        const status = await userLimit.getUsageStatus();
        if (status.cooldown.active) {
            console.log(`🚫 Image request blocked - user on cooldown`);
            return res.status(429).json({type: 'cooldown', error: 'cooldown', message: `AI services are currently on cooldown. Available again in ${status.cooldown.hoursRemaining} hours.`, cooldownUntil: status.cooldown.until, reason: status.cooldown.reason});
        }        
        const estimatedTokens = 50;
        await userLimit.checkAndUpdateUsage(0, 0, 0);
        // console.log(`✅ Image request allowed - tokens used: ${estimatedTokens}`);        
        const updatedStatus = await userLimit.getUsageStatus();
        res.set('X-Usage-Tokens-Used', updatedStatus.daily.tokens.used.toString());
        res.set('X-Usage-Tokens-Remaining', updatedStatus.daily.tokens.remaining.toString());
        res.set('X-Usage-Places-Viewed', updatedStatus.daily.places.viewed.toString());
        res.set('X-Usage-Places-Remaining', updatedStatus.daily.places.remaining.toString());
    } catch (limitError) {
        console.log(`🚫 Image request blocked: ${limitError.message}`);
        return res.status(429).json({ type: 'cooldown', error: 'cooldown', message: limitError.message, cooldownUntil: limitError.cooldownUntil });
    }
    const user = await User.findById(userId).select('location');
    const location = user?.location?.coordinates || null;
    const placeId = imageRequest.placeId;
    const verifiedId = imageRequest.verifiedId || null;
    console.log(`\n🖼️ [IMAGE-REQUEST] placeName: "${imageRequest.placeName}" | placeId: ${placeId} | verifiedId: ${verifiedId}`);
    try {
        res.write(`data: ${JSON.stringify({ type: 'image_stream_start', placeName: imageRequest.placeName })}\n\n`);
        // STEP 0A: Check if this is a DB business/destination — use its stored image URLs directly
        const mongoose = require('mongoose');
        console.log(`🖼️ [IMAGE-REQUEST] verifiedId valid ObjectId: ${verifiedId && mongoose.Types.ObjectId.isValid(verifiedId)}`);
        if (verifiedId && mongoose.Types.ObjectId.isValid(verifiedId)) {
            let dbRecord = await Business.findById(verifiedId).lean();
            console.log(`🖼️ [IMAGE-REQUEST] Business.findById(${verifiedId}): ${dbRecord ? dbRecord.name + ' | images: ' + (dbRecord.images?.length || 0) : 'NOT FOUND'}`);
            if (!dbRecord) {
                dbRecord = await Destination.findById(verifiedId).lean();
                console.log(`🖼️ [IMAGE-REQUEST] Destination.findById(${verifiedId}): ${dbRecord ? dbRecord.name + ' | images: ' + (dbRecord.images?.length || 0) : 'NOT FOUND'}`);
            }
            if (dbRecord && dbRecord.images && dbRecord.images.length > 0) {
                console.log(`✅ [IMAGE-REQUEST] Using ${dbRecord.images.length} DB images:`, dbRecord.images);
                const dbImages = dbRecord.images.map((url, index) => ({
                    index,
                    url,
                    title: `${imageRequest.placeName} - View ${index + 1}`,
                    caption: generateImageCaption(imageRequest.placeName, index),
                    source: 'database',
                    width: 800,
                    height: 600,
                    cached: false,
                    isDataUrl: false
                }));
                res.write(`data: ${JSON.stringify({ type: 'image_batch', images: dbImages, total: dbImages.length, fromCache: false, batchDelivery: true, source: 'database' })}\n\n`);
                for (let i = 0; i < dbImages.length; i++) {
                    res.write(`data: ${JSON.stringify({ type: 'image_single', image: dbImages[i], progress: { current: i + 1, total: dbImages.length }, fromCache: false, source: 'database' })}\n\n`);
                }
                res.write(`data: ${JSON.stringify({ type: 'image_stream_complete', totalLoaded: dbImages.length, fromCache: false, placeId: verifiedId, deliveryMode: 'database_urls' })}\n\n`);
                res.end();
                return;
            } else { console.log(`⚠️ [IMAGE-REQUEST] DB record found but no images — falling through to Google`) }
        }
        // STEP 0B: Check if we already have 8 images cached from a previous image gallery request
        console.log(`🖼️ [IMAGE-REQUEST] Checking PlaceCache for placeId: ${placeId}`);
        let images = [];
        let fromCache = false;
        let cachedImageData = []; // For base64 images (immediate delivery)
        if (placeId) {
            const cached = await PlaceCache.findOne({ placeId, imagesStored: true, $expr: { $gte: [{ $size: "$photos" }, 8] } });
            if (cached && cached.photos && cached.photos.length >= 8) {
                // console.log(`✅ Found complete image gallery in cache: ${cached.photos.length} images`);                
                const firstEightImages = cached.photos.slice(0, 8);
                const allHaveBinaryData = firstEightImages.every(photo => photo.imageData && photo.imageData.length > 0);
                if (allHaveBinaryData) {
                    // console.log(`✅ All 8 images have binary data - converting to base64 for immediate display`);
                    fromCache = true;
                    cachedImageData = await Promise.all(
                        firstEightImages.map(async (photo, index) => {
                            try {
                                let imageBuffer;
                                if (photo.imageData instanceof Buffer) { imageBuffer = photo.imageData } 
                                else if (photo.imageData && photo.imageData.buffer) { imageBuffer = Buffer.from(photo.imageData.buffer) } 
                                else if (photo.imageData && typeof photo.imageData === 'object' && photo.imageData.type === 'Buffer') { imageBuffer = Buffer.from(photo.imageData.data || photo.imageData) }
                                if (imageBuffer) {
                                    const base64 = imageBuffer.toString('base64');
                                    const dataUrl = `data:${photo.contentType || 'image/jpeg'};base64,${base64}`;
                                    return {
                                        index,
                                        url: dataUrl,
                                        title: `${imageRequest.placeName} - View ${index + 1}`,
                                        caption: generateImageCaption(imageRequest.placeName, index),
                                        source: 'cache',
                                        width: photo.width || 800,
                                        height: photo.height || 600,
                                        placeId: placeId,
                                        photoIndex: index,
                                        cached: true,
                                        isDataUrl: true,
                                        size: imageBuffer.length
                                    };
                                }
                            } catch (err) {
                                console.error(`Error converting image ${index} to base64:`, err.message);
                                return null;
                            }
                        })
                    ).then(results => results.filter(img => img !== null));
                    images = cachedImageData;
                    // console.log(`✅ Converted ${images.length} images to base64 for immediate delivery`);
                } else { console.log(`⚠️ Gallery found but some images missing binary data`) }
            } else { 
                // console.log(`❌ No complete gallery in cache (have ${cached?.photos?.length || 0} images)`) 
            }
        }
        // STEP 1: If no complete cache, fetch from Google
        if (!fromCache || images.length < 8) {
            // console.log(`🔄 Fetching images from Google API...`);
            const googleImages = await fetchImagesForPlace(imageRequest.placeName, location);
            if (!googleImages || googleImages.length === 0) {
                res.write(`data: ${JSON.stringify({ type: 'image_error', message: 'No images found' })}\n\n`);
                res.end();
                return;
            }            
            images = googleImages.slice(0, 8);
            // console.log(`✅ Fetched ${images.length} images from Google`);
        }
        // STEP 2: Stream to user - DIFFERENT STRATEGY BASED ON SOURCE
        // console.log(`📤 Streaming ${images.length} images to client...`);
        let storedInline = false;
        if (fromCache && cachedImageData.length > 0) {
            // CASE 1: We have base64 images - send them ALL in one batch
            // console.log(`🚀 Sending ${cachedImageData.length} cached images as base64 in batch...`);            
            res.write(`data: ${JSON.stringify({ type: 'image_batch', images: cachedImageData, total: cachedImageData.length, fromCache: true, batchDelivery: true })}\n\n`);            
            for (let i = 0; i < cachedImageData.length; i++) { res.write(`data: ${JSON.stringify({ type: 'image_single', image: cachedImageData[i], progress: { current: i + 1, total: cachedImageData.length }, fromCache: true, immediate: true })}\n\n`) }
        } else {
            // CASE 2: fresh from Google — download ALL photos in parallel and
            // stream each one's real bytes (base64) in index order as soon as
            // its download lands. Streaming bare proxy URLs here made the
            // viewer race the background store: unstored slots served the
            // first photo as a stand-in and flips took seconds.
            const downloads = images.map(img =>
                img.photo_reference
                    ? imageStorageService.downloadPhoto(img.photo_reference).catch(err => { console.error(`Gallery photo download failed: ${err.message}`); return null; })
                    : Promise.resolve(null)
            );
            const inlineStored = [];
            for (let i = 0; i < images.length; i++) {
                const dl = await downloads[i];
                inlineStored.push({ photoReference: images[i].photo_reference || null, imageData: dl ? dl.buffer : null, contentType: dl ? dl.contentType : 'image/jpeg', storedAt: new Date() });
                if (!dl) {
                    res.write(`data: ${JSON.stringify({ type: 'image_single_error', index: i, error: 'download failed' })}\n\n`);
                    continue;
                }
                const dataUrl = `data:${dl.contentType};base64,${dl.buffer.toString('base64')}`;
                res.write(`data: ${JSON.stringify({ type: 'image_single', image: { ...images[i], url: dataUrl, isDataUrl: true }, progress: { current: i + 1, total: images.length }, fromCache: false })}\n\n`);
            }
            // Persist what we just downloaded — no second download pass needed.
            storedInline = true;
            if (placeId && inlineStored.some(p => p.imageData)) {
                PlaceCache.findOneAndUpdate({ placeId }, { $set: { photos: inlineStored, imagesStored: true } }, { upsert: true })
                    .catch(err => console.error('Gallery inline store failed:', err));
            }
        }
        res.write(`data: ${JSON.stringify({type: 'image_stream_complete', totalLoaded: images.length, fromCache: fromCache, placeId: placeId, deliveryMode: fromCache ? 'batch_base64' : 'sequential_urls'})}\n\n`);
        res.end();
        // STEP 3: Store in background ONLY if we fetched from Google AND didn't
        // already persist the downloads inline in CASE 2 above.
        if (!fromCache && !storedInline && placeId && images.length > 0) {
            // console.log(`📦 Background: Will store images after sending to user...`);            
            setTimeout(async () => {
                try { await storeImagesInBackground(imageRequest.placeName, images, location, placeId) } 
                catch (err) { console.error('Background storage failed:', err) }
            }, 100);
        } // else if (fromCache) { console.log(`✅ Already have complete gallery - no storage needed`) }
    } catch (error) {
        console.error('Image request error:', error);
        res.write(`data: ${JSON.stringify({ type: 'image_error', message: 'Failed to fetch images' })}\n\n`);
        res.end();
    }
}

async function storeImagesInBackground(placeName, images, location, placeId = null) {
    try {
        // console.log(`📦 Background: Storing images for gallery of ${placeName}`);
        if (!placeId) {
            const places = await googleService.findPlaces(placeName, location);
            if (places.length === 0) {
                console.log(`❌ No place found for: ${placeName}`);
                return;
            }
            placeId = places[0].place_id;
        }
        const photoReferences = [];
        for (const img of images) {
            if (img.source !== 'google_places') continue;
            // Prefer the structured reference already carried on the image:
            // Places API (New) -> "places/{id}/photos/{ref}", legacy -> raw ref.
            // buildPhotoUrl() in imageStorageService understands both. Only fall
            // back to scraping the URL (legacy ?photoreference=, or a New-API
            // /places/.../photos/... path) when that field is somehow absent.
            let ref = img.photo_reference || null;
            if (!ref && img.url) {
                const legacy = img.url.match(/photoreference=([^&]+)/i);
                const newApi = img.url.match(/places\/[^/]+\/photos\/[^/?]+/i);
                ref = legacy ? legacy[1] : (newApi ? newApi[0] : null);
            }
            if (ref) {
                photoReferences.push({ photo_reference: ref });
            } else {
                console.log(`⚠️ Could not extract photo reference for image: ${(img.url || '').substring(0, 60)}...`);
            }
        }
        const photosToStore = photoReferences.slice(0, 8);
        if (photosToStore.length > 0) {
            // console.log(`⬇️  Downloading ${photosToStore.length} images for gallery storage...`);
            await imageStorageService.downloadAndStoreImages( placeId, photosToStore, photosToStore.length );
            // : Stored ${photosToStore.length} images`);
        } else {
            // console.log(`⚠️ No photo references extracted from images`);
            const existingCache = await PlaceCache.findOne({ placeId });
            if (existingCache && existingCache.photos && existingCache.photos.length >= 8) { console.log(`✅ Already have ${existingCache.photos.length} images in cache`) }
        }
    } catch (error) { console.error('Background storage error:', error) }
}

async function fetchImagesForPlace(placeName, location = null) {
    try {
        const googleImagesResult = await getGooglePlaceImages(placeName, location).catch(error => {
            console.error('Google images fetch failed:', error);
            return [];
        });
        const googleImages = googleImagesResult || [];
        // console.log(`${googleImages.length} images for ${placeName}`);
        // Keep photo_reference — storeImagesInBackground needs it to download the
        // full gallery; dropping it here left every place stuck with 1 stored
        // photo (all 8 viewer slots then serve that same first image).
        const processedImages = googleImages.slice(0, 8).map((image, index) => ({ url: image.url || image, title: image.title || `${placeName} - View ${index + 1}`, caption: image.caption || generateImageCaption(placeName, index), source: image.source || 'google_places', photo_reference: image.photo_reference || null }));
        return processedImages;
    } catch (error) {
        console.error('Image fetch error:', error);
        return [];
    }
}

async function getGooglePlaceImages(placeName, location = null) {
    try {
        const normalizedName = placeName.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();        
        const cached = await PlaceCache.findOne({ 
            $or: [{ searchName: normalizedName },{ name: { $regex: new RegExp(escapeRegExp(placeName), 'i') } },{ searchName: { $regex: new RegExp(normalizedName.replace(/\s+/g, '.*'), 'i') } }],
            placeId: { $exists: true, $ne: null }
        });
        let places;
        let placeId;
        if (cached && cached.placeId) {
            // console.log(`✅ Found cached place_id for ${placeName}: ${cached.placeId}`);
            placeId = cached.placeId;
            places = [{ place_id: placeId }];
        } else {
            places = await googleService.findPlaces(placeName, location);
            // console.log(`Found ${places.length} places for ${placeName}`);
            if (places.length === 0) {
                // console.log(`No places found for: ${placeName}`);
                return [];
            }
            placeId = places[0].place_id;
        }        
        const placeDetails = await googleService.getPlaceDetails(placeId, false);
        // console.log(`Place details:`, { name: placeDetails?.name, hasPhotos: !!placeDetails?.photos, photoCount: placeDetails?.photos?.length || 0 });
        if (!placeDetails || !placeDetails.photos) {
            // console.log(`No photos found for: ${placeName}`);
            return [];
        }
        const images = placeDetails.photos.slice(0, 8).map((photo, index) => {
            // Backend proxy, not a direct Google URL (key leak + IP restriction).
            // The ?v= cache-buster makes each gallery view fetch fresh — it
            // both heals browsers that cached the substituted-first-photo
            // responses (pre-fix) and sidesteps the cache while a gallery is
            // still downloading in the background.
            const imageUrl = `/api/ai/place-image/${placeId}/${index}?v=${Date.now()}`;
            // console.log(`Image ${index + 1} - URL contains photoreference: ${imageUrl.includes('photoreference=')}`);
            return {
                url: imageUrl, 
                title: `${placeName} - View ${index + 1}`, 
                caption: generateImageCaption(placeName, index), 
                source: 'google_places',
                photo_reference: photo.name || photo.photo_reference // Keeping reference for easier extraction
            };
        });
        return images;
    } catch (error) {
        console.error('Failed to get Google place images:', error);
        return [];
    }
}

function generateImageCaption(placeName, index) {
    const captions = [ `Exterior view of ${placeName}`, `Interior view of ${placeName}`, `Unique features of ${placeName}` ];
    return captions[index % captions.length];
}

function formatDestinationDetails(destination) {
    // Same event-expiry computation as formatBusinessDetails. Destinations
    // tagged 'events' are validator-curated concerts/festivals and carry the
    // identical eventSchedule shape, so the rec card can render the date row
    // and an "Ended" badge without knowing which collection the place came
    // from. The rule lives canonically on Destination.isEventExpired(); we
    // repeat it inline here because these docs arrive via .lean() (plain
    // objects, no model methods attached).
    const isEvent = Array.isArray(destination.type) && destination.type.includes('events');
    let isExpired = false;
    if (isEvent && !destination.eventSchedule?.isRecurring) {
        const end = destination.eventSchedule?.endDate || destination.eventSchedule?.startDate;
        if (end) isExpired = new Date(end).getTime() < Date.now();
    }
    return {
        source: 'database',
        type: destination.type,
        // Event-specific — null for the parks/monuments/viewpoints that make up
        // most destinations. The chat UI guards on isEventRec() before showing
        // the schedule row, so emitting null is harmless.
        eventSchedule: destination.eventSchedule || null,
        _isExpired: isExpired,
        id: destination._id,
        name: destination.name,
        description: destination.description,
        region: destination.location?.region || 'Unknown Region',
        // ── Address line — same shape as formatBusinessDetails so the card
        //    can render a real location string instead of "Location not specified".
        location: destination.location?.address ? `${destination.location.address}, ${destination.location.city || ''}`.trim().replace(/,\s*$/, '') : destination.location?.city || 'Location not specified',
        // ── First image — previously missing entirely, which is why destination
        //    cards rendered without an image even when the DB had photos.
        // Coords for the recommendation map (see formatBusinessDetails).
        geometry: { location: { lat: destination.location?.coordinates?.lat ?? null, lng: destination.location?.coordinates?.lng ?? null } },
        // Contact for the map popup (Call / Website actions).
        website: destination.contact?.website || null,
        phone:   destination.contact?.phone || null,
        images: destination.images?.slice(0, 1) || [],
        distance: destination.distance,
        distanceKm: destination.distance,
        distanceText: destination.distanceText
    };
}

function formatBusinessDetails(business) {
    // Compute event-expired flag here so the client doesn't have to repeat
    // the rule (which lives canonically on Business.js isEventExpired). The
    // discoverabilityFilter in proximityService already hides expired events
    // from new recs, but old chat history may reference an event that has
    // since ended — surface the flag so the rec card can label it honestly.
    const isEvent = Array.isArray(business.type) && business.type.includes('events');
    let isExpired = false;
    if (isEvent && !business.eventSchedule?.isRecurring) {
        const end = business.eventSchedule?.endDate || business.eventSchedule?.startDate;
        if (end) isExpired = new Date(end).getTime() < Date.now();
    }
    return {
        source: 'database',
        type: business.type,
        id: business._id,
        name: business.name,
        description: business.description?.detailed || business.description?.short || 'No description',
        category: business.type,
        distance: business.distance,
        distanceKm: business.distance,
        distanceText: business.distanceText,
        location: business.location?.address ? `${business.location.address}, ${business.location.city || ''}`.trim() : business.location?.city || 'Location not specified',
        // Coords for the recommendation map. The model stores them at
        // location.coordinates; expose as geometry.location so the rec builder
        // (and anything reusing entityDetails) finds them the same way it does
        // for Google/cache places.
        geometry: { location: { lat: business.location?.coordinates?.lat ?? null, lng: business.location?.coordinates?.lng ?? null } },
        // Contact for the map popup (Call / Website actions).
        website: business.contact?.website || null,
        phone:   business.contact?.phone || null,
        images: business.images?.slice(0, 1) || [],
        isPartner: business.partnership?.isPartner || false,
        // Event-specific fields — only meaningful for type includes 'events',
        // but cheap to always emit. The chat UI guards on isEventRec() to
        // decide whether to show the schedule row.
        eventSchedule: business.eventSchedule || null,
        _isExpired: isExpired
    };
}

/* ═══════════════════ schema.org/Event listing fetch ═══════════════════════
 * The model is a good DISCOVERER of events and an unreliable REPORTER of their
 * dates: of three events verified by hand against the live web, two were wrong
 * (Blessing of Grapes a day early; the Shéné concert three weeks early — it is
 * Sept 5, and it is hip-hop, not pop). It also has no artwork at all, while the
 * listing pages carry official posters — ticket-am.com serves the LOBODA image.
 *
 * The model already reports the page it read as SOURCE_URL. This fetches that
 * page and reads its schema.org/Event JSON-LD, which is machine-written by the
 * ticketing platform rather than recalled — so the date comes from the seller.
 * Whatever the listing states OVERRIDES the model, and each overridden field is
 * stamped in rec.provenance so the origin of every date stays inspectable.
 *
 * A VALIDATOR's record still outranks a listing; this pass only ever touches
 * AI-discovered events (source !== 'database').
 *
 * ── Fetching a model-supplied URL is an SSRF sink ───────────────────────────
 * The URL is chosen by a language model out of web-search results, so it is
 * attacker-influenceable in principle and must never be able to reach our own
 * network. Guards: http/https only, default ports only, DNS resolved UP FRONT
 * with every returned address checked against private/loopback/link-local/CGNAT
 * ranges (169.254.169.254 — the cloud metadata endpoint — included), redirects
 * followed MANUALLY so each hop is re-validated (a 302 to localhost is the
 * classic bypass), hard timeout, byte cap, and HTML-ish content types only.
 * Residual risk: DNS rebinding between our lookup and the connect, which needs
 * a custom agent/socket-level check to close; noted rather than silently
 * assumed away. No response body is ever echoed back to the user — only parsed
 * dates, an image URL and a venue string.
 */
/* A venue string that names no single location. The model writes "Various
 * venues" for a city-wide festival and "Armenian Apostolic Churches" for a
 * nationwide feast; both were being geocoded as if they were addresses, costing
 * a Places call and pinning the event on whatever came back. Such an event
 * should stay a date-card.
 *
 * Hoisted to module scope so the listing pass and the venue pass apply the SAME
 * rule — it previously lived inside the venue loop, so a placeholder arriving
 * from a listing would have bypassed it. No /g flag, so it carries no lastIndex
 * state between the two call sites. */
const PLACEHOLDER_VENUE_RE = /^(various|multiple|several|many|different|citywide|city-wide|nationwide|tba|tbd|n\/?a|online|virtual)\b|\b(venues|locations|churches|theatres|theaters|cinemas|halls|sites)\s*$/i;

/* A CITY is not a venue either — and this one shipped.
 *
 * The model answered "Yerevan" and "Yerevan city centre" as the venue/address
 * for three unrelated events. Both were sent to Google as if they were venues,
 * which returned an arbitrary establishment near the city centre: all three
 * events were pinned at 10 Tamanyan St and rendered with the SAME Cascade
 * photo. (The `[cache] rejected poisoned mapping "Yerevan" → …` guard fired,
 * proving the cache already distrusts such mappings — but the live lookup then
 * happily resolved it fresh.)
 *
 * "Somewhere in this city" carries no more location than "Various venues" does,
 * so it gets the same treatment: stay an honest date-card. Matches the bare
 * city or region name, optionally followed only by a centre/downtown-type word.
 */
const _CITY_QUALIFIER_RE = /^(city\s*)?(centre|center|downtown|city|old\s*town|central|area|region|province|outskirts|suburbs)$/i;
function isPlaceholderVenue(value, cityNames = []) {
    const v = String(value || '').trim();
    if (!v) return true;
    if (PLACEHOLDER_VENUE_RE.test(v)) return true;
    const norm = normalizePlaceName(v);
    if (!norm) return true;
    for (const city of cityNames) {
        const c = normalizePlaceName(city);
        if (!c || !norm.startsWith(c)) continue;
        const rest = norm.slice(c.length).trim();
        // Exactly the city ("Yerevan"), or the city plus only a generic
        // qualifier ("Yerevan city centre"). "Yerevan Opera House" has a real
        // remainder and is a genuine venue, so it passes.
        if (!rest || _CITY_QUALIFIER_RE.test(rest)) return true;
    }
    return false;
}

const EVENT_LISTING_TIMEOUT_MS   = 4500;
const EVENT_LISTING_MAX_BYTES    = 1500000;    // ~1.5 MB of HTML is plenty for a <head> full of JSON-LD
const EVENT_LISTING_MAX_REDIRECTS = 3;
const EVENT_LISTING_CONCURRENCY  = 4;          // polite, and bounds worst-case added latency
const EVENT_LISTING_TTL_MS       = 6 * 60 * 60 * 1000;
const EVENT_LISTING_CACHE_MAX    = 500;

// url → { at, data }. Listing pages change rarely and the same few URLs recur
// across taps and users, so this removes almost all repeat fetches.
const _eventListingCache = new Map();

function _isPrivateIpAddress(ip) {
    const net = require('net');
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127) return true;              // this-host, private, loopback
        if (a === 172 && b >= 16 && b <= 31) return true;               // private
        if (a === 192 && b === 168) return true;                        // private
        if (a === 169 && b === 254) return true;                        // link-local (cloud metadata)
        if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
        if (a >= 224) return true;                                      // multicast + reserved
        return false;
    }
    if (net.isIPv6(ip)) {
        const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
        if (s === '::1' || s === '::') return true;                     // loopback / unspecified
        if (/^fe[89ab]/.test(s)) return true;                           // link-local
        if (/^f[cd]/.test(s)) return true;                              // unique-local
        const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);         // IPv4-mapped
        if (mapped) return _isPrivateIpAddress(mapped[1]);
        return false;
    }
    return true;   // unparseable → refuse rather than resolve
}

async function _assertPublicHttpUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`blocked scheme ${url.protocol}`);
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error(`blocked port ${url.port}`);
    if (url.username || url.password) throw new Error('blocked credentials in URL');
    const dns = require('dns').promises;
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (!addrs.length) throw new Error('no DNS result');
    for (const a of addrs) {
        if (_isPrivateIpAddress(a.address)) throw new Error(`blocked private address ${a.address}`);
    }
    return url;
}

async function _fetchListingHtml(rawUrl) {
    let target = rawUrl;
    for (let hop = 0; hop <= EVENT_LISTING_MAX_REDIRECTS; hop++) {
        const url = await _assertPublicHttpUrl(target);   // re-validated on EVERY hop
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), EVENT_LISTING_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, {
                redirect: 'manual',
                signal: ac.signal,
                headers: {
                    // Identify honestly; some ticketing sites 403 an empty UA.
                    'User-Agent': 'JinniTravelBot/1.0 (+https://jinni.travel; event listing date verification)',
                    'Accept': 'text/html,application/xhtml+xml,application/ld+json;q=0.9,*/*;q=0.1',
                    'Accept-Language': 'en,hy;q=0.8,ru;q=0.8'
                }
            });
        } finally {
            clearTimeout(timer);
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const loc = res.headers.get('location');
            if (!loc) return null;
            target = new URL(loc, url).toString();
            continue;                                     // loop re-validates the new host
        }
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|application\/ld\+json/i.test(ct)) return null;

        // Streamed with a byte cap: Content-Length can lie or be absent, so the
        // cap has to be enforced on what actually arrives.
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > EVENT_LISTING_MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    return null;   // redirect budget exhausted
}

// schema.org Event and its subtypes. Anchored so "EventVenue" can't match.
const _LD_EVENT_TYPE = /^(Event|MusicEvent|Festival|MusicFestival|TheaterEvent|DanceEvent|ComedyEvent|SportsEvent|ScreeningEvent|ExhibitionEvent|EducationEvent|SocialEvent|FoodEvent|LiteraryEvent|BusinessEvent|ChildrensEvent|VisualArtsEvent|DeliveryEvent|PublicationEvent|Hackathon)$/;

function _collectLdEvents(node, out, depth = 0) {
    if (!node || depth > 8 || out.length > 200) return;
    if (Array.isArray(node)) { for (const n of node) _collectLdEvents(n, out, depth + 1); return; }
    if (typeof node !== 'object') return;
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some(x => typeof x === 'string' && _LD_EVENT_TYPE.test(x.replace(/^.*\//, '')))) out.push(node);
    // Containers a listing page wraps its events in.
    for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'subEvents', 'events', 'mainEntity', 'mainEntityOfPage']) {
        if (node[key]) _collectLdEvents(node[key], out, depth + 1);
    }
}

function _extractLdEvents(html) {
    const out = [];
    const re = /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }   // one malformed block never kills the rest
        _collectLdEvents(parsed, out);
    }
    return out;
}

/* A date-ONLY value must stay date-only: the past-event filter reads "exactly
 * midnight UTC" as "all day, so it lives out its whole day", and a real clock
 * time as "expires at that instant". A timed value that happens to land on
 * midnight UTC is nudged 1 ms so it cannot masquerade as all-day. */
function _ldDate(v) {
    const s = typeof v === 'string' ? v.trim() : (typeof v?.['@value'] === 'string' ? v['@value'].trim() : '');
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    let ms = d.getTime();
    if (ms % 86400000 === 0) ms += 1;
    return new Date(ms).toISOString();
}

function _ldImage(v, depth = 0) {
    if (!v || depth > 4) return null;
    if (typeof v === 'string') return /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
    if (Array.isArray(v)) { for (const i of v) { const r = _ldImage(i, depth + 1); if (r) return r; } return null; }
    if (typeof v === 'object') return _ldImage(v.contentUrl || v.url || v['@id'], depth + 1);
    return null;
}

function _ldText(v) {
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v)) { for (const i of v) { const r = _ldText(i); if (r) return r; } return null; }
    if (v && typeof v === 'object') return _ldText(v['@value'] ?? v.name);
    return null;
}

function _ldAddress(a) {
    if (!a) return null;
    if (typeof a === 'string') return a.trim() || null;
    if (Array.isArray(a)) return _ldAddress(a[0]);
    if (typeof a === 'object') {
        const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry]
            .map(p => _ldText(p)).filter(Boolean);
        return parts.length ? parts.join(', ') : null;
    }
    return null;
}

/* ── Event titles are not place names ─────────────────────────────────────────
 * namesPlausiblyMatch() exists to compare a requested PLACE to a resolved one,
 * and its stopword list is full of place words (hotel, cafe, lounge…). Applied
 * to event titles it matched "LOBODA Concert" to "Tickets for the Spleen
 * concert" — because both contain "concert" — and shipped LOBODA with Spleen's
 * date, poster and venue, while breaking the curated dedupe as a side effect
 * (the corrected date no longer matched the validator's record).
 *
 * An event title is mostly selling boilerplate. Strip that, and what remains is
 * the ARTIST or the festival name — the only part that identifies the event.
 * Two events match only if they share one of those distinctive words. */
const _EVENT_STOPWORDS = new Set([
    'ticket', 'tickets', 'concert', 'concerts', 'show', 'shows', 'festival', 'fest',
    'party', 'live', 'tour', 'night', 'nights', 'event', 'events', 'performance',
    'presents', 'present', 'feat', 'featuring', 'gala', 'open', 'air', 'birthday',
    'the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'at', 'on', 'with', 'by', 's',
    'yerevan', 'armenia', 'am'
]);
const _eventTokens = (s) => normalizePlaceName(
        // Possessives first: normalizePlaceName strips the apostrophe and glues
        // the s on ("Asatryan's" → "asatryans"), which then fails to equal
        // "asatryan" now that multi-word titles must share TWO tokens.
        String(s || '').replace(/['’]s\b/gi, '')
    )
    .split(' ')
    .filter(t => t.length >= 3 && !_EVENT_STOPWORDS.has(t));

function eventNamesMatch(a, b) {
    const ta = _eventTokens(a), tb = _eventTokens(b);
    // No distinctive word on either side → refuse to guess. Silence beats a
    // confidently wrong date on somebody else's concert.
    if (!ta.length || !tb.length) return false;
    /* One shared word is enough only when one side has just one word to give
     * ("Spleen" vs "Tickets for the Spleen concert"). When BOTH titles are
     * multi-word, a single shared token is a coincidence, not an identity:
     * "Symphonic Yerevan International Music Festival" matched "Symphonic
     * Hayko. Ararat in the Heart" on the word "symphonic" alone, and shipped
     * the festival with the other concert's Aug-25 date. Two shared
     * distinctive words is the bar a multi-word pair must clear. */
    const shared = ta.filter(x => tb.includes(x)).length;
    const needed = Math.min(ta.length, tb.length) >= 2 ? 2 : 1;
    return shared >= needed;
}

// Feed titles are HTML-escaped and wrapped in selling words: "Tickets for
// Grisha Asatryan&apos;s concert". Users should see the event, not the shop.
const _HTML_ENTITIES = { amp: '&', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', nbsp: ' ', laquo: '«', raquo: '»' };
function _decodeEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&([a-z]+);/gi, (m, n) => _HTML_ENTITIES[n.toLowerCase()] ?? m);
}
function cleanEventTitle(raw) {
    let s = _decodeEntities(raw).trim();
    s = s.replace(/\s+in\s+[A-Z][\w'’-]*(?:\s*,\s*[A-Z][\w'’-]*)?\s*$/u, '');   // "… in Yerevan"
    s = s.replace(/^tickets?\s+(?:for|to)\s+(?:the\s+)?/i, '');                  // "Tickets for the …"
    s = s.replace(/\s+tickets?$/i, '');                                          // "… Tickets"
    // "concert "Symphonic Hayko…"" → the quoted title is the real name.
    const quoted = s.match(/^(?:concert|show|performance)\s*[«"'“]([^»"'”]+)/i);
    if (quoted) s = quoted[1];
    s = s.replace(/^[«"'“]|[»"'”]$/g, '').trim();
    return s || _decodeEntities(raw).trim();
}

// The poster lives in og:image on these listing pages, not in the JSON-LD.
function _extractOgImage(html) {
    const m = html.match(/<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:image["']/i);
    const u = m && m[1] && m[1].trim();
    return u && /^https?:\/\//i.test(u) ? u : null;
}

function _normalizeLdEvent(node) {
    const loc = Array.isArray(node.location) ? node.location[0] : node.location;
    // `url` is the per-event page. On an index feed it is the only way back to
    // the individual listing, and it becomes the card's "check the listing" link.
    const url = typeof node.url === 'string' && /^https?:\/\//i.test(node.url.trim())
        ? node.url.trim() : null;
    return {
        name: _ldText(node.name),
        startDate: _ldDate(node.startDate),
        endDate: _ldDate(node.endDate),
        image: _ldImage(node.image),
        url,
        venueName: loc && typeof loc === 'object' ? _ldText(loc.name) : _ldText(loc),
        venueAddress: loc && typeof loc === 'object' ? _ldAddress(loc.address) : null
    };
}

/* Fetch one listing URL and return the schema.org Event that best corresponds
 * to `eventName`. A ticketing page often lists MANY events (a "what's on" rail
 * in the footer), so taking the first one would import a neighbouring concert's
 * date — worse than the model's guess. Requires a name match; falls back to the
 * page's single event only when the page has exactly one. */
// Global fetch + web streams need Node 18+. Nothing in this repo pins a Node
// version (no Dockerfile, .nvmrc or engines field), so an older runtime is not
// impossible. The try/catch below would already swallow it, but that would mean
// one confusing warning per URL per tap; check once and degrade to model dates
// with a single honest line instead.
let _listingFetchUnavailable = typeof fetch !== 'function';
if (_listingFetchUnavailable) {
    console.warn('[listing] global fetch() unavailable on this Node runtime (needs 18+) — event dates will fall back to model recall');
}

async function fetchEventListing(rawUrl, eventName) {
    if (_listingFetchUnavailable) return null;
    const key = String(rawUrl).slice(0, 500);
    const hit = _eventListingCache.get(key);
    if (hit && (Date.now() - hit.at) < EVENT_LISTING_TTL_MS) return hit.data;

    let data = null;
    try {
        const html = await _fetchListingHtml(rawUrl);
        /* Say WHY nothing came back. The first production run reported
         * "0 date(s) corrected" on every tap with no other line — accurate but
         * unactionable, since it could equally have meant a blocked fetch, a
         * page with no JSON-LD, or events that didn't match. Probing the URLs
         * by hand settled it (visityerevan.am and tkt.am publish no JSON-LD at
         * all; only ticket-am.com does). That probe should not have been
         * necessary, so each outcome now names itself. */
        if (!html) {
            console.log(`[listing] no usable body from ${String(rawUrl).slice(0, 120)} (blocked, non-HTML, or oversized)`);
        } else {
            const nodes = _extractLdEvents(html);
            const normalized = nodes.map(_normalizeLdEvent).filter(e => e.startDate || e.image);
            if (!nodes.length) {
                /* No structured data — but the POSTER is usually still there, in
                 * og:image. Tbilisi proved the cost of ignoring it: tkt.ge pages
                 * carry the artwork and every card rendered with a blank calendar
                 * icon, because this path only ever looked at JSON-LD.
                 *
                 * Image ONLY. A date read off an unstructured page would be a
                 * guess, and guessed dates are the thing this whole pass exists to
                 * eliminate. Restricted to a DEEP url (a specific event page), so
                 * a category or home page cannot donate its site banner as if it
                 * were event artwork. */
                let path = '';
                try { path = new URL(rawUrl).pathname.replace(/\/+$/, ''); } catch {}
                const looksSpecific = path.split('/').filter(Boolean).length >= 2;
                const og = looksSpecific ? _extractOgImage(html) : null;
                if (og) {
                    data = { name: null, startDate: null, endDate: null, image: og, url: null, venueName: null, venueAddress: null };
                    console.log(`[listing] no JSON-LD on ${String(rawUrl).slice(0, 90)} — taking og:image only (no date from an unstructured page)`);
                } else {
                    console.log(`[listing] no schema.org/Event JSON-LD on ${String(rawUrl).slice(0, 120)} — this source cannot verify dates`);
                }
            } else if (!normalized.length) {
                console.log(`[listing] ${nodes.length} Event block(s) on ${String(rawUrl).slice(0, 90)} but none carried a date or image`);
            } else if (normalized.length === 1) {
                data = normalized[0];
            } else {
                data = normalized.find(e => e.name && namesPlausiblyMatch(eventName, e.name)) || null;
                if (!data) console.log(`[listing] ${normalized.length} events on page, none matching "${eventName}" — ignoring rather than guessing`);
            }
        }
    } catch (err) {
        // Never let a slow, hostile or malformed third-party page fail the tap.
        console.warn(`[listing] fetch failed for ${String(rawUrl).slice(0, 120)}: ${err.message}`);
        data = null;
    }

    if (_eventListingCache.size >= EVENT_LISTING_CACHE_MAX) {
        // Cheap FIFO trim — insertion order is Map's iteration order.
        const oldest = _eventListingCache.keys().next().value;
        _eventListingCache.delete(oldest);
    }
    _eventListingCache.set(key, { at: Date.now(), data });
    return data;
}

/* ═══════════════════════ Ticketing index feeds ════════════════════════════
 * The cheapest good data in this pipeline, and the answer to the cost problem.
 *
 * Events web-search on EVERY tap (not just the first), at roughly $0.05–0.07 a
 * tap once the ~18k tokens of injected search results are counted. That is per
 * user, per tap, forever — the one part of this app whose cost grows linearly
 * with success. And it buys unreliable dates: the model put the Shéné concert
 * three weeks early and Blessing of Grapes a day early.
 *
 * ticket-am.com publishes its whole upcoming schedule as schema.org/Event
 * JSON-LD, in ENGLISH at /en/, with exact start times, real venue names and
 * official poster art. For the LOBODA concert it gives precisely what a human
 * validator entered by hand:
 *
 *     "Loboda Concert Tickets" | 2026-08-15T20:00:00 | "Altezza by Armenian
 *     Helicopters" | cdn.pbilet.net/origin/cdb908b7-…
 *
 * One HTTP GET. No tokens, no web searches, no model recall. Cached process-
 * wide and shared by ALL users — cost does not scale with traffic at all.
 *
 * Used two ways below: to CORRECT an AI event whose date the model guessed at,
 * and to SUPPLY events outright. Confined to the country it actually covers —
 * this is an Armenian ticketing site, not a world feed.
 */
/* A source declares WHICH COUNTRIES IT COVERS. Nothing here is special-cased
 * to one city, and no coordinates are hardcoded: the app is used worldwide, so
 * the pipeline asks "is there a source for where this user is?" and gets no
 * feed — falling back to the AI exactly as before — anywhere there isn't one.
 * Adding Paris or Tbilisi later is one more row in this array.
 *
 * The country must come from `userRegion` (googleService.detectUserRegion),
 * NOT from `effectiveLocation`. That was the bug that silently disabled the
 * whole feed in production: resolveEffectiveLocation()'s real-time GPS branch —
 * the common path — returns only { lat, lng, source, privacyMode, nearbyRadius,
 * discoveryRadius }, with no city and no country. `effectiveLocation.country`
 * was undefined, nothing matched, and the feed never ran: no `[feed]` line and
 * refills still paying for web search. userRegion is already resolved once per
 * request for the search context, so this costs nothing extra. */
const EVENT_FEED_SOURCES = [
    {
        label: 'ticket-am',
        // /en/ is the same JSON-LD with English names and venues.
        url: 'https://ticket-am.com/en/',
        countries: ['armenia']
    },
    {
        label: 'tomsarkgh',
        // Server-rendered, no JSON-LD — read via page-text extraction. Carries
        // the near-term events (13/15/23/25 Aug) that ticket-am's window lacked.
        url: 'https://www.tomsarkgh.am/en',
        countries: ['armenia'],
        mode: 'extract'
    }
];
/* ═══════════════ Language-free canonicalization (the normalizer) ═══════════
 * THE architectural rule: identity is never words (it is coords + day + URL),
 * and linguistics belongs to the MODEL, once, at ingestion — never to regexes
 * at request time. The English regex layer (cleanEventTitle, _EVENT_STOPWORDS)
 * only ever worked in English; every non-Latin market walked around it. These
 * two functions replace that layer for any language, at one small model call
 * per SOURCE per refresh — shared by every user, so per-user AI cost stays 0.
 * The regexes remain only as the degradation path when the model call fails.
 *
 * The model handles ONLY language (titles, tags, price text). Dates, URLs and
 * coordinates are code-owned: the normalizer is never even shown a date it
 * could corrupt, and the extractor's dates are code-validated or dropped —
 * an unparseable date is a guess, and a guess never renders as fact. */
const EVENT_TAG_VOCABULARY = ['music','concert','festival','theater','opera','ballet','dance','comedy','standup','circus','cinema','exhibition','art','museum','sports','food','wine','nightlife','club','family','kids','education','literature','poetry','tech','outdoor','market','holiday','religious'];

/** One call per feed refresh: English titles + canonical tags for any language. */
async function normalizeEventBatch(sourceLabel, events) {
    if (!events.length) return events;
    try {
        const cfg = await AppConfig.getConfig();
        const payload = events.map((e, i) => ({ i, name: e.rawName || e.name, venue: e.venueName || null }));
        const res = await claudeService.complete({
            model: cfg.claudeModel, maxTokens: 1500, temperature: 0,
            system: 'You return only JSON. No prose, no markdown fences.',
            messages: [{ role: 'user', content:
                `For each event give a concise English title (drop ticket-shop wording like "Tickets for") `
              + `and tags chosen ONLY from: ${EVENT_TAG_VOCABULARY.join(', ')}. `
              + `Events (any language): ${JSON.stringify(payload)}. `
              + `Reply ONLY a JSON array [{"i":0,"en":"...","tags":["music"]}]. Do not add or remove events.` }]
        });
        const arr = JSON.parse((String(res?.text || '').match(/\[[\s\S]*\]/) || ['[]'])[0]);
        const byI = new Map((Array.isArray(arr) ? arr : []).filter(x => x && Number.isInteger(x.i)).map(x => [x.i, x]));
        let applied = 0;
        events.forEach((e, i) => {
            const n = byI.get(i); if (!n) return;
            const en = typeof n.en === 'string' && n.en.trim() ? n.en.trim().slice(0, 120) : null;
            const tags = Array.isArray(n.tags) ? n.tags.filter(t => EVENT_TAG_VOCABULARY.includes(t)).slice(0, 6) : [];
            if (en) { e.names = { original: e.rawName || e.name, en }; e.name = en; applied++; }
            if (tags.length) e.tags = tags;
        });
        console.log(`[normalize] ${sourceLabel}: ${applied}/${events.length} titled+tagged in one shared call`);
    } catch (err) {
        console.warn(`[normalize] ${sourceLabel} failed (${err.message}) — regex-cleaned titles stand in`);
    }
    return events;
}

function _htmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .split('\n').map(t => t.trim()).filter(Boolean).join('\n').slice(0, 12000);
}

/* Server-rendered sites with no JSON-LD (tomsarkgh) still print every event in
 * their visible text — name, date, venue, price, in their own language. The
 * model reads that text once per refresh; CODE then validates every date and
 * drops anything unparseable or out of range. Provenance 'extracted' sits one
 * trust tier below a structured feed: it may fill holes, never overwrite. */
async function extractEventsFromPage(source, html) {
    const text = _htmlToText(html);
    if (text.length < 200) return [];
    const cfg = await AppConfig.getConfig();
    const today = new Date().toISOString().slice(0, 10);
    const res = await claudeService.complete({
        model: cfg.claudeModel, maxTokens: 2000, temperature: 0,
        system: 'You return only JSON. No prose, no markdown fences.',
        messages: [{ role: 'user', content:
            `Visible text of ${source.label}, an event-listing page (any language). Today is ${today}. `
          + `List ONLY events explicitly present with an explicit date — never invent or guess. `
          + `Reply ONLY a JSON array [{"original":"<title as written>","en":"<concise English title>","date":"YYYY-MM-DD","endDate":null,"venue":"<as written or null>","priceMin":null,"priceMax":null,"currency":null,"tags":[only from: ${EVENT_TAG_VOCABULARY.join(',')}]}].\n\n${text}` }]
    });
    const arr = JSON.parse((String(res?.text || '').match(/\[[\s\S]*\]/) || ['[]'])[0]);
    const out = [];
    const minT = Date.now() - 86400000, maxT = Date.now() + 366 * 86400000;
    for (const e of (Array.isArray(arr) ? arr : [])) {
        if (!e || typeof e.en !== 'string' || !e.en.trim()) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
        const t = Date.parse(e.date + 'T00:00:00.000Z');
        if (!Number.isFinite(t) || t < minT || t > maxT) continue;
        const end = /^\d{4}-\d{2}-\d{2}$/.test(e.endDate || '') ? e.endDate + 'T00:00:00.000Z' : null;
        out.push({
            name: e.en.trim().slice(0, 120), rawName: (e.original || e.en).trim(),
            names: { original: (e.original || e.en).trim(), en: e.en.trim() },
            startDate: e.date + 'T00:00:00.000Z', ...(end ? { endDate: end } : {}),
            image: null, url: source.url,
            venueName: typeof e.venue === 'string' && e.venue.trim() ? e.venue.trim() : null, venueAddress: null,
            tags: Array.isArray(e.tags) ? e.tags.filter(x => EVENT_TAG_VOCABULARY.includes(x)).slice(0, 6) : [],
            price: Number.isFinite(e.priceMin)
                ? { min: e.priceMin, max: Number.isFinite(e.priceMax) ? e.priceMax : e.priceMin, currency: typeof e.currency === 'string' ? e.currency.slice(0, 3).toUpperCase() : null }
                : null,
            provenance: 'extracted', feedLabel: source.label
        });
    }
    console.log(`[extract] ${source.label}: ${out.length} dated event(s) read from page text (model-read, code-validated)`);
    return out;
}

const EVENT_FEED_TTL_MS = 30 * 60 * 1000;   // a ticketing schedule moves in days, not minutes
const _eventFeedCache = new Map();          // url → { at, events }

/**
 * Upcoming events from one ticketing index, normalized to the shape the event
 * pipeline already uses. Never throws — a dead feed degrades to [].
 */
async function getEventFeed(source) {
    const hit = _eventFeedCache.get(source.url);
    if (hit && (Date.now() - hit.at) < EVENT_FEED_TTL_MS) return hit.events;
    if (_listingFetchUnavailable) return [];

    let events = [];
    try {
        const html = await _fetchListingHtml(source.url);
        if (html && source.mode === 'extract') {
            events = await extractEventsFromPage(source, html);
        } else if (html) {
            events = _extractLdEvents(html)
                .map(_normalizeLdEvent)
                .filter(e => e.name && e.startDate)
                .map(e => ({ ...e, rawName: e.name, name: cleanEventTitle(e.name), feedLabel: source.label }));

            /* Posters: the index JSON-LD carries an image for only a couple of
             * events, so most cards fell back to the VENUE's Google photo — a
             * generic building where the official artwork exists. Each event's
             * own page has it in og:image, so fill the gaps from there.
             *
             * Done once per feed refresh (every 30 min, shared by ALL users),
             * not per request, and bounded to 4 at a time. Still $0 in AI. */
            const missing = events.filter(e => !e.image && e.url).slice(0, 20);
            if (missing.length) {
                const queue = missing.slice();
                let found = 0;
                const worker = async () => {
                    while (queue.length) {
                        const ev = queue.shift();
                        try {
                            const page = await _fetchListingHtml(ev.url);
                            if (page) { const og = _extractOgImage(page); if (og) { ev.image = og; found++; } }
                        } catch { /* a missing poster is not worth failing over */ }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
                console.log(`[feed] ${source.label}: ${found}/${missing.length} poster(s) recovered from event pages`);
            }
            // Language work happens HERE, once per refresh — not per request.
            events = await normalizeEventBatch(source.label, events);
        }
        console.log(`[feed] ${source.label}: ${events.length} upcoming event(s) (cached ${Math.round(EVENT_FEED_TTL_MS / 60000)} min, shared by all users, $0 in AI)`);
    } catch (err) {
        console.warn(`[feed] ${source.label} unavailable: ${err.message}`);
        events = [];
    }
    // Cache even an empty result, so a broken feed is retried on the TTL rather
    // than on every single tap.
    _eventFeedCache.set(source.url, { at: Date.now(), events });
    return events;
}

/** Every feed covering the country the user is actually in. */
async function getEventFeedsForLocation(userRegion, effectiveLocation, destinationInfo) {
    const hay = [userRegion?.country, destinationInfo?.country, effectiveLocation?.country]
        .filter(Boolean).map(s => String(s).toLowerCase().trim());
    if (!hay.length) return [];
    // Hand-registered sources first, then anything discovery verified for this
    // country — so a new market gets free feeds without a code change.
    let sources = EVENT_FEED_SOURCES.filter(s => s.countries.some(c => hay.includes(c)));
    if (userRegion?.country) {
        try {
            const found = (await discoverEventSources(userRegion.country, userRegion.city)).feeds || [];
            const known = new Set(sources.map(s => s.label));
            sources = sources.concat(found.filter(f => !known.has(f.label)));
        } catch { /* discovery is an optimisation, never a dependency */ }
    }
    if (!sources.length) return [];   // no source here — the AI path is unchanged
    const lists = await Promise.all(sources.map(s => getEventFeed(s)));
    return lists.flat();
}

/* ═══════════ Automatic per-country event-source discovery ═════════════════
 * A hand-typed domain allowlist only ever covers one country. The moment the
 * app is opened in Tbilisi or Paris it either blocks everything useful or has
 * to be extended by hand, forever — and this app is used worldwide.
 *
 * So the sources are DISCOVERED, once per country, and then reused:
 *
 *   1. ask the model which sites list events in that country (one small call,
 *      no web search, ~100 tokens);
 *   2. VERIFY every name it gives — models invent plausible-looking domains,
 *      so anything that fails DNS/SSRF checks or does not return HTML is
 *      discarded before it is trusted with anything;
 *   3. probe each survivor for schema.org/Event JSON-LD. A site that publishes
 *      it becomes a free, exact-date, poster-carrying FEED — the same deal
 *      ticket-am gives — with no country-specific code written for it;
 *   4. cache the result for a week.
 *
 * Cost is one small call per country per week, shared by every user in it.
 * A MANUAL allowlist always wins where one is set: discovery fills the gaps,
 * it does not overrule a human decision.
 */
const DOMAIN_DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOMAIN_DISCOVERY_MAX = 6;
const _discoveredByCountry = new Map();   // country(lc) → { at, domains, feeds }
const _discoveryInFlight = new Map();     // country(lc) → Promise (one call, not N)

/* Two DIFFERENT questions, and conflating them threw away real sources.
 *
 * Dubai's first discovery proposed 6 sites and kept 2, rejecting
 * ticketmaster.ae, timeoutdubai.com and platinumlist.net — all real, major
 * event sites. Checked by hand: ticketmaster.ae answers 200 to anyone,
 * timeoutdubai.com returns 403 to bots, platinumlist.net simply would not
 * connect from our host. Only virgin-megastore.ae was genuinely invented
 * (no DNS at all).
 *
 * The error was using ONE test for both purposes. For the search allowlist we
 * never fetch the site — Claude's own search infrastructure does, and it is
 * not blocked by the things that block us. All that matters there is that the
 * domain is real and public. Our fetch has to succeed only for the JSON-LD
 * feed probe, where we genuinely need the bytes.
 */

/** Real, public, resolvable? Enough to let the SEARCH read it. */
async function _domainResolves(host) {
    try {
        await _assertPublicHttpUrl(`https://${host}/`);   // DNS + SSRF guards
        return true;
    } catch {
        return false;
    }
}

/** Can WE fetch it? Only needed to decide whether it can be a free feed. */
async function _fetchDomainHome(host) {
    /* `/en` WITHOUT the trailing slash matters: tomsarkgh.am/en/ 404s while
     * tomsarkgh.am/en is the English listing page. Falling straight through to
     * `/` served the Armenian homepage, where the Latin word "Yerevan" never
     * appears — so the relevance test excluded a site that is the country's
     * best event source. */
    for (const url of [`https://${host}/en`, `https://${host}/en/`, `https://${host}/`]) {
        try {
            const html = await _fetchListingHtml(url);
            if (html && html.length > 500) return { url, html };
        } catch { /* try the next form */ }
    }
    return null;
}

async function discoverEventSources(country, city) {
    const key = String(country || '').toLowerCase().trim();
    if (!key || _listingFetchUnavailable) return { domains: [], feeds: [] };

    const hit = _discoveredByCountry.get(key);
    if (hit && (Date.now() - hit.at) < DOMAIN_DISCOVERY_TTL_MS) return hit;
    if (_discoveryInFlight.has(key)) return _discoveryInFlight.get(key);

    const run = (async () => {
        let domains = [], feeds = [];
        try {
            const cfg = await AppConfig.getConfig();
            const res = await claudeService.complete({
                model: cfg.claudeModel,
                maxTokens: 200,
                temperature: 0,
                system: 'You return only JSON. No prose, no markdown fences.',
                messages: [{
                    role: 'user',
                    /* The place MUST be named unambiguously. Asked for "Georgia"
                     * alone the model returned exploregeorgia.org, atlanta.net and
                     * US ticket sellers — the STATE, not the country — and every
                     * one passed verification because they are real domains. A
                     * Tbilisi user's search was locked to Atlanta and found
                     * nothing. Naming the city settles it, and "the COUNTRY"
                     * settles it again for Georgia, Jordan, Luxembourg and every
                     * other name shared with a city or region. */
                    content: `Which websites list upcoming public events and sell event tickets in `
                           + `${city ? `${city}, ` : ''}${country}? `
                           + `${country} here is the COUNTRY${city ? `, and ${city} is a city in it` : ''} — `
                           + `not a US state or any similarly named place elsewhere. `
                           + `Prefer national ticket sellers and official city/tourism event calendars for that country. `
                           + `Exclude blogs, travel magazines, aggregators and social networks. `
                           + `Reply with ONLY a JSON array of at most ${DOMAIN_DISCOVERY_MAX} bare hostnames, e.g. ["example.com","example.org"].`
                }]
            });
            const raw = String(res?.text || '');
            const arr = JSON.parse((raw.match(/\[[\s\S]*?\]/) || ['[]'])[0]);
            const proposed = (Array.isArray(arr) ? arr : [])
                .map(d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
                .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
                .slice(0, DOMAIN_DISCOVERY_MAX);

            // ── Verify, then probe. A name the model produced is a HINT, never
            //    a fact: it reaches the network only after passing the same
            //    SSRF guards as any other fetched URL.
            const checks = await Promise.all(proposed.map(async host => {
                // Real domain? → the SEARCH may read it, whether or not we can.
                const real = await _domainResolves(host);
                if (!real) return { host, real: false, feed: null };
                // Fetchable by us? → then it can also be probed for a free feed.
                const ok = await _fetchDomainHome(host);
                if (!ok) return { host, real: true, feed: null };
                /* Real is not the same as RELEVANT. Every Atlanta domain above was
                 * real. When we can read the page, require it to mention the place
                 * we asked about — a Georgian ticket site names Tbilisi or Georgia;
                 * atlanta.net names neither. Sites we cannot fetch keep the benefit
                 * of the doubt, since we have no page to judge. */
                /* Match on the CITY, not the country. Country names are the whole
                 * problem: atlanta.net and exploregeorgia.org both say "Georgia"
                 * on every page, so a country-name test kept exactly the domains
                 * it was meant to remove. "Tbilisi" appears on neither. */
                const hay = ok.html.toLowerCase();
                const needle = String(city || country || '').toLowerCase().replace(/^t'/, '');
                const relevant = !needle || hay.includes(needle);
                const events = _extractLdEvents(ok.html).map(_normalizeLdEvent).filter(e => e.name && e.startDate);
                return {
                    host, real: true, relevant,
                    feed: relevant && events.length >= 3
                        ? { label: host, url: ok.url, countries: [String(country).toLowerCase()] }
                        : null
                };
            }));

            /* Drop every readable page that does not mention the city, with no
             * "keep them all if none matched" escape — that escape kept the entire
             * Atlanta list, which is the precise failure it was meant to prevent.
             *
             * Emptying the list is SAFE, and it is the same answer in both cases
             * this can produce. If the domains were wrong (Atlanta for Tbilisi),
             * dropping them is correct. If they were right but write their city
             * only in their own script, dropping them costs us nothing we had
             * before: an empty allowlist means UNRESTRICTED search — exactly the
             * behaviour that existed before discovery, never a broken state. */
            /* The allowlist requires PROVEN relevance: fetched, and the page names
             * the city. Unfetchable domains no longer get the benefit of the doubt.
             *
             * That leniency was added so bot-blocked Dubai sites survived, and it
             * is precisely what let atlanta.net and exploregeorgia.org through for
             * Tbilisi — both 403 us, so neither could be disproved, and search was
             * locked to the wrong continent while the user saw "no events".
             *
             * The two failure modes are not symmetric. A WRONG allowlist actively
             * breaks the feature; a SMALL or empty one merely means unrestricted
             * search, which is what happened before discovery existed. So when in
             * doubt, leave the domain out. */
            const offTopic = checks.filter(c => c.real && c.relevant !== true).map(c => c.host);
            domains = checks.filter(c => c.relevant === true).map(c => c.host);
            feeds = checks.filter(c => c.feed).map(c => c.feed);
            const invented = checks.filter(c => !c.real).map(c => c.host);
            console.log(`[discovery] ${country}: model proposed ${proposed.length} → ${domains.length} real [${domains.join(', ') || '—'}]`
                + `${invented.length ? ` | not a real domain: ${invented.join(', ')}` : ''}`
                + `${offTopic.length ? ` | unconfirmed for ${city || country} (excluded): ${offTopic.join(', ')}` : ''}`
                + `${feeds.length ? ` | JSON-LD feed(s): ${feeds.map(f => f.label).join(', ')}` : ' | no free feeds here — search only'}`);
        } catch (err) {
            console.warn(`[discovery] ${country} failed: ${err.message} — falling back to unrestricted search`);
            domains = []; feeds = [];
        }
        const out = { at: Date.now(), domains, feeds };
        _discoveredByCountry.set(key, out);
        _discoveryInFlight.delete(key);
        return out;
    })();

    _discoveryInFlight.set(key, run);
    return run;
}

/* Domains KNOWN to be good for a country — verified by hand, not by a model.
 * Discovery asks the model each week and gets a different answer each time:
 * one Armenian run proposed tickets.am/iyerevan.am/yerevan.am/kassir.am and
 * CACHED it for 7 days, locking the search out of ticket-am.com and
 * tomsarkgh.am — the two sources this project has actually verified against
 * the live web. A registry row per known market fixes the floor; discovery
 * still fills every country that has no row. Same pattern as
 * EVENT_FEED_SOURCES, and rows are data, not code paths. */
const KNOWN_EVENT_SEARCH_DOMAINS = [
    { countries: ['armenia'], domains: ['ticket-am.com', 'tomsarkgh.am', 'tkt.am'] }
];

/** Domains the web search may read here. A manual allowlist always wins. */
async function resolveSearchDomains(cfg, userRegion) {
    const manual = Array.isArray(cfg.claudeWebSearchAllowedDomains) ? cfg.claudeWebSearchAllowedDomains.filter(Boolean) : [];
    if (manual.length) return manual;
    if (cfg.eventSourceAutoDiscover === false) return [];
    const country = userRegion?.country;
    if (!country) return [];
    const key = String(country).toLowerCase();
    // Registry first: the floor no model answer can remove. Feed sources'
    // own hosts ride along — a site good enough to supply events is good
    // enough to be read by the search.
    const known = new Set(KNOWN_EVENT_SEARCH_DOMAINS
        .filter(r => r.countries.includes(key))
        .flatMap(r => r.domains));
    for (const s of EVENT_FEED_SOURCES.filter(s => s.countries.includes(key))) {
        try { known.add(new URL(s.url).hostname.replace(/^www\./, '')); } catch {}
    }
    let discovered = [];
    try { discovered = (await discoverEventSources(country, userRegion?.city)).domains; } catch {}
    return [...new Set([...known, ...discovered])];
}

let quickActionCallCount = 0;
router.post('/quick-action-stream', auth, usageTracker, async (req, res) => {
    // ── Client disconnect ────────────────────────────────────────────────
    // chat-stream has handled this since forever (see its handleDisconnect);
    // this route never did. A phone backgrounding the tab, a closed window or
    // a dropped connection left the handler running: every later res.write()
    // buffers against a dead socket while the AI and Google work carries on
    // to nobody. Writes become no-ops the moment the client goes away, and
    // `req.clientGone` lets the body skip work it no longer needs to do.
    req.clientGone = false;
    const _markGone = () => { req.clientGone = true; };
    req.on('close', _markGone);
    req.on('error', _markGone);
    if (req.socket) { req.socket.on('close', _markGone); req.socket.on('error', _markGone); }
    const _origWrite = res.write.bind(res);
    res.write = (...args) => (req.clientGone ? true : _origWrite(...args));

    let messages = '';
    quickActionCallCount++;
    const thisCallNumber = quickActionCallCount;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    // console.log(`\n🎯 QUICK ACTION CALL #${thisCallNumber} - ${requestId}`);
    // console.log(`📊 Previous Google API stats:`, googleService.getGlobalStats());
    // console.log(`\n========= [${requestId}] QUICK ACTION STREAM START =========\n`);
    const isClientDisconnected = setupConnectionMonitoring(req, res, () => {
        // console.log('🛑 Client disconnected from quick action stream')
    });
    const uniquePlaces = new Set();
    try { 
        const { action, location, count = 5, excludeNames = [], excludePlaceIds = [], nearbyMode = false, subType = null, actionType = null, viewMoreCount = 0 } = req.body;
        // Tap-tiering for economization. The FIRST request for an action (the
        // initial tap, not a "View More") is the only one allowed to use web
        // search — it seeds PlaceCache with fresh, real, photographed places that
        // every subsequent refill (and every other user) then draws from. View
        // More taps (viewMoreCount ≥ 1) prefer the cache and only fall back to the
        // model for any shortfall, and never pay for web search again.
        const isFirstTap = actionType !== 'view_more' && (viewMoreCount || 0) === 0;
        const isRefillTap = !isFirstTap;
        if (isClientDisconnected()) {return}
        const userId = req.user.id;
        let user;
        try { user = await User.findById(userId).select('preferences settings') } 
        catch (error) {
            console.error('Failed to fetch user:', error);
            return res.status(500).json({ success: false, error: 'user_fetch_failed', message: messages.user_fetch_failed });
        }
        let userLanguage = user?.settings?.language || 'en';
        messages = getAllMessages(userLanguage);   
        let effectiveLocation = await resolveEffectiveLocation(user, location, messages);
        if (effectiveLocation && effectiveLocation.error === 'location_required') {
            console.log('❌ LOCATION VALIDATION FAILED - No valid coordinates');
            console.log(`   Reason: ${effectiveLocation.message}`);
            return res.status(400).json({
                success: false,
                error: 'location_required',
                message: messages.location_required,
                userMessage: messages.location_set_destination,
                action: 'configure_location',
                suggestions: [messages.location_suggestion_1, messages.location_suggestion_2]
            });
        }
        if (!effectiveLocation) {
            console.log('❌ LOCATION VALIDATION FAILED - effectiveLocation is null');
            return res.status(400).json({
                success: false,
                error: 'location_required',
                message: messages.location_required,
                userMessage: messages.location_set_destination,
                action: 'configure_location',
                suggestions: [messages.location_suggestion_1, messages.location_suggestion_2]
            });
        }
        // console.log('\n📊 USAGE TRACKING - INITIAL STATE:');
        // if (req.userLimit) {
        //     const initialStatus = await req.userLimit.getUsageStatus();
        //     console.log(`   Daily Tokens: ${initialStatus.daily.tokens.used}/${initialStatus.daily.tokens.limit}`);
        //     console.log(`   Daily Places: ${initialStatus.daily.places.viewed}/${initialStatus.daily.places.limit}`);
        //     console.log(`   Is Premium: ${initialStatus.isPremium}`);
        // }
        let estimatedTokens = 0;
        try {
            const userLimit = req.userLimit;
            if (userLimit) {
                const actionText = action || 'general';
                estimatedTokens = estimateTokens(actionText) + 500; 
                // console.log(`\n🔍 TOKEN USAGE CHECK:`);
                // console.log(`   Estimated tokens: ${estimatedTokens}`);
                const usageStatus = await userLimit.checkAndUpdateUsage(estimatedTokens, 0, 1); 
                // console.log(`\n✅ TOKEN CHECK PASSED:`);
                // console.log(`   Tokens remaining: ${usageStatus.dailyTokensRemaining}`);
                // console.log(`   Places remaining: ${usageStatus.dailyPlacesRemaining}`);              
                res.set('X-Usage-Tokens-Used', usageStatus.dailyTokensUsed?.toString() || '0');
                res.set('X-Usage-Tokens-Remaining', usageStatus.dailyTokensRemaining?.toString() || '10000');
                res.set('X-Usage-Places-Viewed', usageStatus.dailyPlacesViewed?.toString() || '0');
                res.set('X-Usage-Places-Remaining', usageStatus.dailyPlacesRemaining?.toString() || '50');
                if (usageStatus.onCooldown) {
                    console.log(`⏸️ User on cooldown until ${usageStatus.cooldownUntil}`);
                    return res.status(429).json({type: 'cooldown', message: messages.cooldown_simple, cooldownUntil: usageStatus.cooldownUntil, reason: 'daily_limit_exceeded'});
                }
            }
        } catch (limitError) {
            console.log(`🚫 Usage limit exceeded: ${limitError.message}`);
            return res.status(429).json({ type: 'cooldown', message: limitError.message, cooldownUntil: req.userLimit?.cooldownUntil });
        }
        if (!process.env.OPENAI_MODEL && !process.env.GOOGLE_API_KEY) {
            console.error('Missing required environment variables');
            return res.status(500).json({ error: 'Server configuration error', message: messages.api_credentials_missing });
        }
        // console.log('Request parameters:', { action, locationCoords: location ? `${location.lat},${location.lng}` : 'none', count, excludeNames: excludeNames.length, excludePlaceIds: excludePlaceIds.length, nearbyMode, userId });
        let preferences = {};
        let shouldFilterBudget = false;
        try {
            if (isClientDisconnected()) return;
            user = await User.findById(userId).select('preferences settings');
            preferences = user?.preferences || {};
            userLanguage = user?.settings?.language || 'en'; 
            shouldFilterBudget = preferences.budget?.min && preferences.budget?.max && !(preferences.budget.min === 0 && preferences.budget.max === 0);

            effectiveLocation = await resolveEffectiveLocation(user, location, messages);
            // console.log('\n🎯 EFFECTIVE LOCATION:', effectiveLocation);
            if (!effectiveLocation) {
                console.log('❌ Quick action requires location but none available');
                return res.status(400).json({success: false, error: 'location_required', message: messages.location_required_details, action: 'configure_location'});
            }
            // console.log('User preferences loaded:', { interests: preferences.interests || [], budget: preferences.budget || 'none', travelStyle: preferences.travelStyle || 'solo', shouldFilterBudget: shouldFilterBudget });
        } catch (userError) {
            console.error('Failed to fetch user:', userError.message);
            preferences = {};
            shouldFilterBudget = false;
        }
        const maxCount = getMaxCount(action);
        const requestedCount = Math.min(Math.max(count, 3), maxCount);
        // console.log('Count calculation:', { requested: count, max: maxCount, final: requestedCount });
        res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8','Cache-Control': 'no-cache','Connection': 'keep-alive','Access-Control-Allow-Origin': '*','Access-Control-Allow-Headers': 'Cache-Control, Authorization, Content-Type','Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining'});
        let responseText;
        // True once we know the model returned a usable list of place NAMES (bracketed
        // or salvaged from a comma list), as opposed to genuine prose. Set inside the
        // AI block below (where bracketedNames is in scope) and read later when
        // deciding what text to stream above the cards.
        let recommendations = [];
                    // Hoisted here (was defined lower, inside the if(aiPrompt)
                    // block) so the cache-first refill path above can also build
                    // recommendations from cache docs. Pure builder — closes only
                    // over action/userLanguage/subType, all set before this point.
                    function createRecommendation(candidate, index, enrichedData, distanceInfo = null) {
                        const cleanName = candidate.name;
                        const isFromCache = enrichedData?._fromCache || false;
                        // console.log(`\n🏨 Creating recommendation for: ${cleanName}`);
                        // console.log(`   Source: ${candidate.source}`);
                        let imageUrl = null;
                        if (enrichedData?.photos?.[0]) {
                            const firstPhoto = enrichedData.photos[0];
                            // 1. If we have a place_id, always use the stored image endpoint —
                            //    photos may be raw Google objects (no .imageData) even though
                            //    downloadAndStoreImages already saved them to MongoDB.
                            if (enrichedData.place_id) {
                                imageUrl = `/api/ai/place-image/${enrichedData.place_id}/0`;
                                // console.log(`   ✅ Using stored image from database`);
                            }
                            // 2. String URL — handles both https:// (DB images) and /api/ (cached images)
                            else if (typeof firstPhoto === 'string' && firstPhoto.length > 0) {
                                imageUrl = firstPhoto;
                                // console.log(`   ✅ Using string URL: ${imageUrl}`);
                            }
                            // 3. Object with a url property — handles both https:// and /api/
                            else if (firstPhoto.url && typeof firstPhoto.url === 'string') {
                                imageUrl = firstPhoto.url;
                                // console.log(`   ✅ Using object URL: ${imageUrl}`);
                            }
                            // 4. No usable URL found
                            else {
                                // console.log(`   ⚠️ No valid image URL available`);
                                imageUrl = null;
                            }
                        } else {
                            // console.log(`   No photos in enrichedData`);
                        }
                        const address = enrichedData?.formatted_address || enrichedData?.vicinity || (candidate.source === 'database' && candidate.data?.location?.address) || 'Address not available';
                        // Event-specific fields. Only database businesses carry an
                        // eventSchedule; AI/Google-fallback candidates have none.
                        // Mirrors the rule in formatBusinessDetails so the rec card
                        // can show the date/time row and an "Ended" badge without
                        // re-implementing the logic client-side.
                        const dbData = candidate.source === 'database' ? candidate.data : null;
                        const eventSchedule = dbData?.eventSchedule || null;
                        let _isExpired = false;
                        if (eventSchedule
                            && Array.isArray(dbData?.type) && dbData.type.includes('events')
                            && !eventSchedule.isRecurring) {
                            const end = eventSchedule.endDate || eventSchedule.startDate;
                            if (end) _isExpired = new Date(end).getTime() < Date.now();
                        }
                        let distanceText = 'Distance unavailable';
                        let distanceKm = null;
                        let durationText = null;
                        if (distanceInfo) {
                            distanceText = distanceInfo.distance;
                            distanceKm = distanceInfo.distanceKm;
                            durationText = distanceInfo.duration;
                            // console.log(`   Distance: ${distanceText} (${durationText})`);
                        }
                        return {
                            id: candidate.source === 'database' ? `db-${candidate.data?._id || Date.now()}-${index}` : `${candidate.source}-${Date.now()}-${index}`,
                            name: (enrichedData && enrichedData.name) ? enrichedData.name : cleanName,
                            category: getCategoryFromAction(action, userLanguage, subType),
                            description: candidate.source === 'database' ? (candidate.data?.description?.short || candidate.data?.description?.detailed || cleanName) : (enrichedData?.description || cleanName),
                            region: enrichedData?.vicinity || enrichedData?.formatted_address || 'Unknown region',
                            location: address,
                            image: imageUrl,
                            distance: distanceText,
                            distanceKm: distanceKm,
                            duration: durationText,
                            placeId: enrichedData?.place_id || null,
                            // ── coords for the recommendation map ──
                            // Google-enriched candidates carry geometry; DB
                            // candidates carry location.coordinates on .data.
                            latitude:  enrichedData?.geometry?.location?.lat ?? candidate.data?.location?.coordinates?.lat ?? null,
                            longitude: enrichedData?.geometry?.location?.lng ?? candidate.data?.location?.coordinates?.lng ?? null,
                            // contact for the map popup
                            website: enrichedData?.website || candidate.data?.contact?.website || null,
                            phone:   enrichedData?.formatted_phone_number || enrichedData?.international_phone_number || candidate.data?.contact?.phone || null,
                            source: candidate.source,
                            // Real Google types of the resolved place (empty for DB rows,
                            // which are already type-correct by construction). Consumed by
                            // the type sanity filter below; not sent to the client.
                            placeTypes: candidate.source === 'database' ? [] : (enrichedData?.types || []),
                            placePrimaryType: candidate.source === 'database' ? null : (enrichedData?.primaryType || null),
                            requestedName: candidate.source === 'database' ? null : (enrichedData?.requestedName || null),
                            verifiedId: candidate.source === 'database' ? candidate.data?._id?.toString() : null,
                            isPartner: candidate.source === 'database' ? (candidate.data?.partnership?.isPartner || false) : false,
                            partnerTier: candidate.source === 'database' ? (candidate.data?.partnership?.tier || null) : null,
                            _verifiedModel: candidate.source === 'database' ? (candidate.data?.partnership !== undefined ? 'business' : 'destination') : null,
                            _fromCache: isFromCache,
                            // Raw quick-action this rec was produced under ('events',
                            // 'historical', …). Internal — stripped before send. Echoed
                            // back by the client on feedback so a dislike can be scoped
                            // to THIS action (a museum disliked as an 'event' must not
                            // vanish from 'historical'). Distinct from `category`, which
                            // is a localized display label.
                            _action: action,
                            // Event-specific. null for non-events / non-DB candidates.
                            // JinniChat's isEventRec() guards the rec card date row
                            // and the info-modal Event Schedule row on these.
                            eventSchedule: eventSchedule,
                            _isExpired: _isExpired,
                            metadata: {
                                hasImages: !!imageUrl,
                                cacheStatus: isFromCache ? 'hit' : 'miss',
                                imageSource: imageUrl ? 'database' : 'none'
                            },
                            ...(candidate.source === 'database' && candidate.data && {
                                pricing: candidate.data.pricing?.range,
                                contact: candidate.data.contact,
                                highlights: candidate.data.description?.highlights
                            })
                        };
                    };
        try {
            let searchContext = 'Global destinations';
            let userRegion = null;
            if (effectiveLocation) {
                try {
                    userRegion = await googleService.detectUserRegion(effectiveLocation, requestId);
                    searchContext = getSearchContext(effectiveLocation, userRegion);
                } catch (error) {
                    console.error('Failed to detect user region:', error.message);
                    searchContext = 'Global destinations';
                }
            } else { console.log('No location provided, using global search') }
            // console.log('\nFetching nearby businesses and destinations...');
            let nearbyBusinesses = [];
            let nearbyDestinations = [];
            if (isClientDisconnected()) return;
            const userRadius = effectiveLocation ? (nearbyMode ? effectiveLocation.nearbyRadius : effectiveLocation.discoveryRadius) : (nearbyMode ? 5 : 50);
            // console.log(`📏 Using radius: ${userRadius}km (${nearbyMode ? 'nearby' : 'discovery'} mode)`);
            const smartProximityResults = await proximityService.findSmartProximityPlaces(effectiveLocation, preferences, action, userRadius, requestedCount, userRegion, requestId, subType);
            nearbyBusinesses = smartProximityResults.businesses;
            nearbyDestinations = smartProximityResults.destinations;
            /* ── Curated destinations are NOT filtered by schedule ────────────────
             * These were filed under 'events' by a validator on purpose: paragliding,
             * wakeboarding, zip lines and horse riding run almost every day, so from a
             * traveler's side they ARE things happening — they just have no single
             * date to print. A schedule filter here was removing deliberate human
             * classification, which is the opposite of the rule the rest of this
             * pipeline follows (a validator's decision beats an inferred one).
             *
             * The undated-venue problem this briefly "fixed" had a different source:
             * PlaceCache entries tagged 'events' automatically because a venue was
             * once shown under an event. That inference is gone (see the tagger and
             * findCachedBackfill), which is the correct place to solve it.
             */
            // ── Google candidate prefetch (flag-gated, per-action) ──────────────
            // One Text Search → a shortlist of REAL places the model ranks/filters,
            // instead of recalling local names. Kept names carry a real placeId so
            // enrichment skips the per-name findPlaces call. Cached by area+radius.
            // Any failure leaves googleCandidates = [] and the path is unchanged.
            let googleCandidates = [];
            // How prefetch candidates are used downstream: 'suggest' injects unmatched
            // candidates as recommendations; 'resolve' uses them only as a name→placeId
            // index (skips findPlaces) without suggesting. Set from config below.
            let prefetchMode = 'suggest';
            try {
                const pcfg = await AppConfig.getConfig();
                // Layer = which tap this is. 1 = first tap; 2–4 = View More refills.
                // googlePrefetchLayers picks which layers draw from Google; because the
                // result set is area-cached, enabling 2,3,4 costs the same one Text
                // Search as enabling just 2 (later taps page the cached pool). Empty = all.
                const currentLayer = (viewMoreCount || 0) + 1;
                const layerOn = !pcfg.googlePrefetchLayers?.length || pcfg.googlePrefetchLayers.includes(currentLayer);
                const prefetchOn = pcfg.googlePrefetch && layerOn &&
                    (!pcfg.googlePrefetchActions?.length || pcfg.googlePrefetchActions.includes(action));
                if (prefetchOn && effectiveLocation) {
                    prefetchMode = pcfg.googlePrefetchMode === 'resolve' ? 'resolve' : 'suggest';
                    googleCandidates = await googlePrefetch.getCandidates({
                        action, subType,
                        location: effectiveLocation,
                        radiusKm: userRadius,
                        limit: pcfg.googlePrefetchCount || 12,
                        excludePlaceIds,   // View More: skip already-shown places in the shortlist
                        ttlMin: pcfg.googlePrefetchTtlMin || 1440,
                        requestId,
                    });
                    console.log(`[quick-action] google prefetch (layer ${currentLayer}, mode=${prefetchMode}): ${googleCandidates.length} candidate(s) for action=${action}`);
                }
            } catch (prefetchErr) {
                console.warn('[quick-action] google prefetch failed:', prefetchErr.message);
                googleCandidates = [];
            }
            // ── Tap-tiering: cache-first on refill taps (View More) ─────────────
            // On taps 2–4 we prefer the PlaceCache that the first tap (model + web
            // search) seeded. We build straight from cache here, BEFORE the model:
            // personalized (this user's dislikes excluded), already-seen excluded,
            // community-ranked. If cache completes the grid we skip the model and
            // the web search entirely. If the cache is thin (cold city / fresh
            // action) we fall through to the model, which on refills runs WITHOUT
            // web search (gated above) and tops up the rest.
            let skipModel = false;
            if (isRefillTap && effectiveLocation && recommendations.length < requestedCount) {
                try {
                    // Personalize: never refill with places THIS user disliked.
                    let earlyDislikedIds = new Set();
                    try {
                        const rows = await PlaceFeedback.find({ userId, action, vote: 'dislike' }).select('placeId').lean();
                        earlyDislikedIds = new Set(rows.map(r => r.placeId));
                    } catch (pfErr) { console.warn('[quick-action] refill dislike-set load failed:', pfErr.message); }
                    const haveNames = new Set(recommendations.map(r => (r.name || '').toLowerCase().trim()));
                    const havePlaceIds = recommendations.map(r => r.placeId).filter(Boolean);
                    const cacheSpares = await findCachedBackfill({
                        center: { lat: effectiveLocation.lat, lng: effectiveLocation.lng },
                        radiusKm: userRadius || (nearbyMode ? 5 : 50),
                        action, subType, preferences,
                        excludePlaceIds: [...havePlaceIds, ...(excludePlaceIds || []), ...earlyDislikedIds],
                        excludeNames: [...haveNames, ...(excludeNames || [])],
                        limit: requestedCount - recommendations.length
                    });
                    let cacheAdded = 0;
                    const servedIds = [];
                    for (const { doc, distanceKm } of cacheSpares) {
                        if (recommendations.length >= requestedCount) break;
                        const nm = (doc.name || '').toLowerCase().trim();
                        if (haveNames.has(nm)) continue;
                        const candidate = { name: doc.name, source: 'cache', data: null };
                        const enrichedData = {
                            name: doc.name,
                            source: 'cache',
                            photos: (doc.photos && doc.photos.length) ? doc.photos.slice(0, 1) : [],
                            place_id: doc.placeId,
                            formatted_address: doc.details?.formatted_address || '',
                            geometry: doc.details?.geometry || null,
                            types: doc.types || [],
                            primaryType: doc.primaryType || null,
                            _fromCache: true
                        };
                        const distanceInfo = { distance: `${distanceKm.toFixed(1)} km`, distanceKm, duration: null };
                        recommendations.push(createRecommendation(candidate, recommendations.length, enrichedData, distanceInfo));
                        haveNames.add(nm);
                        if (doc.placeId) servedIds.push(doc.placeId);
                        cacheAdded++;
                    }
                    if (servedIds.length) {
                        PlaceCache.updateMany({ placeId: { $in: servedIds } }, { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } })
                            .catch(err => console.warn('[quick-action] refill cache useCount bump failed:', err.message));
                    }
                    if (recommendations.length >= requestedCount) {
                        skipModel = true;
                        responseText = '';
                        // The model path runs separateAndShuffleBySource inside its
                        // block; mirror that here so a cache-only refill is ordered
                        // the same way (these are all source:'cache', so this mainly
                        // normalizes ordering and is harmless if it's a no-op).
                        recommendations = separateAndShuffleBySource(recommendations);
                        console.log(`[quick-action] tap ${viewMoreCount}: served ${recommendations.length}/${requestedCount} from cache — model SKIPPED, search SKIPPED`);
                    } else {
                        console.log(`[quick-action] tap ${viewMoreCount}: cache gave ${cacheAdded} (have ${recommendations.length}/${requestedCount}) — model fills rest WITHOUT search`);
                    }
                } catch (earlyCacheErr) { console.warn('[quick-action] refill cache-first fill failed:', earlyCacheErr.message); }
            }
            // ── Cache curation (flag-gated): show the model what we already have ──
            // On the FIRST tap (the one call that runs WITH web search) hand the
            // model a capped, ranked slice of the places we ALREADY hold for this
            // action+area and ask it (in the prompt) to suggest strong places BEYOND
            // them. Output then COMPLEMENTS the cache instead of regenerating the same
            // local "top N", so each grid carries more variety and the cache widens.
            // Web search verifies any novel name, so nothing unverifiable slips in.
            // Skipped on refills, when prefetch already supplied a shortlist, or when
            // the flag is off → behaviour unchanged.
            let knownCachedNames = [];
            if (!skipModel && !isRefillTap && effectiveLocation && !googleCandidates.length) {
                try {
                    const ccfg = await AppConfig.getConfig();
                    const curationOn = ccfg.cacheCuration &&
                        (!ccfg.cacheCurationActions?.length || ccfg.cacheCurationActions.includes(action));
                    if (curationOn) {
                        const haveNames = new Set(recommendations.map(r => (r.name || '').toLowerCase().trim()));
                        const known = await findCachedBackfill({
                            center: { lat: effectiveLocation.lat, lng: effectiveLocation.lng },
                            radiusKm: userRadius || (nearbyMode ? 5 : 50),
                            action, subType, preferences,
                            excludePlaceIds: excludePlaceIds || [],
                            excludeNames: [...haveNames, ...(excludeNames || [])],
                            limit: ccfg.cacheCurationCount || 15
                        });
                        // One line per place with its performance data, not just the
                        // name — the model can then skip what travelers received badly
                        // and aim past what already works. See describeKnownPlace.
                        knownCachedNames = known.filter(k => k.doc && k.doc.name).map(k => describeKnownPlace(k.doc, k.distanceKm));
                        if (knownCachedNames.length) console.log(`[quick-action] cache curation: showing model ${knownCachedNames.length} known place(s) with feedback data, asking for new ones (action=${action})`);
                    }
                } catch (curErr) { console.warn('[quick-action] cache curation fetch failed:', curErr.message); knownCachedNames = []; }
            }
            let aiPrompt = '';
            if (!skipModel && (action === 'hidden_gems' || action === 'restaurants' || action === 'historical' || action === 'hotels' || action === 'events' || action === 'photo_spots' || action === 'shopping')) { 
                aiPrompt = generateTargetedPrompt(action, searchContext, preferences, requestedCount, excludeNames, subType, googleCandidates, knownCachedNames);
                // console.log('\n🤖 AI PROMPT BEING SENT:\n', aiPrompt, '\n');
            } 
            else if (!skipModel) {
                console.log(`Unknown action: ${action}`);
                responseText = "I'd be happy to help you with that! Could you tell me more about what you're looking for?";
            }
            if (aiPrompt) {
                const maxTokens = calculateTokenLimit(requestedCount, action);
                try {
                    // ── Provider selection (DeepSeek default, Claude if toggled) ──
                    const cfg = await AppConfig.getConfig();
                    let qaSearchCount = 0;
                    // Real token usage as REPORTED BY THE PROVIDER, when available.
                    // The estimate below counts only the prompt we wrote — it cannot see
                    // the web-search results Anthropic injects into the context, which is
                    // where the tokens on a search-enabled tap actually go. Measured on a
                    // live tap: 18,052 real input tokens vs ~600 estimated. Null for
                    // providers that report nothing; the estimate is then used unchanged.
                    let qaRealTokens = null;
                    if (cfg.aiProviderQuickAction === 'claude') {
                        /* ── Events may search on refills; nothing else may ───────────────
                         * "View More" normally runs WITHOUT web search: restaurants, hotels
                         * and historical sites live in the place cache, so a refill is just
                         * more of what we already hold. Events are the exception — they do
                         * not exist in any cache until someone looks them up, and with the
                         * cache padding gone (rightly: it was serving venues as events) a
                         * searchless refill returns nothing at all. The model does not
                         * invent, so it answers in prose: "I don't have verified real-time
                         * event data…", and View More comes back empty.
                         *
                         * So for events only, a refill is allowed one search. Every other
                         * action keeps the cheap cache-first refill it had.
                         */
                        /* ── …UNLESS a ticketing feed can refill instead ──────────────
                         * The exemption above is what made events the most expensive
                         * action in the app: a search on every tap, ~$0.05–0.07 each,
                         * per user, forever. It existed only because a searchless refill
                         * came back empty — which is a statement about having no other
                         * source, not about needing a search.
                         *
                         * There is now another source. When a feed covers this country it
                         * supplies real, dated, in-country events for one cached HTTP GET
                         * shared by every user, so the refill has something to serve and
                         * the search is redundant. The FIRST tap still searches: the feed
                         * is one ticketing site, not the whole world, and discovery of
                         * everything outside it still has to come from somewhere.
                         *
                         * Reversible in seconds: drop 'events' back into the condition, or
                         * remove the source from EVENT_FEED_SOURCES. */
                        let feedForRefill = [];
                        if (action === 'events' && !isFirstTap) {
                            try { feedForRefill = await getEventFeedsForLocation(userRegion, effectiveLocation, req.body?.destinationInfo); }
                            catch { feedForRefill = []; }
                        }
                        const feedCanRefill = feedForRefill.length > 0;
                        /* Which sites this search may read. Manual list if set,
                         * otherwise the verified per-country discovery — so the
                         * search is constrained everywhere, not just where a
                         * human happened to type an allowlist. */
                        /* EVENTS ONLY. These domains are ticket sellers and event
                         * calendars, discovered by asking "who lists events here?".
                         * Applied to every action they became a cage: a photo_spots
                         * tap was restricted to tkt.ge/gnta.ge/tickets.ge, and the
                         * model said so itself — "the search results from TKT.GE
                         * did not render specific dated event listings" — while
                         * being asked about photogenic places. Other actions get an
                         * unrestricted search, exactly as before. */
                        const qaSearchDomains = action === 'events'
                            ? await resolveSearchDomains(cfg, userRegion)
                            : (Array.isArray(cfg.claudeWebSearchAllowedDomains) ? cfg.claudeWebSearchAllowedDomains : []);
                        if (qaSearchDomains.length) console.log(`[search] ${action}: restricted to ${qaSearchDomains.length} domain(s): ${qaSearchDomains.join(', ')}`);
                        const claudeWebSearch = (isFirstTap || (action === 'events' && !feedCanRefill)) && cfg.claudeWebSearch &&
                            (Array.isArray(cfg.claudeWebSearchActions) && cfg.claudeWebSearchActions.includes(action));
                        if (action === 'events' && !isFirstTap) {
                            console.log(`[quick-action] events refill: web search ${claudeWebSearch ? 'ON' : `OFF — ${feedForRefill.length} feed event(s) can refill instead (saves ~1 search + ~18k tokens)`}`);
                        }
                        // Claude (esp. Haiku) treats the bracketed-list instruction as a
                        // user request it can negotiate — it will sometimes refuse, add a
                        // preamble, or switch to markdown/headings, which yields ZERO
                        // bracketed names and breaks enrichment. A system prompt is followed
                        // far more reliably, so we pin the output contract here. DeepSeek is
                        // untouched (separate branch below).
                        let qaSystem = `You recommend real places for a travel app. Output ONLY place names, each wrapped in square brackets and comma-separated, like: [Name One], [Name Two], [Name Three]. Output nothing else — no introduction, no explanation, no caveats, no apologies, no markdown, no headings, no numbering. Never refuse and never write sentences. Only suggest real establishments that actually exist in or very near ${searchContext}; do NOT invent names and do NOT use a famous brand name unless that brand truly has a branch there. It is better to return fewer real, verifiable local places than to pad the list with guesses. Return as many real matches as you can, in the exact bracket format.`;
                        if (claudeWebSearch) {
                            // With the search tool attached, Haiku tends to "think out loud"
                            // (preamble + reasoning), which breaks the bracket contract and
                            // floods enrichment with prose fragments. Reinforce that the FINAL
                            // message must be ONLY the bracketed items in exactly the format the
                            // user's message specifies (which, for events, includes ISO dates).
                            qaSystem += ` You may use web search to find current, real, currently-open places and upcoming events near ${searchContext}. After searching, do NOT narrate or summarize your research and do NOT explain — your ENTIRE final message must be ONLY the bracketed items, in exactly the format requested in the user's message, with nothing before or after.`;
                        }
                        const claudeResult = await claudeService.complete({
                            system: qaSystem,
                            messages: [ { role: "user", content: aiPrompt } ],
                            model: cfg.claudeModel,
                            maxTokens: maxTokens,
                            temperature: 0.3,
                            webSearch: claudeWebSearch,
                            webSearchMaxUses: cfg.claudeWebSearchMaxUses,
                            // Never sent before: the search ran unrestricted, so the model read
                            // whatever ranked — a travel blog over the ticket seller's own page.
                            allowedDomains: qaSearchDomains,
                            blockedDomains: cfg.claudeWebSearchBlockedDomains,
                            cacheSystem: true,   // now effective — there is a system string to cache
                        });
                        responseText = claudeResult.text;
                        qaSearchCount = claudeResult.searchCount || 0;
                        if (claudeResult.usage) {
                            // input+output alone omits cached input, which is most of it
                            // once the system prompt is cache_control'd — see
                            // claudeService.billableTokens().
                            qaRealTokens = claudeService.billableTokens(claudeResult.usage);
                        }
                        console.log(`[provider] quick-action=claude model=${cfg.claudeModel} searches=${claudeResult.searchCount} tokens=${qaRealTokens ?? '?'} (in=${claudeResult.usage?.input_tokens || 0} out=${claudeResult.usage?.output_tokens || 0} cacheRead=${claudeResult.usage?.cache_read_input_tokens || 0} cacheWrite=${claudeResult.usage?.cache_creation_input_tokens || 0})`);
                        /* ── Which sites this answer actually came from ───────────────
                         * Always on, one line. The result URLs already arrive inside the
                         * response we paid for, but nothing ever printed them outside
                         * AI_TRACE — so "where did this date come from?" was unanswerable
                         * from a normal log, and a homeexchange.com blog post supplying a
                         * concert date went unnoticed until the card looked wrong.
                         * Domains only: enough to judge the sources at a glance, and it
                         * shows immediately whether the allow/block lists are biting. */
                        if (claudeResult.searches?.length) {
                            const domains = [...new Set(
                                claudeResult.searches
                                    .flatMap(s => (s.results || []).map(r => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return null; } }))
                                    .filter(Boolean)
                            )];
                            console.log(`[search] read ${domains.length} domain(s): ${domains.join(', ') || 'none'}`);
                        }
                        /* ── Trace: what it searched, what it read, what it said ──────
                         * Off unless AI_TRACE=1. Diagnosing a wrong card previously meant
                         * inferring the model's answer from the Google lookups it caused;
                         * these three lines show it directly. No extra API cost — the
                         * queries and result URLs already arrive in the response.
                         */
                        if (process.env.AI_TRACE === '1') {
                            for (const s of (claudeResult.searches || [])) {
                                const urls = (s.results || []).slice(0, 6).map(r => r.url).filter(Boolean);
                                console.log(`[trace] search ${JSON.stringify(s.query)} → ${(s.results || []).length} result(s)${urls.length ? ':\n  ' + urls.join('\n  ') : ''}`);
                            }
                            console.log(`[trace] model answer (${action}):\n${String(responseText || '').trim().slice(0, 1500)}`);
                        }
                        // claudeResult.searchCount available here for per-request billing logging
                    } else {
                        const completion = await openai.chat.completions.create({
                            model: process.env.OPENAI_MODEL || "deepseek-v4-pro",
                            messages: [ { role: "user", content: aiPrompt } ],
                            temperature: 0.3,
                            max_tokens: maxTokens,
                            frequency_penalty: 0.1,
                            presence_penalty: 0.1
                        });
                        responseText = completion.choices[0].message.content;
                        console.log('[provider] quick-action=deepseek');
                    }
                    // Per-provider daily usage (parallel to existing stats)
                    const qaTokens = qaRealTokens != null
                        ? qaRealTokens
                        : Math.ceil(((aiPrompt?.length || 0) + (responseText?.length || 0)) / 4);
                    AiProviderDailyStats.track(cfg.aiProviderQuickAction, { tokens: qaTokens, queries: 1, searches: qaSearchCount, endpoint: 'quick_action' }).catch(err => console.error('AiProviderDailyStats error:', err));
                    // console.log('\nAI response received:', responseText);
                    let bracketedNames = extractBracketedNames(responseText);
                    // For the events action, each bracket may carry ISO dates
                    // ("Name | START | END"). Parsed below (after salvage) into this map
                    // keyed by clean lower-cased name, and consumed at card-assembly time.
                    const eventDateByName = new Map();
                    if (bracketedNames.length === 0 && responseText) {
                        // Providers (DeepSeek included) intermittently ignore the
                        // "[Name], [Name]" contract and return a plain comma/newline
                        // list instead. The previous code threw all of those names away
                        // and fell back to DB-only — which is why a Hotels/Historical
                        // search could collapse to a single stray destination even though
                        // the model named 6-7 real places.
                        //
                        // We salvage the list, but CONSERVATIVELY, so a refusal or a
                        // paragraph is NOT turned into junk "names" (the original concern
                        // that motivated removing the old splitter):
                        //   • split on newlines / commas / semicolons / colons
                        //   • strip numbering, bullets, surrounding quotes, trailing dots
                        //   • keep only Capitalized, reasonably short fragments — that is
                        //     what a real place name looks like. This also drops a
                        //     comma-split tail like "a Luxury Collection Hotel" (lowercase
                        //     start → belongs to the preceding name) and filler such as
                        //     "Here are 7 hotels".
                        //   • only trust the result if it yields >= 2 plausible names;
                        //     otherwise behave exactly as before (DB candidates only).
                        // FIRST: decide whether this is even a list. In search mode
                        // especially, the model often abandons the bracket contract and
                        // writes a REASONING PARAGRAPH ("Based on my research… Additionally…
                        // However, many of these are festivals rather than venues…").
                        // Splitting that on commas yields junk "names" like "However" /
                        // "Santa Fe)" / "To provide you with accurate" that we then waste
                        // Google calls on. If the text reads like prose, don't salvage.
                        const _PROSE_MARKERS = /\b(based on|my research|search results?|i apologize|i could ?n'?t|i can ?not|i can'?t|i found|i recommend|i'?d recommend|i'?d be happy|let me|to provide you|please note|i should note|unfortunately|however|additionally|furthermore|moreover|that said|rather than|not typically|would be suitable|meet your|specific criteria|keep in mind|it'?s worth|the following|as an ai)\b/i;
                        if (_PROSE_MARKERS.test(responseText || '')) {
                            console.warn('[quick-action] unbracketed output looks like prose; skipping salvage. Raw start:', (responseText || '').slice(0, 160));
                            bracketedNames = [];
                        } else {
                        const salvaged = responseText
                            .split(/[\n,;:]+/)
                            .map(s => s.trim()
                                .replace(/^\d+[\.\)]\s*/, '')              // "1. " / "1) "
                                .replace(/^[-•*]\s*/, '')                   // bullets
                                .replace(/^["'“”\[]+|["'“”\]]+$/g, '')      // surrounding quotes/brackets
                                .replace(/\.+$/, '')                        // trailing period(s)
                                .trim())
                            .filter(s =>
                                s.length >= 3 && s.length <= 60 &&
                                /^[\p{Lu}0-9]/u.test(s) &&                  // starts capital or digit
                                /\p{L}/u.test(s) &&                         // contains a letter (drops "2026")
                                (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length && // balanced parens (drops "Santa Fe)")
                                !_PROSE_MARKERS.test(s) &&                  // fragment-level prose guard
                                !/\b(here are|i recommend|i'd recommend|sure|certainly|of course|happy to|suggestion|option|following|below|as a|note that|unfortunately|i (?:cannot|can't))\b/i.test(s)
                            )
                            .slice(0, requestedCount);
                        if (salvaged.length >= 2) {
                            bracketedNames = salvaged.map(name => ({ name, placeId: null }));
                            console.log(`[quick-action] salvaged ${bracketedNames.length} name(s) from unbracketed model output`);
                        } else {
                            console.warn('[quick-action] no bracketed names and salvage unsafe; using DB candidates only. Raw start:', (responseText || '').slice(0, 200));
                            bracketedNames = [];
                        }
                        }
                    }
                    // bracketedNames is now final (proper, salvaged, or empty).
                    // Events: split "Name | START | END" → record the dates and reduce
                    // the candidate name to just the clean event/place name, so Google
                    // resolution and downstream matching use the name alone.
                    if (action === 'events' && bracketedNames.length) {
                        const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
                        bracketedNames = bracketedNames.map(b => {
                            const parts = String(b.name).split('|').map(s => s.trim());
                            const cleanName = parts[0];
                            const start = parts[1] && ISO_DATE.test(parts[1]) ? parts[1] : null;
                            const end = parts[2] && ISO_DATE.test(parts[2]) ? parts[2] : null;
                            // Fields 4 and 5 (venue / address) are new and optional — an
                            // older or sloppier reply that stops after the dates still
                            // parses exactly as before, it just resolves no venue.
                            const venue = parts[3] || null;
                            const address = parts[4] || null;
                            /* SOURCE_URL — the page the model says it read. Two of three
                             * events in a live test carried WRONG dates from recall (a
                             * feast a day early, a concert three weeks early), so the
                             * card must be able to show where a claim came from. Accepted
                             * only as a plain http(s) URL; anything else is dropped rather
                             * than shown, since a fabricated link is worse than none. */
                            let sourceUrl = null;
                            if (parts[5] && /^https?:\/\/[^\s"'<>]+$/i.test(parts[5])) sourceUrl = parts[5];
                            if (cleanName && (start || venue || address || sourceUrl)) {
                                eventDateByName.set(cleanName.toLowerCase().trim(), { start, end, venue, address, sourceUrl });
                            }
                            return { ...b, name: cleanName };
                        }).filter(b => b.name && b.name.length > 0);
                    }
                    // console.log('\nStarting enrichment (Database + AI suggestions)... ');
                    const databaseCandidates = [];
                    nearbyBusinesses.forEach(business => {
                        databaseCandidates.push({
                            name: business.name,
                            source: 'database',
                            data: business,
                            preferenceScore: business.preferenceScore || 0,
                            distance: business.distance || null,
                            distanceText: business.distanceText || null,
                            duration: business.duration || null,
                            totalScore: business.totalScore || 0
                        });
                    });
                    nearbyDestinations.forEach(destination => {
                        databaseCandidates.push({
                            name: destination.name,
                            source: 'database',
                            data: destination,
                            preferenceScore: destination.preferenceScore || 0,
                            distance: destination.distance || null,
                            distanceText: destination.distanceText || null,
                            duration: destination.duration || null,
                            totalScore: destination.totalScore || 0
                        });
                    });
                    // console.log(`Database candidates: ${databaseCandidates.length} places ready for enrichment`);
                    // Reconcile the model's chosen names against the Google prefetch
                    // shortlist. A name that MATCHES a prefetched place becomes a
                    // 'google' candidate carrying that place's real placeId (so
                    // enrichment skips the findPlaces resolution call). A name the
                    // model ADDED that doesn't match stays a pure 'ai' candidate and
                    // is resolved by name as before.
                    const prefetchByName = new Map();
                    (googleCandidates || []).forEach(g => {
                        const k = normalizePlaceName(g.name);
                        if (k && !prefetchByName.has(k)) prefetchByName.set(k, g);
                    });
                    const aiCandidates = bracketedNames.map(obj => {
                        const hit = prefetchByName.get(normalizePlaceName(obj.name));
                        if (hit) {
                            return {
                                name: hit.name,
                                source: 'google',
                                data: null,
                                placeId: hit.placeId,        // skips findPlaces in enrichment
                                preferenceScore: 0,
                                distance: null,
                                distanceText: null,
                                duration: null,
                                totalScore: 0
                            };
                        }
                        return {
                            name: obj.name,
                            source: 'ai',
                            data: null,
                            placeId: null,
                            preferenceScore: 0,
                            distance: null,
                            distanceText: null,
                            duration: null,
                            totalScore: 0
                        };
                    });
                    // console.log(`AI candidates: ${aiCandidates.length} places from AI suggestions`);
                    // Step 2 — in 'suggest' mode, use the WHOLE prefetch shortlist, not just
                    // the names the model recalled. Prefetch candidates the model did NOT name
                    // are added here as 'google' candidates carrying their real placeId, so
                    // enrichment serves them from PlaceCache when present (FREE) or enriches
                    // + caches them once (details + 1 image). This consumes the full pool and
                    // warms the cache; getCandidates already excluded already-shown places
                    // (View More) and off-type results. Deduped against the model's names; the
                    // SOURCE_RANK sort keeps these real places ahead of pure-AI, and they pass
                    // through the same distance / dislike / tier gates below.
                    //
                    // In 'resolve' mode this injection is SKIPPED: candidates that MATCH a
                    // model name still carried their placeId into aiCandidates above (so
                    // findPlaces is skipped — the resolution win is kept), but unmatched
                    // candidates are NOT suggested. Use this in thin / well-known markets where
                    // the model already names the right places and Google's generic pool would
                    // only surface off-style places that the gates then drop.
                    const modelNamed = new Set(aiCandidates.map(c => normalizePlaceName(c.name)));
                    const extraPrefetch = (prefetchMode === 'suggest' ? (googleCandidates || []) : [])
                        .filter(g => g.placeId && g.name && !modelNamed.has(normalizePlaceName(g.name)))
                        .map(g => ({ name: g.name, source: 'google', data: null, placeId: g.placeId, preferenceScore: 0, distance: null, distanceText: null, duration: null, totalScore: 0 }));
                    if (extraPrefetch.length) console.log(`[quick-action] prefetch fill: +${extraPrefetch.length} unused candidate(s) into enrichment (cache-first)`);
                    else if (prefetchMode === 'resolve' && (googleCandidates || []).length) console.log(`[quick-action] prefetch mode=resolve: candidates used for placeId resolution only (not suggested)`);
                    const allCandidates = [...databaseCandidates, ...aiCandidates, ...extraPrefetch];
                    const seenNames = new Set();
                    const uniqueCandidates = allCandidates.filter(candidate => {
                        const normalizedName = candidate.name.toLowerCase().trim();
                        if (seenNames.has(normalizedName)) {
                            console.log(`Duplicate removed: ${candidate.name} (${candidate.source})`);
                            return false;
                        }
                        seenNames.add(normalizedName);
                        return true;
                    });
                    // Source priority: real DB listings first, then real
                    // Google-prefetched places, then pure-AI suggestions.
                    const SOURCE_RANK = { database: 0, google: 1, ai: 2 };
                    uniqueCandidates.sort((a, b) => {
                        const ra = SOURCE_RANK[a.source] ?? 3;
                        const rb = SOURCE_RANK[b.source] ?? 3;
                        if (ra !== rb) return ra - rb;
                        return b.totalScore - a.totalScore;
                    });
                    // console.log(`Combined candidates: ${uniqueCandidates.length} unique places for enrichment`);
                    // console.log(`\n\n`);
                    const locationDetails = {};
                    const enrichmentLimit = Math.min(uniqueCandidates.length, 15);
                    const candidatesForEnrichment = uniqueCandidates.slice(0, enrichmentLimit);
                    const locationPromises = candidatesForEnrichment.map(async (candidate) => {
                        const cleanName = candidate.name;
                        try {
                            // Fetch from database the database results
                            if (candidate.source === 'database' && candidate.data) {
                                const dbPlace = candidate.data;
                                const loc = dbPlace.location;
                                if (loc) {
                                    // console.log(`✓ Using database data for ${cleanName} - skipping Google`);
                                    const uniqueKey = `db_${dbPlace._id}`;                                    
                                    const hasImages = dbPlace.images && dbPlace.images.length > 0;
                                    locationDetails[uniqueKey] = {
                                        name: cleanName,
                                        source: 'database',
                                        photos: hasImages ? dbPlace.images.slice(0, 1) : [], 
                                        place_id: null,
                                        formatted_address: dbPlace.location?.address || `${dbPlace.location?.city}, ${dbPlace.location?.region}`,
                                        geometry: dbPlace.location?.coordinates ? { location: { lat: dbPlace.location.coordinates.lat, lng: dbPlace.location.coordinates.lng } } : null
                                    };
                                    candidate.enrichmentKey = uniqueKey;
                                    return;
                                }
                            }
                            // Fetch from Cache the AI results, if not there fetch from GOOGLE
                            // console.log(`→ Looking up ${cleanName} (cache-first)`);
                            const details = await getCachedPlaceDetails(cleanName, false, requestId, effectiveLocation, candidate.placeId || null, googleService.actionIncludedType(action, subType));
                            if (!details) {
                                console.log(`⚠️ Failed to get details for ${cleanName} with getCachedPlaceDetails - using FALLBACK`);
                                const fallbackKey = `fallback_${Date.now()}_${Math.random()}`;
                                locationDetails[fallbackKey] = {
                                    name: cleanName,
                                    source: 'fallback',
                                    formatted_address: searchContext,
                                    geometry: null,
                                    photos: [],
                                    place_id: null
                                };
                                candidate.enrichmentKey = fallbackKey;
                                return;
                            }
                            if (details && details.geometry?.location?.lat && details.geometry?.location?.lng) {
                                const placeId = details.place_id || `google_${Date.now()}_${Math.random()}`;
                                locationDetails[placeId] = {
                                    name: details.name,
                                    source: details._fromCache ? 'cache' : 'google',
                                    formatted_address: details.formatted_address,
                                    geometry: details.geometry,
                                    photos: details.photos || [],
                                    place_id: details.place_id,
                                    // Contact fields for the map popup's Call / Website
                                    // buttons. getCachedPlaceDetails (Google + PlaceCache)
                                    // always returns these, but they were being dropped
                                    // here, so Google-sourced recs showed only Directions.
                                    website: details.website || null,
                                    formatted_phone_number: details.formatted_phone_number || null,
                                    international_phone_number: details.international_phone_number || null,
                                    // Real Google types of the resolved place — used by the
                                    // type sanity filter to drop non-matching kinds (a brandy
                                    // house / garden / hotel surfacing under "restaurants").
                                    types: details.types || [],
                                    primaryType: details.primaryType || null,
                                    // The name the MODEL asked for, kept so the name-similarity
                                    // guard can compare it against what Google actually
                                    // resolved — a hallucinated name like "Liqstum Hotel" that
                                    // Google rescues with an unrelated real place ("The Lichk
                                    // Lodge") shares no token and is dropped.
                                    requestedName: cleanName,
                                    _fromCache: details._fromCache || false
                                };
                                candidate.enrichmentKey = placeId;
                                // console.log(`✅ Enriched: ${cleanName} (from ${details._fromCache ? '✅ CACHE' : 'Google'})`);
                            }
                        } catch (enrichError) {
                            console.error(`Failed to enrich ${cleanName}:`, enrichError.message);
                            // Fallback
                            const fallbackKey = `fallback_${Date.now()}_${Math.random()}`;
                            if (candidate.source === 'database' && candidate.data) {
                                locationDetails[fallbackKey] = {
                                    name: cleanName,
                                    source: 'database_fallback',
                                    photos: candidate.data.images?.slice(0, 1) || [],
                                    place_id: null,
                                    formatted_address: candidate.data.location?.address || searchContext,
                                    geometry: candidate.data.location?.coordinates ? { location: { lat: candidate.data.location.coordinates.lat, lng: candidate.data.location.coordinates.lng } } : null
                                };
                            } else {
                                locationDetails[fallbackKey] = {
                                    name: cleanName,
                                    source: 'fallback',
                                    formatted_address: searchContext,
                                    geometry: null,
                                    photos: [],
                                    place_id: null
                                };
                            }
                            candidate.enrichmentKey = fallbackKey;
                        }
                    });
                    await Promise.all(locationPromises);
                    // console.log('Enrichment completed\n');

                    // console.log(`\n📊 API CALLS AFTER ENRICHMENT:`);
                    googleService.getDetailedRequestStats(requestId);

                    if (effectiveLocation) { 
                        // console.log('\n📍 Starting distance calculation...');
                        // console.log(`Total candidates: ${candidatesForEnrichment.length}`);
                        const aiCandidatesNeedingDistance = candidatesForEnrichment
                            .filter(c => {
                                const needsDistance = c.enrichmentKey && !c.distance;
                                // console.log(`  - ${c.name}:  NEEDS = ${needsDistance}`);
                                return needsDistance;
                            })
                            .map(c => {
                                const enrichedData = locationDetails[c.enrichmentKey];
                                // console.log(`Data for ${c.name}:`, { lat: enrichedData?.geometry?.location?.lat, lng: enrichedData?.geometry?.location?.lng });
                                if (enrichedData?.geometry?.location?.lat && enrichedData?.geometry?.location?.lng) {
                                    return {
                                        lat: enrichedData.geometry.location.lat,
                                        lng: enrichedData.geometry.location.lng,
                                        name: c.name,
                                        enrichmentKey: c.enrichmentKey,
                                        enrichedData: enrichedData
                                    };
                                }
                                return null;
                            }).filter(Boolean);
                        // console.log(`\n✅ Found ${aiCandidatesNeedingDistance.length} candidates needing distance calculation\n`);
                        let aiDistanceResults = [];
                        if (aiCandidatesNeedingDistance.length > 0) {
                            try { aiDistanceResults = await googleService.calculateDistances({ lat: effectiveLocation.lat, lng: effectiveLocation.lng }, aiCandidatesNeedingDistance, requestId ) } 
                            catch (error) {
                                console.error('AI distance calculation failed:', error);
                                aiDistanceResults = [];
                            }
                        } else { console.log('⚠️ No candidates need distance calculation') }
                        recommendations = candidatesForEnrichment.map((candidate, index) => {
                            const enrichedData = locationDetails[candidate.enrichmentKey];
                            let distanceInfo = null;
                            if (candidate.source === 'database' && candidate.distance) { distanceInfo = {distance: candidate.distanceText, distanceKm: candidate.distance, duration: candidate.duration} } 
                            else if (candidate.enrichmentKey) {
                                const distanceResult = aiDistanceResults.find(result => result.destination.enrichmentKey === candidate.enrichmentKey);
                                if (distanceResult && distanceResult.status === 'OK') {
                                    distanceInfo = {distance: distanceResult.distance.text, distanceKm: distanceResult.distance.km, duration: distanceResult.duration.text};
                                    // console.log(`\n✅ Distance assigned to ${candidate.name}: ${distanceInfo.distance}`);
                                } else {console.log(`\n❌ No distance result for ${candidate.name} (key: ${candidate.enrichmentKey})`)}
                            }
                            return createRecommendation(candidate, index, enrichedData, distanceInfo);
                        });
                    } else {
                        recommendations = candidatesForEnrichment.map((candidate, index) => {
                            const enrichedData = locationDetails[candidate.enrichmentKey];
                            return createRecommendation(candidate, index, enrichedData);
                        });
                    }
                    const seenPlaceIds = new Set();
                    recommendations = recommendations.filter(rec => {
                        if (!rec.placeId) return true;
                        if (!seenPlaceIds.has(rec.placeId)) {
                            seenPlaceIds.add(rec.placeId);
                            return true;
                        } else {
                            // console.log(`Duplicate place removed: ${rec.name} (${rec.placeId})`);
                            return false;
                        }
                    }).filter(rec => !rec.placeId || !excludePlaceIds.includes(rec.placeId));
                    // ── Name-based exclusion (covers DB places too) ──────────────────────
                    // excludePlaceIds only filters Google/cache recs — DB businesses and
                    // destinations carry placeId=null, so without this the SAME DB places
                    // recycle on every "View More" and the client drops them as duplicates,
                    // leaving an empty batch (the spinner clears with nothing new). Exclude
                    // by normalized name across ALL sources, matching the client's
                    // normalization (lowercase, strip non-word chars). First batch sends no
                    // excludeNames, so normal searches are unaffected.
                    if (Array.isArray(excludeNames) && excludeNames.length) {
                        const normName = (s) => (s || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
                        const excludeNameSet = new Set(excludeNames.map(normName).filter(Boolean));
                        if (excludeNameSet.size) {
                            const beforeN = recommendations.length;
                            recommendations = recommendations.filter(rec => !excludeNameSet.has(normName(rec.name)));
                            const droppedN = beforeN - recommendations.length;
                            if (droppedN > 0) { console.log(`[quick-action] excluded ${droppedN} already-shown place(s) by name`); }
                        }
                    }
                    // ── Distance sanity filter (AI/Google-enriched places only) ──────────
                    // Database candidates are already constrained to the search radius by
                    // proximityService. AI-suggested names, though, are looked up on Google
                    // with only a location *bias*, so a name that doesn't exist locally
                    // (e.g. a hallucinated "Lotte Hotel Yerevan") can match a same-named
                    // hotel in another country. Drop enriched non-database places that
                    // resolve far outside the search area, so a Yerevan query never surfaces
                    // a Moscow/Boston/Phuket hotel. Real local suggestions (what DeepSeek
                    // produces) resolve nearby and are untouched; places with no computed
                    // distance are left alone.
                    if (effectiveLocation) {
                        // Cap AI/Google-resolved places at the user's OWN search radius
                        // (nearby vs discovery, from their settings) — the same radius used
                        // for the DB proximity query — so results never exceed the area the
                        // user asked for. Applies to every action: if someone wants hotels or
                        // monasteries farther out, they raise their discovery radius. Distances
                        // are measured from effectiveLocation, so when planning a trip to
                        // another city/country the cap applies around THAT destination, not the
                        // user's current GPS. Optional global ceiling
                        // (AppConfig.quickActionMaxDistanceKm, 0 = off) can clamp it further.
                        let maxDistanceKm = userRadius || (nearbyMode ? 5 : 50);
                        if (cfg.quickActionMaxDistanceKm > 0) { maxDistanceKm = Math.min(maxDistanceKm, cfg.quickActionMaxDistanceKm); }
                        const beforeCount = recommendations.length;
                        recommendations = recommendations.filter(rec => rec.source === 'database' || rec.distanceKm == null || rec.distanceKm <= maxDistanceKm);
                        const dropped = beforeCount - recommendations.length;
                        if (dropped > 0) { console.log(`[quick-action] dropped ${dropped} out-of-area enriched place(s) (> ${maxDistanceKm}km, ${nearbyMode ? 'nearby' : 'discovery'} mode)`); }
                    }

                    // ── Type sanity filter (AI/Google-enriched places only) ──────────────
                    // The AI proposes names; Google resolves each to its top text match
                    // regardless of kind, so a "restaurants" search can surface a brandy
                    // house, a garden, or a hotel — all stamped "Restaurant" by the
                    // action-derived category. Drop enriched non-database places whose REAL
                    // Google types don't match the action. DB rows are type-correct by
                    // construction (skipped); places with no type info are kept (lenient,
                    // self-heals on re-fetch). Gates inclusion actions (restaurants / hotels
                    // / shopping) AND the landmark exclusion actions (historical / hidden_gems
                    // / photo_spots) — so a restaurant no longer slips into Historical.
                    if (googleService.actionHasTypeFilter(action, subType)) {
                        const beforeType = recommendations.length;
                        recommendations = recommendations.filter(rec =>
                            rec.source === 'database' ||
                            googleService.placeMatchesActionType(action, subType, rec.placeTypes, rec.placePrimaryType)
                        );
                        const droppedType = beforeType - recommendations.length;
                        if (droppedType > 0) { console.log(`[quick-action] dropped ${droppedType} off-type place(s) not matching action=${action}${subType ? '/' + subType : ''}`); }
                    }

                    // ── Name-similarity guard (AI/Google-enriched places only) ───────────
                    // Drop places where Google "rescued" a hallucinated/garbled model name
                    // with an unrelated real place (e.g. "Liqstum Hotel" → "The Lichk
                    // Lodge"). Cross-script resolutions (a Latin query → an Armenian-script
                    // name) are intentionally kept; see namesPlausiblyMatch. DB rows have no
                    // requested/resolved gap and are skipped.
                    {
                        const beforeName = recommendations.length;
                        recommendations = recommendations.filter(rec =>
                            rec.source === 'database' || namesPlausiblyMatch(rec.requestedName, rec.name)
                        );
                        const droppedName = beforeName - recommendations.length;
                        if (droppedName > 0) { console.log(`[quick-action] dropped ${droppedName} name-mismatch place(s) (model name vs Google match)`); }
                    }

                    // ── Events: attach schedule, keep date-only festivals, drop past ─────
                    // For the events action, stamp each rec that the model dated with an
                    // eventSchedule (the frontend renders the "when" from this). A festival
                    // the model named with a date but that Google can't resolve to a place
                    // (no map pin — e.g. "Yerevan Wine Days") would otherwise be dropped as
                    // an unresolved placeholder; instead we keep it as a DATE-CARD (no map,
                    // no distance — just name + date). Finally, drop anything already past.
                    /* Gate is the ACTION alone, not "the model dated something".
                     *
                     * This used to also require `eventDateByName.size`, which was
                     * harmless while the model was the only source: no dated events
                     * meant nothing to process. It is actively wrong now. A refill
                     * runs without web search precisely because the FEED will serve
                     * it — and the model contributes no dated brackets on such a
                     * tap, so the old gate would skip the block that consults the
                     * feed and View More would come back empty again: the exact
                     * failure the search exemption was added to prevent.
                     *
                     * Everything inside already tolerates an empty map (the metadata
                     * loop `continue`s when a rec has no entry). */
                    if (action === 'events') {
                        /* Start of TODAY IN THE USER'S OWN TIMEZONE, expressed as a
                         * UTC-midnight stamp so it compares directly against a date-only
                         * event (which is stored as UTC midnight of its date).
                         *
                         * Using UTC midnight here was wrong: Yerevan is UTC+4, so at 02:15
                         * on the 13th the server still called it the 12th and yesterday's
                         * all-day events were served as current. Any zone ahead of UTC hit
                         * this for its first hours of every day.
                         *
                         * en-CA formats as YYYY-MM-DD, which parses without ambiguity.
                         * Falls back to UTC when the client sends no timezone. */
                        const startOfTodayUTC = (() => {
                            /* Only an ACTUALLY-SENT timezone is trusted here.
                             *
                             * This previously read `req.body.userTimezone || 'UTC'`, which
                             * looked like a harmless default and was in fact the bug: 'UTC'
                             * is a VALID zone, so the try below always succeeded and the
                             * longitude fallback underneath was unreachable dead code. The
                             * quick-action request bodies never carried userTimezone at all
                             * (only chat-stream did), so EVERY events tap silently ran on UTC.
                             *
                             * At 02:35 in Yerevan on Aug 13 that makes "today" Aug 12, and an
                             * all-day Aug-12 event is stored at exactly Aug-12T00:00Z — so
                             * `t >= startOfTodayUTC` held, three stale cards shipped, and
                             * because nothing was dropped no `dropped N past event(s)` line
                             * was ever logged. The absent log line WAS the symptom.
                             *
                             * The client now sends the zone (JinniChat.vue), but cached old
                             * frontends will keep omitting it, so the estimate below has to be
                             * genuinely reachable rather than nominally present. */
                            const tz = typeof req.body.userTimezone === 'string' && req.body.userTimezone.trim()
                                ? req.body.userTimezone.trim()
                                : null;
                            if (tz) {
                                try {
                                    const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
                                        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
                                    }).format(new Date()).split('-').map(Number);
                                    return Date.UTC(y, m - 1, d);
                                } catch { /* client sent a bogus zone — fall through to the estimate */ }
                            }
                            /* No usable timezone from the client. Falling back to UTC would
                             * reinstate the very bug above for every user east of Greenwich,
                             * and this app is used worldwide — so estimate the offset from
                             * longitude (15° per hour). It can be an hour off at a zone edge
                             * and ignores DST, but it puts the day boundary within an hour of
                             * correct anywhere on earth, instead of up to 14 hours off. */
                            const n = new Date();
                            const lng = effectiveLocation && Number.isFinite(effectiveLocation.lng) ? effectiveLocation.lng : 0;
                            const local = new Date(n.getTime() + Math.round(lng / 15) * 3600000);
                            return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
                        })();
                        for (const rec of recommendations) {
                            /* ── An event is never renamed to its venue ───────────────────
                             * Enrichment replaces a rec's name with the Google result's
                             * name, which is right for a place and wrong for an event:
                             * "Tropical Night Party" shipped to users as "Tropica Inn",
                             * and — because the schedule map is keyed on the name the
                             * MODEL gave — it also lost its dates and never reached the
                             * venue pass. So look the metadata up by the requested name,
                             * and put that name back on the card. The resolved place stays
                             * on as the venue, which is what it actually is.
                             */
                            const askedName = rec.requestedName || rec.name;
                            const meta = eventDateByName.get(String(askedName || '').toLowerCase().trim())
                                      || eventDateByName.get(String(rec.name || '').toLowerCase().trim());
                            if (!meta) continue;
                            if (rec.requestedName && rec.name && rec.requestedName !== rec.name) {
                                console.log(`[quick-action] event kept its own name: "${rec.requestedName}" (resolved place "${rec.name}" treated as the venue)`);
                                rec.venueName = rec.name;
                                rec.name = rec.requestedName;
                            }
                            /* ── An event name is not a place name ────────────────────────
                             * Enrichment resolves every rec through Google Text Search. For
                             * an event that search has no correct answer — "LOBODA Live
                             * Concert" is not a listing — so Google returns whatever venues
                             * look vaguely similar and the picker takes the best of a bad
                             * set. That is how a Jrvezh Park concert was placed at Aram
                             * Khachaturian Concert Hall, and how "Tropical Night Party"
                             * became "Tropica Inn".
                             *
                             * So a resolution obtained from the EVENT name is only trusted
                             * when it matches the venue the model actually named. Otherwise
                             * the geography is discarded and the venue pass below re-resolves
                             * from the venue string — the field that is meant to answer
                             * "where", and the one that produced every correct result so far.
                             * With no venue named at all, a coincidental establishment match
                             * is worse than an honest date-card.
                             */
                            if (rec.latitude != null && rec.source !== 'database') {
                                const resolvedPlaceName = rec.venueName || null;
                                const venueTrusted = resolvedPlaceName && meta.venue
                                    && namesPlausiblyMatch(meta.venue, resolvedPlaceName);
                                if (resolvedPlaceName && !venueTrusted) {
                                    console.log(`[quick-action] event "${rec.name}": discarded name-resolution to "${resolvedPlaceName}" (model named venue "${meta.venue || '—'}") — re-resolving from the venue`);
                                    rec.latitude = null; rec.longitude = null;
                                    rec.distanceKm = null; rec.distance = null;
                                    rec.placeId = null; rec.venuePlaceId = null;
                                    rec.image = null; rec.location = null; rec.region = null;
                                    rec.venueName = null;
                                }
                            }
                            if (meta.start) {
                                rec.eventSchedule = {
                                    startDate: `${meta.start}T00:00:00.000Z`,
                                    ...(meta.end ? { endDate: `${meta.end}T00:00:00.000Z` } : {})
                                };
                                rec.category = 'Event';
                            }
                            // Carried to the venue-resolution pass below, then stripped
                            // before the response is sent.
                            rec._eventVenue = meta.venue || null;
                            rec._eventAddress = meta.address || null;
                            // Survives to the card: lets the user check a date we cannot
                            // verify ourselves. Only ever set for AI-named events — a
                            // curated destination carries the validator's own data.
                            if (meta.sourceUrl && rec.source !== 'database') rec.sourceUrl = meta.sourceUrl;
                        }

                        /* ── Trust the listing over the model's memory ────────────────
                         * Runs BEFORE venue resolution, dedupe and the past-event filter,
                         * because every one of those reads the date: resolving a venue for
                         * an event that the listing proves already ended is wasted Google
                         * budget, and deduping on a date the model misremembered by three
                         * weeks matches nothing.
                         *
                         * Only AI events with a sourceUrl are fetched — a curated record is
                         * the validator's own work and outranks any listing.
                         */
                        {
                            const toFetch = recommendations.filter(r =>
                                r && r.sourceUrl && r.source !== 'database'
                            );
                            if (toFetch.length) {
                                let corrected = 0, imaged = 0, checked = 0;
                                // Bounded concurrency: a handful of workers draining a shared
                                // queue, so N slow pages cost one timeout, not N.
                                const queue = toFetch.slice();
                                const worker = async () => {
                                    while (queue.length) {
                                        const rec = queue.shift();
                                        const ld = await fetchEventListing(rec.sourceUrl, rec.name);
                                        checked++;
                                        if (!ld) continue;
                                        rec.provenance = rec.provenance || {};
                                        if (ld.startDate) {
                                            const was = rec.eventSchedule?.startDate || null;
                                            rec.eventSchedule = {
                                                startDate: ld.startDate,
                                                ...(ld.endDate ? { endDate: ld.endDate } : {})
                                            };
                                            rec.category = 'Event';
                                            rec.provenance.startDate = 'listing';
                                            if (ld.endDate) rec.provenance.endDate = 'listing';
                                            if (was && was.slice(0, 10) !== ld.startDate.slice(0, 10)) {
                                                corrected++;
                                                console.log(`[listing] "${rec.name}": date corrected ${was.slice(0, 10)} → ${ld.startDate.slice(0, 10)} (from ${rec.sourceUrl})`);
                                            }
                                        }
                                        // The poster the model could never supply. Only fills a
                                        // gap — a Google venue photo already chosen stays.
                                        if (ld.image && !rec.image) {
                                            rec.image = ld.image;
                                            rec.provenance.image = 'listing';
                                            imaged++;
                                        }
                                        // A listing's venue beats the model's guess as the query
                                        // for the venue pass below (JazZara → "Zazoo Rooftop
                                        // Lounge" was internally consistent and simply wrong).
                                        if (ld.venueName && !isPlaceholderVenue(ld.venueName, [userRegion?.city, userRegion?.region, userRegion?.country, effectiveLocation?.city, effectiveLocation?.country].filter(Boolean))) {
                                            rec._eventVenue = ld.venueName;
                                            rec.provenance.venue = 'listing';
                                        }
                                        if (ld.venueAddress) rec._eventAddress = ld.venueAddress;
                                    }
                                };
                                await Promise.all(
                                    Array.from({ length: Math.min(EVENT_LISTING_CONCURRENCY, toFetch.length) }, worker)
                                );
                                console.log(`[quick-action] listing check: ${checked} source page(s) read, ${corrected} date(s) corrected, ${imaged} image(s) adopted`);
                            }
                        }

                        /* ── Ticketing feed: correct what the model guessed, then fill ──
                         * See EVENT_FEED_SOURCES for why this exists. Runs before venue
                         * resolution so feed events inherit the whole existing pipeline —
                         * venue lookup, curated dedupe, past-event expiry — for free.
                         */
                        {
                            const feed = await getEventFeedsForLocation(userRegion, effectiveLocation, req.body?.destinationInfo);
                            if (feed.length) {
                                const norm = s => normalizePlaceName(s);
                                const dayOf = d => { const t = new Date(d).getTime(); return Number.isFinite(t) ? Math.floor(t / 86400000) : null; };

                                // ── (a) CORRECT ───────────────────────────────────────
                                // A feed entry is a seller's own record; it outranks recall.
                                let fixedDate = 0, fixedVenue = 0, fixedImage = 0;
                                const claimed = new Set();
                                for (const rec of recommendations) {
                                    if (!rec || rec.source === 'database') continue;
                                    const rn = norm(rec.name);
                                    if (!rn) continue;
                                    /* eventNamesMatch, NOT namesPlausiblyMatch.
                                     * The latter is a PLACE-name comparator: it matched
                                     * "LOBODA Concert" to "Tickets for the Spleen concert"
                                     * on the shared word "concert" and overwrote LOBODA's
                                     * date, venue and poster with Spleen's — then broke the
                                     * curated dedupe, because the now-wrong date no longer
                                     * matched the validator's Aug-15 record and both shipped. */
                                    /* Both names are tried: the canonical English one AND the
                                     * source's original-language one. An Armenian model
                                     * suggestion matches the Armenian original; an English one
                                     * matches the normalized title. Cross-language pairs simply
                                     * fail to match — which is the safe outcome, never a guess. */
                                    const match = feed.find(f =>
                                        (f.name && eventNamesMatch(rec.name, f.name)) ||
                                        (f.rawName && f.rawName !== f.name && eventNamesMatch(rec.name, f.rawName)));
                                    if (!match) continue;
                                    claimed.add(match);
                                    rec.provenance = rec.provenance || {};
                                    const wasDay = dayOf(rec.eventSchedule?.startDate);
                                    rec.eventSchedule = { startDate: match.startDate, ...(match.endDate ? { endDate: match.endDate } : {}) };
                                    rec.category = 'Event';
                                    rec.provenance.startDate = 'feed';
                                    if (wasDay != null && wasDay !== dayOf(match.startDate)) {
                                        fixedDate++;
                                        console.log(`[feed] "${rec.name}": date corrected ${new Date(wasDay * 86400000).toISOString().slice(0, 10)} → ${match.startDate.slice(0, 10)} (${match.feedLabel})`);
                                    }
                                    if (match.venueName && !isPlaceholderVenue(match.venueName, [userRegion?.city, userRegion?.region, userRegion?.country, effectiveLocation?.city, effectiveLocation?.country].filter(Boolean))) {
                                        if (norm(match.venueName) !== norm(rec._eventVenue)) fixedVenue++;
                                        rec._eventVenue = match.venueName;
                                        rec.provenance.venue = 'feed';
                                        /* Any geography derived from the model's guess is now
                                         * suspect: the seller says the event is elsewhere. Clear
                                         * it so the venue pass re-resolves from the feed's venue.
                                         * Kept only when what we already resolved is demonstrably
                                         * the same place — an UNNAMED resolution proves nothing
                                         * (JazZara → "Zazoo Rooftop Lounge" was internally
                                         * consistent and still wrong). */
                                        const alreadyRight = rec.venueName && namesPlausiblyMatch(match.venueName, rec.venueName);
                                        if (rec.latitude != null && !alreadyRight) {
                                            rec.latitude = null; rec.longitude = null;
                                            rec.distance = null; rec.distanceKm = null;
                                            rec.venueName = null; rec.venuePlaceId = null;
                                        }
                                    }
                                    if (match.venueAddress) rec._eventAddress = match.venueAddress;
                                    if (match.image && !rec.image) { rec.image = match.image; rec.provenance.image = 'feed'; fixedImage++; }
                                    if (match.url) { rec.sourceUrl = match.url; rec.provenance.sourceUrl = 'feed'; }
                                }

                                // ── (b) SUPPLY ────────────────────────────────────────
                                // Real, dated, in-country events the model never mentioned.
                                // Bounded by the shortfall so a tap never overshoots.
                                const shortfall = Math.max(0, (requestedCount || 0) - recommendations.length);
                                let added = 0;
                                if (shortfall > 0) {
                                    const shown = new Set([
                                        ...recommendations.map(r => norm(r?.name)),
                                        ...(excludeNames || []).map(norm)
                                    ].filter(Boolean));
                                    /* Personalization is CODE, not another model call: tags were
                                     * assigned once at ingestion from a fixed vocabulary, so
                                     * matching them against the user's interests is language-free
                                     * and per-user free. Ordering only, never exclusion — an
                                     * empty grid is worse than an unranked one. Known price rides
                                     * along for the budget filter the moment a budget field
                                     * exists; nothing claims to fit a budget it cannot see. */
                                    const _interests = (Array.isArray(preferences?.interests) ? preferences.interests : [])
                                        .map(x => String(x).toLowerCase());
                                    const _tagScore = f => (f.tags || []).reduce((n, t) =>
                                        n + (_interests.some(i => i.includes(t) || t.includes(i)) ? 1 : 0), 0);
                                    const orderedFeed = [...feed].sort((a, b) =>
                                        _tagScore(b) - _tagScore(a) || (new Date(a.startDate) - new Date(b.startDate)));
                                    for (const f of orderedFeed) {
                                        if (added >= shortfall) break;
                                        if (claimed.has(f)) continue;
                                        const fn = norm(f.name);
                                        if (!fn || [...shown].some(s => s && (s.includes(fn) || fn.includes(s)))) continue;
                                        shown.add(fn);
                                        recommendations.push({
                                            // Not a Google place: no placeId, exactly like every
                                            // other event. The venue pass gives it coordinates.
                                            id: `feed_${f.feedLabel}_${fn.replace(/\s+/g, '_').slice(0, 48)}`,
                                            name: f.name,
                                            source: f.feedLabel,
                                            category: 'Event',
                                            type: 'events',
                                            description: '',
                                            placeId: null,
                                            latitude: null, longitude: null,
                                            image: f.image || null,
                                            eventSchedule: { startDate: f.startDate, ...(f.endDate ? { endDate: f.endDate } : {}) },
                                            _eventVenue: f.venueName || null,
                                            _eventAddress: f.venueAddress || null,
                                            sourceUrl: f.url || null,
                                            _action: 'events',
                                            ...(f.tags?.length ? { tags: f.tags } : {}),
                                            ...(f.price ? { price: f.price } : {}),
                                            ...(f.names ? { names: f.names } : {}),
                                            provenance: { startDate: f.provenance === 'extracted' ? 'extracted' : 'feed', venue: f.provenance === 'extracted' ? 'extracted' : 'feed', ...(f.image ? { image: 'feed' } : {}) }
                                        });
                                        added++;
                                    }
                                }
                                console.log(`[quick-action] feed: ${feed.length} available | corrected ${fixedDate} date(s), ${fixedVenue} venue(s), ${fixedImage} image(s) | added ${added} event(s) at $0 AI cost`);
                            }
                        }

                        /* ── Venue resolution ────────────────────────────────────────
                         * An event is not a Google place — "Yerevan Book Festival" has
                         * no listing, so it resolves to nothing and lands here with no
                         * coordinates, no image and no address: the empty card users
                         * see today. But the VENUE it is held at almost always is a
                         * Google place, and a street is at least geocodable. So we
                         * resolve the venue instead of the event, and the card inherits
                         * its pin, address, photo, phone, website and hours.
                         *
                         * Runs ONLY for events that already failed to resolve, so a
                         * working card can never be changed by this pass. Bounded on
                         * purpose: at most two lookups per event (venue, then address),
                         * no retries, no loops — a stubborn event stays a date-card
                         * rather than spending the request's Google budget on itself.
                         *
                         * The event KEEPS ITS OWN NAME — only location data is adopted
                         * from the venue. Out-of-area matches are rejected by the same
                         * radius the rest of the pipeline uses, so a wrong venue match
                         * falls back to the date-card instead of misplacing the pin.
                         */
                        /* ── …and not too far in the FUTURE either ────────────────────
                         * The other end of the same question. A tap in August was
                         * returning concerts in October — seven weeks out is a catalogue,
                         * not "what's on now". Both the model and the ticketing feed list
                         * everything they have, so the horizon has to be applied here.
                         *
                         * Runs BEFORE venue resolution on purpose. Sitting after it, this
                         * filter threw away events the venue pass had ALREADY paid Google
                         * to locate — the logs show "The Adana Complex" and the Demirchyan
                         * complex looked up on every single tap only to be dropped moments
                         * later. It also sat between `beforePast` and its own subtraction,
                         * so the past-event filter reported the horizon's drops as its own
                         * ("dropped 9 of 9" when it had dropped none).
                         *
                         * A CURATED record is exempt: a validator entering an event months
                         * ahead did so deliberately, and the governing principle is that
                         * their decision is authoritative. Set eventHorizonDays to 0 in
                         * admin to switch this off. */
                        const horizonDays = Number.isFinite(cfg.eventHorizonDays) ? cfg.eventHorizonDays : 7;
                        if (horizonDays > 0) {
                            const cutoff = startOfTodayUTC + (horizonDays + 1) * 86400000;
                            const beforeFar = recommendations.length;
                            recommendations = recommendations.filter(rec => {
                                if (!rec.eventSchedule || rec.source === 'database') return true;
                                const t = new Date(rec.eventSchedule.startDate).getTime();
                                if (!Number.isFinite(t)) return true;
                                return t < cutoff;
                            });
                            const droppedFar = beforeFar - recommendations.length;
                            if (droppedFar > 0) console.log(`[quick-action] horizon: dropped ${droppedFar} event(s) beyond ${horizonDays} day(s)`);
                        }

                        const needVenue = recommendations.filter(r =>
                            (r.latitude == null || r.longitude == null) && (r._eventVenue || r._eventAddress)
                        );
                        if (needVenue.length && effectiveLocation && Number.isFinite(effectiveLocation.lat)) {
                            const center = { lat: effectiveLocation.lat, lng: effectiveLocation.lng };
                            const venueRadiusKm = userRadius || (nearbyMode ? 5 : 50);
                            /* Names that mean "this whole city/country", not a building.
                             *
                             * userRegion FIRST, and it is the one that actually matters:
                             * effectiveLocation carries city/country only on the settings
                             * path, never on real-time GPS. Built from effectiveLocation
                             * alone this list came out EMPTY in production, so
                             * isPlaceholderVenue had no city to compare against and
                             * "Yerevan" passed straight through to Google — which is why
                             * three events still landed on one Cascade pin after the fix
                             * that was supposed to stop exactly that. */
                            const venueCityNames = [
                                userRegion?.city,
                                userRegion?.region,
                                userRegion?.country,
                                effectiveLocation.city,
                                effectiveLocation.country,
                                req.body?.destinationInfo?.city,
                                req.body?.destinationInfo?.country
                            ].filter(Boolean);
                            let resolvedByVenue = 0, resolvedByAddress = 0;
                            for (const rec of needVenue) {
                                /* Drop placeholder venues before they reach Google — see
                                 * PLACEHOLDER_VENUE_RE / isPlaceholderVenue for why. The
                                 * city list is what stops "Yerevan" and "Yerevan city
                                 * centre" being geocoded as if they named a building. */
                                const attempts = [rec._eventVenue, rec._eventAddress]
                                    .filter(Boolean)
                                    .filter(v => {
                                        if (!isPlaceholderVenue(v, venueCityNames)) return true;
                                        console.log(`[quick-action] event "${rec.name}": skipped placeholder venue "${v}" (no single location — keeping as a date-card)`);
                                        return false;
                                    });
                                for (let i = 0; i < attempts.length; i++) {
                                    try {
                                        const v = await getCachedPlaceDetails(attempts[i], false, requestId, center);
                                        const loc = v && v.geometry && v.geometry.location;
                                        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;
                                        const distKm = _haversineKm(center.lat, center.lng, loc.lat, loc.lng);
                                        if (distKm > venueRadiusKm) continue;   // wrong city — reject, keep the date-card
                                        rec.latitude = loc.lat;
                                        rec.longitude = loc.lng;
                                        rec.distanceKm = Math.round(distKm * 10) / 10;
                                        // The CARD reads `distance` (a display string); `distanceKm`
                                        // alone renders as "Distance unavailable". The distance pass
                                        // ran before this resolution, so it never saw these places.
                                        rec.distance = `${rec.distanceKm} km`;
                                        // ── The event does NOT take the venue's identity ──────────
                                        // `placeId` is identity everywhere in this app: votes
                                        // (PlaceFeedback), saves, dedupe, cache tagging and the staff
                                        // validator all key on it. Giving "The Firebird" the concert
                                        // hall's placeId would make a dislike of the concert suppress
                                        // the HALL for that user, collide with the hall's own card in
                                        // dedupe, and make one card's image button fire on both.
                                        // So we borrow the venue's PHOTO and address, never its id.
                                        rec.venuePlaceId = v.place_id || null;
                                        if (!rec.image && v.place_id && Array.isArray(v.photos) && v.photos.length) {
                                            rec.image = `/api/ai/place-image/${v.place_id}/0`;
                                        }
                                        rec.location = v.formatted_address || rec.location || null;
                                        rec.region = v.vicinity || v.formatted_address || rec.region || null;
                                        rec.website = rec.website || v.website || null;
                                        rec.phone = rec.phone || v.formatted_phone_number || v.international_phone_number || null;
                                        if (!Number.isFinite(rec.rating) && Number.isFinite(v.rating)) rec.rating = v.rating;
                                        if (i === 0) resolvedByVenue++; else resolvedByAddress++;
                                        break;   // one success is enough — never try the second query
                                    } catch (vErr) {
                                        console.warn(`[quick-action] venue resolution failed for "${attempts[i]}":`, vErr.message);
                                    }
                                }
                            }
                            const stillUnresolved = needVenue.length - resolvedByVenue - resolvedByAddress;
                            console.log(`[quick-action] event venue resolution: ${resolvedByVenue} by venue, ${resolvedByAddress} by address, ${stillUnresolved} still date-card(s) of ${needVenue.length} attempted`);
                        }

                        /* ── A curated event beats the AI's copy of it ────────────────
                         * A validator entered LOBODA by hand — right venue (Jrvezh Park),
                         * right time (20:00), verified from the organizer. The model then
                         * named the same concert as "LOBODA Live Concert", which dedupe
                         * missed: the names are not equal and the ids are different
                         * (a Destination _id vs a Google placeId), so both shipped — the
                         * curated one correct, the AI one at the wrong hall and dateless
                         * ("All day"). For events, match on containment plus overlapping
                         * dates instead of equality, and always keep the human record:
                         * it carries the time and the venue the AI can only guess at.
                         *
                         * ── Why NAME matching alone is not enough ─────────────────────
                         * It let the same concert through twice. The model called it "Pop
                         * concert at Altezza by Armenian Helicopters" (Aug 15, Jrvezh) —
                         * that IS the curated LOBODA event, and the two strings share not
                         * one significant word. Name matching only ever worked when the
                         * model happened to say the artist's name.
                         *
                         * An event is pinned down by WHERE and WHEN, not by what someone
                         * chose to call it: same venue + same date ⇒ same event. So three
                         * independent matchers now run, any one of which is sufficient:
                         *
                         *   1. NAME     — containment, as before (catches a renamed venue).
                         *   2. VENUE    — the model's venue string against the curated
                         *                 event's name or address (LOBODA: "Jrvezh").
                         *   3. GEOGRAPHY— resolved coordinates within DEDUPE_VENUE_KM of
                         *                 the curated pin. The strongest signal, and the
                         *                 reason this block now runs AFTER venue
                         *                 resolution: before it, an AI event has no
                         *                 coordinates to compare and this matcher is blind.
                         *
                         * Matchers 2 and 3 require BOTH sides to carry a real date that
                         * agrees. Name matching can afford to let an undated event through
                         * on the name alone; venue and geography cannot — a concert hall
                         * hosts a different act every night, so "same venue, date unknown"
                         * is not evidence of anything.
                         *
                         * Accepted trade-off: two genuinely different events at one venue
                         * on one day will collapse to the curated one. That is rare, it is
                         * the direction the governing principle points (the human record is
                         * authoritative; the AI copy is unverified), and every drop is
                         * logged with the matcher that fired so it stays diagnosable.
                         */
                        {
                            const DEDUPE_VENUE_KM = 0.4;   // one venue's footprint — a park and its stage, a hall and its car park
                            const normEvt = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
                            const sameDay = (a, b) => {
                                if (!a || !b) return true;   // one side undated → name match alone decides
                                const da = new Date(a), db = new Date(b);
                                if (isNaN(da) || isNaN(db)) return true;
                                return Math.abs(da.getTime() - db.getTime()) <= 36 * 60 * 60 * 1000;   // same-ish day
                            };
                            // Stricter than sameDay: BOTH sides must be present, parseable
                            // and on the same calendar day. Used by the venue/geography
                            // matchers, where a missing date must never count as agreement.
                            const definitelySameDay = (a, b) => {
                                if (!a || !b) return false;
                                const da = new Date(a), db = new Date(b);
                                if (isNaN(da) || isNaN(db)) return false;
                                return Math.abs(da.getTime() - db.getTime()) <= 36 * 60 * 60 * 1000;
                            };
                            const curated = recommendations.filter(r => r && r.source === 'database' && r.eventSchedule);
                            if (curated.length) {
                                const before = recommendations.length;
                                recommendations = recommendations.filter(rec => {
                                    if (!rec || rec.source === 'database' || !rec.eventSchedule) return true;
                                    let how = null;
                                    const a = normEvt(rec.name);
                                    // Everything the AI side can say about "where": the model's
                                    // venue string, the listing's venue, and the resolved name.
                                    const aVenues = [rec._eventVenue, rec.venueName, rec._eventAddress]
                                        .filter(Boolean).map(normEvt).filter(Boolean);
                                    const dup = curated.find(c => {
                                        const b = normEvt(c.name);
                                        // 1. NAME
                                        if (a && b) {
                                            const contained = a === b || a.includes(b) || b.includes(a);
                                            if (contained && sameDay(rec.eventSchedule.startDate, c.eventSchedule?.startDate)) {
                                                how = 'name+date';
                                                return true;
                                            }
                                        }
                                        if (!definitelySameDay(rec.eventSchedule.startDate, c.eventSchedule?.startDate)) return false;
                                        // 2. VENUE — the curated event's own name and address are
                                        //    the only "where" a validator records.
                                        const cWheres = [c.name, c.location, c.region]
                                            .filter(Boolean).map(normEvt).filter(Boolean);
                                        for (const av of aVenues) {
                                            for (const cw of cWheres) {
                                                // Containment either way, plus the shared-token test
                                                // that already guards venue resolution — so
                                                // "Jrvezh" matches "Jrvezh Park" and
                                                // "Arno Babajanyan Concert Hall" matches its street.
                                                if (av.includes(cw) || cw.includes(av) || namesPlausiblyMatch(av, cw)) {
                                                    how = `venue+date ("${av}" ≈ "${cw}")`;
                                                    return true;
                                                }
                                            }
                                        }
                                        // 3. GEOGRAPHY
                                        if (Number.isFinite(rec.latitude) && Number.isFinite(rec.longitude)
                                            && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
                                            const km = _haversineKm(rec.latitude, rec.longitude, c.latitude, c.longitude);
                                            if (km <= DEDUPE_VENUE_KM) {
                                                how = `coords+date (${Math.round(km * 1000)} m apart)`;
                                                return true;
                                            }
                                        }
                                        return false;
                                    });
                                    if (dup) console.log(`[quick-action] dropped AI event "${rec.name}" — already curated as "${dup.name}" via ${how} (validator record wins)`);
                                    return !dup;
                                });
                                const droppedDupes = before - recommendations.length;
                                if (droppedDupes > 0) console.log(`[quick-action] events: ${droppedDupes} AI duplicate(s) of curated events dropped`);
                            }
                        }
                        // Per-item outcome — one table instead of reconstructing the run
                        // from scattered drop counters.
                        if (process.env.AI_TRACE === '1') {
                            console.log('[trace] event outcomes:');
                            for (const rec of recommendations) {
                                const m = eventDateByName.get(String(rec.requestedName || rec.name || '').toLowerCase().trim());
                                if (!m && !rec.eventSchedule) continue;
                                const when = rec.eventSchedule ? String(rec.eventSchedule.startDate).slice(0, 10) : 'no-date';
                                const where = rec.latitude != null ? `${rec.venueName || rec.location || 'located'} (${rec.distance || '?'})` : 'DATE-CARD (unlocated)';
                                console.log(`  • ${rec.name} | ${when} | model-venue: ${m?.venue || '—'} | model-address: ${m?.address || '—'} | → ${where}`);
                            }
                        }

                        // Anything still without coordinates becomes a date-card, so the
                        // coordinate-drop below keeps it instead of discarding it.
                        for (const rec of recommendations) {
                            if (rec.eventSchedule && (rec.latitude == null || rec.longitude == null)) rec._isDateCard = true;
                        }
                        const beforePast = recommendations.length;
                        /* ── Same expiry instant the cleanup service uses ─────────────
                         * eventCleanup deletes a curated event the moment it expires,
                         * with no grace, and an event with no end date expires at its
                         * START (a 20:00 concert stops showing at 20:00). This filter
                         * compared against START-OF-DAY instead, so between 20:00 and
                         * midnight the curated record was already deleted while an AI
                         * copy of the same concert — wrong venue, no time — survived
                         * here and became the only card. Now the two agree.
                         *
                         * A DATE-ONLY event (midnight UTC, i.e. the model gave a day and
                         * no time) still lives out its whole day: "sometime on Saturday"
                         * has not passed at 00:01 on Saturday. Only a real time expires
                         * at that time — matching the rule the client encodes when it
                         * sends an explicit 23:59 for all-day events.
                         */
                        const nowMs = Date.now();
                        recommendations = recommendations.filter(rec => {
                            if (!rec.eventSchedule) return true;
                            const ref = rec.eventSchedule.endDate || rec.eventSchedule.startDate;
                            const t = new Date(ref).getTime();
                            if (!Number.isFinite(t)) return true;          // unparseable → keep, as before
                            const dateOnly = t % 86400000 === 0;           // exactly midnight UTC
                            return dateOnly ? t >= startOfTodayUTC : t >= nowMs;
                        });
                        const droppedPast = beforePast - recommendations.length;
                        /* Logged UNCONDITIONALLY, including the zero case. Previously this
                         * only spoke up when it dropped something, so "no line in the log"
                         * was ambiguous between "the filter kept everything correctly" and
                         * "the filter was comparing against the wrong day" — which is exactly
                         * the ambiguity that hid the UTC bug above for a whole round. Print
                         * the day boundary and where it came from so one line settles it. */
                        console.log(`[quick-action] past-event filter: dropped ${droppedPast} of ${beforePast} | today=${new Date(startOfTodayUTC).toISOString().slice(0, 10)} | tz=${req.body.userTimezone || 'NOT SENT → longitude estimate'}`);
                    }

                    // ── Drop unresolved placeholders (no coordinates) ────────────────────
                    // When a model-suggested name can't be resolved on Google (returns 0
                    // results — often a hallucinated or mistyped name, or a café excluded
                    // by an over-narrow query), the enrichment builds a "fallback" entry
                    // with no geometry, no image and no distance. Those render as empty
                    // skeleton cards. Drop any non-database rec without real coordinates so
                    // the user only ever sees complete cards. DB rows always have coords.
                    // EXCEPTION: event date-cards are coordinate-free by design and kept.
                    {
                        const beforeCoords = recommendations.length;
                        recommendations = recommendations.filter(rec =>
                            rec.source === 'database' || rec._isDateCard || (rec.latitude != null && rec.longitude != null)
                        );
                        const droppedCoords = beforeCoords - recommendations.length;
                        if (droppedCoords > 0) { console.log(`[quick-action] dropped ${droppedCoords} unresolved placeholder(s) with no coordinates`); }
                    }

                    // ── Per-user dislike set (model names AND both backfills) ────────────
                    // Places THIS user has disliked UNDER THIS ACTION. Scoped by action so a
                    // place disliked as an 'event' can still surface under 'historical'.
                    // Loaded unconditionally now (cheap indexed query on userId+action)
                    // because it also gates the model's OWN named results below — not just
                    // the fill-to-target spares.
                    let userDislikedIds = new Set();
                    try {
                        const rows = await PlaceFeedback.find({ userId, action, vote: 'dislike' }).select('placeId').lean();
                        userDislikedIds = new Set(rows.map(r => r.placeId));
                    } catch (pfErr) { console.warn('[quick-action] dislike-set load failed:', pfErr.message); }
                    // Validator-suppressed places (Block AI + Hidden) — global
                    // suppression, same rule as chat.
                    try {
                        (await PlaceCache.find({ $or: [{ aiBlocked: true }, { 'explore.status': 'hidden' }] }).select('placeId').lean())
                            .forEach(b => b.placeId && userDislikedIds.add(b.placeId));
                    } catch (abErr) { console.warn('[quick-action] suppression-set load failed:', abErr.message); }

                    // ── Preference gate on the MODEL'S OWN named results ─────────────────
                    // The model proposes names from its training memory, which can include
                    // places the community has rejected, that THIS user disliked, or that are
                    // the wrong price tier for the user's style. Those used to pass untouched
                    // (only backfill was filtered), so a bad/off-tier place could re-enter
                    // purely because the model recalled it. Here we run the SAME checks the
                    // backfill uses against the enriched recs:
                    //   • per-user dislike — this user disliked it under this action
                    //     (Google placeId for cache places, verifiedId for DB places).
                    //   • community hard-reject — net ≤ −3 AND ≥3 votes AND ≥60% dislikes
                    //     (looked up from PlaceCache by placeId — the rec doesn't carry the
                    //     counters, so we batch-fetch them: this is the "search the cache"
                    //     step).
                    //   • price-tier mismatch — for restaurants/hotels/shopping/hidden_gems,
                    //     drop a place whose KNOWN tier is the clear opposite of the user's
                    //     luxury/budget style (priceLevel from the same cache lookup; lodging
                    //     subtype from the rec's types). Unknown tier is kept.
                    // Dropping here (before the backfills) frees the slot so a clean place
                    // backfills in its place. Date-cards / unresolved recs have no placeId
                    // and are never matched, so they're unaffected.
                    {
                        const recIds = [...new Set(recommendations.map(r => r.placeId).filter(Boolean))];
                        const cacheMeta = new Map();   // placeId → { likes, dislikes, priceLevel }
                        if (recIds.length) {
                            try {
                                const rows = await PlaceCache.find({ placeId: { $in: recIds } })
                                    .select('placeId likes dislikes priceLevel').lean();
                                rows.forEach(r => cacheMeta.set(r.placeId, { likes: r.likes || 0, dislikes: r.dislikes || 0, priceLevel: r.priceLevel || null }));
                            } catch (cvErr) { console.warn('[quick-action] model-name gate lookup failed:', cvErr.message); }
                        }
                        // Validator-curated category rejects — a place staff filed under a
                        // DIFFERENT category than the one being requested (see the gate's
                        // comment block). Separate indexed query rather than more fields on
                        // the one above, because it only ever matches curated docs.
                        const curatedRejects = await loadCuratedRejects(recIds, action);
                        const beforeDislike = recommendations.length;
                        let droppedCommunity = 0, droppedUser = 0, droppedTier = 0, droppedCategory = 0;
                        const tierApplies = isPriceAction(action);   // restaurants/hotels/shopping/hidden_gems
                        recommendations = recommendations.filter(rec => {
                            // Per-user dislike: match on Google placeId OR DB verifiedId.
                            if ((rec.placeId && userDislikedIds.has(rec.placeId)) ||
                                (rec.verifiedId && userDislikedIds.has(String(rec.verifiedId)))) {
                                droppedUser++; return false;
                            }
                            // Wrong category for this action, per a validator's curation.
                            // Checked before the community/tier rules because it is a human
                            // decision about what this place IS, not a signal about how good
                            // it is — the place stays perfectly valid under its own category.
                            if (rec.placeId && curatedRejects.has(rec.placeId)) { droppedCategory++; return false; }
                            const meta = rec.placeId ? cacheMeta.get(rec.placeId) : null;
                            // Community hard-reject: only cached places carry vote counts.
                            if (meta && isCommunityRejected(meta.likes, meta.dislikes)) { droppedCommunity++; return false; }
                            // Price-tier mismatch (Step 3): drop a place whose KNOWN tier is the
                            // clear opposite of the user's style (luxury vs a budget hostel, etc.).
                            // Types come from the rec (placeTypes/placePrimaryType, set at enrich
                            // time); priceLevel from the cache lookup. Unknown tier → kept.
                            if (tierApplies) {
                                const tier = priceTier(rec.placeTypes, rec.placePrimaryType, meta ? meta.priceLevel : null).tier;
                                if (tierMismatch(tier, preferences.travelStyle)) { droppedTier++; return false; }
                            }
                            return true;
                        });
                        const droppedTotal = beforeDislike - recommendations.length;
                        if (droppedTotal > 0) {
                            console.log(`[quick-action] preference gate dropped ${droppedTotal} model-named place(s) (community ${droppedCommunity}, this-user ${droppedUser}, tier ${droppedTier}, wrong-category ${droppedCategory})`);
                        }
                    }

                    // ── Batch backfill from nearby database places (shortfall only) ──────
                    // The frontend reveals "View More" only when a full batch is returned
                    // (recommendations.length >= the action's default count). A provider can
                    // under-deliver — e.g. Claude naming only a few real local places, or the
                    // distance filter above dropping out-of-area matches. When that leaves us
                    // short AND we have a location, top the batch up to requestedCount with
                    // additional REAL, in-area database listings of the right type that aren't
                    // already shown. These are genuine local places (never fabricated names),
                    // carry their own coordinates/photos, and need no Google call. DeepSeek
                    // returns full batches, so recommendations.length is already >= requestedCount
                    // and this block is skipped for it entirely — its behaviour is unchanged.
                    if (effectiveLocation && recommendations.length < requestedCount) {
                        try {
                            const alreadyNames = new Set(recommendations.map(r => (r.name || '').toLowerCase().trim()));
                            const alreadyIds   = new Set(recommendations.map(r => r.verifiedId).filter(Boolean));
                            const excludeLower = new Set((excludeNames || []).map(n => (n || '').toLowerCase().trim()));
                            // Pull a wider nearby pool than the original fetch so we have spares.
                            // userRegion is passed through, so this adds no Google API calls
                            // (region detection is skipped and distances are computed locally).
                            const backfillPool = await proximityService.findSmartProximityPlaces(effectiveLocation, preferences, action, userRadius, requestedCount * 3, userRegion, requestId);
                            // Destinations are validator-curated, so their category is
                            // taken at face value here too — no schedule filter (see the
                            // note at the primary destination pull).
                            const spares = [...(backfillPool.businesses || []), ...(backfillPool.destinations || [])]
                                .filter(p => {
                                    if (!p || !p.name) return false;
                                    const nm = p.name.toLowerCase().trim();
                                    const id = p._id ? p._id.toString() : null;
                                    if (id && userDislikedIds.has(id)) return false;   // this user disliked it
                                    return !alreadyNames.has(nm) && !excludeLower.has(nm) && (!id || !alreadyIds.has(id));
                                });
                            let added = 0;
                            for (const place of spares) {
                                if (recommendations.length >= requestedCount) break;
                                const candidate = { name: place.name, source: 'database', data: place };
                                const enrichedData = {
                                    name: place.name,
                                    source: 'database',
                                    photos: (place.images && place.images.length) ? place.images.slice(0, 1) : [],
                                    place_id: null,
                                    formatted_address: place.location?.address || `${place.location?.city || ''}, ${place.location?.region || ''}`,
                                    geometry: place.location?.coordinates ? { location: { lat: place.location.coordinates.lat, lng: place.location.coordinates.lng } } : null
                                };
                                const distanceInfo = place.distance != null ? { distance: place.distanceText, distanceKm: place.distance, duration: place.duration } : null;
                                recommendations.push(createRecommendation(candidate, recommendations.length, enrichedData, distanceInfo));
                                alreadyNames.add(place.name.toLowerCase().trim());
                                if (place._id) alreadyIds.add(place._id.toString());
                                added++;
                            }
                            if (added > 0) { console.log(`[quick-action] backfilled ${added} nearby DB place(s) toward target ${requestedCount} (now ${recommendations.length})`); }
                            else { console.log(`[quick-action] shortfall (${recommendations.length}/${requestedCount}) but no extra in-area DB places to backfill`); }
                        } catch (backfillErr) { console.warn('[quick-action] backfill failed:', backfillErr.message) }
                    }

                    // ── Cache backfill (shortfall only, AFTER DB backfill) ───────────────
                    // When the model ran dry and the DB has no spares either, top the batch
                    // up from PlaceCache: real, in-area places we already verified on an
                    // earlier request, ranked by community feedback (likes - dislikes),
                    // Google rating, this user's preference fit, capped in-app popularity,
                    // and closeness. NO Google calls. Preferences are scored at query time,
                    // never stored on the shared place doc. Same hard gates as a fresh
                    // result (radius from the search center, type, freshness, has-image).
                    if (effectiveLocation && recommendations.length < requestedCount) {
                        try {
                            const haveNames = new Set(recommendations.map(r => (r.name || '').toLowerCase().trim()));
                            const havePlaceIds = recommendations.map(r => r.placeId).filter(Boolean);
                            const cacheSpares = await findCachedBackfill({
                                center: { lat: effectiveLocation.lat, lng: effectiveLocation.lng },
                                radiusKm: userRadius || (nearbyMode ? 5 : 50),
                                action, subType, preferences,
                                excludePlaceIds: [...havePlaceIds, ...(excludePlaceIds || []), ...userDislikedIds],
                                excludeNames: [...haveNames, ...(excludeNames || [])],
                                limit: requestedCount - recommendations.length
                            });
                            let cacheAdded = 0;
                            const servedIds = [];
                            for (const { doc, distanceKm } of cacheSpares) {
                                if (recommendations.length >= requestedCount) break;
                                const nm = (doc.name || '').toLowerCase().trim();
                                if (haveNames.has(nm)) continue;
                                const candidate = { name: doc.name, source: 'cache', data: null };
                                const enrichedData = {
                                    name: doc.name,
                                    source: 'cache',
                                    photos: (doc.photos && doc.photos.length) ? doc.photos.slice(0, 1) : [],
                                    place_id: doc.placeId,
                                    formatted_address: doc.details?.formatted_address || '',
                                    geometry: doc.details?.geometry || null,
                                    types: doc.types || [],
                                    primaryType: doc.primaryType || null,
                                    _fromCache: true
                                };
                                const distanceInfo = { distance: `${distanceKm.toFixed(1)} km`, distanceKm, duration: null };
                                recommendations.push(createRecommendation(candidate, recommendations.length, enrichedData, distanceInfo));
                                haveNames.add(nm);
                                if (doc.placeId) servedIds.push(doc.placeId);
                                cacheAdded++;
                            }
                            if (cacheAdded > 0) {
                                console.log(`[quick-action] backfilled ${cacheAdded} place(s) from PlaceCache (community-ranked) toward target ${requestedCount} (now ${recommendations.length})`);
                                // Count these as real serves so popularity reflects usage.
                                if (servedIds.length) {
                                    PlaceCache.updateMany({ placeId: { $in: servedIds } }, { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } })
                                        .catch(err => console.warn('[quick-action] cache backfill useCount bump failed:', err.message));
                                }
                            }
                        } catch (cacheBackErr) { console.warn('[quick-action] cache backfill failed:', cacheBackErr.message); }
                    }
                    // console.log(`\nFinal recommendations: ${recommendations.length} places`);
                    const uniquePlaces = new Set();
                    recommendations.forEach(rec => { if (rec.name) uniquePlaces.add(rec.name) });
                    // console.log(`\n📊 USAGE TRACKING - PLACES COUNT:`);
                    // console.log(`   Total recommendations: ${recommendations.length}`);
                    // console.log(`   Unique places to track: ${uniquePlaces.size}`);
                    try {
                        if (req.userLimit && uniquePlaces.size > 0) {
                            // console.log(`\n🔄 Updating places count...`);
                            const updateResult = await req.userLimit.checkAndUpdateUsage(0, uniquePlaces.size, 1);
                            // console.log(`\n✅ PLACES UPDATE SUCCESSFUL:`);
                            // console.log(`   Places added: ${uniquePlaces.size}`);
                            // console.log(`   New daily total: ${updateResult.dailyPlacesViewed}`);
                            // console.log(`   Remaining: ${updateResult.dailyPlacesRemaining}`);                         
                            res.set('X-Usage-Places-Viewed', updateResult.dailyPlacesViewed.toString());
                            res.set('X-Usage-Places-Remaining', updateResult.dailyPlacesRemaining.toString());
                        }
                    } catch (error) { 
                        // console.warn('Failed to update places count:', error.message) 
                    }
                    // console.log('Recommendation sources:', recommendations.reduce((acc, rec) => {
                    //     acc[rec.source] = (acc[rec.source] || 0) + 1;
                    //     return acc;
                    // }, {}));
                    if (effectiveLocation && recommendations.length > 0) { 
                        if (nearbyMode) {
                            const NEAR_RANK = { database: 0, google: 1, cache: 2, ai: 3 };
                            recommendations.sort((a, b) => {
                                const ra = NEAR_RANK[a.source] ?? 3;
                                const rb = NEAR_RANK[b.source] ?? 3;
                                if (ra !== rb) return ra - rb;
                                if (a.distanceKm && b.distanceKm) return a.distanceKm - b.distanceKm;
                                if (a.distanceKm && !b.distanceKm) return -1;
                                if (!a.distanceKm && b.distanceKm) return 1;
                                return 0;
                            });
                            // console.log('Sorted by source priority, then distance (nearby mode)');
                        } else {
                            recommendations = separateAndShuffleBySource(recommendations);
                            // console.log('Database first, then shuffled AI (discovery mode)');
                        }
                    } else if (!nearbyMode) {
                        recommendations = separateAndShuffleBySource(recommendations);
                        // console.log('Database first, then shuffled AI (no location)');
                    }
                } catch (aiError) {
                    console.error('OpenAI API error:', aiError.message);
                    throw aiError;
                }
            }
            // What the user sees ABOVE the cards. The quick-action model output is
            // just a list of candidate NAMES (or, in search mode, sometimes a
            // reasoning/refusal paragraph). Either way it is NOT a message meant for
            // the user: the cards below are the verified, filtered result — often
            // topped up from the community cache even when the model itself returned
            // nothing usable. So the lead-in is driven purely by whether we have
            // cards to show, never by the raw model text. This keeps a refusal like
            // "I cannot provide exactly 10…" from ever appearing above a full grid.
            const _leadInByAction = {
                restaurants: 'Here are some places to eat I found near you:',
                hotels: 'Here are some places to stay I found for you:',
                historical: 'Here are some historical spots near you:',
                hidden_gems: 'Here are a few hidden gems near you:',
                photo_spots: 'Here are some photo-worthy spots near you:',
                events: 'Here are a few things happening near you:',
                shopping: 'Here are some places to shop near you:'
            };
            const visibleText = recommendations.length > 0
                ? (_leadInByAction[action] || 'Here are some places I found for you:')
                : "I couldn't find strong matches near you right now — try widening your search radius or a different category.";
            const words = visibleText.split(' ');
            for (let i = 0; i < words.length; i++) {
                if (isClientDisconnected()) {return}
                const word = words[i] + (i < words.length - 1 ? ' ' : '');
                res.write(`data: ${JSON.stringify({ type: 'token', content: word })}\n\n`);
                await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 50));
            }
            await Analytics.create({
                type: 'quick_action_used',
                userId,
                metadata: {
                    sessionId: 'stream_session',
                    value: recommendations.length,
                    action: action,
                    // Shopping resolves to a concrete sub-type (jewelry, market,
                    // …) before any search runs, and that choice is the actual
                    // signal — "Shopping" alone says nothing about what people
                    // are looking for. Null for every other action.
                    subType: subType || null,
                    count: requestedCount,
                    hasLocation: !!effectiveLocation,
                    locationInfo: effectiveLocation ? { source: effectiveLocation.source, city: effectiveLocation.city, country: effectiveLocation.country, privacyMode: effectiveLocation.privacyMode } : null,
                    excludedCount: excludeNames.length,
                    nearbyMode: nearbyMode,
                    preferencesApplied: {budgetFiltered: shouldFilterBudget, interestFiltered: preferences.interests?.length > 0, travelStyle: preferences.travelStyle},
                    usageTracked: { placesCounted: uniquePlaces?.size || 0, tokensUsed: estimatedTokens || 0, dailyTokensRemaining: req.userLimit?.dailyUsage?.tokensRemaining || 0 }
                }
            }).catch(err => console.error('Analytics error:', err));
            // console.log('\n\nDEBUG: Final recommendations before sending:');
            // recommendations.forEach((rec, idx) => {
            //     console.log(`${idx + 1}. ${rec.name}`);
            //     console.log(`   Image: ${rec.image}`);
            //     console.log(`   Address: ${rec.address}`); 
            //     console.log(`   Distance: ${rec.distance}`);
            //     console.log(`   Source: ${rec.source}`);
            //     console.log(`   Has Geometry: ${!!rec.geometry}`);
            // });
            if (!isClientDisconnected()) {
                /* ── AI-found events: validator blocklist + durable record ─────────
                 * Two steps, both scoped to the events action and both before the
                 * internal-field strip below (they read _eventVenue/_eventAddress).
                 *
                 * 1. DROP anything a validator has hidden. Hidden AiFoundEvent docs
                 *    are matched language-free: same venue placeId, or
                 *    eventNamesMatch within the request area. Geo-scoped query so
                 *    the hidden set stays tiny.
                 * 2. RECORD every dated event actually sent, so validators can see
                 *    (and manage) everything Jinni recommends. Upsert by identity
                 *    key — repeat serves only bump timesShown. Best-effort: a
                 *    failure here must never break the response. */
                if (action === 'events') {
                    const _evDay = (d) => { const t = d ? new Date(d) : null; return (t && !isNaN(t.getTime())) ? t.toISOString().slice(0, 10) : null; };
                    try {
                        const cLat = effectiveLocation?.lat, cLng = effectiveLocation?.lng;
                        const recPlaceIds = recommendations.map(r => r.placeId).filter(Boolean);
                        const hiddenQuery = { status: 'hidden', $or: [] };
                        if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
                            hiddenQuery.$or.push({ lat: { $gte: cLat - 1.5, $lte: cLat + 1.5 }, lng: { $gte: cLng - 1.5, $lte: cLng + 1.5 } });
                        }
                        hiddenQuery.$or.push({ lat: null });                       // unresolved venues: name-match only
                        if (recPlaceIds.length) hiddenQuery.$or.push({ placeId: { $in: recPlaceIds } });
                        const hiddenDocs = await AiFoundEvent.find(hiddenQuery).select('name placeId').lean();
                        if (hiddenDocs.length) {
                            const kept = recommendations.filter(r => {
                                const isEvent = !!r?.eventSchedule?.startDate || r.category === 'Event' || r.type === 'events';
                                if (!isEvent) return true;
                                const blocked = hiddenDocs.some(h =>
                                    (r.placeId && h.placeId && r.placeId === h.placeId && eventNamesMatch(r.name, h.name)) ||
                                    eventNamesMatch(r.name, h.name));
                                if (blocked) console.log(`[ai-events] "${r.name}" suppressed — hidden by validator`);
                                return !blocked;
                            });
                            if (kept.length !== recommendations.length) { recommendations.length = 0; recommendations.push(...kept); }
                        }
                    } catch (e) { console.warn('[ai-events] hidden-filter failed (serving unfiltered):', e.message) }
                    try {
                        const TIERS = ['feed', 'listing', 'extracted', 'model'];
                        const ops = [];
                        for (const r of recommendations) {
                            const day = _evDay(r?.eventSchedule?.startDate);
                            if (!day || !r.name) continue;                          // dated events only
                            const norm = _eventTokens(r.name).join(' ') || String(r.name).toLowerCase().trim();
                            const anchor = r.placeId
                                || (Number.isFinite(r.latitude) && Number.isFinite(r.longitude) ? `${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}` : null)
                                || (effectiveLocation?.city || 'unknown');
                            const startDate = new Date(r.eventSchedule.startDate);
                            const rawEnd = r.eventSchedule.endDate ? new Date(r.eventSchedule.endDate) : null;
                            const endDate = (rawEnd && !isNaN(rawEnd.getTime())) ? rawEnd : null;
                            // effectiveLocation can be coordinates-only (GPS or a
                            // destination pin) with no city/country strings; without a
                            // region the staff scope filter can't place the record.
                            // The venue address carries it: "…, Yerevan, Armenia".
                            const region = parseAddressRegion(r._eventAddress || r.address || '');
                            ops.push({ updateOne: {
                                filter: { key: `${norm}|${day}|${anchor}` },
                                update: {
                                    $setOnInsert: {
                                        key: `${norm}|${day}|${anchor}`,
                                        name: r.name,
                                        description: (r.description || '').slice(0, 500) || null,
                                        placeId: r.placeId || null,
                                        lat: Number.isFinite(r.latitude) ? r.latitude : null,
                                        lng: Number.isFinite(r.longitude) ? r.longitude : null,
                                        venueName: r._eventVenue || null,
                                        address: r._eventAddress || r.address || null,
                                        city: effectiveLocation?.city || region.city || null,
                                        country: effectiveLocation?.country || region.country || null,
                                        startDate,
                                        endDate,
                                        isRecurring: !!r.eventSchedule.isRecurring,
                                        sourceUrl: r.sourceUrl || null,
                                        sourceTier: TIERS.includes(r.provenance?.startDate) ? r.provenance.startDate : 'unknown',
                                        status: 'new',
                                        // Queue self-cleans a week after the event passes.
                                        expireAt: new Date((endDate || startDate).getTime() + 7 * 24 * 3600 * 1000),
                                    },
                                    $inc: { timesShown: 1 },
                                    $set: { lastShownAt: new Date() },
                                },
                                upsert: true,
                            } });
                        }
                        if (ops.length) {
                            AiFoundEvent.bulkWrite(ops, { ordered: false })
                                .then(() => console.log(`[ai-events] recorded ${ops.length} served event(s) for the validator queue`))
                                .catch(err => console.warn('[ai-events] record failed:', err.message));
                        }
                    } catch (e) { console.warn('[ai-events] capture failed:', e.message) }
                }
                // Strip internal-only fields (used by the type sanity filter) so they
                // don't bloat the payload sent to the client.
                recommendations.forEach(r => { delete r.placeTypes; delete r.placePrimaryType; delete r.requestedName; delete r._isDateCard; delete r._eventVenue; delete r._eventAddress; });
                // console.log('\n📤 Sending completion with recommendations...');
                const completionPayload = {
                    type: 'complete',
                    recommendations: recommendations,
                    metadata: {
                        timestamp: new Date(),
                        action,
                        count: requestedCount,
                        hasLocation: !!effectiveLocation,
                        locationInfo: effectiveLocation ? {source: effectiveLocation.source, city: effectiveLocation.city, country: effectiveLocation.country, privacyMode: effectiveLocation.privacyMode} : null,
                        totalResults: recommendations.length,
                        uniquePlacesCounted: uniquePlaces.size, 
                        locationUsed: !!effectiveLocation,
                        excludedCount: excludeNames.length,
                        searchContext: searchContext,
                        nearbyMode: nearbyMode,
                        searchRadius: userRadius,
                        radiusMode: nearbyMode ? 'nearby' : 'discovery',
                        preferencesApplied: {budgetFiltered: shouldFilterBudget, interestFiltered: preferences.interests?.length > 0, travelStyle: preferences.travelStyle},
                        usageTracked: {placesCounted: uniquePlaces.size, tokensUsed: estimatedTokens, dailyTokensRemaining: req.userLimit?.dailyUsage?.tokensRemaining || 0, dailyPlacesRemaining: req.userLimit?.dailyUsage?.placesRemaining || 0 }
                    }
                };
                // console.log('\n📤 Sending completion with usage tracking:', {
                //     recommendations: completionPayload.recommendations.length,
                //     placesCounted: completionPayload.metadata.uniquePlacesCounted,
                //     tokensUsed: completionPayload.metadata.usageTracked.tokensUsed
                // });
                // console.log('📦 Completion payload structure:', Object.keys(completionPayload));
                // console.log('📦 Recommendations in payload:', completionPayload.recommendations.length);  
                // TRACK VIEWS
                const verifiedRecs = recommendations.filter(r => r.verifiedId);
                if (verifiedRecs.length > 0) {
                    const businessIds = verifiedRecs.filter(r => r._verifiedModel === 'business').map(r => r.verifiedId);
                    const destinationIds = verifiedRecs.filter(r => r._verifiedModel === 'destination').map(r => r.verifiedId);
                    if (businessIds.length > 0) { Business.updateMany({ _id: { $in: businessIds } }, { $inc: { 'analytics.views': 1 } }).catch(err => console.error('Business view tracking error:', err)) }
                    if (destinationIds.length > 0) { Destination.updateMany({ _id: { $in: destinationIds } }, { $inc: { 'analytics.views': 1 } }).catch(err => console.error('Destination view tracking error:', err)) }
                }
                // Record the quick-action category on every Google/cache place we are
                // actually SHOWING (DB rows have no PlaceCache doc). This is what the
                // cache backfill later filters on, so a place is only ever served back
                // under a category a real user was shown it under — no type-guessing,
                // and no cross-category leakage (a Historical place is never tagged
                // 'events', so it can't surface there). Runs only for survivors of the
                // filters, so resolved-but-dropped rejects are never tagged.
                const shownPlaceIds = [...new Set(recommendations.map(r => r.placeId).filter(Boolean))];
                if (shownPlaceIds.length > 0 && action) {
                    /* ── 'events' is never written to the cache ───────────────────────
                     * `actions` means "this place belongs in that category", and the
                     * tagger infers it from "was shown under it". That inference holds
                     * for restaurants or historical sites and is FALSE for events: what
                     * gets shown under an event is its VENUE. Tagging it turned Zazoo
                     * Rooftop, the Opera Theatre, Yerevan Zoo and a dozen other venues
                     * into permanent "events", which the backfill then served as undated
                     * Event cards forever. An event is a moment in time; a cache of
                     * places cannot hold one, so events are simply never cached.
                     */
                    if (action !== 'events') {
                        PlaceCache.updateMany({ placeId: { $in: shownPlaceIds }, actionsCurated: { $ne: true } }, { $addToSet: { actions: action } })
                            .catch(err => console.warn('[quick-action] action-tag update failed:', err.message));
                    }
                }
                // For event places, also persist the event's date onto the cache doc
                // so the admin cache view can show WHEN a cached venue was last shown
                // as an event. Per-place values, so a bulkWrite (one op per dated event
                // place); best-effort, never blocks the response. Only event recs carry
                // eventSchedule, so this naturally scopes to events.
                if (action === 'events') {
                    const eventOps = [];
                    const seenEvt = new Set();
                    for (const r of recommendations) {
                        const rawStart = r?.eventSchedule?.startDate;
                        if (!r.placeId || !rawStart || seenEvt.has(r.placeId)) continue;
                        // startDate/endDate arrive as ISO strings for AI events and as
                        // Dates for DB-business events. Convert explicitly so a string is
                        // never stored in the Date field regardless of bulkWrite casting.
                        const startDate = new Date(rawStart);
                        if (isNaN(startDate.getTime())) continue;          // skip unparseable
                        const rawEnd = r.eventSchedule.endDate;
                        const endDate = rawEnd ? new Date(rawEnd) : null;
                        seenEvt.add(r.placeId);
                        eventOps.push({
                            updateOne: {
                                filter: { placeId: r.placeId },
                                update: { $set: { eventSchedule: {
                                    startDate,
                                    endDate: (endDate && !isNaN(endDate.getTime())) ? endDate : null,
                                    isRecurring: !!r.eventSchedule.isRecurring
                                } } }
                            }
                        });
                    }
                    if (eventOps.length) {
                        PlaceCache.bulkWrite(eventOps, { ordered: false })
                            .catch(err => console.warn('[quick-action] event-date cache update failed:', err.message));
                    }
                }
                res.write(`data: ${JSON.stringify(completionPayload)}\n\n`);
                // console.log('✅ Completion sent successfully');                  
                res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
                res.end();
                // console.log('✅ Response stream closed');
            } else { console.log('⚠️ Client disconnected - skipping completion') }
        } catch (actionError) {
            console.error('Action processing error:', actionError);
            res.write(`data: ${JSON.stringify({type: 'error', message: messages.processing_error, debug: actionError.message})}\n\n`);
        }
        const apiStats = googleService.getRequestStats(requestId);
        const totalCalls = (apiStats.findPlaces || 0) + (apiStats.getPlaceDetails || 0) + (apiStats.calculateDistances || 0) + (apiStats.imageDownload || 0) + (apiStats.prefetchSearch || 0);
        // console.log(`\n\n📊 [${requestId}] API CALLS SUMMARY (FINAL):`);
        // console.log(`   Total Google API Calls: ${totalCalls}`);
        // console.log(`   findPlaces: ${apiStats.findPlaces || 0}`);
        // console.log(`   getPlaceDetails: ${apiStats.getPlaceDetails || 0}`);
        // console.log(`   reverseGeocode: ${apiStats.reverseGeocode || 0}`);
        // console.log(`   calculateDistances: ${apiStats.calculateDistances || 0}`);
        // console.log(`   imageDownload (Photos): ${apiStats.imageDownload || 0}`);
        // if (apiStats.imageDownload > 0) {
        //     console.log(`\n   💡 Image Downloads Breakdown:`);
        //     console.log(`      - New images fetched from Google: ${apiStats.imageDownload}`);
        //     console.log(`      - Served from cache: Check PlaceCache hits`);
        // }
        googleService.clearRequestStats(requestId);
        // console.log(`\n========= [${requestId}] QUICK ACTION STREAM END =========\n\n`);
        if (!isClientDisconnected) { res.end() }
    } catch (error) {
        console.error('Main error:', error);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Failed to process quick action', message: error.message, stack: error.stack }));
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: messages.quick_action_failed, debug: error.message })}\n\n`);
            res.end();
        }
    }
});

const separateAndShuffleBySource = (recommendations) => {
    const databaseRecs = recommendations.filter(r => r.source === 'database');
    // Google-prefetched places are real and ranked; keep them ordered, above AI.
    const googleRecs = recommendations.filter(r => r.source === 'google');
    // PlaceCache backfill: real, previously-verified places already ordered by the
    // community-ranked score. Keep that order, placed above the shuffled AI picks.
    const cacheRecs = recommendations.filter(r => r.source === 'cache');
    const aiRecs = recommendations.filter(r => r.source === 'ai');
    // Safety net: any rec with an unexpected/missing source must still survive.
    // (A previous version returned only database+google+ai, which silently dropped
    // cache-backfilled recs — the batch reached the target server-side but lost one
    // before sending, so "View More" never appeared.)
    const known = new Set(['database', 'google', 'cache', 'ai']);
    const otherRecs = recommendations.filter(r => !known.has(r.source));
    for (let i = aiRecs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [aiRecs[i], aiRecs[j]] = [aiRecs[j], aiRecs[i]];
    }
    return [...databaseRecs, ...googleRecs, ...cacheRecs, ...aiRecs, ...otherRecs];
};

const getCategoryFromAction = (actionType, userLanguage = 'en', subType = null) => {return getCategoryFromActionType(actionType, userLanguage, subType)};
function getCategoryFromActionType(actionType, userLanguage = 'en', subType = null) {
    // Shopping sub-types get their own card label ("Jewelry", "Mall", …) so a
    // jewelry result doesn't just read "Shop". Falls back to the generic shop
    // label when no/unknown sub-type is supplied.
    const SHOPPING_SUBTYPE_KEY = {
        souvenirs: 'souvenir_shop',
        clothing:  'clothing_store',
        market:    'market',
        mall:      'mall',
        jewelry:   'jewelry_shop',
        food:      'food_shop'
    };
    if (actionType === 'shopping' && subType && SHOPPING_SUBTYPE_KEY[subType]) {
        const k = SHOPPING_SUBTYPE_KEY[subType];
        const subTranslations = {
            souvenir_shop:  {'en':'Souvenir Shop','ru':'Сувенирный магазин','zh':'纪念品店','hy':'Հուշանվերների խանութ','fr':'Boutique de souvenirs','ar':'متجر هدايا'},
            clothing_store: {'en':'Clothing Store','ru':'Магазин одежды','zh':'服装店','hy':'Հագուստի խանութ','fr':'Magasin de vêtements','ar':'متجر ملابس'},
            market:         {'en':'Market','ru':'Рынок','zh':'市场','hy':'Շուկա','fr':'Marché','ar':'سوق'},
            mall:           {'en':'Mall','ru':'Торговый центр','zh':'购物中心','hy':'Առևտրի կենտրոն','fr':'Centre commercial','ar':'مركز تسوق'},
            jewelry_shop:   {'en':'Jewelry','ru':'Ювелирные изделия','zh':'珠宝店','hy':'Ոսկերչական','fr':'Bijouterie','ar':'مجوهرات'},
            food_shop:      {'en':'Food & Gourmet','ru':'Гастрономия','zh':'美食店','hy':'Սննդի խանութ','fr':'Épicerie fine','ar':'متجر أطعمة'}
        };
        return subTranslations[k]?.[userLanguage] || subTranslations[k]?.['en'];
    }
    const categoryKeyMap = {
        'hotels': 'hotel',
        'hotel': 'hotel',
        'restaurants': 'restaurant',
        'restaurant': 'restaurant',
        'historical': 'historical',
        'hidden_gems': 'hidden_gem',
        'hidden': 'hidden_gem',
        'events': 'event',
        'event': 'event',
        'photo_spots': 'photo_spot',
        'photography': 'photo_spot',
        'shopping': 'shop',
        'shops': 'shop',
        'attractions': 'attraction',
        'attraction': 'attraction',
        'accommodation': 'hotel',
        'dining': 'restaurant',
        'food': 'restaurant',
        'eat': 'restaurant',
        'stay': 'hotel',
        'history': 'historical',
        'heritage': 'historical',
        'ancient': 'historical',
        'monument': 'historical',
        'secret': 'hidden_gem',
        'local': 'hidden_gem',
        'gems': 'hidden_gem',
        'activity': 'event',
        'activities': 'event',
        'festival': 'event',
        'celebration': 'event'
    };
    const categoryKey = categoryKeyMap[actionType.toLowerCase()] || 'attraction';    
    const translations = {
        'hotel': {'en': 'Hotel','ru': 'Отель','zh': '酒店','hy': 'Հյուրանոց','fr': 'Hôtel','ar': 'فندق'},
        'restaurant': {'en': 'Restaurant','ru': 'Ресторан','zh': '餐厅','hy': 'Ռեստորան','fr': 'Restaurant','ar': 'مطعم'},
        'historical': {'en': 'Historical Site','ru': 'Историческое место','zh': '历史遗址','hy': 'Պատմական վայր','fr': 'Site historique','ar': 'موقع تاريخي'},
        'hidden_gem': {'en': 'Hidden Gem','ru': 'Скрытая жемчужина','zh': '隐藏宝藏','hy': 'Թաքնված գանձ','fr': 'Trésor caché','ar': 'جوهرة مخفية'},
        'event': {'en': 'Event','ru': 'Событие','zh': '活动','hy': 'Միջոցառում','fr': 'Événement','ar': 'حدث'},
        'photo_spot': {'en': 'Photo Spot','ru': 'Фотолокация','zh': '拍照地点','hy': 'Լուսանկարման վայր','fr': 'Spot photo','ar': 'موقع تصوير'},
        'shop': {'en': 'Shop','ru': 'Магазин','zh': '商店','hy': 'Խանութ','fr': 'Boutique','ar': 'متجر'},
        'attraction': {'en': 'Attraction','ru': 'Достопримечательность','zh': '景点','hy': 'Տեսարժան վայր','fr': 'Attraction','ar': 'معلم سياحي'}
    };
    return translations[categoryKey]?.[userLanguage] || translations[categoryKey]?.['en'] || 'Attraction';
}

function getMaxCount(action) {
    const limits = { 'restaurants': 30, 'hotels': 30, 'historical': 25, 'hidden_gems': 25, 'events': 25, 'photo_spots': 25, 'shopping': 25 };
    return limits[action] || 12;
}

function calculateTokenLimit(count, action) {
    const baseTokens = 50;
    const tokensPerRec = { 'restaurants': 10, 'hotels': 10, 'historical': 10, 'hidden_gems': 10, 'events': 10, 'photo_spots': 10, 'shopping': 10 };
    const perRecToken = tokensPerRec[action] || 10;
    return Math.min(baseTokens + (count * perRecToken), 300);
}

function generateTargetedPrompt(action, searchContext, preferences, requestedCount, excludeNames, subType = null, googleCandidates = [], knownCachedNames = []) {
    const excludeText = excludeNames.length > 0 ? `\n\nPERMANENT EXCLUSIONS: Do not suggest: ${excludeNames.join(', ')}` : '';
    // ── Google prefetch shortlist ──────────────────────────────────────────────
    // When the quick-action prefetch is enabled for this action, we hand the
    // model a list of REAL, currently-operating places near the user and ask it
    // to RANK/FILTER them against the traveler's profile (plus optionally add a
    // few it's confident about), instead of recalling local names from scratch.
    // Empty list (prefetch off / no results) → block is omitted and the model
    // behaves exactly as before.
    //
    // If prefetch supplied nothing but cache-curation is on, we instead show the
    // model the strong places we ALREADY hold and ask it to suggest places BEYOND
    // them — the opposite framing: prefetch says "prefer these", curation says
    // "prefer NEW ones, fall back to these". Only one of the two is ever active per
    // request (prefetch wins) so the prompt never carries contradictory signals.
    const candidateText = (Array.isArray(googleCandidates) && googleCandidates.length)
        ? `\n        CANDIDATE SHORTLIST (real, currently-open places near ${searchContext} — strongly prefer choosing from these):\n        ${googleCandidates.map(c => c.name).filter(Boolean).join(', ')}\n        From this shortlist pick the ones that best match the traveler. You MAY add a few additional real, verifiable places you are confident exist in ${searchContext} if they fit the traveler better — but never invent names.`
        : (Array.isArray(knownCachedNames) && knownCachedNames.length)
        ? `\n        ALREADY IN OUR SYSTEM near ${searchContext} — places we can already show, with how our travelers received them (INTERNAL context: never mention these numbers, ratings-counts or "verified" labels in your reply):\n        ${knownCachedNames.join('\n        ')}\n        Use this as evidence about the area, then do better than it:\n        - Prefer EXCELLENT real, verifiable places that are NOT on this list, so the traveler's choices keep widening.\n        - Do NOT re-suggest a listed place that travelers received poorly (more disliked than liked).\n        - You MAY include a listed place when it is genuinely among the best answers for this traveler — especially a staff-verified or well-liked one.\n        - Never invent names.`
        : '';
    // ── Photo spots ───────────────────────────────────────────────────────────
    // Not a business category — it's a "what's worth photographing" lens over a
    // place. Every interest a user can pick (nature, adventure, cultural,
    // history, art, nightlife, food & drink, relaxation, family, romantic) maps
    // to a concrete *visual* brief so the same button gives a nature lover
    // landscapes, an art lover murals/architecture, a romantic traveler sunset
    // backdrops, etc. Mirrors the per-interest criteria the other actions build.
    if (action === 'photo_spots') {
        // Canonicalise interest tokens so 'food & drink' / 'food&drink' /
        // 'food_drink' all collapse to the same key.
        const normInterest = (i) => i.toLowerCase().trim()
            .replace(/\s*&\s*/g, '_')   // "food & drink" -> "food_drink"
            .replace(/\s+/g, '_')       // any stray spaces -> underscore
            .replace(/_and_/g, '_');    // "food_and_drink" -> "food_drink"
        const PHOTO_INTEREST_CRITERIA = {
            nature:      'sweeping landscapes, mountains, lakes, waterfalls, forests, and scenic natural overlooks',
            adventure:   'dramatic vantage points reached on foot, cliffs, gorges, canyons, and rugged outdoor scenery',
            cultural:    'colorful local neighborhoods, traditional architecture, lively markets, and authentic street scenes',
            history:     'historic landmarks, monuments, old fortresses, churches, and heritage sites',
            art:         'street art and murals, sculptures, galleries, and striking modern or unusual architecture',
            nightlife:   'illuminated skylines, city lights at night, neon-lit streets, and rooftop night views',
            food_drink:  'atmospheric cafés, colorful food markets, and stylish rooftop or view-side dining spots',
            relaxation:  'calm, serene spots — gardens, quiet waterfronts, and peaceful viewpoints away from crowds',
            family:      'easy-to-reach, open spots that work for family photos — parks, squares, and gentle viewpoints',
            romantic:    'scenic romantic backdrops — sunset viewpoints, charming old streets, and intimate settings'
        };
        const criteria = (preferences.interests || []).map(normInterest).map(k => PHOTO_INTEREST_CRITERIA[k]).filter(Boolean);
        const interestText = criteria.length
            ? `\n        Tailor the selection to this traveler's interests — favor: ${criteria.join('; ')}.`
            : '';
        return `As a local photography guide for ${searchContext}, recommend EXACTLY ${requestedCount} of the most photogenic places — scenic viewpoints, panoramic overlooks, iconic landmarks, striking architecture, picturesque old streets, colorful or unusual spots, and beautiful natural settings that visitors can actually reach and photograph.${interestText}
        Prioritize places genuinely known for how they look, not generic listings.${candidateText}
        RESPONSE FORMAT:
        [Place 1], [Place 2], ... [Place ${requestedCount}]
        (ONLY names in brackets, no explanations)${excludeText}`;
    }
    // ── Shopping (sub-type driven) ──────────────────────────────────────────────
    // The button asks a follow-up question first, so subType is normally set.
    // Each sub-type maps to a concrete "what to look for" phrase; an unknown or
    // missing subType falls back to a sensible general-shopping prompt.
    if (action === 'shopping') {
        const SHOPPING_PROMPTS = {
            souvenirs: 'souvenir and gift shops selling local mementos, postcards, and keepsakes',
            clothing:  'clothing and fashion stores, boutiques, and apparel shops — include a mix of options for women, men, and unisex',
            market:    'markets, bazaars, farmers markets, and street markets',
            mall:      'shopping malls and large shopping centers with many stores under one roof',
            jewelry:   'jewelry shops and stores selling fine jewelry, gold, and gemstones',
            food:      'gourmet food shops selling local edible specialties — sweets, chocolate, spices, tea, coffee, wine and spirits, and regional delicacies to take home'
        };
        const target = SHOPPING_PROMPTS[subType] || 'notable shops, markets, and shopping destinations worth visiting';
        return `As a local shopping guide for ${searchContext}, recommend EXACTLY ${requestedCount} ${target}.
        Only suggest real, existing places that visitors can actually go to — well-regarded local spots are better than generic chains.${candidateText}
        RESPONSE FORMAT:
        [Place 1], [Place 2], ... [Place ${requestedCount}]
        (ONLY names in brackets, no explanations)${excludeText}`;
    }
    // ── Events ──────────────────────────────────────────────────────────────────
    // Deliberately a LOOSE ask. The generic builder layers on luxury/verified/
    // interest constraints that make a cautious model refuse ("I cannot provide
    // exactly N luxury family-friendly events with verified dates…"). For events we
    // want breadth and a real date when there is one: upcoming public happenings
    // (festivals, concerts, exhibitions, shows) mixed with ongoing family-friendly
    // venues/activities. Interests are a soft preference, never a hard filter, and
    // the model is told explicitly not to refuse.
    if (action === 'events') {
        const todayISO = new Date().toISOString().slice(0, 10);
        // Travelers plan the week in front of them, not the season. A festival two
        // months out is trivia; something on Saturday is a plan. So the window is
        // the next 7 days, with anything further out allowed only as a fallback
        // when the week is genuinely empty.
        const weekEndISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const softInterests = (preferences.interests || []).filter(Boolean);
        const interestHint = softInterests.length
            ? `\n        If it fits, lean toward things that suit these interests (a soft preference, not a filter): ${softInterests.join(', ')}.`
            : '';
        return `As a local what's-on guide for ${searchContext}, list up to ${requestedCount} public events HAPPENING in the NEXT 7 DAYS (${todayISO} to ${weekEndISO}): festivals, concerts, exhibitions, performances, screenings, markets, sports fixtures, seasonal celebrations.
        Every item must be something that HAPPENS on a date — not a place that is simply open. A museum, park or attraction belongs here only when it is hosting a specific dated event this week (an opening, a concert, a temporary exhibition), and then the EVENT is what you list, not the venue.
        If the week is genuinely thin, you may reach up to a month ahead rather than pad the list with permanent attractions. Returning fewer real events is better than filling space.${interestHint}${candidateText}
        Favor real events you are confident are actually scheduled in ${searchContext}. Do NOT refuse and do NOT explain.
        RESPONSE FORMAT — output ONLY bracketed items, nothing else:
        [Event or place name | START_DATE | END_DATE | VENUE | ADDRESS | SOURCE_URL]
        - START_DATE is REQUIRED and is an ISO date (YYYY-MM-DD) — an item with no date is not an event; leave it out. END_DATE only for multi-day events: [Name | START_DATE | | VENUE | ADDRESS] for a single day.
        - VENUE is REQUIRED whenever you know it, and is WHERE THE EVENT ACTUALLY TAKES PLACE — the hall, museum, park, or street it is held at (e.g. "Cafesjian Center for the Arts", "Saryan Street"). It is NOT the organizing company or its office. Leave it empty if you are not sure.
        - ADDRESS is the street address or district of that venue, if you know it. Leave it empty if you are not sure.
        - SOURCE_URL is the listing or official page you actually SAW in your search results for this event — the page the date came from. Copy it exactly. Leave it empty if the event comes from memory rather than a page you just read; never construct or guess a URL.
        - Never invent a venue or address. An empty field is always better than a guessed one — the place is looked up afterwards, and a wrong venue puts the event on the map in the wrong spot.
        - Only include dated events on or after ${todayISO}; never list past events.${excludeText}`;
    }

    const allInterests = preferences.interests || [];
    // Occasion interests (family | romantic) describe atmosphere/suitability and
    // belong in the REQUIREMENTS block — a place isn't "known for romantic", it
    // IS romantic. Discovery interests (cultural, nature, food…) are the ones a
    // place can be "known for", so only those feed the TARGET / known-for lines.
    const OCCASION_INTERESTS = ['family', 'romantic'];
    const discoveryInterests = allInterests.filter(i => !OCCASION_INTERESTS.includes(i.toLowerCase()));
    const travelStyle = preferences.travelStyle?.toLowerCase() || 'solo';
    const budget = preferences.budget || null;
    let shouldFilterBudget = preferences.budget?.min && preferences.budget?.max && !(preferences.budget.min === 0 && preferences.budget.max === 0);
    let interestCriteria = [];
    // Iterate ALL interests here so occasion interests (family/romantic) can add
    // their own per-action criteria. discoveryInterests is used only for the
    // "known for X" phrasing in the prompt template below — a place is "known
    // for" cultural/nature, but it IS family-friendly/romantic, not "known for" it.
    allInterests.forEach(interest => {
        // Canonicalise so "Food & Drink", "Food&Drink" and "Food and Drink" all
        // resolve to the same key — otherwise a stored variant that doesn't
        // lowercase to exactly "food & drink" would silently contribute no
        // criteria (the interest would be applied nowhere, with no error).
        const currentInterest = String(interest).toLowerCase().trim()
            .replace(/\s+and\s+/g, ' & ')
            .replace(/\s*&\s*/g, ' & ')
            .replace(/\s+/g, ' ')
            .trim();
        switch (currentInterest) {
            case 'nature':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('restaurants with outdoor seating, garden settings, scenic natural views');
                        break;
                    case 'hotels':
                        interestCriteria.push('hotels with direct access to nature trails, mountain/forest views from rooms, located near natural attractions');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('natural hidden spots like waterfalls, hiking trails, scenic viewpoints');
                        break;
                    case 'historical':
                        interestCriteria.push('historical sites in natural settings outdoor heritage locations');
                        break;
                    case 'events':
                        interestCriteria.push('outdoor events, nature activities, eco-tourism experiences');
                        break;
                }
                break;
            case 'nightlife':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('restaurants with evening entertainment, rooftop dining, late-night options');
                        break;
                    case 'hotels':
                        interestCriteria.push('hotels near nightlife districts, with bars/lounges, in vibrant evening areas');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('unique evening spots, rooftop bars, atmospheric night venues');
                        break;
                    case 'historical':
                        interestCriteria.push('historic buildings that are active in evening hours, illuminated at night');
                        break;
                    case 'events':
                        interestCriteria.push('evening events, night tours, cultural performances, nightlife activities');
                        break;
                }
                break;
            case 'cultural':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('authentic local restaurants, traditional cuisine, culturally significant dining');
                        break;
                    case 'hotels':
                        interestCriteria.push('boutique hotels with local character, heritage properties, culturally immersive stays');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('local cultural spots, artisan workshops, authentic neighborhood gems');
                        break;
                    case 'historical':
                        interestCriteria.push('significant cultural heritage sites, museums, traditional landmarks');
                        break;
                    case 'events':
                        interestCriteria.push('cultural festivals, art exhibitions, traditional performances, local celebrations');
                        break;
                }
                break;
            case 'adventure':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('restaurants near adventure activities, with unique adventurous dining experiences');
                        break;
                    case 'hotels':
                        interestCriteria.push('adventure-focused hotels, mountain lodges, accommodation near activity hubs');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('off-the-beaten-path adventure spots, challenging hikes, adrenaline activities');
                        break;
                    case 'historical':
                        interestCriteria.push('historical sites requiring hiking exploration to reach');
                        break;
                    case 'events':
                        interestCriteria.push('adventure activities, outdoor sports, hiking events, physical challenges');
                        break;
                }
                break;
            case 'food & drink':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('exceptional dining experiences, local specialties, renowned culinary establishments');
                        break;
                    case 'hotels':
                        interestCriteria.push('hotels with excellent restaurants, culinary programs, food-focused amenities');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('hidden culinary gems, local markets, authentic food experiences');
                        break;
                    case 'historical':
                        interestCriteria.push('food heritage sites, traditional markets, historic wineries, culinary landmarks');
                        break;
                    case 'events':
                        interestCriteria.push('food festivals, wine tastings, cooking classes, culinary tours');
                        break;
                }
                break;
            case 'art':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('restaurants in artistic neighborhoods, artistic atmosphere');
                        break;
                    case 'hotels':
                        interestCriteria.push('boutique hotels with art galleries, artistic design');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('hidden art studios, local galleries, street art locations, artistic workshops');
                        break;
                    case 'historical':
                        interestCriteria.push('art museums, historic artistic sites, sculpture gardens');
                        break;
                    case 'events':
                        interestCriteria.push('art exhibitions, gallery openings, artist talks, creative workshops');
                        break;
                }
                break;
            case 'history':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('historic restaurants');
                        break;
                    case 'hotels':
                        interestCriteria.push('historic hotels');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('lesser-known historical sites, local heritage spots, historical neighborhoods');
                        break;
                    case 'historical':
                        interestCriteria.push('major historical landmarks, monuments, archaeological sites, museums');
                        break;
                    case 'events':
                        interestCriteria.push('historical reenactments, heritage tours, museum events');
                        break;
                }
                break;
            case 'relaxation':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('peaceful restaurants with tranquil atmosphere, wellness-focused dining');
                        break;
                    case 'hotels':
                        interestCriteria.push('spa hotels, wellness retreats, peaceful accommodation with relaxation amenities');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('serene hidden spots, quiet retreats, peaceful natural locations');
                        break;
                    case 'historical':
                        interestCriteria.push('peaceful historical sites, gardens, contemplative heritage locations');
                        break;
                    case 'events':
                        interestCriteria.push('wellness events, spa treatments, meditation sessions, relaxation experiences');
                        break;
                }
                break;
            case 'family':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('family-friendly restaurants with kids menus, high chairs, relaxed casual atmosphere, space for groups');
                        break;
                    case 'hotels':
                        interestCriteria.push('family hotels with connecting rooms or family suites, kids amenities, pools, family-friendly facilities');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('family-friendly hidden spots, easy accessible trails, parks and playgrounds suitable for children');
                        break;
                    case 'historical':
                        interestCriteria.push('kid-friendly historical sites, interactive or hands-on museums, sites with engaging family tours');
                        break;
                    case 'events':
                        interestCriteria.push('family-friendly events, activities suitable for children, daytime festivals and shows for all ages');
                        break;
                }
                break;
            case 'romantic':
                switch (action) {
                    case 'restaurants':
                        interestCriteria.push('intimate restaurants with candlelit ambiance, couples seating, quiet romantic atmosphere, fine dining for two');
                        break;
                    case 'hotels':
                        interestCriteria.push('romantic hotels with couples suites, private balconies or scenic views, honeymoon-friendly amenities, intimate boutique stays');
                        break;
                    case 'hidden_gems':
                        interestCriteria.push('secluded romantic spots, scenic viewpoints for two, quiet intimate locations off the beaten path');
                        break;
                    case 'historical':
                        interestCriteria.push('atmospheric historical sites ideal for couples, scenic heritage settings, evening or candlelit tours');
                        break;
                    case 'events':
                        interestCriteria.push('romantic events, evening concerts or shows, intimate experiences suited to couples');
                        break;
                }
                break;
        }
    });
    let qualityRequirements = '';
    // travelStyle now carries the PRICE axis only (luxury | budget). The
    // occasion axis (family | romantic) moved to interests, so we read those
    // from allInterests below. Legacy users may still have travelStyle set to
    // 'family'/'romantic' — we treat that as an occasion signal too so their
    // saved preferences keep working until the data migration runs.
    switch (travelStyle) {
        case 'luxury':
            qualityRequirements += 'LUXURY: Luxurious recommendations only ';
            break;
        case 'budget':
            qualityRequirements += 'BUDGET: Great value options while maintaining quality ';
            break;
    }
    // Occasion emphasis — sourced from interests, with legacy travelStyle fallback.
    const occasionSignals = new Set([
        ...allInterests.map(i => i.toLowerCase()),
        travelStyle // legacy: old accounts may still have 'family'/'romantic' here
    ]);
    if (occasionSignals.has('family')) { qualityRequirements += 'FAMILY-FRIENDLY: Suitable for families with children ' }
    if (occasionSignals.has('romantic')) { qualityRequirements += 'ROMANTIC: Intimate atmosphere and couples-friendly ' }
    if (shouldFilterBudget) {
        if (qualityRequirements) qualityRequirements += '| ';
        const userCurrency = budget.currency || 'USD';
        const currencySymbols = { 'USD': '$', 'EUR': '€', 'GBP': '£', 'RUB': '₽' };
        const symbol = currencySymbols[userCurrency] || userCurrency;
        if (userCurrency !== 'USD') {
            const normalizedBudget = currencyService.normalizeBudgetToUSD(budget);
            qualityRequirements += `BUDGET: ${symbol}${budget.min.toLocaleString()}-${symbol}${budget.max.toLocaleString()} ${userCurrency} `;
            qualityRequirements += `(USD: $${normalizedBudget.min.toFixed(2)}-$${normalizedBudget.max.toFixed(2)}) `;
        } else { qualityRequirements += `BUDGET RANGE: ${symbol}${budget.min.toLocaleString()}-${symbol}${budget.max.toLocaleString()} USD` }
    }
    // excludeText is declared at the top of the function (shared with the
    // photo_spots / shopping branches), so we reuse it here.
    // Discovery interests drive the "known for X" phrasing; when a traveler
    // picked only occasion interests (family/romantic) discoveryInterests is
    // empty, so we fall back to profile/requirements-driven phrasing instead of
    // rendering an empty interest list.
    const hasDiscovery = discoveryInterests.length > 0;
    // interestCriteria can be populated by occasion interests (family/romantic)
    // even when there are no discovery interests, so append it in both branches.
    const criteriaText = interestCriteria.length ? ` with this criteria: ${interestCriteria.join('; ')}` : '';
    const targetLine = hasDiscovery ? `TARGET: Find ${action} that STRONGLY match ALL of these interests: ${discoveryInterests.join(', ')}${criteriaText}` : `TARGET: Find ${action} that best fit the traveler's profile and the requirements below${criteriaText}`;
    const priorityLine = hasDiscovery ? `IMPORTANT: Each recommendation must strongly match at least one of the user's interests - prioritize places genuinely known for ${discoveryInterests.join(' or ')} rather than generic options that only loosely relate` : `IMPORTANT: Prioritize places that genuinely satisfy the requirements above rather than generic options`;
    const prompt = `As a travel specialist for ${searchContext}, recommend EXACTLY ${requestedCount} ${action}.
        ${targetLine}
        REQUIREMENTS: ${qualityRequirements}
        ${priorityLine}${candidateText}
        RESPONSE FORMAT: 
        [Place 1], [Place 2], ... [Place ${requestedCount}] 
        (ONLY names in brackets, no explanations)${excludeText}`;
    return prompt;
}

function getSearchContext(location, userRegion) { return userRegion?.city && userRegion?.country ? `${userRegion.city}, ${userRegion.country}` : 'Global destinations' }

function detectPreferenceConflict(userMessage, userPreferences) {
    const message = userMessage.toLowerCase();
    const conflicts = [];    
    if (message.length < 10) {return conflicts}
    const countMatches = (keywords) => {return keywords.filter(keyword => message.includes(keyword)).length};    
    const INTEREST_CLUSTERS = {
        cultureHeritage: ['cultural', 'history', 'art'],
        outdoorWellness: ['nature', 'relaxation'],
        activeSocial: ['adventure', 'nightlife'],
        universal: ['food & drink']
    };
    const savedInterests = userPreferences.interests || [];
    const savedCount = savedInterests.length;    
    const normalizedSaved = savedInterests.map(i => i.toLowerCase().replace(/_/g, ' ').replace(/&/g, 'and').trim());
    // RULE 1: Check for culture cluster overload (3+ from cultural/history/art)
    const cultureClusterCount = normalizedSaved.filter(i => INTEREST_CLUSTERS.cultureHeritage.includes(i)).length;
    if (cultureClusterCount >= 3) {
        conflicts.push({type: 'cluster_overload',cluster: 'culture',saved: INTEREST_CLUSTERS.cultureHeritage.filter(i => normalizedSaved.includes(i)),message: 'focus_culture',confidence: 'high',action: 'update_preferences'});
        console.log('⚠️ Culture cluster overload detected');
        return conflicts;
    }    
    const currentStyle = userPreferences.travelStyle?.toLowerCase();
    // travelStyle is now the PRICE axis only (luxury | budget). family/romantic
    // became interests, so they're detected via interestKeywords below — not
    // here. Keeping only luxury/budget means a saved-luxury user who asks for
    // "cheap" options still gets the price-contradiction notice, which is the
    // one style conflict that genuinely matters.
    const styleKeywords = {
        luxury: ['luxury', 'luxurious', 'upscale', 'high-end', 'high end', 'premium', '5-star', '5 star', 'exclusive', 'deluxe', 'elegant', 'finest', 'fancy', 'posh'],
        budget: ['budget', 'cheap', 'affordable', 'inexpensive', 'economical', 'low-cost', 'low cost', 'value', 'reasonable', 'bargain']
    };
    for (const [style, keywords] of Object.entries(styleKeywords)) {
        if (currentStyle && style !== currentStyle) {
            const matchCount = countMatches(keywords);
            if (matchCount >= 1) {
                const currentStyleKeywords = styleKeywords[currentStyle] || [];
                const hasCurrentStyleToo = countMatches(currentStyleKeywords) >= 1;
                if (!hasCurrentStyleToo) {
                    conflicts.push({type: 'travelStyle',saved: currentStyle,detected: style,confidence: matchCount >= 2 ? 'high' : 'medium'});
                    break;
                }
            }
        }
    }    
    const strongKeywords = {
        nature: ['nature', 'hiking', 'trekking', 'wildlife', 'wilderness'],
        nightlife: ['nightlife', 'bar', 'bars', 'club', 'clubs', 'party', 'clubbing', 'nightclub'],
        cultural: ['cultural', 'folklore', 'ethnic', 'traditional'],
        history: ['historical', 'archaeological', 'ancient', 'ruins', 'heritage'],
        art: ['gallery', 'galleries', 'exhibition', 'artwork', 'museum'],
        'food & drink': ['culinary', 'gastronomy', 'gastronomic', 'gourmet'],
        adventure: ['adventure', 'extreme', 'adrenaline', 'climbing'],
        relaxation: ['spa', 'wellness', 'meditation', 'yoga'],
        // Occasion interests (moved off travelStyle). Strong keywords are the
        // unambiguous ones — "honeymoon"/"date night" almost always mean romantic.
        family: ['family-friendly', 'family friendly', 'kid-friendly', 'with kids', 'for kids', 'for families'],
        romantic: ['honeymoon', 'date night', 'anniversary', 'candlelit', 'couples']
    };
    const interestKeywords = {
        nature: ['nature', 'hiking', 'hike', 'outdoor', 'outdoors', 'mountains', 'mountain', 'forest', 'park', 'parks', 'garden', 'trail', 'trails', 'wildlife', 'scenic', 'waterfall', 'lake', 'trekking', 'trek', 'wilderness','beach', 'beaches', 'countryside', 'safari', 'canyon'],
        nightlife: ['nightlife', 'bar', 'bars', 'club', 'clubs', 'party', 'parties', 'clubbing', 'night out', 'nightclub', 'pub', 'pubs', 'lounge', 'late night', 'late-night', 'live music', 'dance', 'dancing','cocktail', 'beer','brewery', 'rooftop bar'],
        cultural: ['cultural', 'culture', 'traditional', 'authentic', 'local customs', 'local experience', 'traditions', 'folklore', 'ethnic', 'native', 'artisan', 'heritage site','ceremony'],
        history: ['history', 'historical', 'historic', 'ancient', 'heritage', 'museum', 'museums', 'monument', 'monuments', 'ruins', 'archaeological', 'medieval', 'old town', 'fortress', 'castle', 'temple', 'shrine', 'relic'],
        art: ['art', 'arts', 'gallery', 'galleries', 'exhibition', 'artwork', 'artistic', 'contemporary art', 'modern art', 'sculpture', 'painting', 'installation', 'street art', 'mural', 'artist'],
        'food & drink': ['food', 'restaurant', 'restaurants', 'dining', 'culinary', 'wine', 'cuisine', 'eat', 'eating', 'meal', 'lunch', 'dinner', 'breakfast', 'cafe', 'cafes', 'coffee', 'tasting', 'gastronomy', 'bistro', 'foodie', 'gourmet'],
        adventure: ['adventure', 'adventurous', 'extreme', 'adrenaline', 'climbing', 'rafting', 'thrill', 'thrilling', 'zip line', 'zipline', 'rock climbing', 'bungee', 'paragliding', 'kayaking', 'challenging', 'off-road', 'expedition'],
        relaxation: ['relaxation', 'relax', 'relaxing', 'spa', 'spas', 'wellness', 'peaceful', 'tranquil', 'calm', 'serene', 'massage', 'meditation', 'yoga', 'hot springs', 'thermal', 'sauna', 'retreat'],
        family: ['family', 'families', 'kids', 'children', 'child', 'family-friendly', 'family friendly', 'kid-friendly', 'playground', 'with kids', 'for kids', 'for families'],
        romantic: ['romantic', 'romance', 'couples', 'couple', 'honeymoon', 'intimate', 'date night', 'anniversary', 'for two', 'candlelit', 'private', 'cozy']
    };    
    const detectedInterests = [];
    for (const [interest, keywords] of Object.entries(interestKeywords)) {
        const normalizedInterest = interest.toLowerCase().replace('&', 'and').trim();
        const hasInterestSaved = normalizedSaved.includes(normalizedInterest);
        if (!hasInterestSaved) {
            const matchCount = countMatches(keywords);            
            const strongMatches = strongKeywords[interest] || [];
            const hasStrongKeyword = strongMatches.some(keyword => message.includes(keyword));            
            if (hasStrongKeyword || matchCount >= 2) {detectedInterests.push({interest: normalizedInterest,matchCount: matchCount,hasStrongKeyword: hasStrongKeyword,confidence: hasStrongKeyword || matchCount >= 3 ? 'high' : 'medium'})}
        }
    }
    const highConfidenceNew = detectedInterests.filter(d => d.confidence === 'high');
    // RULE 2: User has 6+ interests AND asking about 3+ new ones
    if (savedCount >= 6 && highConfidenceNew.length >= 3) {
        conflicts.push({type: 'too_scattered',savedCount: savedCount,detectedCount: highConfidenceNew.length,detected: highConfidenceNew.map(d => d.interest),message: 'too_many_total',confidence: 'high',action: 'update_preferences'});
        console.log('⚠️ Too scattered: 6+ saved interests + 3+ new detected');
        return conflicts;
    }
    // RULE 3: Check if query itself spans 4+ distinct categories
    const categoriesInQuery = new Set();
    detectedInterests.forEach(d => {
        if (INTEREST_CLUSTERS.cultureHeritage.includes(d.interest)) {categoriesInQuery.add('culture')} 
        else if (INTEREST_CLUSTERS.outdoorWellness.includes(d.interest)) {categoriesInQuery.add('outdoor')} 
        else if (INTEREST_CLUSTERS.activeSocial.includes(d.interest)) {categoriesInQuery.add('active')} 
        else if (INTEREST_CLUSTERS.universal.includes(d.interest)) {} 
        else {categoriesInQuery.add(d.interest)}
    });
    if (categoriesInQuery.size >= 4) {
        conflicts.push({type: 'query_too_broad',categories: Array.from(categoriesInQuery),detected: detectedInterests.map(d => d.interest),message: 'narrow_query',confidence: 'high',action: 'update_preferences'});
        console.log('⚠️ Query too broad: 4+ distinct categories');
        return conflicts;
    }
    // RULE 4: Conflicting outdoor preferences (nature + relaxation, but asking about adventure)
    const hasNature = normalizedSaved.includes('nature');
    const hasRelaxation = normalizedSaved.includes('relaxation');
    const askingAdventure = highConfidenceNew.some(d => d.interest === 'adventure');
    if (hasNature && hasRelaxation && askingAdventure) {
        conflicts.push({type: 'conflicting_outdoor',saved: ['nature', 'relaxation'],detected: 'adventure',message: 'outdoor_conflict',confidence: 'medium',action: 'clarify_preferences'});
        console.log('⚠️ Conflicting outdoor interests');
        return conflicts;
    }
    // RULE 5: Original logic - single interest suggestions (only if no major conflicts)
    if (highConfidenceNew.length > 0 && conflicts.length === 0) {conflicts.push({type: 'interest',detected: highConfidenceNew.map(d => d.interest).join(', '),interests: highConfidenceNew.map(d => d.interest),confidence: 'high',count: highConfidenceNew.length})}
    // console.log('🔍 Preference conflicts detected:', conflicts);
    return conflicts;
}

function getAllMessages(userLanguage = 'en') {
    const translations = {
        'en': {
            location_required: 'Location is required for recommendations.',
            location_no_coordinates: 'No valid destination coordinates set',
            location_gps_unavailable: 'GPS enabled but no location available. Please set a destination.',
            location_required_details: 'Location is required for recommendations. Please enable location access or select a city in your settings.',
            location_set_destination: 'Please set your travel destination in Settings or enable GPS location detection.',
            location_suggestion_1: 'Open Settings → Travel Destination → Use the map to select your location',
            location_suggestion_2: 'Or enable "Use My Current Location" in Privacy settings',
            stream_interrupted: 'Stream interrupted',
            connection_error: "I'm having trouble connecting right now. Please try again!",
            processing_error: 'Error processing request. Please try again.',
            quick_action_failed: 'Failed to process quick action',
            cooldown_simple: 'AI services are currently on cooldown. Available again in 4 hours.',
        },
        'ru': {
            location_required: 'Для рекомендаций требуется местоположение.',
            location_no_coordinates: 'Нет действительных координат назначения',
            location_gps_unavailable: 'GPS включен, но местоположение недоступно. Пожалуйста, установите пункт назначения.',
            location_required_details: 'Для рекомендаций требуется местоположение. Пожалуйста, включите доступ к местоположению или выберите город в настройках.',
            location_set_destination: 'Пожалуйста, установите пункт назначения в Настройках или включите определение GPS.',
            location_suggestion_1: 'Откройте Настройки → Пункт назначения → Используйте карту для выбора местоположения',
            location_suggestion_2: 'Или включите "Использовать мое текущее местоположение" в настройках конфиденциальности',
            stream_interrupted: 'Поток прерван',
            connection_error: 'У меня проблемы с подключением. Пожалуйста, попробуйте еще раз!',
            processing_error: 'Ошибка обработки запроса. Пожалуйста, попробуйте еще раз.',
            quick_action_failed: 'Не удалось обработать быстрое действие',
            cooldown_simple: 'Сервисы ИИ временно недоступны. Доступны снова через 4 часа.',
        },
        'hy': {
            location_required: 'Խորհուրդների համար անհրաժեշտ է տեղակայությունը։',
            location_no_coordinates: 'Վավեր նպատակակետի կոորդինատներ չկան',
            location_gps_unavailable: 'GPS-ը միացված է, բայց տեղակայությունը հասանելի չէ։ Խնդրում ենք սահմանել նպատակակետ։',
            location_required_details: 'Խորհուրդների համար անհրաժեշտ է տեղակայությունը։ Խնդրում ենք միացնել տեղակայության հասանելիությունը կամ ընտրել քաղաք կարգավորումներում։',
            location_set_destination: 'Խնդրում ենք սահմանել ձեր ճանապարհորդության նպատակակետը Կարգավորումներում կամ միացնել GPS որոշումը։',
            location_suggestion_1: 'Բացեք Կարգավորումներ → Ճանապարհորդության նպատակակետ → Օգտագործեք քարտեզը տեղակայությունը ընտրելու համար',
            location_suggestion_2: 'Կամ միացրեք "Օգտագործել իմ ընթացիկ տեղակայությունը" Գաղտնիության կարգավորումներում',
            stream_interrupted: 'Հոսքը ընդհատվեց',
            connection_error: 'Ես կապի խնդիրներ ունեմ։ Խնդրում ենք կրկին փորձել։',
            processing_error: 'Հարցումը մշակելու սխալ։ Խնդրում ենք կրկին փորձել։',
            quick_action_failed: 'Չհաջողվեց մշակել արագ գործողությունը',
            cooldown_simple: 'AI ծառայությունները ժամանակավորապես անհասանելի են։ Կրկին հասանելի կլինեն 4 ժամից։',
        },
        'zh': {
            location_required: '推荐需要位置信息。',
            location_no_coordinates: '没有设置有效的目的地坐标',
            location_gps_unavailable: 'GPS已启用但无法获取位置。请设置目的地。',
            location_required_details: '推荐需要位置信息。请在设置中启用位置访问或选择一个城市。',
            location_set_destination: '请在设置中设置您的旅行目的地或启用GPS位置检测。',
            location_suggestion_1: '打开设置 → 旅行目的地 → 使用地图选择您的位置',
            location_suggestion_2: '或在隐私设置中启用“使用我的当前位置”',
            stream_interrupted: '流中断',
            connection_error: '我现在连接有问题。请重试！',
            processing_error: '处理请求时出错。请重试。',
            quick_action_failed: '处理快速操作失败',
            cooldown_simple: 'AI服务当前处于冷却期。将在4小时后再次可用。',
        },
        'fr': {
            location_required: 'La localisation est requise.',
            location_no_coordinates: 'Aucune coordonnée de destination valide définie',
            location_gps_unavailable: 'GPS activé mais aucune localisation disponible. Veuillez définir une destination.',
            location_required_details: 'La localisation est requise pour les recommandations. Veuillez activer l\'accès à la localisation ou sélectionner une ville dans vos paramètres.',
            location_set_destination: 'Veuillez définir votre destination de voyage dans Paramètres ou activer la détection GPS.',
            location_suggestion_1: 'Ouvrez Paramètres → Destination de voyage → Utilisez la carte pour sélectionner votre emplacement',
            location_suggestion_2: 'Ou activez "Utiliser ma position actuelle" dans les paramètres de confidentialité',
            stream_interrupted: 'Flux interrompu',
            connection_error: 'J\'ai des difficultés de connexion. Veuillez réessayer !',
            processing_error: 'Erreur lors du traitement de la demande. Veuillez réessayer.',
            quick_action_failed: 'Échec du traitement de l\'action rapide',
            cooldown_simple: 'Les services IA sont en période de refroidissement. Disponibles dans 4 heures.',
        },
        'ar': {
            location_required: 'الموقع مطلوب.',
            location_no_coordinates: 'لم يتم تعيين إحداثيات وجهة صالحة',
            location_gps_unavailable: 'تم تمكين GPS ولكن لا يتوفر موقع. يرجى تعيين وجهة.',
            location_required_details: 'الموقع مطلوب للتوصيات. يرجى تمكين الوصول إلى الموقع أو تحديد مدينة في إعداداتك.',
            location_set_destination: 'يرجى تعيين وجهة سفرك في الإعدادات أو تمكين اكتشاف موقع GPS.',
            location_suggestion_1: 'افتح الإعدادات → وجهة السفر → استخدم الخريطة لتحديد موقعك',
            location_suggestion_2: 'أو فعّل "استخدام موقعي الحالي" في إعدادات الخصوصية',
            stream_interrupted: 'تم مقاطعة التدفق',
            connection_error: 'أواجه مشكلة في الاتصال الآن. يرجى المحاولة مرة أخرى!',
            processing_error: 'خطأ في معالجة الطلب. يرجى المحاولة مرة أخرى.',
            quick_action_failed: 'فشل في معالجة الإجراء السريع',
            cooldown_simple: 'خدمات الذكاء الاصطناعي في فترة تهدئة. ستكون متاحة خلال 4 ساعات.',
        },
    };
    return translations[userLanguage] || translations['en'];
}

router.get('/cached-place/:placeId', auth, async (req, res) => {
    try {
        const { placeId } = req.params;
        if (!placeId) { return res.status(400).json({ success: false, error: 'Place ID required' }) }
        const cached = await PlaceCache.findOne({ placeId });
        const CACHE_VALIDITY_DAYS = 30;
        const isCacheValid = cached && (Date.now() - cached.lastFetched) < (CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
        if (isCacheValid) {
            console.log(`✅ Serving ${cached.name} from cache (no API call)`);            
            return res.json({
                success: true,
                fromCache: true,
                data: {
                    name: cached.name,
                    place_id: placeId,
                    formatted_address: cached.details.formatted_address,
                    photos: cached.photos.map(p => ({ url: p.url, width: p.width, height: p.height })),
                    geometry: cached.details.geometry
                }
            });
        }
        console.log(`❌ Cache miss for ${placeId}, fetching from Google`);
        const details = await getCachedPlaceDetails(placeId, false);
        if (details) { return res.json({ success: true, fromCache: false, data: details }) } 
        else { return res.status(404).json({ success: false, error: 'Place not found' }) }
    } catch (error) {
        console.error('Cached place endpoint error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch place details', message: error.message });
    }
});

router.get('/place-details/:placeId', auth, usageTracker, async (req, res) => {
    try {
        if (req.userLimit) {
            const status = await req.userLimit.getUsageStatus();
            if (status.cooldown.active) {
                console.log(`🚫 Place details request blocked - user on cooldown`);
                return res.status(429).json({ success: false, error: 'cooldown', message: `AI services are currently on cooldown. Available again in ${status.cooldown.hoursRemaining} hours.`, cooldownUntil: status.cooldown.until });
            }            
            const estimatedTokens = 30;
            await req.userLimit.checkAndUpdateUsage(estimatedTokens, 0, 0);
        }
        const { placeId } = req.params;
        console.log(`\n🔍 [PLACE-DETAILS] called with placeId: "${placeId}"`);
        // ── STEP A: MongoDB ID check (DB businesses / destinations) ──────────
        const mongoose = require('mongoose');
        const isMongoId = mongoose.Types.ObjectId.isValid(placeId);
        console.log(`🔍 [PLACE-DETAILS] isMongoId: ${isMongoId}`);
        if (isMongoId) {
            // Apply the same status+freshness gate the chat/quick-action paths
            // use. This handles the late-click case: an AI response from
            // earlier in the session might surface a listing that has since
            // expired (event ended) or been frozen. Without this filter the
            // user would still get the full place details. With it, the
            // findOne returns null and we fall through to the Google place
            // lookup below — same as if the placeId had never matched.
            const discFilter = proximityService.discoverabilityFilter();
            let dbRecord = await Business.findOne({_id: placeId, isActive: true, status: discFilter.status, $and: discFilter.$and}).lean();
            console.log(`🔍 [PLACE-DETAILS] Business.findOne result: ${dbRecord ? dbRecord.name : 'NOT FOUND'}`);
            let recordType = 'business';
            if (!dbRecord) {
                dbRecord = await Destination.findById(placeId).lean();
                recordType = 'destination';
                console.log(`🔍 [PLACE-DETAILS] Destination.findById result: ${dbRecord ? dbRecord.name : 'NOT FOUND'}`);
            }
            if (dbRecord) {
                console.log(`✅ [PLACE-DETAILS] Returning DB record for: ${dbRecord.name}`);
                // Track the click
                if (recordType === 'business') { Business.findByIdAndUpdate(placeId, { $inc: { 'analytics.clicks': 1 } }).catch(() => {}) } 
                else { Destination.findByIdAndUpdate(placeId, { $inc: { 'analytics.clicks': 1 } }).catch(() => {}) }
                // Build a rich response from DB fields
                // For events, also pass eventSchedule and a computed _isExpired
                // flag so the modal can show the date/time and an "Ended" badge
                // without re-implementing the rule client-side. Applies to BOTH
                // record types: destinations tagged 'events' are validator-
                // curated concerts/festivals and carry the same schedule shape
                // as event businesses.
                let _isExpired = false;
                if (Array.isArray(dbRecord.type) && dbRecord.type.includes('events')
                    && !dbRecord.eventSchedule?.isRecurring) {
                    const end = dbRecord.eventSchedule?.endDate || dbRecord.eventSchedule?.startDate;
                    if (end) _isExpired = new Date(end).getTime() < Date.now();
                }
                const dbDetails = {
                    name: dbRecord.name,
                    address: dbRecord.location?.address ? `${dbRecord.location.address}${dbRecord.location.city ? ', ' + dbRecord.location.city : ''}` : dbRecord.location?.city || null,
                    phone: dbRecord.contact?.phone || null,
                    website: dbRecord.contact?.website || null,
                    email: dbRecord.contact?.showEmail ? (dbRecord.contact?.email || null) : null,
                    socialMedia: dbRecord.contact?.socialMedia || null,
                    pricing: dbRecord.pricing?.range ? `${dbRecord.pricing.range} ${dbRecord.pricing.currency || 'USD'}` : null,
                    description: dbRecord.description?.short || dbRecord.description?.detailed || dbRecord.description || null,
                    highlights: dbRecord.description?.highlights?.length ? dbRecord.description.highlights : (dbRecord.highlights?.length ? dbRecord.highlights : null),
                    rating: dbRecord.rating || null,
                    hours: null,
                    isOpenNow: null,
                    businessStatus: dbRecord.isActive ? 'OPERATIONAL' : 'CLOSED_PERMANENTLY',
                    photos: dbRecord.images?.length ? dbRecord.images.slice(0, 1) : [],
                    geometry: dbRecord.location?.coordinates ? { location: { lat: dbRecord.location.coordinates.lat, lng: dbRecord.location.coordinates.lng } } : null,
                    // Event-specific (null when irrelevant). Modal renders the
                    // Event Schedule row only when eventSchedule is truthy.
                    eventSchedule: dbRecord.eventSchedule || null,
                    _isExpired,
                    type: Array.isArray(dbRecord.type) ? dbRecord.type : null,
                    source: 'database'
                };
                console.log(`✅ [PLACE-DETAILS] dbDetails being sent:`, JSON.stringify(dbDetails, null, 2));
                return res.json({ success: true, data: dbDetails });
            }
        }
        // ── STEP B: Google / PlaceCache fallback (non-MongoDB IDs) ──────────
        console.log(`🔍 [PLACE-DETAILS] falling through to Google/PlaceCache for: "${placeId}"`);
        const details = await getCachedPlaceDetails(placeId, true, `details-${Date.now()}`);
        if (details) {
            // TRACK CLICKS — try Business first, then Destination
            const placeName = details.name;
            const clickedBusiness = await Business.findOneAndUpdate({ name: { $regex: new RegExp(`^${escapeRegExp(placeName)}$`, 'i') }, isActive: true }, { $inc: { 'analytics.clicks': 1 } }).lean();
            if (!clickedBusiness) { Destination.findOneAndUpdate({ name: { $regex: new RegExp(`^${escapeRegExp(placeName)}$`, 'i') }, isActive: true }, { $inc: { 'analytics.clicks': 1 } }).catch(err => console.error('Destination click tracking error:', err)) }
            const formattedDetails = {
                name: details.name,
                address: details.formatted_address,
                phone: details.international_phone_number || details.formatted_phone_number,
                website: details.website,
                rating: details.rating,
                businessStatus: details.business_status,
                hours: details.opening_hours?.weekday_text || null,
                isOpenNow: details.opening_hours?.open_now || null,
                photos: details.photos?.slice(0, 1).map((photo, index) => `/api/ai/place-image/${placeId}/${index}`) || [],
                geometry: details.geometry
            };
            res.json({ success: true, data: formattedDetails });
        } else { res.status(404).json({ success: false, error: 'Place not found' }) }
    } catch (error) {
        if (error.message.includes('cooldown') || error.message.includes('limit')) { return res.status(429).json({success: false, error: 'cooldown', message: error.message}) }
        console.error('Place details API error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch place details', message: error.message });
    }
});

router.post('/feedback/:queryId', auth, async (req, res) => {
    try {
        const { queryId } = req.params;
        const { rating, comments, wasHelpful } = req.body;
        // Scope to the owner: without the userId filter any user could overwrite
        // feedback on any query by id (and inject arbitrary `comments` text, which
        // is a stored-XSS risk if surfaced in an admin panel). Assumes TravelQuery
        // has a `userId` field — if feedback stops saving, that field is named
        // differently and the filter needs adjusting.
        const updated = await TravelQuery.findOneAndUpdate({ _id: queryId, userId: req.user.id }, { feedback: { rating, comments, wasHelpful } });
        if (!updated) { return res.status(404).json({ success: false, error: 'Query not found' }) }
        res.json({ success: true, message: 'Feedback saved successfully' });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to save feedback' }) }
});

router.post('/save-chat-title', auth, async (req, res) => {
    try {
        const { sessionId, title } = req.body;
        const updated = await ChatSession.findOneAndUpdate( { _id: sessionId, userId: req.user.id }, { title, updatedAt: new Date() } );
        if (!updated) { return res.status(404).json({ success: false, error: 'Session not found' }) }
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving chat title:', error);
        res.status(500).json({ success: false, error: 'Failed to save title' });
    }
});

router.get('/chat-sessions/:id', auth, async (req, res) => {
    try {
        const session = await ChatSession.findOne({ _id: req.params.id, userId: req.user.id }).lean();
        if (!session) { return res.status(404).json({ error: 'Session not found' }) }
        console.log(`📋 Loading session ${session._id} with ${session.messages?.length || 0} messages`);        
        let needsEnrichment = false;
        for (const msg of session.messages || []) {
            if (msg.recommendations?.some(r => r.placeId && !r.image)) {
                needsEnrichment = true;
                break;
            }
        }
        if (!needsEnrichment) {
            console.log('✅ Session has all images - no enrichment needed');
            return res.json(session);
        }        
        console.log('🔄 Enriching session with cached images...');
        for (const msg of session.messages || []) {
            if (msg.recommendations?.length > 0) {
                for (const rec of msg.recommendations) {
                    if (rec.placeId && !rec.image) {
                        const cached = await PlaceCache.findOne({ placeId: rec.placeId, imagesStored: true });
                        if (cached) {
                            rec.image = `/api/ai/place-image/${rec.placeId}/0`;
                            // console.log(`  ✅ Enriched ${rec.name} from cache`);
                        } else { console.log(`  ⚠️ ${rec.name} not in cache`) }
                    }
                }
            }
        }
        console.log('✅ Session enrichment complete (0 API calls)');
        res.json(session);
    } catch (error) {
        console.error('Get session error:', error);
        res.status(500).json({ error: 'Failed to load session' });
    }
});

router.get('/chat-sessions', auth, async (req, res) => {
    try {
        const sessions = await ChatSession.find({ userId: req.user.id }).sort({ updatedAt: -1 }).lean();
        // console.log(`📋 Serving ${sessions.length} sessions (no API calls)`);
        res.json(sessions);
    } catch (error) {
        console.error('List sessions error:', error);
        res.status(500).json({ error: 'Failed to load sessions' });
    }
});

router.post('/chat-sessions', auth, async (req, res) => {
    try {
        // userId LAST so a `userId` in the request body can't override the real
        // owner (mass-assignment spoofing). Spreading req.body first, owner second.
        const session = new ChatSession({ ...req.body, userId: req.user.id });
        await session.save();
        res.json(session);
    } catch (error) { res.status(500).json({ error: 'Failed to create session' }) }
});

router.patch('/chat-sessions/:id', auth, async (req, res) => {
  try {
    const session = await ChatSession.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      {
        $set: {
          messages: await Promise.all(req.body.messages.map(async msg => {
            const messageData = {
              id: msg.id,
              sender: msg.sender,
              text: msg.text,
              timestamp: new Date(msg.timestamp),
              streaming: msg.streaming || false,
              isChatRecommendation: msg.isChatRecommendation || false,
              actionType: msg.actionType,
              viewMoreCount: msg.viewMoreCount,
              isViewMore: msg.isViewMore || false,
              isLoadingMore: msg.isLoadingMore || false,
              ...(msg.quickActions && { quickActions: msg.quickActions }),
              // Id of a generated itinerary rendered on this AI message. Must be
              // whitelisted here or the PATCH strips it and the itinerary
              // vanishes after a refresh (frontend + schema alone are not enough).
              ...(msg.itineraryId && { itineraryId: msg.itineraryId }),
              feedback: msg.feedback || null,
              ...(msg.contentParts && { contentParts: msg.contentParts })
            };
            if (msg.recommendations && msg.recommendations.length > 0) {
              messageData.recommendations = msg.recommendations.map(rec => ({
                id: rec.id,
                name: rec.name,
                category: rec.category,
                type: rec.type,
                description: rec.description || '',
                image: rec.cachedImageUrl || rec.image,
                address: rec.address,
                location: rec.location,
                distance: rec.distance,
                rating: rec.rating,
                placeId: rec.placeId,
                // Coordinates for the recommendation map. Without these in this
                // backend whitelist, the save drops them and the map disappears
                // after a refresh — even if the frontend sent them.
                latitude:  rec.latitude  ?? null,
                longitude: rec.longitude ?? null,
                phone:     rec.phone ?? null,
                verifiedId: rec.verifiedId || null,
                source: rec.source || null,
                isPartner: rec.isPartner || false,
                partnerTier: rec.partnerTier || null,
                _verifiedModel: rec._verifiedModel || null,
                // Quick-action this rec was shown under. Persisted so a dislike
                // tapped after a session reload is still scoped to the right action.
                ...(rec._action && { _action: rec._action }),
                website: rec.website,
                photos: rec.photos || [],
                // Event-specific fields. Persisted so the rec card's date/time
                // row still renders after the session is reloaded from history.
                // Absent on non-event recs — the spread keeps the doc clean.
                ...(rec.eventSchedule && { eventSchedule: rec.eventSchedule }),
                ...(rec._isExpired != null && { _isExpired: rec._isExpired }),
                // The listing the date came from, the venue the event is held at,
                // and which fields the listing (rather than the model) supplied.
                // Without these in the whitelist a reloaded session silently loses
                // its "check the listing" link and its date provenance, while the
                // eventSchedule above survives — leaving a date on screen with no
                // way to tell where it came from.
                ...(rec.sourceUrl && { sourceUrl: rec.sourceUrl }),
                ...(rec.venueName && { venueName: rec.venueName }),
                ...(rec.venuePlaceId && { venuePlaceId: rec.venuePlaceId }),
                ...(rec.provenance && { provenance: rec.provenance }),
                feedback: rec.feedback || null
              }));
              // console.log(`💾 Saved ${messageData.recommendations.length} recommendations without re-enrichment`); // ⬅️ FIXED: Changed from backtick to parentheses
            }
            return messageData;
          })),
          title: req.body.title,
          updatedAt: new Date()
        }
      },
      { new: true, lean: true }
    );
    if (!session) { return res.status(404).json({ error: 'Session not found' }) }
    res.json(session);
  } catch (error) {
    console.error('Update session error:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

router.delete('/chat-sessions/all', auth, async (req, res) => {
    try {
        const userId = req.userId || req.user?.id || req.user?._id;
        if (!userId) {
            console.error('❌ No user ID found in request');
            return res.status(401).json({ error: 'User ID not found', debug: {hasReqUser: !!req.user, hasReqUserId: !!req.userId} });
        }
        const result = await ChatSession.deleteMany({ userId });
        const user = await User.findById(userId).select('email name');
        if (user?.email) {emailService.sendChatSessionsDeletedEmail(user.email, user.name).then(() => console.log(`✅ Chat sessions deleted email sent to ${user.email}`)).catch(err => console.error('⚠️ Failed to send chat sessions deleted email:', err.message))}
        res.json({success: true, deletedCount: result.deletedCount, message: 'All chat sessions deleted successfully'});
    } catch (error) {
        console.error('❌ Delete all chats error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({error: 'Failed to delete all chat sessions', details: error.message});
    }
});

router.delete('/chat-sessions/:id', auth, async (req, res) => {
    try {
        const deleted = await ChatSession.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
        if (!deleted) { return res.status(404).json({ error: 'Session not found' }) }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to delete session' }) }
});

router.post('/generate-chat-title', auth, async (req, res) => {
    try {
        const { messages } = req.body;
        const userId = req.user.id;        
        const user = await User.findById(userId).select('settings');
        const userLanguage = user?.settings?.language || 'en';
        const firstUserMessage = messages.find(m => m.sender === 'user')?.text || '';
        const firstAIResponse = messages.find(m => m.sender === 'ai')?.text || '';        
        const prompts = {
            'en': `Generate a very short (2-5 word) title for this chat that captures the main theme or purpose.
                Don't use direct quotes. The title should be expressive and engaging.
                Examples: "Romantic Getaway" or "Historical Sites Exploration"
                User: "${firstUserMessage}"
                AI: "${firstAIResponse}"
                Title:`,
            'ru': `Сгенерируйте очень короткое (2-5 слов) название для этого чата, которое отражает основную тему или цель.
                Не используйте прямые цитаты. Название должно быть выразительным и привлекательным.
                Примеры: "Романтическое путешествие" или "Исследование исторических мест"
                Пользователь: "${firstUserMessage}"
                AI: "${firstAIResponse}"
                Название:`,
            'zh': `为此聊天生成一个非常简短（2-5个词）的标题，捕捉主要主题或目的。
                不要使用直接引用。标题应该富有表现力和吸引力。
                示例："浪漫之旅"或"历史遗址探索"
                用户："${firstUserMessage}"
                AI："${firstAIResponse}"
                标题：`,
            'hy': `Ստեղծեք շատ կարճ (2-5 բառ) վերնագիր այս զրույցի համար, որը արտացոլում է հիմնական թեման կամ նպատակը։
                Մի օգտագործեք ուղղակի մեջբերումներ։ Վերնագիրը պետք է լինի արտահայտիչ և գրավիչ։
                Օրինակներ՝ «Ռոմանտիկ ճանապարհորդություն» կամ «Պատմական վայրերի հետազոտություն»
                Օգտատեր՝ "${firstUserMessage}"
                AI՝ "${firstAIResponse}"
                Վերնագիր՝`,
            'fr': `Générez un titre très court (2-5 mots) pour cette conversation qui capture le thème principal ou l'objectif.
                N'utilisez pas de citations directes. Le titre doit être expressif et engageant.
                Exemples : "Escapade romantique" ou "Exploration de sites historiques"
                Utilisateur : "${firstUserMessage}"
                AI : "${firstAIResponse}"
                Titre :`,
            'ar': `أنشئ عنوانًا قصيرًا جدًا (2-5 كلمات) لهذه المحادثة يلتقط الموضوع الرئيسي أو الهدف.
                لا تستخدم اقتباسات مباشرة. يجب أن يكون العنوان معبرًا وجذابًا.
                أمثلة: "رحلة رومانسية" أو "استكشاف المواقع التاريخية"
                المستخدم: "${firstUserMessage}"
                الذكاء الاصطناعي: "${firstAIResponse}"
                العنوان:`
        };
        const prompt = prompts[userLanguage] || prompts['en'];
        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
            messages: [
                { 
                    role: "system", 
                    content: "You are an assistant that generates concise, engaging titles for chat conversations. Focus on the essence of the conversation, not literal words. Respond with just the title text." 
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 20
        });
        const title = completion.choices[0].message.content.replace(/["']/g, '').trim();
        res.json({ success: true, title });
    } catch (error) {
        console.error('Title generation error:', error);
        res.status(500).json({ success: false, error: 'Failed to generate title' });
    }
});

router.post('/image-request-only', auth, handleImageRequestOnly);

router.get('/test-google-apis', auth, async (req, res) => {
    console.log('Testing Google APIs...');
    console.log('API Key exists:', !!process.env.GOOGLE_API_KEY);
    console.log('API Key preview:', process.env.GOOGLE_API_KEY?.substring(0, 10) + '...');
    const results = {};
    try {
        const placesUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=restaurant+yerevan&inputtype=textquery&key=${process.env.GOOGLE_API_KEY}`;
        const placesResponse = await fetch(placesUrl);
        const placesData = await placesResponse.json();
        results.places = { status: placesResponse.status, data: placesData };
        console.log('Places API test:', placesData.status);
    } catch (error) {
        results.places = { error: error.message };
        console.log('Places API error:', error.message);
    }
    try {
        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=40.1776,44.5126&key=${process.env.GOOGLE_API_KEY}`;
        const geocodeResponse = await fetch(geocodeUrl);
        const geocodeData = await geocodeResponse.json();
        results.geocoding = { status: geocodeResponse.status, data: geocodeData };
        console.log('Geocoding API test:', geocodeData.status);
    } catch (error) {
        results.geocoding = { error: error.message };
        console.log('Geocoding API error:', error.message);
    }
    try {
        const distanceUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=40.1776,44.5126&destinations=40.1830,44.5162&key=${process.env.GOOGLE_API_KEY}`;
        const distanceResponse = await fetch(distanceUrl);
        const distanceData = await distanceResponse.json();
        results.distance = { status: distanceResponse.status, data: distanceData };
        console.log('Distance Matrix API test:', distanceData.status);
    } catch (error) {
        results.distance = { error: error.message };
        console.log('Distance Matrix API error:', error.message);
    }
    res.json(results);
});

router.post('/test-prompt-debug', auth, async (req, res) => {
    try {
        const { action, location, count = 5, excludeNames = [], preferences = {} } = req.body;
        const userRegion = location ? await googleService.detectUserRegion(location) : null;
        const searchContext = getSearchContext(location, userRegion);
        const prompt = generateTargetedPrompt(action, searchContext, preferences, count, excludeNames);
        const completion = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "deepseek-v4-pro", messages: [ {role: "user", content: prompt + "\n\nPlease also explain your reasoning for these suggestions in a concise way."} ], temperature: 0.3, max_tokens: 600, frequency_penalty: 0.1, presence_penalty: 0.1 });
        const responseText = completion.choices[0].message.content;
        let suggestions = [];
        let reasoning = "";
        if (responseText.includes("Reasoning:")) {
            const parts = responseText.split("Reasoning:");
            suggestions = extractBracketedNames(parts[0]);
            reasoning = parts[1].trim();
        } else {
            suggestions = extractBracketedNames(responseText);
            reasoning = "The AI didn't provide explicit reasoning for these suggestions.";
        }
        res.json({ success: true, debugInfo: { generatedPrompt: prompt, rawAIResponse: responseText, parsedSuggestions: suggestions, reasoning: reasoning, parameters: { action, location, count, excludeNames, preferences, searchContext } } });
    } catch (error) {
        console.error('Test prompt debug error:', error);
        res.status(500).json({success: false, error: 'Failed to test prompt', message: error.message});
    }
});

router.get('/place-image/:placeId/:photoIndex', async (req, res) => {
    try {
        const { placeId, photoIndex } = req.params;
        const index = parseInt(photoIndex) || 0;
        const image = await imageStorageService.serveImage(placeId, index);
        if (!image || !image.data) {
            console.log(`❌ No image data returned`);
            return res.status(404).send('Image not found');
        }        
        if (!(image.data instanceof Buffer)) {
            console.log(`❌ Data is not a Buffer, it's a ${typeof image.data}`);
            return res.status(500).send('Invalid image data format');
        }     
        // Substituted responses (requested slot not stored yet — e.g. gallery
        // still downloading) must never be cached: with the 30-day max-age the
        // browser would pin the first photo into every index for a month.
        const cacheControl = image.fallback ? 'no-store' : 'public, max-age=2592000';
        res.set({'Content-Type': image.contentType || 'image/jpeg', 'Content-Length': image.data.length, 'Cache-Control': cacheControl, 'Access-Control-Allow-Origin': '*'});
        if (!image.fallback) res.set('Expires', new Date(Date.now() + 2592000000).toUTCString());
        res.send(image.data);
        // console.log(`✅ Image sent successfully\n`);        
    } catch (error) {
        console.error('❌ Image serve error:', error);
        res.status(404).send('Image not found');
    }
});

router.get('/place-images/:placeId', auth, async (req, res) => {
    try {
        const { placeId } = req.params;
        const cached = await PlaceCache.findOne({ placeId });
        if (!cached || !cached.photos) { return res.json({ images: [] }) }
        const imageUrls = cached.photos.map((photo, index) => ({url: `/api/ai/place-image/${placeId}/${index}`, thumbnail: `/api/ai/place-image/${placeId}/${index}?size=thumb`, width: photo.width, height: photo.height, hasStoredImage: !!photo.imageData}));
        res.json({ images: imageUrls });
    } catch (error) {
        console.error('Batch images error:', error);
        res.status(500).json({ error: 'Failed to fetch images' });
    }
});

router.get('/usage-notifications', auth, usageTracker, async (req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'});
    const sendNotification = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`) };    
    try {
        const userLimit = req.userLimit;
        if (userLimit) {
            const status = userLimit.getUsageStatus();
            sendNotification({type: 'usage_status', data: status, timestamp: new Date()});            
            if (status.daily.tokens.percentage > 80) { sendNotification({type: 'warning', message: `You've used ${status.daily.tokens.percentage}% of your daily token limit.`, remainingTokens: status.daily.tokens.remaining}) }
            if (status.daily.places.percentage > 80) { sendNotification({type: 'warning', message: `You've viewed ${status.daily.places.percentage}% of your daily places limit.`, remainingPlaces: status.daily.places.remaining}) }
        }
    } catch (error) { console.error('Usage notification error:', error) }    
    const heartbeat = setInterval(() => { res.write(':heartbeat\n\n') }, 30000);    
    req.on('close', () => {
        clearInterval(heartbeat);
        res.end();
    });
});

router.get('/usage-status', auth, usageTracker, async (req, res) => {
    try {
        const userLimit = req.userLimit;
        if (!userLimit) { return res.json({ daily: { tokens: { used: 0, limit: 10000, remaining: 10000, percentage: 0 }, places: { viewed: 0, limit: 50, remaining: 50, percentage: 0 } }, cooldown: { active: false, hoursRemaining: 0 }, isPremium: req.user.isPremium || false }) }
        const status = await userLimit.getUsageStatus();
        res.json(status);
    } catch (error) {
        console.error('Usage status error:', error);
        res.status(500).json({ error: 'Failed to get usage status' });
    }
});

router.post('/reset-cooldown', auth, async (req, res) => {
    try {
        if (!req.user.isPremium) { return res.status(403).json({ error: 'Premium feature only' }) }
        const userLimit = await UserAILimit.findOne({ userId: req.user.id });
        if (!userLimit) { return res.status(404).json({ error: 'User limits not found' }) }
        userLimit.onCooldown = false;
        userLimit.cooldownUntil = null;
        userLimit.cooldownReason = null;
        await userLimit.save();
        res.json({ success: true, message: 'Cooldown reset successfully', cooldown: { active: false } });
    } catch (error) {
        console.error('Reset cooldown error:', error);
        res.status(500).json({ error: 'Failed to reset cooldown' });
    }
});

router.get('/chat-sessions/:id/health', auth, async (req, res) => {
    try {
        const session = await ChatSession.findOne({ _id: req.params.id, userId: req.user.id });
        if (!session) { return res.status(404).json({ error: 'Session not found' }) }
        const contextManager = new JinniContextManager();
        const healthCheck = contextManager.checkSessionHealth(session);
        res.json({ success: true, health: healthCheck, sessionId: session._id, title: session.title});
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({ error: 'Failed to check session health' });
    }
});

/**
 * Grant premium to a user. ADMIN ONLY.
 *
 * SECURITY: this route used to be `auth` alone — no payment, no authorization
 * check. Its own comment read "In a real app, you would process payment here".
 * Any logged-in user could POST it from a browser console and hand themselves
 * unlimited quota for free. It was the only self-service write to `isPremium`
 * anywhere in the codebase, so locking it closes the hole entirely.
 *
 * There is no user-payment integration to hook into (the Payment model is
 * business-only), so there is no honest way to make this self-service. It is
 * therefore a MANUAL grant: support comps, sales, and testing.
 *
 * When a real checkout exists, the upgrade must happen inside that provider's
 * SIGNATURE-VERIFIED WEBHOOK — never in a route the client can reach, and
 * never on the strength of a client-supplied "I paid" flag.
 */
router.post('/upgrade-premium', auth, admin, async (req, res) => {
    try {
        // An admin may grant to someone else; omitting userId means themselves.
        const targetId = req.body?.userId ? String(req.body.userId) : req.user.id;
        if (!mongoose.Types.ObjectId.isValid(targetId)) {
            return res.status(400).json({ success: false, error: 'invalid_user_id' });
        }
        const user = await User.findById(targetId);
        if (!user) { return res.status(404).json({ success: false, error: 'user_not_found' }) }

        // ── Term ─────────────────────────────────────────────────────────
        // Premium used to be permanent: the flag went up and nothing ever
        // brought it down. A grant now carries a term, and renewing an
        // ACTIVE account extends it rather than truncating time already paid
        // for (see premiumTermEnd). `lifetime: true` is the deliberate
        // escape hatch for staff accounts — it must be asked for explicitly.
        const lifetime = req.body?.lifetime === true;
        const days = Number.isFinite(Number(req.body?.days)) ? Math.round(Number(req.body.days)) : 30;
        if (!lifetime && (days < 1 || days > 3650)) {
            return res.status(400).json({ success: false, error: 'invalid_days', message: 'days must be between 1 and 3650, or pass lifetime: true' });
        }

        user.isPremium = true;
        user.premiumUntil = lifetime ? null : premiumTermEnd(days, user);
        await user.save();

        // Upsert rather than 404: a user who has never made an AI request has
        // no limit document yet, and the old code refused the grant for that.
        const userLimit = await UserAILimit.findOneAndUpdate(
            { userId: targetId },
            { isPremium: true, onCooldown: false, cooldownUntil: null, cooldownReason: null },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        // Auditable: who granted what, to whom, for how long.
        console.log(`[premium] granted to user ${targetId} by admin ${req.user.id} — ${lifetime ? 'lifetime' : days + ' day(s), until ' + user.premiumUntil.toISOString()}`);

        res.json({
            success: true,
            message: 'Premium granted',
            userId: targetId,
            premiumUntil: user.premiumUntil,
            benefits: {
                dailyTokens: userLimit.premiumBenefits.dailyTokens,
                dailyPlaces: userLimit.premiumBenefits.dailyPlaces,
                noCooldown: userLimit.premiumBenefits.noCooldown
            }
        });
    } catch (error) {
        console.error('Upgrade error:', error);
        res.status(500).json({ success: false, error: 'Failed to upgrade' });
    }
});

router.delete('/user/account', auth, async (req, res) => {
    try {
        const userId = req.userId || req.user?.id || req.user?._id;
        if (!userId) {
            console.error('❌ CRITICAL: No user ID found!');
            return res.status(401).json({error: 'User ID not found', debug: {hasReqUser: !!req.user, hasReqUserId: !!req.userId}});
        }
        const user = await User.findById(userId).select('email name businessId');
        // ── Cascade-delete business if this user owns one ─────────────────────
        // Look up by owner field (source of truth on Business side) and also
        // fall back to user.businessId in case the bidirectional link drifted.
        const business = await Business.findOne({$or: [{ owner: userId }, ...(user?.businessId ? [{ _id: user.businessId }] : [])]}).select('_id zoneKey status partnership.tier');
        if (business) {
            // If this listing is an active Signature holding a zone slot, note
            // the zone so we can promote the top waitlisted bidder into the slot
            // AFTER the listing is removed. Self-deletion is an immediate, clean
            // vacancy: the owner is gone, so there's nothing to bill or protect —
            // the slot should free now (not wait for a billing-period vacancy
            // date) and the highest bidder enters right away. Without this, a
            // self-delete silently empties the slot and no bidder is ever
            // promoted (the auction scheduler only resolves slots that were
            // cancelled through the proper flow, never hard-deleted ones).
            const freesSignatureSlot = business.status === 'active' && business.partnership?.tier === 'signature' && !!business.zoneKey;
            const freedZoneKey = freesSignatureSlot ? business.zoneKey : null;
            // Wipe analytics rows tied to this business — prevents orphaned
            // businessId references in admin reports.
            await Analytics.deleteMany({ businessId: business._id });
            // Remove SavedPlaces that other users had bookmarked pointing at
            // this business as a verified DB record.
            await SavedPlace.deleteMany({ verifiedId: business._id, verifiedModel: 'business' });
            // Finally delete the business listing itself.
            await Business.deleteOne({ _id: business._id });
            console.log(`🗑️ Deleted business ${business._id} owned by user ${userId}`);
            // Promote the top bidder into the now-empty Signature slot. Best-effort
            // and fully isolated: a promotion failure must never block or fail the
            // account deletion the user requested.
            if (freedZoneKey) {
                try {
                    const result = await zoneAuction._promoteTopBidder(freedZoneKey);
                    if (result?.promoted) { console.log(`⚖️ Promoted bidder ${result.winnerId} into zone ${freedZoneKey} at $${result.price}/mo after owner self-deletion.`) } 
                    else { console.log(`⚖️ Slot freed in zone ${freedZoneKey} but no bidder promoted (${result?.reason || 'empty bid book'}).`) }
                } catch (promoteErr) { console.error('⚖️ Bidder promotion after self-deletion failed (slot left open):', promoteErr) }
            }
        }
        // ── User-scoped data (regardless of business ownership) ───────────────
        await SavedPlace.deleteMany({ userId });
        await ChatSession.deleteMany({ userId });
        await UserAILimit.deleteMany({ userId });
        await User.findByIdAndDelete(userId);
        if (user?.email) {emailService.sendAccountDeletedEmail(user.email, user.name).then(() => console.log(`✅ Account deleted email sent to ${user.email}`)).catch(err => console.error('⚠️ Failed to send account deleted email:', err.message))}
        res.json({success: true, message: 'Account and all associated data deleted successfully'});
    } catch (error) {
        console.error('🗑️ ========================================');
        console.error('❌ DELETE ACCOUNT ERROR');
        console.error('🗑️ ========================================');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('Error name:', error.name);
        console.error('🗑️ ========================================');
        res.status(500).json({error: 'Failed to delete account', details: error.message, step: 'Check server logs for detailed breakdown'});
    }
});

router.post('/track-interaction', auth, async (req, res) => {
    try {
        const { verifiedId, placeName, interactionType } = req.body;
        const userId = req.user.id;
        // Map each interactionType to the correct Business analytics counter.
        // Each action writes to its own dedicated field for granular dashboard reporting.
        if (verifiedId) {
            const COUNTER_MAP = {
                // Main engagement tiles
                map_open:          'analytics.directionClicks',   // directions button
                website_click:     'analytics.websiteClicks',    // website link
                phone_click:       'analytics.phoneClicks',      // phone number tap
                search_click:      'analytics.searchClicks',     // online search button
                instagram_click:   'analytics.instagramClicks',  // Instagram link
                facebook_click:    'analytics.facebookClicks',   // Facebook link
                tripadvisor_click: 'analytics.tripadvisorClicks',// TripAdvisor link
                ai_ask:            'analytics.aiAsk',            // Ask AI button on card
                more_images:       'analytics.moreImages',       // More Images button
                // Share has its own top-level field
                place_share:       'analytics.shares',
                // view_more is sitewide — no per-business counter
                view_more_clicked: null,
            };
            const counter = interactionType in COUNTER_MAP
                ? COUNTER_MAP[interactionType]
                : 'analytics.conversions';                      // default: booking/conversion intent
            if (counter) {
                const updatedBusiness = await Business.findByIdAndUpdate(verifiedId, { $inc: { [counter]: 1 } }).lean();
                if (!updatedBusiness) { await Destination.findByIdAndUpdate(verifiedId, { $inc: { [counter]: 1 } }) }
            }
        }
        // Determine analytics event type
        const VIEW_MORE_TYPE = 'view_more_clicked';
        const SHARE_TYPE     = 'place_share';
        const analyticsType = interactionType === 'place_share' ? SHARE_TYPE : interactionType === 'view_more_clicked' ? VIEW_MORE_TYPE : 'place_interaction';
        await Analytics.create({ type: analyticsType, userId, metadata: { verifiedId, placeName, interactionType, timestamp: new Date() } });
        res.json({ success: true });
    } catch (error) {
        console.error('Track interaction error:', error);
        res.json({ success: true }); // never fail silently to user
    }
});

// ── POST /feedback ────────────────────────────────────────────────────────────
// Handles both AI message feedback and recommendation card feedback.
//
// Body shape:
//   type        : 'message' | 'recommendation'
//   sessionId   : ChatSession _id
//   messageId   : message.id string
//   feedback    : 'like' | 'dislike' | null   (null = toggled off)
//
//   -- only for type === 'recommendation' --
//   recId       : the rec's id field (e.g. "db-<mongoId>" or a placeId string)
//   verifiedId  : present when rec is a Business or Destination mongo _id
//   placeId     : present when rec is a PlaceCache entry
//
// Source detection logic:
//   verifiedId present         → try Business first, then Destination
//   no verifiedId, placeId     → PlaceCache
//   neither                    → Analytics log only (AI-only rec with no DB record)
//
// Counter correctness — delta approach:
//   We always read the previous feedback value from ChatSession BEFORE writing,
//   then compute a delta so that:
//     - switching like → dislike:  likes -1, dislikes +1
//     - toggling off (null):        previous side -1, nothing incremented
//     - clicking the same value:   no-op (idempotent, prevents spam inflation)
router.post('/feedback', auth, async (req, res) => {
    try {
        const { type, sessionId, messageId, feedback, recId, verifiedId, placeId, action } = req.body;
        const userId = req.user.id;
        // ── Validate ──────────────────────────────────────────────────────────
        if (!['message', 'recommendation'].includes(type)) { return res.status(400).json({ error: 'Invalid feedback type' }) }
        if (!sessionId || !messageId) { return res.status(400).json({ error: 'sessionId and messageId are required' }) }
        if (feedback !== null && !['like', 'dislike'].includes(feedback)) { return res.status(400).json({ error: 'feedback must be "like", "dislike", or null' }) }
        // ── 1. Read previous feedback from ChatSession (source of truth) ──────
        // We need the DB value — not the client's local state — to compute the
        // correct delta and guard against spam from multiple sessions/tabs.
        const session = await ChatSession.findOne(
            { _id: sessionId, userId },
            { 'messages.$': 1 }  // only pull the matching message
        ).where('messages.id').equals(messageId).lean();
        const message = session?.messages?.[0];
        let previousFeedback = null; // what the DB currently holds
        if (type === 'message') { previousFeedback = message?.feedback ?? null } 
        else {
            const rec = message?.recommendations?.find(r => r.id === recId);
            previousFeedback = rec?.feedback ?? null;
        }
        // ── Idempotency guard — same value already stored, nothing to do ──────
        if (previousFeedback === feedback) { return res.json({ success: true, noop: true }) }
        // ── 2. Persist new feedback into ChatSession ──────────────────────────
        if (type === 'message') { await ChatSession.updateOne({ _id: sessionId, userId, 'messages.id': messageId }, { $set: { 'messages.$.feedback': feedback } }) } 
        else {
            // arrayFilters to reach the nested recommendation subdocument
            await ChatSession.updateOne({ _id: sessionId, userId, 'messages.id': messageId }, { $set: { 'messages.$[msg].recommendations.$[rec].feedback': feedback } }, { arrayFilters: [{ 'msg.id': messageId }, { 'rec.id': recId }] });
        }
        // ── 3. Compute delta and update counters (recommendations only) ────────
        // Delta rules:
        //   previousFeedback → feedback      likes delta   dislikes delta
        //   null             → 'like'           +1              0
        //   null             → 'dislike'          0            +1
        //   'like'           → 'dislike'         -1            +1
        //   'dislike'        → 'like'            +1            -1
        //   'like'           → null              -1              0
        //   'dislike'        → null               0            -1
        if (type === 'recommendation') {
            const likesDelta    = (feedback === 'like' ? 1 : 0) - (previousFeedback === 'like' ? 1 : 0);
            const dislikesDelta = (feedback === 'dislike' ? 1 : 0) - (previousFeedback === 'dislike' ? 1 : 0);
            // Only hit the DB if there's actually something to change
            if (likesDelta !== 0 || dislikesDelta !== 0) {
                if (verifiedId) {
                    const inc = {};
                    if (likesDelta !== 0)    inc['analytics.likes']    = likesDelta;
                    if (dislikesDelta !== 0) inc['analytics.dislikes'] = dislikesDelta;
                    // Try Business first, fall back to Destination
                    const updatedBusiness = await Business.findByIdAndUpdate(
                        verifiedId,
                        { $inc: inc }
                    ).lean();
                    if (!updatedBusiness) { await Destination.findByIdAndUpdate(verifiedId, { $inc: inc }) }
                } else if (placeId) {
                    const inc = {};
                    if (likesDelta !== 0)    inc.likes    = likesDelta;
                    if (dislikesDelta !== 0) inc.dislikes = dislikesDelta;
                    await PlaceCache.findOneAndUpdate({ placeId }, { $inc: inc });
                }
                // If neither — AI-only rec, Analytics log is enough
            }
            // ── Per-user current-vote sync (PlaceFeedback) ────────────────────
            // Records the user's CURRENT vote for this place+action. Two consumers:
            //   • backfill reads vote==='dislike' to hide a place for this user
            //     under this action (a museum disliked as an 'event' still shows
            //     under 'historical');
            //   • the cross-chat highlight reads any vote to light up a card when
            //     the place reappears in a new chat.
            // Keyed by the id the rec carried: verified _id for DB places, else the
            // Google placeId. A like or dislike upserts the row with that vote;
            // clearing the vote (→ null) removes the row.
            const voteKey = verifiedId ? String(verifiedId) : (placeId || null);
            // A vote must NEVER be silently dropped just because the card carried no
            // action (older chat cards, or any future card type that forgets to stamp
            // one). Fall back to the sentinel 'chat': per-action scoping degrades
            // gracefully — the chat-stream filter and /my-votes both collapse votes
            // per-place across actions, so a 'chat' row still hides and highlights
            // correctly everywhere it should. Toggle-off deletes use the same
            // fallback, so the delete always targets the row the write created.
            const voteAction = action || 'chat';
            if (voteKey) {
                try {
                    if (feedback === 'like' || feedback === 'dislike') {
                        await PlaceFeedback.updateOne(
                            { userId, placeId: voteKey, action: voteAction },
                            { $set: { vote: feedback, name: req.body.name || '' }, $setOnInsert: { userId, placeId: voteKey, action: voteAction } },
                            { upsert: true }
                        );
                    } else { // feedback === null → vote cleared
                        await PlaceFeedback.deleteOne({ userId, placeId: voteKey, action: voteAction });
                    }
                } catch (pfErr) {
                    // Duplicate-key race on rapid double-tap is harmless — the upsert
                    // target already exists, which is the desired end state.
                    if (pfErr.code !== 11000) console.warn('[feedback] PlaceFeedback sync failed:', pfErr.message);
                }
            }
        }
        // ── 4. Log to Analytics ───────────────────────────────────────────────
        await Analytics.create({
            type: type === 'message' ? 'message_feedback' : 'recommendation_feedback',
            userId,
            metadata: {
                sessionId,
                messageId,
                previousFeedback,             // useful for trend analysis
                feedback,                     // 'like' | 'dislike' | null
                ...(type === 'recommendation' && { recId, verifiedId: verifiedId || null, placeId:    placeId    || null }),
                timestamp: new Date()
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Feedback error:', error);
        res.json({ success: true }); // never surface errors to the user for fire-and-forget actions
    }
});

// ── My votes for a set of places (cross-chat highlight) ──────────────────────
// The card like/dislike highlight is per-session by default: a place that
// reappears in a NEW chat renders blank even if the user voted on it before.
// This batched lookup closes that gap. The client sends the placeIds currently
// on screen; we return this user's CURRENT vote per placeId so the cards can
// light up. Display is PER-PLACE (collapsed across actions, latest vote wins) —
// "liked anywhere shows liked everywhere" — even though the dislike-HIDE remains
// per-action. Read-only, cheap (indexed on userId+placeId), capped to a sane
// batch so a huge body can't scan the world.
router.post('/my-votes', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const ids = Array.isArray(req.body?.placeIds) ? req.body.placeIds.filter(Boolean).slice(0, 200) : [];
        if (!ids.length) return res.json({ votes: {} });
        const rows = await PlaceFeedback.find({ userId, placeId: { $in: ids } })
            .select('placeId action vote updatedAt')
            .lean();
        // Collapse to one vote per placeId: most recently updated row wins, so a
        // later like under any action overrides an earlier dislike under another.
        const latest = {};   // placeId → { vote, updatedAt }
        for (const r of rows) {
            const prev = latest[r.placeId];
            if (!prev || new Date(r.updatedAt) > new Date(prev.updatedAt)) {
                latest[r.placeId] = { vote: r.vote, updatedAt: r.updatedAt };
            }
        }
        const votes = {};
        for (const [pid, v] of Object.entries(latest)) votes[pid] = v.vote;
        res.json({ votes });
    } catch (error) {
        console.error('my-votes error:', error);
        res.json({ votes: {} }); // fail soft — highlight is cosmetic
    }
});

router.get('/location/detect', auth, async (req, res) => {
    const services = ['https://ipapi.co/json/', 'https://ipwho.is/', 'https://ipwhois.app/json/'];
    for (const url of services) {
        try {
            const response = await fetch(url, {headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000)});
            const ct = response.headers.get('content-type') || '';
            if (!ct.includes('application/json')) continue;
            const data = await response.json();
            const lat = parseFloat(data.latitude || data.lat);
            const lng = parseFloat(data.longitude || data.lon || data.lng);
            if (lat && lng) {return res.json({ success: true, lat, lng, city: data.city || '', country: data.country_name || data.country || '', source: url })}
        } catch (e) {console.warn(`IP location service failed (${url}):`, e.message)}
    }
    return res.status(503).json({ success: false, message: 'Could not detect location' });
});

module.exports = router;
// Shared with itineraryRoutes.js — reuses the PlaceCache-first enrichment
// pipeline and location/message helpers. No circular require.
/* ═══════════════════════ EXPLORE (Jinni Eye) ═══════════════════════════════
 * A browse-by-category view of everything Jinni already knows about the user's
 * region — served ENTIRELY from PlaceCache (zero Google calls, zero cost), with
 * the user's disliked places filtered out. Empty region → the honest
 * "not_explored" signal so the UI can say "Jinni hasn't been there yet".
 *
 * Categories map to the cache's `actions[]` array (the same category ids used
 * across chat/quick-actions), so no new taxonomy is introduced.
 */
const EXPLORE_CATEGORIES = ['restaurants', 'hotels', 'historical', 'events', 'photo_spots', 'hidden_gems', 'shopping'];
// Map a user's free-text interests (from onboarding) onto explore categories,
// so someone who chose "food" and "history" sees those sections first. Keyword
// match — an interest can boost more than one category.
const INTEREST_TO_CATEGORY = [
    [/food|restaurant|dining|cuisine|culinary|gastro|eat/i, 'restaurants'],
    [/history|histor|heritage|monument|castle|ruin|ancient|architecture/i, 'historical'],
    [/museum|art|gallery|culture|cultural/i, 'historical'],
    [/hidden|local|offbeat|authentic|secret|unique/i, 'hidden_gems'],
    [/nature|outdoor|hike|hiking|landscape|scenic|view|mountain|lake/i, 'photo_spots'],
    [/photo|instagram|scenic|viewpoint/i, 'photo_spots'],
    [/event|festival|concert|nightlife|music|party|show/i, 'events'],
    [/shop|shopping|market|bazaar|boutique|souvenir/i, 'shopping'],
    [/hotel|stay|accommodation|lodging|luxury/i, 'hotels'],
];
const EXPLORE_RADIUS_KM = Number(process.env.EXPLORE_RADIUS_KM) || 150;   // region-sized; tuned for a small country

function _haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

router.get('/explore', auth, usageTracker, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('preferences settings isPremium');
        const messages = getAllMessages(user?.settings?.language || 'en');
        // Explicit search override (the TripAdvisor-style search bar): explore an
        // arbitrary geocoded point instead of the user's own location. `label` is
        // display-only, echoed back for the header / empty-state title.
        const qLat = parseFloat(req.query.lat), qLng = parseFloat(req.query.lng);
        const hasOverride = Number.isFinite(qLat) && Number.isFinite(qLng) && Math.abs(qLat) <= 90 && Math.abs(qLng) <= 180;
        const overrideLabel = hasOverride && typeof req.query.label === 'string' ? req.query.label.slice(0, 80) : null;
        const eff = await resolveEffectiveLocation(user, null, messages);
        if (!hasOverride && (!eff || eff.error === 'location_required' || !Number.isFinite(eff.lat) || !Number.isFinite(eff.lng))) {
            return res.status(400).json({ success: false, error: 'location_required', message: messages.location_required });
        }
        const centerLat = hasOverride ? qLat : eff.lat, centerLng = hasOverride ? qLng : eff.lng;
        // Bounding box first (uses the geo index), haversine-refined below.
        const dLat = EXPLORE_RADIUS_KM / 111;
        const dLng = EXPLORE_RADIUS_KM / (111 * Math.cos(centerLat * Math.PI / 180) || 1);

        // Everything this user has disliked anywhere → hidden from Explore.
        const disliked = new Set(
            (await PlaceFeedback.find({ userId: req.user.id, vote: 'dislike' }).select('placeId').lean())
                .map(r => r.placeId).filter(Boolean)
        );

        const rows = await PlaceCache.find({
            actions: { $in: EXPLORE_CATEGORIES },
            'details.geometry.location.lat': { $gte: centerLat - dLat, $lte: centerLat + dLat },
            'details.geometry.location.lng': { $gte: centerLng - dLng, $lte: centerLng + dLng },
        }).select('placeId name rating actions primaryType types photos likes dislikes explore details.geometry.location details.formatted_address details.vicinity').lean();

        // Partner-tier glow: match active partner businesses to cached places by
        // normalized name (a partner's cache entry was created from the same
        // name the business record carries). One cheap query; purely decorative —
        // any failure must never break Explore.
        const normBizName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const bizTiers = new Map();
        try {
            const bizRows = await Business.find({ status: 'active' }).select('name partnership.tier').lean();
            for (const b of bizRows) {
                const k = normBizName(b.name);
                if (k) bizTiers.set(k, b.partnership?.tier || 'verified');
            }
        } catch (e) { /* decorative only */ }

        const HARD_HIDE = (r) => (r.dislikes || 0) >= 3 && (r.dislikes || 0) > (r.likes || 0) * 2;   // community-buried
        // Auto-quality gate: weak rating or net-negative feedback keeps a place off
        // the browse page (chat can still serve it). Unknown rating passes — most
        // legit cached places carry one, and punishing "no data" would empty new
        // regions. 'verified' places are exempt from BOTH auto rules.
        const AUTO_HIDE = (r) => (Number.isFinite(r.rating) && r.rating < 3.5)
            || ((r.dislikes || 0) >= 2 && (r.dislikes || 0) > (r.likes || 0));
        const categories = {};
        for (const c of EXPLORE_CATEGORIES) categories[c] = [];

        for (const r of rows) {
            if (!r.placeId || disliked.has(r.placeId)) continue;
            const modStatus = r.explore?.status || 'visible';
            if (modStatus === 'hidden') continue;
            if (modStatus !== 'verified' && (HARD_HIDE(r) || AUTO_HIDE(r))) continue;
            const loc = r.details?.geometry?.location;
            if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;
            const distKm = _haversineKm(centerLat, centerLng, loc.lat, loc.lng);
            if (distKm > EXPLORE_RADIUS_KM) continue;
            const hasImage = Array.isArray(r.photos) && r.photos.length > 0;
            const card = {
                placeId: r.placeId,
                name: r.name,
                rating: Number.isFinite(r.rating) ? r.rating : null,
                image: hasImage ? `/api/ai/place-image/${r.placeId}/0` : null,
                region: r.details?.vicinity || r.details?.formatted_address || null,
                distanceKm: Math.round(distKm * 10) / 10,
                likes: r.likes || 0,
                verified: modStatus === 'verified',
                tier: bizTiers.get(normBizName(r.name)) || null,
            };
            // A place can belong to several categories; list it under each it claims.
            for (const c of r.actions || []) if (categories[c]) categories[c].push(card);
        }

        /* ── Events: merged from their own sources, not the place cache ──────
         * Events are deliberately never written to PlaceCache (a cache of
         * places cannot hold a moment in time), so the loop above yields an
         * empty events category. The real sources are:
         *   1. validator Destinations typed 'events'  → verified cards
         *   2. AiFoundEvent records (status 'new')    → what Jinni served in
         *      chat, visible here until a validator moderates it
         * Approved AI events are skipped: approval created a Destination, so
         * source 1 already carries them. Hidden ones never appear. Both
         * sources are date-filtered — an ended event is not a recommendation.
         * Failures fall through: Explore must never break over events. */
        try {
            const now = new Date();
            const upcoming = (s, e, rec) => rec || ((e || s) && new Date(e || s) >= now);
            const destRows = await Destination.find({
                type: 'events',
                isActive: { $ne: false },
                'location.coordinates.lat': { $gte: centerLat - dLat, $lte: centerLat + dLat },
                'location.coordinates.lng': { $gte: centerLng - dLng, $lte: centerLng + dLng },
            }).select('name images location eventSchedule popularity').lean();
            for (const d of destRows) {
                if (!upcoming(d.eventSchedule?.startDate, d.eventSchedule?.endDate, d.eventSchedule?.isRecurring)) continue;
                const loc = d.location?.coordinates;
                const distKm = _haversineKm(centerLat, centerLng, loc.lat, loc.lng);
                if (distKm > EXPLORE_RADIUS_KM) continue;
                categories.events.push({
                    placeId: `dest_${d._id}`,
                    name: d.name,
                    rating: null,
                    image: (Array.isArray(d.images) && d.images[0]) || null,
                    region: d.location?.address || d.location?.city || null,
                    distanceKm: Math.round(distKm * 10) / 10,
                    likes: 0,
                    verified: true,                              // validator-curated
                    tier: null,
                    eventDates: d.eventSchedule?.startDate
                        ? { start: d.eventSchedule.startDate, end: d.eventSchedule.endDate || null }
                        : null,
                });
            }
            const aiRows = await AiFoundEvent.find({
                status: 'new',
                lat: { $gte: centerLat - dLat, $lte: centerLat + dLat },
                lng: { $gte: centerLng - dLng, $lte: centerLng + dLng },
            }).select('name placeId lat lng address city startDate endDate isRecurring timesShown').lean();
            for (const ev of aiRows) {
                if (!upcoming(ev.startDate, ev.endDate, ev.isRecurring)) continue;
                if (ev.placeId && disliked.has(ev.placeId)) continue;
                // The same event may exist as a validator destination too (either
                // via approval of a twin record or independent curation) — the
                // curated card wins.
                if (categories.events.some(c => c.verified && eventNamesMatch(c.name, ev.name))) continue;
                const distKm = _haversineKm(centerLat, centerLng, ev.lat, ev.lng);
                if (distKm > EXPLORE_RADIUS_KM) continue;
                categories.events.push({
                    placeId: ev.placeId || `aiev_${ev._id}`,
                    name: ev.name,
                    rating: null,
                    // The venue got cached during venue resolution, so its photo
                    // proxy works whenever a placeId resolved.
                    image: ev.placeId ? `/api/ai/place-image/${ev.placeId}/0` : null,
                    region: ev.address || ev.city || null,
                    distanceKm: Math.round(distKm * 10) / 10,
                    likes: 0,
                    verified: false,
                    tier: null,
                    eventDates: { start: ev.startDate, end: ev.endDate || null },
                });
            }
        } catch (e) { console.warn('[explore] events merge failed:', e.message) }

        // ── Preferences: which categories does this user care about? ──
        const interests = Array.isArray(user?.preferences?.interests) ? user.preferences.interests : [];
        const interestScore = {};
        for (const c of EXPLORE_CATEGORIES) interestScore[c] = 0;
        for (const it of interests) {
            for (const [re, cat] of INTEREST_TO_CATEGORY) if (re.test(String(it || ''))) interestScore[cat] = (interestScore[cat] || 0) + 1;
        }

        // Rank each category: human-verified first, then rating, then community likes.
        let total = 0;
        for (const c of EXPLORE_CATEGORIES) {
            categories[c].sort((a, b) => (b.verified - a.verified) || (b.rating || 0) - (a.rating || 0) || (b.likes || 0) - (a.likes || 0));
            categories[c] = categories[c].slice(0, 40);
            total += categories[c].length;
        }

        // Section order: interest-matching categories first, then the default
        // order — only for categories that actually have places.
        const DEFAULT_ORDER = ['restaurants', 'historical', 'hidden_gems', 'photo_spots', 'events', 'shopping', 'hotels'];
        const order = DEFAULT_ORDER
            .filter(c => categories[c] && categories[c].length)
            .sort((a, b) => (interestScore[b] || 0) - (interestScore[a] || 0)
                || DEFAULT_ORDER.indexOf(a) - DEFAULT_ORDER.indexOf(b));

        return res.json({
            success: true,
            location: overrideLabel
                ? { city: overrideLabel, country: null }
                : { city: eff?.city || null, country: eff?.country || null },
            categories,
            order,
            interests,
            total,
            // Nothing cached nearby yet — the UI shows "Jinni hasn't been here yet".
            explored: total > 0,
        });
    } catch (error) {
        console.error('Explore error:', error);
        return res.status(500).json({ success: false, error: 'explore_failed' });
    }
});

module.exports.shared = { getCachedPlaceDetails, resolveEffectiveLocation, getAllMessages, placeBlockedForAction, loadCuratedRejects };