const idram = require('./idramService');
// const arca = require('./arcaService'); // For future use

module.exports = {
    processPayment: async (business, amount) => {
        return idram.createPaymentLink({
            amount: amount,
            currency: 'AMD',
            businessId: business._id,
            description: `Premium subscription for ${business.name}`,
            callbackUrl: `${process.env.APP_URL}/payment-callback`
        });
    },

    handleWebhook: (payload) => {
        return idram.verifyPayment(payload);
    }
};