# 🪙 Wallet Service

A high-traffic virtual wallet service for gaming platforms and loyalty reward systems. Built with **Node.js**, **Express**, and **MongoDB (Mongoose)**.

---

## 📐 Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         API Layer                            │
│  POST /topup    POST /bonus    POST /spend    GET /balance   │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                    WalletService                             │
│  • Idempotency check  → return cached result if duplicate   │
│  • Create pending Transaction (atomic idempotency lock)     │
│  • Atomic balance update  (findOneAndUpdate + $gte check)   │
│  • Create double-entry LedgerEntries                        │
│  • Mark Transaction as completed                            │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                      MongoDB                                 │
│  AssetType │ Account │ Transaction │ LedgerEntry            │
└──────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Option A — Docker (Recommended)

```bash
# Clone the repo
git clone <repo-url>
cd wallet-service

# Start everything (MongoDB + seed + API) with one command
docker-compose up --build

# The API is now at http://localhost:3000
```

### Option B — Local (Node + MongoDB)

```bash
# Prerequisites: Node 18+, MongoDB 6+

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env if your MongoDB URI is different

# 3. Seed the database
npm run seed

# 4. Start the API
npm start
# or for development with auto-reload:
npm run dev
```

---

## 🌱 Seeding

The seed script (`src/seed.js`) inserts:

| Type | What | Details |
|------|------|---------|
| **Asset Types** | Gold Coins (`GOLD`) | Primary in-game currency |
| | Diamonds (`DIAMOND`) | Premium currency |
| | Loyalty Points (`POINTS`) | Reward points |
| **System Accounts** | Treasury | Source for top-ups (10M initial balance) |
| | Bonus Pool | Source for free bonuses (5M initial balance) |
| | Revenue | Receives spend credits (starts at 0) |
| **User Accounts** | `user_alice` | GOLD=500, DIAMOND=50, POINTS=1200 |
| | `user_bob` | GOLD=150, DIAMOND=10, POINTS=300 |

Each system account has one wallet per asset type (3 × 3 = 9 system accounts, 2 × 3 = 6 user accounts).

---

## 📡 API Reference

### Base URL: `http://localhost:3000`

---

### `GET /health`
Returns service health status.

---

### Wallet Endpoints

#### `GET /api/wallets/:userId/balance/:assetCode`
Get current balance.

```bash
curl http://localhost:3000/api/wallets/user_alice/balance/GOLD
```

```json
{
  "success": true,
  "data": {
    "userId": "user_alice",
    "assetCode": "GOLD",
    "assetName": "Gold Coins",
    "balance": 500
  }
}
```

---

#### `GET /api/wallets/:userId/history/:assetCode?page=1&limit=20`
Get ledger history (paginated).

```bash
curl http://localhost:3000/api/wallets/user_alice/history/GOLD
```

---

#### `POST /api/wallets/topup` — Flow 1: Wallet Top-up
User purchases credits (payment assumed pre-verified).

```bash
curl -X POST http://localhost:3000/api/wallets/topup \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_alice",
    "assetCode": "GOLD",
    "amount": 100,
    "idempotencyKey": "unique-request-id-001",
    "metadata": { "paymentReference": "pay_stripe_abc123" }
  }'
```

---

#### `POST /api/wallets/bonus` — Flow 2: Issue Bonus
System awards free credits to a user.

```bash
curl -X POST http://localhost:3000/api/wallets/bonus \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_bob",
    "assetCode": "POINTS",
    "amount": 200,
    "idempotencyKey": "bonus-level5-user_bob-20240101",
    "reason": "level_complete",
    "metadata": { "level": 5 }
  }'
```

---

#### `POST /api/wallets/spend` — Flow 3: Purchase / Spend
User spends credits to buy an in-app item.

```bash
curl -X POST http://localhost:3000/api/wallets/spend \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_alice",
    "assetCode": "GOLD",
    "amount": 30,
    "idempotencyKey": "spend-sword-user_alice-20240101",
    "itemId": "item_sword_of_fire",
    "metadata": { "itemName": "Sword of Fire" }
  }'
```

---

#### `GET /api/wallets/:userId/verify/:assetCode`
Audit endpoint — recomputes balance from all ledger entries and compares to cached balance.

```bash
curl http://localhost:3000/api/wallets/user_alice/verify/GOLD
```

---

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/asset-types` | List all asset types |
| POST | `/api/admin/asset-types` | Create a new asset type |
| GET | `/api/admin/accounts` | List accounts (filter: `?type=system&userId=xxx`) |
| POST | `/api/admin/accounts` | Create a new account |
| GET | `/api/admin/transactions` | List transactions (filter: `?type=spend&status=completed`) |
| GET | `/api/admin/system-balances` | View all system account balances |

---

## 🔐 Idempotency

Every write endpoint (`topup`, `bonus`, `spend`) **requires** an `idempotencyKey`.

- The key must be unique per operation (use a UUID or meaningful string).
- If the same key is sent again, the original result is returned without re-processing.
- The response includes `"isIdempotentReplay": true` when a duplicate is detected.

**How it works:**
1. Before processing, we look for an existing `Transaction` with the same `idempotencyKey` + `assetType`.
2. If found → return the original result immediately.
3. If not found → we insert the `Transaction` record as `pending` **first**, using MongoDB's unique index as an atomic lock. If two concurrent requests arrive simultaneously, only one can create the pending record — the other gets a duplicate key error (E11000) and retries the lookup.

---

## ⚡ Concurrency & Race Conditions

### The Problem
Without protection, two concurrent "spend 100 coins" requests for a user with 150 coins could both pass a balance check and both deduct, leaving the user at -50.

### Our Solution: Atomic `findOneAndUpdate` with Condition

```javascript
// This is atomic — MongoDB's document-level lock ensures
// only ONE operation can pass the $gte check at a time.
Account.findOneAndUpdate(
  { _id: accountId, balance: { $gte: amount } },  // ← conditional check
  { $inc: { balance: -amount } },                  // ← atomic deduct
  { new: true }
)
```

If the condition fails (balance < amount), MongoDB returns `null` — no deduction happens. The first concurrent request that wins deducts the balance atomically, and the second one finds insufficient funds.

---

## 🔒 Deadlock Avoidance

When debiting one account and crediting another, we always acquire locks in **sorted `_id` order**:

```javascript
const [firstId, secondId] = [fromAccountId, toAccountId].sort();
// Always process smaller _id first
```

This prevents the classic A→B + B→A circular deadlock pattern. (MongoDB doesn't have traditional deadlocks, but this pattern protects against ordering issues in future SQL migrations and is a good practice.)

---

## 📒 Double-Entry Ledger

Every financial event creates **exactly two ledger entries** — one debit and one credit:

```
User buys 100 Gold Coins (Top-up):
  TREASURY  → DEBIT  100  (Treasury gives 100 coins)
  USER_ALICE → CREDIT 100  (Alice receives 100 coins)

Alice spends 30 Gold Coins:
  USER_ALICE → DEBIT  30   (Alice gives 30 coins)
  REVENUE   → CREDIT 30   (Revenue receives 30 coins)
```

**The ledger always balances:** Sum of all credits − sum of all debits = 0.

Use `GET /api/wallets/:userId/verify/:assetCode` to audit any wallet — it recomputes the balance from all ledger entries and checks it against the cached balance.

---

## 🛠 Technology Choices

| Choice | Reason |
|--------|--------|
| **Node.js + Express** | Fast I/O, huge ecosystem, excellent MongoDB support |
| **MongoDB + Mongoose** | Document-level atomic operations make balance updates safe without distributed transactions. Flexible schema is great for `metadata`. Horizontal scaling via sharding. |
| **Mongoose `findOneAndUpdate`** | Atomic read-modify-write. The `$gte` condition prevents negative balances without needing 2-phase locks. |
| **Double-entry ledger** | Immutable audit trail. Every coin is accounted for at all times. Cannot silently lose or create coins. |
| **Unique index on `{idempotencyKey, assetType}`** | Database-enforced idempotency. The unique index is the last line of defense even if application-level checks fail under race conditions. |

---

## 📁 Project Structure

```
wallet-service/
├── src/
│   ├── config/
│   │   └── database.js         # MongoDB connection
│   ├── models/
│   │   ├── AssetType.js        # Currency definitions
│   │   ├── Account.js          # User & system wallets
│   │   ├── Transaction.js      # Top-level transaction records
│   │   └── LedgerEntry.js      # Double-entry ledger lines
│   ├── routes/
│   │   ├── wallet.js           # Core wallet endpoints
│   │   └── admin.js            # Admin / reporting endpoints
│   ├── middleware/
│   │   └── validate.js         # Idempotency key validation
│   ├── utils/
│   │   └── walletService.js    # Core business logic
│   ├── seed.js                 # Database seeding script
│   └── server.js               # Express app entry point
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```
