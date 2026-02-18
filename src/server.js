require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');

const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Connect to Database ──────────────────────────────────────────────────────
connectDB();

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet());

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ── General Middleware ───────────────────────────────────────────────────────
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'wallet-service',
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/wallets', walletRoutes);
app.use('/api/admin', adminRoutes);

// ── API Reference ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Wallet Service API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      wallet: {
        getBalance:  'GET  /api/wallets/:userId/balance/:assetCode',
        getHistory:  'GET  /api/wallets/:userId/history/:assetCode',
        topUp:       'POST /api/wallets/topup',
        bonus:       'POST /api/wallets/bonus',
        spend:       'POST /api/wallets/spend',
        verifyLedger:'GET  /api/wallets/:userId/verify/:assetCode',
      },
      admin: {
        listAssetTypes:   'GET  /api/admin/asset-types',
        createAssetType:  'POST /api/admin/asset-types',
        listAccounts:     'GET  /api/admin/accounts',
        createAccount:    'POST /api/admin/accounts',
        listTransactions: 'GET  /api/admin/transactions',
        systemBalances:   'GET  /api/admin/system-balances',
      },
    },
  });
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
🚀 Wallet Service running on port ${PORT}
📖 API docs: http://localhost:${PORT}/
💊 Health:   http://localhost:${PORT}/health
  `);
});

module.exports = app;
