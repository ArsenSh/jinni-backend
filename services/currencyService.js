/**
 * Real-time Exchange Rate Service
 * Automatically fetches and updates exchange rates from free APIs
 * Supports: USD, RUB, EUR, GBP
 */

const axios = require('axios');

// In-memory cache of exchange rates (USD as base)
let EXCHANGE_RATES = {
    'AED': 3.67,
    'AMD': 387,      // Armenian Dram — Jinni's home market; ~387 AMD per USD
    'USD': 1.00,
    'EUR': 0.92,
    'GBP': 0.79,
    'RUB': 92.50
};

// Store when rates were last updated
let lastUpdated = null;
let updateInProgress = false;

/**
 * Fetch latest exchange rates from a free API
 * Using exchangerate-api.com (free tier: 1,500 requests/month)
 * Alternative APIs:
 * - https://api.exchangerate.host (free, no key needed)
 * - https://open.er-api.com/v6/latest/USD (free, no key needed)
 * - https://api.fixer.io (requires API key)
 */
async function fetchLatestRates() {
    const API_OPTIONS = [
        // Option 1: exchangerate-api.com (most reliable, free)
        {
            url: 'https://open.er-api.com/v6/latest/USD',
            parse: (data) => data.rates
        },
        // Option 2: fawazahmed0 currency-api via jsDelivr (CC0, no key, 341
        // currencies INCLUDING AMD). Replaced api.exchangerate.host, which
        // moved to APILayer and now answers every keyless call with
        // {"success":false,"code":101,"missing_access_key"} — verified dead
        // 2026-08-23. Keys are lowercase here, so they are upper-cased to
        // match the shape every other source returns.
        {
            url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
            parse: (data) => Object.fromEntries(
                Object.entries(data?.usd || {}).map(([k, v]) => [k.toUpperCase(), v])
            )
        },
        // Option 3: frankfurter (api.frankfurter.app now 301s to .dev/v1).
        // LAST resort on purpose: it carries only the ~30 ECB currencies and
        // has NO AMD, GEL or RUB — it cannot serve Jinni's home currency, so
        // AMD would fall back to the stale constant below.
        {
            url: 'https://api.frankfurter.dev/v1/latest?from=USD',
            parse: (data) => data.rates
        }
    ];
    for (const api of API_OPTIONS) {
        try {
            // console.log(`Fetching exchange rates from ${api.url}...`);
            const response = await axios.get(api.url, {
                timeout: 5000, // 5 second timeout
                headers: { 'User-Agent': 'Jinni-Travel-App/1.0' }
            });
            if (response.data && response.status === 200) {
                const rates = api.parse(response.data);                
                const filteredRates = {
                    'USD': 1.00,
                    // Keep AED + AMD across refreshes: the fetch REPLACES the table,
                    // so anything omitted here is silently lost (AED was, and AMD —
                    // Jinni's home currency — was never carried at all).
                    'AED': rates.AED || EXCHANGE_RATES.AED,
                    'AMD': rates.AMD || EXCHANGE_RATES.AMD,
                    'EUR': rates.EUR || EXCHANGE_RATES.EUR,
                    'GBP': rates.GBP || EXCHANGE_RATES.GBP,
                    'RUB': rates.RUB || EXCHANGE_RATES.RUB
                };
                // console.log('✅ Exchange rates fetched successfully:', filteredRates);
                // console.log(`📊 1 USD = ${filteredRates.RUB} RUB`);
                // console.log(`📊 1 USD = ${filteredRates.EUR} EUR`);
                // console.log(`📊 1 USD = ${filteredRates.GBP} GBP`);
                return filteredRates;
            }
        } catch (error) {
            console.warn(`Failed to fetch from ${api.url}:`, error.message);
            // Continue to next API option
        }
    }
    console.error('❌ All exchange rate APIs failed, using cached rates');
    return EXCHANGE_RATES;
}

/**
 * Update exchange rates (called automatically)
 */
async function updateExchangeRates() {
    if (updateInProgress) {
        console.log('Update already in progress, skipping...');
        return;
    }
    try {
        updateInProgress = true;
        const newRates = await fetchLatestRates();
        if (newRates) {
            EXCHANGE_RATES = newRates;
            lastUpdated = new Date();
            // console.log(`✅ Exchange rates updated at ${lastUpdated.toISOString()}`);
        }
    } catch (error) { console.error('Failed to update exchange rates:', error.message) } 
    finally { updateInProgress = false }
}

/**
 * Get current exchange rates
 */
function getCurrentRates() { return { rates: { ...EXCHANGE_RATES }, lastUpdated: lastUpdated, nextUpdate: getNextUpdateTime() } }

/**
 * Calculate next update time
 */
function getNextUpdateTime() {
    if (!lastUpdated) return 'Soon';
    const nextUpdate = new Date(lastUpdated.getTime() + 12 * 60 * 60 * 1000); // +12 hours
    return nextUpdate;
}

/**
 * Convert amount from source currency to USD
 */
function convertToUSD(amount, fromCurrency) {
    if (!amount || amount === 0) return 0;
    const currency = fromCurrency.toUpperCase();
    const rate = EXCHANGE_RATES[currency];
    if (!rate) {
        console.warn(`Currency ${currency} not supported, defaulting to USD`);
        return amount;
    }
    if (currency === 'USD') return amount;
    // Convert: if 1 USD = 92.50 RUB, then 1 RUB = 1/92.50 USD
    return amount / rate;
}

/**
 * Convert amount from USD to target currency
 */
function convertFromUSD(amount, toCurrency) {
    if (!amount || amount === 0) return 0;
    const currency = toCurrency.toUpperCase();
    const rate = EXCHANGE_RATES[currency];
    if (!rate) {
        console.warn(`Currency ${currency} not supported, returning USD amount`);
        return amount;
    }
    if (currency === 'USD') return amount;
    // Convert: USD to target currency
    return amount * rate;
}

/**
 * Convert budget range to USD for database filtering
 */
function normalizeBudgetToUSD(budget) {
    if (!budget || !budget.currency) { return { min: 0, max: 0, currency: 'USD' } }
    const minUSD = convertToUSD(budget.min || 0, budget.currency);
    const maxUSD = convertToUSD(budget.max || 0, budget.currency);
    return { min: Math.round(minUSD * 100) / 100, max: Math.round(maxUSD * 100) / 100, currency: 'USD' };
}

/**
 * Convert business price to user's preferred currency for display
 */
function convertPriceForDisplay(priceUSD, targetCurrency) {
    if (!priceUSD) return null;
    const amount = convertFromUSD(priceUSD, targetCurrency);
    const rounded = Math.round(amount * 100) / 100;
    const symbols = {'USD': '$', 'EUR': '€', 'GBP': '£', 'RUB': '₽', 'AED': 'د.إ'};
    const symbol = symbols[targetCurrency] || targetCurrency;
    return {
        amount: rounded,
        currency: targetCurrency,
        symbol: symbol,
        formatted: `${symbol}${rounded.toLocaleString()}`
    };
}

/**
 * Get supported currencies
 */
function getSupportedCurrencies() { return Object.keys(EXCHANGE_RATES) }

/**
 * Check if currency is supported
 */
function isCurrencySupported(currencyCode) { return EXCHANGE_RATES.hasOwnProperty(currencyCode.toUpperCase()) }

/**
 * Get exchange rate for a currency
 */
function getExchangeRate(currencyCode) { return EXCHANGE_RATES[currencyCode.toUpperCase()] || null }

/**
 * Initialize the service and start auto-updates
 * Call this when your server starts
 */
async function initialize() {
    // console.log('🚀 Initializing Real-time Currency Service...');    
    await updateExchangeRates();
    setInterval(updateExchangeRates, 12 * 60 * 60 * 1000);    
    scheduleUpdateAtMidnight();
    // console.log('✅ Currency service initialized');
    // console.log('📅 Rates will update every 12 hours');
}

/**
 * Schedule update at midnight UTC
 */
function scheduleUpdateAtMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    const msUntilMidnight = midnight - now;
    setTimeout(() => {
        updateExchangeRates();
        setInterval(updateExchangeRates, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
}

/**
 * Force update (useful for manual refresh or testing)
 */
async function forceUpdate() {
    console.log('🔄 Forcing exchange rate update...');
    await updateExchangeRates();
    return getCurrentRates();
}

/**
 * Health check - returns status of the service
 */
function healthCheck() {
    const now = new Date();
    const hoursSinceUpdate = lastUpdated ? (now - lastUpdated) / (1000 * 60 * 60) : null;
    const isHealthy = hoursSinceUpdate !== null && hoursSinceUpdate < 24;
    return {
        status: isHealthy ? 'healthy' : 'stale',
        lastUpdated: lastUpdated,
        hoursSinceUpdate: hoursSinceUpdate ? hoursSinceUpdate.toFixed(2) : 'never',
        supportedCurrencies: getSupportedCurrencies(),
        currentRates: EXCHANGE_RATES,
        nextScheduledUpdate: getNextUpdateTime()
    };
}

module.exports = {
    initialize,
    convertToUSD,
    convertFromUSD,
    normalizeBudgetToUSD,
    convertPriceForDisplay,
    getSupportedCurrencies,
    isCurrencySupported,
    getExchangeRate,
    getCurrentRates,
    forceUpdate,
    healthCheck,
    updateExchangeRates
};