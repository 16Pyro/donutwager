// db.js - sqlite setup + helpers
// balances are stored as integer cents (100 = 1.00 coins) so we never
// touch floating point money math on the server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'donutwager.db'));
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
`);

// additive migrations for older DBs
try { db.exec('ALTER TABLE users ADD COLUMN last_daily INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN mc_username TEXT'); } catch (e) {}

// Drop and recreate mc_link_tokens so user_id is nullable (old schema had NOT NULL)
db.exec(`DROP TABLE IF EXISTS mc_link_tokens;`);
db.exec(`
CREATE TABLE mc_link_tokens (
  token TEXT PRIMARY KEY,
  bot_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  mc_username TEXT,
  user_id INTEGER,
  expires_at INTEGER NOT NULL
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
  tryDeduct: db.prepare('UPDATE users SET balance = balance - ?, total_wagered = total_wagered + ? WHERE id = ? AND balance >= ?'),
  setBonus: db.prepare('UPDATE users SET last_bonus = ? WHERE id = ?'),
  setDaily: db.prepare('UPDATE users SET last_daily = ? WHERE id = ?'),
  setSeeds: db.prepare('UPDATE users SET client_seed=?, server_seed=?, server_seed_hash=?, nonce=0 WHERE id = ?'),
  bumpNonce: db.prepare('UPDATE users SET nonce = nonce + 1 WHERE id = ?'),
  insertBet: db.prepare(`INSERT INTO bets (user_id, game, amount, payout, multiplier, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  recentBets: db.prepare(`SELECT b.game, b.amount, b.payout, b.multiplier, b.created_at, u.username
    FROM bets b JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT 25`),
  myBets: db.prepare(`SELECT game, amount, payout, multiplier, created_at FROM bets
    WHERE user_id = ? ORDER BY id DESC LIMIT 25`),
  leaderboard: db.prepare(`SELECT username, total_wagered FROM users ORDER BY total_wagered DESC LIMIT 10`),
  insertChat: db.prepare('INSERT INTO chat_messages (user_id, message, created_at) VALUES (?, ?, ?)'),
  recentChat: db.prepare(`SELECT c.id, c.message, c.created_at, u.username FROM chat_messages c
    JOIN users u ON u.id = c.user_id WHERE c.id > ? ORDER BY c.id DESC LIMIT 50`),
  getUserByMc: db.prepare('SELECT * FROM users WHERE mc_username = ? COLLATE NOCASE'),
  setMcUsername: db.prepare('UPDATE users SET mc_username = ? WHERE id = ?'),
  createMcUser: db.prepare(`INSERT OR IGNORE INTO users
    (username, passhash, balance, created_at, client_seed, server_seed, server_seed_hash)
    VALUES (@username, @passhash, @balance, @created_at, @client_seed, @server_seed, @server_seed_hash)`),
  insertLinkToken: db.prepare(`INSERT OR REPLACE INTO mc_link_tokens (token, bot_name, amount, expires_at)
    VALUES (?, ?, ?, ?)`),
  getLinkToken: db.prepare('SELECT * FROM mc_link_tokens WHERE bot_name = ? AND amount = ? AND user_id IS NULL AND expires_at > ?'),
  getLinkTokenByToken: db.prepare('SELECT * FROM mc_link_tokens WHERE token = ?'),
  fulfillLinkToken: db.prepare('UPDATE mc_link_tokens SET mc_username = ?, user_id = ? WHERE token = ?'),
  deleteLinkToken: db.prepare('DELETE FROM mc_link_tokens WHERE token = ?'),
  cleanLinkTokens: db.prepare('DELETE FROM mc_link_tokens WHERE expires_at < ?'),
  getActive: db.prepare('SELECT state FROM active_games WHERE user_id = ? AND game = ?'),
  setActive: db.prepare(`INSERT INTO active_games (user_id, game, state) VALUES (?, ?, ?)
    ON CONFLICT(user_id, game) DO UPDATE SET state = excluded.state`),
  clearActive: db.prepare('DELETE FROM active_games WHERE user_id = ? AND game = ?'),
};

module.exports = { db, stmts };
