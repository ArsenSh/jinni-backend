const axios = require('axios');

const DEEPSEEK_API_KEY = process.env.OPENAI_API_KEY;
const DEEPSEEK_API_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';

module.exports = {
    chat: {
        completions: {
            create: async ({ model, messages, temperature, max_tokens, stream = false }) => {
                try {
                    const requestData = {
                        model: model || "deepseek-chat",
                        messages,
                        temperature,
                        max_tokens,
                    };
                    if (stream) {
                        requestData.stream = true;
                    }
                    const response = await axios.post(
                        `${DEEPSEEK_API_URL}/chat/completions`,
                        requestData,
                        {
                            headers: {
                                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            responseType: stream ? 'stream' : 'json'
                        }
                    );
                    if (stream) {
                        return response;
                    }
                    return response.data;
                } catch (error) {
                    console.error("DeepSeek API Error:", error.response?.data || error.message);
                    throw error;
                }
            }
        }
    },
    models: {
        list: async () => {
            try {
                const response = await axios.get(
                    `${DEEPSEEK_API_URL}/models`,
                    {
                        headers: {
                            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                        }
                    }
                );
                return response.data;
            } catch (error) {
                console.error("DeepSeek Models Error:", error.response?.data || error.message);
                throw error;
            }
        }
    }
};