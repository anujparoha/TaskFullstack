/**
 * seed.js — Seeds the database with initial data
 *
 * Run: node src/seed.js
 *
 * Creates:
 *   - 3 Asset Types: Gold Coins, Diamonds, Loyalty Points
 *   - System accounts (Treasury, Bonus Pool, Revenue) for each asset type
 *   - 2 User accounts for each asset type with initial balances
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AssetType = require('./models/AssetType');
const Account = require('./models/Account');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wallet_service';

// ── Seed Data Definitions ─────────────────────────────────────────────────────

const ASSET_TYPES = [
  { code: 'GOLD', name: 'Gold Coins', description: 'Primary in-game currency', decimalPlaces: 0 },
  { code: 'DIAMOND', name: 'Diamonds', description: 'Premium currency for rare items', decimalPlaces: 0 },
  { code: 'POINTS', name: 'Loyalty Points', description: 'Loyalty reward points', decimalPlaces: 0 },
];

// System accounts get very large balances to act as the source of funds
const SYSTEM_ACCOUNTS = [
  {
    userId: 'SYSTEM_TREASURY',
    displayName: 'Treasury — Receives real-money top-ups from users',
    accountType: 'system',
    initialBalance: 10_000_000,
  },
  {
    userId: 'SYSTEM_BONUS_POOL',
    displayName: 'Bonus Pool — Source of free bonuses and incentives',
    accountType: 'system',
    initialBalance: 5_000_000,
  },
  {
    userId: 'SYSTEM_REVENUE',
    displayName: 'Revenue — Receives credits when users spend',
    accountType: 'system',
    initialBalance: 0,
  },
];

const USER_ACCOUNTS = [
  {
    userId: 'user_alice',
    displayName: "Alice's Wallet",
    accountType: 'user',
    // Initial balances per asset type
    balances: { GOLD: 500, DIAMOND: 50, POINTS: 1200 },
  },
  {
    userId: 'user_bob',
    displayName: "Bob's Wallet",
    accountType: 'user',
    balances: { GOLD: 150, DIAMOND: 10, POINTS: 300 },
  },
];

// ── Seed Function ─────────────────────────────────────────────────────────────

async function seed() {
  console.log('🌱 Starting database seed...\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // ── Step 1: Clear existing data ──────────────────────────────────────────
  console.log('🗑️  Clearing existing seed data...');
  await AssetType.deleteMany({});
  await Account.deleteMany({});
  // Don't clear Transactions/Ledger entries in case they exist from other runs
  console.log('   Done.\n');

  // ── Step 2: Create Asset Types ───────────────────────────────────────────
  console.log('💰 Creating Asset Types...');
  const createdAssetTypes = await AssetType.insertMany(ASSET_TYPES);
  const assetTypeMap = {}; // code -> document
  for (const at of createdAssetTypes) {
    assetTypeMap[at.code] = at;
    console.log(`   ✓ ${at.code} — ${at.name}`);
  }
  console.log('');

  // ── Step 3: Create System Accounts ──────────────────────────────────────
  console.log('🏦 Creating System Accounts...');
  for (const at of createdAssetTypes) {
    for (const sysAcc of SYSTEM_ACCOUNTS) {
      await Account.create({
        userId: sysAcc.userId,
        displayName: `[${at.code}] ${sysAcc.displayName}`,
        accountType: sysAcc.accountType,
        assetType: at._id,
        balance: sysAcc.initialBalance,
      });
      console.log(`   ✓ ${sysAcc.userId} [${at.code}] = ${sysAcc.initialBalance.toLocaleString()}`);
    }
  }
  console.log('');

  // ── Step 4: Create User Accounts ────────────────────────────────────────
  console.log('👤 Creating User Accounts...');
  for (const user of USER_ACCOUNTS) {
    for (const at of createdAssetTypes) {
      const balance = user.balances[at.code] || 0;
      await Account.create({
        userId: user.userId,
        displayName: `[${at.code}] ${user.displayName}`,
        accountType: user.accountType,
        assetType: at._id,
        balance,
      });
      console.log(`   ✓ ${user.userId} [${at.code}] = ${balance.toLocaleString()}`);
    }
  }
  console.log('');

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalAccounts = await Account.countDocuments();
  console.log(`✅ Seed complete!`);
  console.log(`   Asset Types: ${createdAssetTypes.length}`);
  console.log(`   Total Accounts: ${totalAccounts}`);
  console.log('');
  console.log('🧪 Quick test commands:');
  console.log('   GET  http://localhost:3000/api/wallets/user_alice/balance/GOLD');
  console.log('   GET  http://localhost:3000/api/wallets/user_bob/balance/GOLD');
  console.log('   GET  http://localhost:3000/api/admin/system-balances');
  console.log('');

  await mongoose.disconnect();
  console.log('👋 Disconnected. Ready to go!\n');
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
