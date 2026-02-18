const mongoose = require('mongoose');

/**
 * Transaction is the top-level record for a financial event.
 * Each Transaction has exactly 2 LedgerEntries (one debit, one credit).
 *
 * Idempotency: The `idempotencyKey` field ensures that retrying the same
 * request does not create duplicate transactions. The key must be unique
 * per assetType. We enforce this at the DB level with a unique index.
 */
const transactionSchema = new mongoose.Schema(
  {
    // ── Idempotency ──────────────────────────────────────────────────────────
    // Client-provided unique key. If a request with the same key is retried,
    // the server returns the original result instead of re-processing.
    idempotencyKey: {
      type: String,
      required: true,
      index: true,
    },
    assetType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssetType',
      required: true,
    },

    // ── Accounts involved ────────────────────────────────────────────────────
    fromAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    toAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },

    // ── Money ────────────────────────────────────────────────────────────────
    amount: {
      type: Number,
      required: true,
      min: [0.000001, 'Amount must be positive'],
    },

    // ── Classification ───────────────────────────────────────────────────────
    type: {
      type: String,
      enum: ['topup', 'bonus', 'spend', 'adjustment'],
      required: true,
    },

    // ── Status ───────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },

    description: {
      type: String,
      default: '',
    },

    // Extra data (e.g., payment reference, game level ID, etc.)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Populated after completion
    ledgerEntries: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LedgerEntry',
      },
    ],

    failureReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Unique idempotency key per asset type
transactionSchema.index({ idempotencyKey: 1, assetType: 1 }, { unique: true });
transactionSchema.index({ fromAccount: 1, createdAt: -1 });
transactionSchema.index({ toAccount: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
