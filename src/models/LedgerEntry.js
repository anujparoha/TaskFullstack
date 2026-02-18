const mongoose = require('mongoose');

/**
 * LedgerEntry implements a double-entry bookkeeping system.
 *
 * Every financial event creates EXACTLY TWO ledger entries:
 *   - A DEBIT on one account (reduces asset/increases liability)
 *   - A CREDIT on another account (increases asset/reduces liability)
 *
 * For simplicity in a closed-loop virtual currency system:
 *   - CREDIT (+) = balance increases (money coming in to account)
 *   - DEBIT  (-) = balance decreases (money going out of account)
 *
 * The sum of all credits minus debits for an account = current balance.
 * Sum of ALL ledger entries across ALL accounts MUST always equal 0 (double-entry invariant).
 *
 * Example — User buys 100 Gold Coins (Top-up):
 *   Entry 1: account=TREASURY,  type=DEBIT,  amount=100  (Treasury gives 100)
 *   Entry 2: account=USER_001,  type=CREDIT, amount=100  (User receives 100)
 *
 * Example — User spends 30 Gold Coins:
 *   Entry 1: account=USER_001,  type=DEBIT,  amount=30   (User gives 30)
 *   Entry 2: account=REVENUE,   type=CREDIT, amount=30   (Revenue receives 30)
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    // Links both sides of the double-entry to the same transaction
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
      index: true,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    assetType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssetType',
      required: true,
    },
    // 'credit' = +balance, 'debit' = -balance
    entryType: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0.000001, 'Amount must be positive'],
    },
    // Running balance AFTER this entry was applied (for auditability)
    balanceAfter: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Index for fast account history queries
ledgerEntrySchema.index({ account: 1, createdAt: -1 });
ledgerEntrySchema.index({ transactionId: 1, entryType: 1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
