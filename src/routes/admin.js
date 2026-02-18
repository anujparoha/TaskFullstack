const express = require('express');
const router = express.Router();
const AssetType = require('../models/AssetType');
const Account = require('../models/Account');
const Transaction = require('../models/Transaction');

// ── GET /api/admin/asset-types ───────────────────────────────────────────────
router.get('/asset-types', async (req, res) => {
  try {
    const assetTypes = await AssetType.find({ isActive: true });
    res.json({ success: true, data: assetTypes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/asset-types ──────────────────────────────────────────────
router.post('/asset-types', async (req, res) => {
  try {
    const { code, name, description, decimalPlaces } = req.body;
    if (!code || !name) {
      return res.status(400).json({ success: false, error: 'code and name are required' });
    }
    const assetType = await AssetType.create({ code, name, description, decimalPlaces });
    res.status(201).json({ success: true, data: assetType });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: 'Asset type code already exists' });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/accounts ──────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const { type, userId } = req.query;
    const filter = {};
    if (type) filter.accountType = type;
    if (userId) filter.userId = userId;

    const accounts = await Account.find(filter)
      .populate('assetType', 'code name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/accounts ─────────────────────────────────────────────────
router.post('/accounts', async (req, res) => {
  try {
    const { userId, accountType, assetCode, displayName, initialBalance, metadata } = req.body;

    if (!userId || !assetCode || !displayName) {
      return res.status(400).json({
        success: false,
        error: 'userId, assetCode, and displayName are required',
      });
    }

    const assetType = await AssetType.findOne({ code: assetCode.toUpperCase() });
    if (!assetType) {
      return res.status(404).json({ success: false, error: `Asset type not found: ${assetCode}` });
    }

    const account = await Account.create({
      userId,
      accountType: accountType || 'user',
      assetType: assetType._id,
      displayName,
      balance: initialBalance || 0,
      metadata: metadata || {},
    });

    res.status(201).json({
      success: true,
      data: { ...account.toObject(), assetType: { code: assetType.code, name: assetType.name } },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Account already exists for this userId + assetType combination',
      });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/transactions ──────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .populate('fromAccount', 'userId displayName')
        .populate('toAccount', 'userId displayName')
        .populate('assetType', 'code name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Math.min(parseInt(limit), 100)),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
        transactions,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/system-balances ───────────────────────────────────────────
router.get('/system-balances', async (req, res) => {
  try {
    const systemAccounts = await Account.find({ accountType: 'system' }).populate(
      'assetType',
      'code name'
    );

    res.json({ success: true, data: systemAccounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
