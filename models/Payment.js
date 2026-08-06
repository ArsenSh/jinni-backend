const paymentSchema = new mongoose.Schema({
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Business',
        required: true
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'AMD' },
    method: {
        type: String,
        enum: ['idram', 'arca', 'bank-transfer'],
        required: true
    },
    period: {
        start: { type: Date, default: Date.now },
        end: { type: Date, required: true }
    },
    transactionId: String, // Gateway reference
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending'
    }
}, { timestamps: true });