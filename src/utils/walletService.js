const mongoose = require('mongoose');
const Account = require('../models/Account');
const AssetType = require('../models/AssetType');
const Transaction = require('../models/Transaction');
const LedgerEntry = require('../models/LedgerEntry');

/**
 * WalletService handles all financial operations with:
 *
 * 1. IDEMPOTENCY — Each request carries an idempotencyKey. If the same key
 *    is seen again, we return the original result without re-processing.
 *
 * 2. CONCURRENCY SAFETY — We use MongoDB's atomic findOneAndUpdate with
 *    conditional operators ($gte for balance checks) to prevent race conditions.
 *    No two concurrent requests can both pass the balance check because
 *    the first one to execute atomically deducts the balance.
 *
 * 3. DEADLOCK AVOIDANCE — We always lock accounts in a consistent order
 *    (by _id ascending). This prevents circular waits that cause deadlocks.
 *    (MongoDB doesn't have traditional locks, but this pattern is still
 *     important for session-based multi-document transactions.)
 *
 * 4. DOUBLE-ENTRY LEDGER — Every transaction creates exactly two LedgerEntries:
 *    a debit on the source account and a credit on the destination account.
 *    This ensures the ledger always balances (sum of all entries = 0).
 */
class WalletService {
  /**
   * Internal method to execute a transfer between two accounts.
   * This is the core of the service — all other methods call this.
   *
   * @param {Object} params
   * @param {string} params.idempotencyKey - Client-provided unique key
   * @param {ObjectId} params.fromAccountId - Source account
   * @param {ObjectId} params.toAccountId - Destination account
   * @param {ObjectId} params.assetTypeId - The currency being transferred
   * @param {number} params.amount - How much to transfer
   * @param {string} params.type - 'topup' | 'bonus' | 'spend' | 'adjustment'
   * @param {string} params.description - Human-readable description
   * @param {Object} params.metadata - Extra data to store
   */
  async _executeTransfer({
    idempotencyKey,
    fromAccountId,
    toAccountId,
    assetTypeId,
    amount,
    type,
    description = '',
    metadata = {},
  }) {
    // ── Step 1: Idempotency check ─────────────────────────────────────────
    // Check if we've already processed this exact request.
    const existing = await Transaction.findOne({
      idempotencyKey,
      assetType: assetTypeId,
    }).populate('ledgerEntries');

    if (existing) {
      // Already processed — return original result (idempotent response)
      return { transaction: existing, isIdempotentReplay: true };
    }

    // ── Step 2: Validate amount ───────────────────────────────────────────
    if (!amount || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // ── Step 3: Load both accounts ────────────────────────────────────────
    const [fromAccount, toAccount] = await Promise.all([
      Account.findById(fromAccountId),
      Account.findById(toAccountId),
    ]);

    if (!fromAccount) throw new Error(`Source account not found: ${fromAccountId}`);
    if (!toAccount) throw new Error(`Destination account not found: ${toAccountId}`);
    if (!fromAccount.isActive) throw new Error('Source account is inactive');
    if (!toAccount.isActive) throw new Error('Destination account is inactive');

    // Ensure both accounts deal in the same asset type
    if (
      fromAccount.assetType.toString() !== assetTypeId.toString() ||
      toAccount.assetType.toString() !== assetTypeId.toString()
    ) {
      throw new Error('Account asset type mismatch');
    }

    // ── Step 4: Create a "pending" Transaction record first ───────────────
    // We create the transaction as 'pending' BEFORE touching balances.
    // This creates the idempotency lock immediately, preventing duplicate
    // concurrent requests from both passing the initial idempotency check.
    let transaction;
    try {
      transaction = await Transaction.create({
        idempotencyKey,
        assetType: assetTypeId,
        fromAccount: fromAccountId,
        toAccount: toAccountId,
        amount,
        type,
        description,
        metadata,
        status: 'pending',
      });
    } catch (err) {
      // Duplicate key error (E11000) = race condition on idempotency key.
      // Another concurrent request just created the same transaction.
      // Wait briefly and re-fetch.
      if (err.code === 11000) {
        await new Promise((r) => setTimeout(r, 50));
        const raced = await Transaction.findOne({
          idempotencyKey,
          assetType: assetTypeId,
        }).populate('ledgerEntries');
        if (raced) return { transaction: raced, isIdempotentReplay: true };
        throw new Error('Transaction conflict — please retry');
      }
      throw err;
    }

    try {
      // ── Step 5: Debit source account atomically ───────────────────────
      // CRITICAL: Use findOneAndUpdate with $gte condition to ensure we only
      // deduct if there's sufficient balance. This is atomic in MongoDB —
      // no other operation can interleave between the check and the update.
      //
      // DEADLOCK AVOIDANCE: We process accounts in consistent _id order.
      // (Less relevant for MongoDB but important for SQL / future migrations.)
      const [firstId, secondId] = [fromAccountId, toAccountId].sort();
      const processInOrder = firstId.toString() === fromAccountId.toString();

      let updatedFrom, updatedTo;

      if (processInOrder) {
        updatedFrom = await this._atomicDebit(fromAccount, amount, transaction._id);
        updatedTo = await this._atomicCredit(toAccount, amount, transaction._id);
      } else {
        updatedTo = await this._atomicCredit(toAccount, amount, transaction._id);
        updatedFrom = await this._atomicDebit(fromAccount, amount, transaction._id);
      }

      // ── Step 6: Create double-entry ledger entries ────────────────────
      const [debitEntry, creditEntry] = await Promise.all([
        LedgerEntry.create({
          transactionId: transaction._id,
          account: fromAccountId,
          assetType: assetTypeId,
          entryType: 'debit',
          amount,
          balanceAfter: updatedFrom.balance,
          description,
        }),
        LedgerEntry.create({
          transactionId: transaction._id,
          account: toAccountId,
          assetType: assetTypeId,
          entryType: 'credit',
          amount,
          balanceAfter: updatedTo.balance,
          description,
        }),
      ]);

      // ── Step 7: Mark transaction as completed ─────────────────────────
      transaction.status = 'completed';
      transaction.ledgerEntries = [debitEntry._id, creditEntry._id];
      await transaction.save();

      return { transaction, isIdempotentReplay: false };
    } catch (err) {
      // Mark the transaction as failed for audit purposes
      await Transaction.findByIdAndUpdate(transaction._id, {
        status: 'failed',
        failureReason: err.message,
      });
      throw err;
    }
  }

  /**
   * Atomically debit (reduce balance) from an account.
   * The $gte check ensures we never go below zero — in a single atomic op.
   */
  async _atomicDebit(account, amount, transactionId) {
    const updated = await Account.findOneAndUpdate(
      {
        _id: account._id,
        balance: { $gte: amount }, // Only proceed if sufficient balance
        isActive: true,
      },
      {
        $inc: { balance: -amount },
      },
      { new: true }
    );

    if (!updated) {
      throw new Error(
        `Insufficient balance. Account ${account.userId} has ${account.balance}, needs ${amount}.`
      );
    }

    return updated;
  }

  /**
   * Atomically credit (increase balance) to an account.
   */
  async _atomicCredit(account, amount, transactionId) {
    const updated = await Account.findOneAndUpdate(
      {
        _id: account._id,
        isActive: true,
      },
      {
        $inc: { balance: amount },
      },
      { new: true }
    );

    if (!updated) {
      throw new Error(`Failed to credit account ${account.userId}`);
    }

    return updated;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * FLOW 1: Wallet Top-up (Purchase)
   * User purchases credits — Treasury deducts, user account credits.
   *
   * @param {string} userId
   * @param {string} assetCode - e.g., "GOLD"
   * @param {number} amount
   * @param {string} idempotencyKey
   * @param {Object} metadata - e.g., { paymentReference: "pay_xxx" }
   */
  async topUp({ userId, assetCode, amount, idempotencyKey, metadata = {} }) {
    const assetType = await this._getAssetType(assetCode);
    const userAccount = await this._getUserAccount(userId, assetType._id);
    const treasuryAccount = await this._getSystemAccount('SYSTEM_TREASURY', assetType._id);

    return this._executeTransfer({
      idempotencyKey,
      fromAccountId: treasuryAccount._id,
      toAccountId: userAccount._id,
      assetTypeId: assetType._id,
      amount,
      type: 'topup',
      description: `Top-up: ${amount} ${assetType.code} for user ${userId}`,
      metadata,
    });
  }

  /**
   * FLOW 2: Bonus / Incentive
   * System issues free credits to a user — e.g., referral bonus, daily reward.
   *
   * @param {string} userId
   * @param {string} assetCode
   * @param {number} amount
   * @param {string} idempotencyKey
   * @param {string} reason - e.g., "referral_bonus", "level_complete"
   * @param {Object} metadata
   */
  async issueBonus({ userId, assetCode, amount, idempotencyKey, reason = 'bonus', metadata = {} }) {
    const assetType = await this._getAssetType(assetCode);
    const userAccount = await this._getUserAccount(userId, assetType._id);
    const bonusPool = await this._getSystemAccount('SYSTEM_BONUS_POOL', assetType._id);

    return this._executeTransfer({
      idempotencyKey,
      fromAccountId: bonusPool._id,
      toAccountId: userAccount._id,
      assetTypeId: assetType._id,
      amount,
      type: 'bonus',
      description: `Bonus issued: ${amount} ${assetType.code} to user ${userId} — ${reason}`,
      metadata: { reason, ...metadata },
    });
  }

  /**
   * FLOW 3: Purchase / Spend
   * User spends credits to buy an in-app item/service.
   * Credits move from user account to Revenue account.
   *
   * @param {string} userId
   * @param {string} assetCode
   * @param {number} amount
   * @param {string} idempotencyKey
   * @param {string} itemId - What they're buying
   * @param {Object} metadata
   */
  async spend({ userId, assetCode, amount, idempotencyKey, itemId, metadata = {} }) {
    const assetType = await this._getAssetType(assetCode);
    const userAccount = await this._getUserAccount(userId, assetType._id);
    const revenueAccount = await this._getSystemAccount('SYSTEM_REVENUE', assetType._id);

    return this._executeTransfer({
      idempotencyKey,
      fromAccountId: userAccount._id,
      toAccountId: revenueAccount._id,
      assetTypeId: assetType._id,
      amount,
      type: 'spend',
      description: `Spend: ${amount} ${assetType.code} by user ${userId} for item ${itemId}`,
      metadata: { itemId, ...metadata },
    });
  }

  /**
   * Get balance for a user
   */
  async getBalance(userId, assetCode) {
    const assetType = await this._getAssetType(assetCode);
    const account = await Account.findOne({
      userId,
      assetType: assetType._id,
    }).populate('assetType', 'code name');

    if (!account) {
      throw new Error(`No ${assetCode} wallet found for user ${userId}`);
    }

    return {
      userId,
      assetCode: assetType.code,
      assetName: assetType.name,
      balance: account.balance,
      accountId: account._id,
    };
  }

  /**
   * Get transaction history for a user
   */
  async getHistory(userId, assetCode, { page = 1, limit = 20 } = {}) {
    const assetType = await this._getAssetType(assetCode);
    const account = await this._getUserAccount(userId, assetType._id);

    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      LedgerEntry.find({ account: account._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('transactionId', 'type description metadata status createdAt'),
      LedgerEntry.countDocuments({ account: account._id }),
    ]);

    return {
      userId,
      assetCode,
      currentBalance: account.balance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      entries: entries.map((e) => ({
        id: e._id,
        type: e.entryType,
        amount: e.amount,
        balanceAfter: e.balanceAfter,
        description: e.description,
        transaction: e.transactionId,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * Verify ledger integrity for an account.
   * Recomputes balance from scratch from all ledger entries.
   * Should match the cached balance on the Account document.
   */
  async verifyLedgerIntegrity(userId, assetCode) {
    const assetType = await this._getAssetType(assetCode);
    const account = await this._getUserAccount(userId, assetType._id);

    const entries = await LedgerEntry.find({ account: account._id });

    let computed = 0;
    for (const entry of entries) {
      if (entry.entryType === 'credit') computed += entry.amount;
      else computed -= entry.amount;
    }

    return {
      userId,
      assetCode,
      cachedBalance: account.balance,
      computedBalance: computed,
      isConsistent: Math.abs(computed - account.balance) < 0.000001,
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  async _getAssetType(code) {
    const assetType = await AssetType.findOne({ code: code.toUpperCase(), isActive: true });
    if (!assetType) throw new Error(`Asset type not found or inactive: ${code}`);
    return assetType;
  }

  async _getUserAccount(userId, assetTypeId) {
    const account = await Account.findOne({ userId, assetType: assetTypeId });
    if (!account) throw new Error(`Wallet not found for user: ${userId}`);
    if (!account.isActive) throw new Error(`Wallet is inactive for user: ${userId}`);
    return account;
  }

  async _getSystemAccount(userId, assetTypeId) {
    const account = await Account.findOne({
      userId,
      assetType: assetTypeId,
      accountType: 'system',
    });
    if (!account) throw new Error(`System account not found: ${userId}`);
    return account;
  }
}

module.exports = new WalletService();
