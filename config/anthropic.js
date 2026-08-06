// config/anthropic.js
//
// Standalone Anthropic (Claude) client. This is the mirror of your existing
// config/openai.js, kept completely separate so nothing about the DeepSeek
// path changes.
//
// Install once:   npm install @anthropic-ai/sdk
// Env required:   ANTHROPIC_API_KEY   (from https://console.anthropic.com → API Keys)
//
// NOTE: This is a different key from your DeepSeek/OpenAI key. Keep both in
// your .env so you can switch providers from the admin panel without redeploying.

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Optional: raise if you see timeouts on web-search requests (search adds latency).
    timeout: 60 * 1000,
    maxRetries: 2,
});

module.exports = anthropic;