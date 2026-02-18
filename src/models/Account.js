const mongoose = require('mongoose');

/**
 * Account represents either a user wallet or a system account (Treasury, Revenue, etc.)
 * 
 * IMPORTANT: `balance` is a CACHED/COMPUTED field for quick reads.
 * The authoritative balance is always derived from the Ledger entries.
 * We keep this in sync using atomic operations + optimistic locking (version key).
 */
const accountSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      // For system accounts, use a well-known string like "SYSTEM_TREASURY"
    },
    accountType: {
      type: String,
      enum: ['user', 'system'],
      required: true,
      default: 'user',
    },
    assetType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssetType',
      required: true,
    },
    // Cached balance — updated atomically with ledger entries
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Balance cannot go negative'],
    },
    displayName: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    // __v is used for optimistic locking (mongoose built-in version key)
    versionKey: '__v',
  }
);

// Compound index: one account per userId per assetType
accountSchema.index({ userId: 1, assetType: 1 }, { unique: true });
accountSchema.index({ accountType: 1 });

module.exports = mongoose.model('Account', accountSchema);
