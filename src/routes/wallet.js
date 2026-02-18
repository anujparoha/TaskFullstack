const express = require('express');
const router = express.Router();
const walletService = require('../utils/walletService');
const { validateIdempotencyKey } = require('../middleware/validate');

// ── GET /api/wallets/:userId/balance/:assetCode ──────────────────────────────
/**
 * Get current balance for a user's wallet
 *
 * GET /api/wallets/user_001/balance/GOLD
 */
router.get('/:userId/balance/:assetCode', async (req, res) => {
  try {
    const { userId, assetCode } = req.params;
    const balance = await walletService.getBalance(userId, assetCode);
    res.json({ success: true, data: balance });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// ── GET /api/wallets/:userId/history/:assetCode ──────────────────────────────
/**
 * Get transaction history / ledger for a user
 *
 * GET /api/wallets/user_001/history/GOLD?page=1&limit=20
 */
router.get('/:userId/history/:assetCode', async (req, res) => {
  try {
    const { userId, assetCode } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const history = await walletService.getHistory(userId, assetCode, {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100), // cap at 100
    });

    res.json({ success: true, data: history });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// ── POST /api/wallets/topup ──────────────────────────────────────────────────
/**
 * Wallet Top-up (Purchase)
 * User purchases credits using real money (payment assumed pre-verified)
 *
 * Body:
 *   userId        - string
 *   assetCode     - string (e.g., "GOLD")
 *   amount        - number
 *   idempotencyKey - string (unique per request, provided by client)
 *   metadata      - object (optional, e.g., { paymentReference: "pay_xxx" })
 *
 * POST /api/wallets/topup
 */
router.post('/topup', validateIdempotencyKey, async (req, res) => {
  try {
    const { userId, assetCode, amount, idempotencyKey, metadata } = req.body;

    if (!userId || !assetCode || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, assetCode, amount',
      });
    }

    const result = await walletService.topUp({
      userId,
      assetCode,
      amount: Number(amount),
      idempotencyKey,
      metadata,
    });

    const statusCode = result.isIdempotentReplay ? 200 : 201;
    res.status(statusCode).json({
      success: true,
      isIdempotentReplay: result.isIdempotentReplay,
      data: formatTransaction(result.transaction),
    });
  } catch (err) {
    const status = err.message.includes('Insufficient') ? 422 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ── POST /api/wallets/bonus ──────────────────────────────────────────────────
/**
 * Issue a Bonus / Incentive
 * System awards free credits to a user (referral bonus, level reward, etc.)
 *
 * Body:
 *   userId        - string
 *   assetCode     - string
 *   amount        - number
 *   idempotencyKey - string
 *   reason        - string (e.g., "referral_bonus", "level_complete")
 *   metadata      - object (optional)
 *
 * POST /api/wallets/bonus
 */
router.post('/bonus', validateIdempotencyKey, async (req, res) => {
  try {
    const { userId, assetCode, amount, idempotencyKey, reason, metadata } = req.body;

    if (!userId || !assetCode || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, assetCode, amount',
      });
    }

    const result = await walletService.issueBonus({
      userId,
      assetCode,
      amount: Number(amount),
      idempotencyKey,
      reason,
      metadata,
    });

    const statusCode = result.isIdempotentReplay ? 200 : 201;
    res.status(statusCode).json({
      success: true,
      isIdempotentReplay: result.isIdempotentReplay,
      data: formatTransaction(result.transaction),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/wallets/spend ──────────────────────────────────────────────────
/**
 * Spend Credits (Purchase in-app item/service)
 * Deducts from user, credits to Revenue account
 *
 * Body:
 *   userId        - string
 *   assetCode     - string
 *   amount        - number
 *   idempotencyKey - string
 *   itemId        - string (what they're buying)
 *   metadata      - object (optional)
 *
 * POST /api/wallets/spend
 */
router.post('/spend', validateIdempotencyKey, async (req, res) => {
  try {
    const { userId, assetCode, amount, idempotencyKey, itemId, metadata } = req.body;

    if (!userId || !assetCode || !amount || !itemId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, assetCode, amount, itemId',
      });
    }

    const result = await walletService.spend({
      userId,
      assetCode,
      amount: Number(amount),
      idempotencyKey,
      itemId,
      metadata,
    });

    const statusCode = result.isIdempotentReplay ? 200 : 201;
    res.status(statusCode).json({
      success: true,
      isIdempotentReplay: result.isIdempotentReplay,
      data: formatTransaction(result.transaction),
    });
  } catch (err) {
    const status = err.message.includes('Insufficient') ? 422 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ── GET /api/wallets/:userId/verify/:assetCode ───────────────────────────────
/**
 * Verify ledger integrity
 * Recomputes balance from all ledger entries and compares to cached balance.
 * Use this for auditing and debugging.
 *
 * GET /api/wallets/user_001/verify/GOLD
 */
router.get('/:userId/verify/:assetCode', async (req, res) => {
  try {
    const { userId, assetCode } = req.params;
    const result = await walletService.verifyLedgerIntegrity(userId, assetCode);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────
function formatTransaction(tx) {
  return {
    id: tx._id,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    description: tx.description,
    metadata: tx.metadata,
    createdAt: tx.createdAt,
  };
}

module.exports = router;
