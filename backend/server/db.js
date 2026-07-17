// db.js - sqlite setup + helpers
// balances are stored as integer cents (100 = 1.00 coins) so we never
// touch floating point money math on the server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'donutwager.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Safety net: real money lives in this file. If the platform swaps in a fresh
// volume, mounts the wrong one, or the file otherwise comes up missing/empty
// on boot, CREATE TABLE IF NOT EXISTS below would happily start serving
// everyone a blank slate (0 balance, empty chat) without anyone noticing until
// it's too late. Instead, if the live db looks empty but we have a prior
// backup snapshot, restore it before opening for real.
(function restoreFromBackupIfEmpty() {
  let looksEmpty = !fs.existsSync(DB_PATH);
  if (!looksEmpty) {
    try {
      const probe = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      const hasUsers = probe.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='users'").get().c > 0;
      looksEmpty = !hasUsers || probe.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
      probe.close();
    } catch (e) {
      looksEmpty = true; // file exists but is corrupt/unreadable - treat as empty
    }
  }
  if (!looksEmpty || !fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
  if (!files.length) return;
  const latest = path.join(BACKUP_DIR, files[files.length - 1]);
  console.error(`[db] SAFETY NET: live database at ${DB_PATH} is missing or empty - restoring from backup ${latest}`);
  fs.copyFileSync(latest, DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (e) {}
  }
})();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  passhash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_bonus INTEGER NOT NULL DEFAULT 0,
  client_seed TEXT NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0,
  total_wagered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER NOT NULL,
  multiplier REAL NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS active_games (
  user_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (user_id, game)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- generic key/value settings store (e.g. the admin win-chance override) - shared
-- between the running server and one-off scripts like admin.js, since both talk
-- to the same sqlite file rather than an in-memory variable only one process sees
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- usernames blocked from ever linking/playing again. Kept as its own table
-- (keyed on the MC username itself, not a user id) so a ban sticks even
-- against an account that doesn't exist yet - it stops the /pay link flow
-- from ever creating one for that name.
CREATE TABLE IF NOT EXISTS bans (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT,
  banned_at INTEGER NOT NULL
);
`);

// additive migrations for older DBs
try { db.exec('ALTER TABLE users ADD COLUMN last_daily INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN mc_username TEXT'); } catch (e) {}
// rakeback: each period tracks a wagered "base" snapshot (rakeback owed = wagered
// since that snapshot * the period's rate) and a last-claim timestamp for cooldown.
// instant has no cooldown, so it only needs a base.
for (const col of [
  'rb_instant_base INTEGER NOT NULL DEFAULT 0',
  'rb_daily_base INTEGER NOT NULL DEFAULT 0', 'rb_daily_at INTEGER NOT NULL DEFAULT 0',
  'rb_weekly_base INTEGER NOT NULL DEFAULT 0', 'rb_weekly_at INTEGER NOT NULL DEFAULT 0',
  'rb_monthly_base INTEGER NOT NULL DEFAULT 0', 'rb_monthly_at INTEGER NOT NULL DEFAULT 0',
  'level_claimed INTEGER NOT NULL DEFAULT 0',
  'level_claimed_list TEXT NOT NULL DEFAULT \'\'', // comma-separated specific milestone levels claimed
  'total_deposited INTEGER NOT NULL DEFAULT 0',
  'total_withdrawn INTEGER NOT NULL DEFAULT 0',
  'anonymous INTEGER NOT NULL DEFAULT 0',
  // wagered-since-season-start, for the 30-day leaderboard race - separate from
  // the all-time total_wagered so a race only counts wagers placed after it began
  'season_wagered INTEGER NOT NULL DEFAULT 0',
  // referrals: referral_code is this user's own shareable code; referred_by is
  // the user id of whoever referred THEM (set once, at account creation, never
  // overwritten). referral_balance is claimable earnings from referred users'
  // wagers; referral_earned is the lifetime total (doesn't decrease on claim).
  'referral_code TEXT',
  'referred_by INTEGER',
  'referral_balance INTEGER NOT NULL DEFAULT 0',
  'referral_earned INTEGER NOT NULL DEFAULT 0',
  // moderation: banned mirrors a row in the `bans` table (kept on the user
  // too so requireAuth can check it with a single row lookup instead of a
  // join on every request); muted_until is a plain epoch-ms expiry.
  'banned INTEGER NOT NULL DEFAULT 0',
  'muted_until INTEGER NOT NULL DEFAULT 0',
]) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) {} }

// Drop and recreate mc_link_tokens so user_id is nullable (old schema had NOT NULL)
db.exec(`DROP TABLE IF EXISTS mc_link_tokens;`);
db.exec(`
CREATE TABLE mc_link_tokens (
  token TEXT PRIMARY KEY,
  bot_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  mc_username TEXT,
  user_id INTEGER,
  expires_at INTEGER NOT NULL,
  referrer_id INTEGER
);
`);

const stmts = {
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser: db.prepare(`INSERT INTO users
    (username, passhash, balance, created_at, client_seed, server_seed, server_seed_hash)
    VALUES (@username, @passhash, @balance, @created_at, @client_seed, @server_seed, @server_seed_hash)`),
  addBalance: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
  setBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),
  // deduct only succeeds if funds are there - the WHERE clause is the guard
  tryDeduct: db.prepare(`UPDATE users SET balance = balance - ?, total_wagered = total_wagered + ?,
    season_wagered = season_wagered + ? WHERE id = ? AND balance >= ?`),
  tryDeductPlain: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
  setBonus: db.prepare('UPDATE users SET last_bonus = ? WHERE id = ?'),
  setDaily: db.prepare('UPDATE users SET last_daily = ? WHERE id = ?'),
  setSeeds: db.prepare('UPDATE users SET client_seed=?, server_seed=?, server_seed_hash=?, nonce=0 WHERE id = ?'),
  bumpNonce: db.prepare('UPDATE users SET nonce = nonce + 1 WHERE id = ?'),
  insertBet: db.prepare(`INSERT INTO bets (user_id, game, amount, payout, multiplier, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  recentBets: db.prepare(`SELECT b.game, b.amount, b.payout, b.multiplier, b.created_at,
    CASE WHEN u.anonymous THEN 'Anonymous' ELSE u.username END AS username
    FROM bets b JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT 25`),
  myBets: db.prepare(`SELECT game, amount, payout, multiplier, created_at FROM bets
    WHERE user_id = ? ORDER BY id DESC LIMIT 25`),
  // ranked by season_wagered (wagers placed since the current 30-day race
  // started), not all-time total_wagered - see server/index.js season logic
  leaderboard: db.prepare(`SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE username END AS username, season_wagered
    FROM users ORDER BY season_wagered DESC LIMIT 10`),
  // top-20 for the dedicated leaderboard page (podium + full list). avatarName is null
  // for anonymous players so the client never renders a skin that could out them.
  leaderboardFull: db.prepare(`
    SELECT CASE WHEN anonymous THEN 'Anonymous' ELSE username END AS username,
           CASE WHEN anonymous THEN NULL ELSE COALESCE(mc_username, username) END AS avatarName,
           season_wagered
    FROM users
    WHERE season_wagered > 0 AND username NOT LIKE 'Guest\\_%' ESCAPE '\\'
    ORDER BY season_wagered DESC LIMIT 20`),
  resetSeasonWagered: db.prepare('UPDATE users SET season_wagered = 0'),
  insertChat: db.prepare('INSERT INTO chat_messages (user_id, message, created_at) VALUES (?, ?, ?)'),
  recentChat: db.prepare(`SELECT c.id, c.message, c.created_at, u.total_wagered,
    CASE WHEN u.anonymous THEN 'Anonymous' ELSE u.username END AS username
    FROM chat_messages c JOIN users u ON u.id = c.user_id WHERE c.id > ? ORDER BY c.id DESC LIMIT 150`),
  getUserByMc: db.prepare('SELECT * FROM users WHERE mc_username = ? COLLATE NOCASE'),
  setMcUsername: db.prepare('UPDATE users SET mc_username = ? WHERE id = ?'),
  createMcUser: db.prepare(`INSERT OR IGNORE INTO users
    (username, passhash, balance, created_at, client_seed, server_seed, server_seed_hash)
    VALUES (@username, @passhash, @balance, @created_at, @client_seed, @server_seed, @server_seed_hash)`),
  insertLinkToken: db.prepare(`INSERT OR REPLACE INTO mc_link_tokens (token, bot_name, amount, expires_at, referrer_id)
    VALUES (?, ?, ?, ?, ?)`),
  getLinkToken: db.prepare('SELECT * FROM mc_link_tokens WHERE bot_name = ? AND amount = ? AND user_id IS NULL AND expires_at > ?'),
  getLinkTokenByToken: db.prepare('SELECT * FROM mc_link_tokens WHERE token = ?'),
  fulfillLinkToken: db.prepare('UPDATE mc_link_tokens SET mc_username = ?, user_id = ? WHERE token = ?'),
  deleteLinkToken: db.prepare('DELETE FROM mc_link_tokens WHERE token = ?'),
  cleanLinkTokens: db.prepare('DELETE FROM mc_link_tokens WHERE expires_at < ?'),
  getActive: db.prepare('SELECT state FROM active_games WHERE user_id = ? AND game = ?'),
  setActive: db.prepare(`INSERT INTO active_games (user_id, game, state) VALUES (?, ?, ?)
    ON CONFLICT(user_id, game) DO UPDATE SET state = excluded.state`),
  clearActive: db.prepare('DELETE FROM active_games WHERE user_id = ? AND game = ?'),
  claimInstantRb: db.prepare('UPDATE users SET rb_instant_base = ? WHERE id = ?'),
  claimDailyRb: db.prepare('UPDATE users SET rb_daily_base = ?, rb_daily_at = ? WHERE id = ?'),
  claimWeeklyRb: db.prepare('UPDATE users SET rb_weekly_base = ?, rb_weekly_at = ? WHERE id = ?'),
  claimMonthlyRb: db.prepare('UPDATE users SET rb_monthly_base = ?, rb_monthly_at = ? WHERE id = ?'),
  setLevelClaimed: db.prepare('UPDATE users SET level_claimed = ? WHERE id = ?'),
  setLevelClaimedList: db.prepare('UPDATE users SET level_claimed_list = ? WHERE id = ?'),
  addDeposited: db.prepare('UPDATE users SET total_deposited = total_deposited + ? WHERE id = ?'),
  addWithdrawn: db.prepare('UPDATE users SET total_withdrawn = total_withdrawn + ? WHERE id = ?'),
  insertTx: db.prepare(`INSERT INTO transactions (user_id, method, type, amount, created_at)
    VALUES (?, ?, ?, ?, ?)`),
  myTx: db.prepare(`SELECT method, type, amount, created_at FROM transactions
    WHERE user_id = ? ORDER BY id DESC LIMIT 50`),
  setAnonymous: db.prepare('UPDATE users SET anonymous = ? WHERE id = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  // ---- referrals ----
  getUserByReferralCode: db.prepare('SELECT * FROM users WHERE referral_code = ? COLLATE NOCASE'),
  setReferralCode: db.prepare('UPDATE users SET referral_code = ? WHERE id = ?'),
  // guarded by "IS NULL" so referred_by can only ever be set once, at account
  // creation - nothing later can reassign who gets credit for a player
  setReferredBy: db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL'),
  creditReferral: db.prepare('UPDATE users SET referral_balance = referral_balance + ?, referral_earned = referral_earned + ? WHERE id = ?'),
  claimReferralBalance: db.prepare('UPDATE users SET balance = balance + referral_balance, referral_balance = 0 WHERE id = ? AND referral_balance > 0'),
  getReferredUsers: db.prepare(`SELECT username, mc_username, total_wagered, created_at
    FROM users WHERE referred_by = ? ORDER BY created_at DESC`),

  // ---- moderation ----
  isBanned: db.prepare('SELECT 1 FROM bans WHERE username = ? COLLATE NOCASE'),
  insertBan: db.prepare(`INSERT INTO bans (username, reason, banned_at) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`),
  deleteBan: db.prepare('DELETE FROM bans WHERE username = ? COLLATE NOCASE'),
  setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  setMuted: db.prepare('UPDATE users SET muted_until = ? WHERE id = ?'),

  // full account wipe back to a fresh-signup baseline: money, wagered/level
  // progress, rakeback bases, referral earnings. Identity fields (username,
  // mc_username, referral_code, who-referred-them) are left alone - this is
  // a progress reset, not a delete.
  fullResetUser: db.prepare(`UPDATE users SET
    balance = 0, total_wagered = 0, season_wagered = 0,
    level_claimed = 0, level_claimed_list = '',
    rb_instant_base = 0, rb_daily_base = 0, rb_daily_at = 0,
    rb_weekly_base = 0, rb_weekly_at = 0, rb_monthly_base = 0, rb_monthly_at = 0,
    total_deposited = 0, total_withdrawn = 0,
    referral_balance = 0, referral_earned = 0
    WHERE id = ?`),
  clearActiveForUser: db.prepare('DELETE FROM active_games WHERE user_id = ?'),
};

module.exports = { db, stmts };
