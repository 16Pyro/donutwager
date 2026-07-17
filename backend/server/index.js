// DonutWager server. Everything that matters happens here, not in the browser.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, stmts } = require('./db');
const fair = require('./fair');
const games = require('./games');
const rewards = require('./rewards');
const SqliteStore = require('./sqliteSessionStore');
const { startBackupSchedule } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;
const START_BALANCE = 0;
const DAILY_BONUS = 1_000_000_000_000;     // 10B coins every 24h
const BONUS_COOLDOWN = 24 * 60 * 60 * 1000;

// session secret persists across restarts so logins survive a deploy
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const secretFile = path.join(DATA_DIR, 'session-secret');
if (!fs.existsSync(secretFile)) {
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'));
}

app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'dw.sid',
  secret: fs.readFileSync(secretFile, 'utf8'),
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true, // every request pushes the expiry back out - active users never expire
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 365 * 24 * 60 * 60 * 1000, // effectively "until you log out"
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- helpers ---------------------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Link your Minecraft account to play' });
  const u = stmts.getUserById.get(req.session.userId);
  if (!u || u.banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'This account has been banned.' });
  }
  next();
}

function formatDuration(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// tiny per-user throttle so nobody can script thousands of bets a second
const lastAction = new Map();
function throttle(req, res, next) {
  const now = Date.now();
  const prev = lastAction.get(req.session.userId) || 0;
  if (now - prev < 120) return res.status(429).json({ error: 'slow down' });
  lastAction.set(req.session.userId, now);
  next();
}

function gameRoute(fn) {
  return (req, res) => {
    try {
      res.json(fn(req.session.userId, req.body || {}));
    } catch (e) {
      if (e instanceof games.GameError) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'something broke on our end' });
    }
  };
}

function publicUser(u) {
  return {
    username: u.username,
    balance: u.balance / 100,
    clientSeed: u.client_seed,
    serverSeedHash: u.server_seed_hash,
    nonce: u.nonce,
    bonusReadyAt: u.last_bonus + BONUS_COOLDOWN,
    dailyReadyAt: u.last_daily + BONUS_COOLDOWN,
    totalWagered: u.total_wagered / 100,
    mcUsername: u.mc_username || null,
    anonymous: !!u.anonymous,
  };
}

// ---- auth --------------------------------------------------------------------

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'username: 3-16 letters, numbers or _' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (stmts.getUserByName.get(username)) {
    return res.status(400).json({ error: 'that name is taken' });
  }
  const serverSeed = fair.newServerSeed();
  const info = stmts.createUser.run({
    username,
    passhash: bcrypt.hashSync(password, 10),
    balance: START_BALANCE,
    created_at: Date.now(),
    client_seed: crypto.randomBytes(8).toString('hex'),
    server_seed: serverSeed,
    server_seed_hash: fair.hashSeed(serverSeed),
  });
  req.session.userId = info.lastInsertRowid;
  res.json({ user: publicUser(stmts.getUserById.get(req.session.userId)) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = stmts.getUserByName.get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.passhash)) {
    return res.status(400).json({ error: 'wrong username or password' });
  }
  req.session.userId = u.id;
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = stmts.getUserById.get(req.session.userId);
  if (!u || u.banned) { req.session.destroy(() => { }); return res.json({ user: null }); }
  // hand back any in-flight games so a refresh doesn't strand them
  const mines = games.minesState(u.id);
  const towers = games.towersState(u.id);
  const bj = games.bjState(u.id);
  const chicken = games.chickenState(u.id);
  res.json({
    user: publicUser(u),
    active: {
      mines: mines ? { revealed: mines.revealed, mineCount: mines.mineCount, amount: mines.amount / 100 } : null,
      towers: towers ? { row: towers.row, diff: towers.diff, amount: towers.amount / 100 } : null,
      blackjack: bj ? { ...games.bjView(bj, false), amount: bj.amount / 100 } : null,
      chicken: chicken ? { lane: chicken.lane, diff: chicken.diff, amount: chicken.amount / 100 } : null,
    },
  });
});

// ---- wallet / meta -------------------------------------------------------------

app.post('/api/bonus', requireAuth, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  const now = Date.now();
  if (now - u.last_bonus < BONUS_COOLDOWN) {
    return res.status(400).json({ error: 'bonus not ready yet', readyAt: u.last_bonus + BONUS_COOLDOWN });
  }
  stmts.setBonus.run(now, u.id);
  stmts.addBalance.run(DAILY_BONUS, u.id);
  res.json({ amount: DAILY_BONUS / 100, balance: (u.balance + DAILY_BONUS) / 100 });
});

// rotate seeds: reveal the old server seed so past bets can be verified
app.post('/api/seeds/rotate', requireAuth, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  if (games.minesState(u.id) || games.towersState(u.id) || games.bjState(u.id) || games.chickenState(u.id)) {
    return res.status(400).json({ error: 'finish active games before rotating seeds' });
  }
  const clientSeed = String((req.body || {}).clientSeed || '').slice(0, 64) || crypto.randomBytes(8).toString('hex');
  const newSeed = fair.newServerSeed();
  stmts.setSeeds.run(clientSeed, newSeed, fair.hashSeed(newSeed), u.id);
  res.json({
    revealedServerSeed: u.server_seed,
    revealedSeedHash: u.server_seed_hash,
    newServerSeedHash: fair.hashSeed(newSeed),
    clientSeed,
  });
});

app.get('/api/feed', (req, res) => {
  res.json({ bets: stmts.recentBets.all().map(b => ({ ...b, amount: b.amount / 100, payout: b.payout / 100 })) });
});

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ bets: stmts.myBets.all(req.session.userId).map(b => ({ ...b, amount: b.amount / 100, payout: b.payout / 100 })) });
});

// 30-day leaderboard race: only wagers placed after the season started count
// (not all-time totals), tracked separately in users.season_wagered. Start
// timestamp is lazily created on first request after a fresh DB/deploy and
// persists in the settings table so it survives restarts. Ending just stops
// the countdown at 0:00 - nothing pays out or resets automatically; that's a
// manual step (`node admin.js resetseason`) so payouts stay a deliberate action.
const SEASON_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
function getSeasonStart() {
  const row = stmts.getSetting.get('seasonStartAt');
  if (row && row.value) return Number(row.value);
  const now = Date.now();
  stmts.setSetting.run('seasonStartAt', String(now));
  return now;
}

app.get('/api/leaderboard', (req, res) => {
  res.json({ top: stmts.leaderboard.all().map(u => ({ username: u.username, wagered: u.season_wagered / 100 })) });
});

app.get('/api/leaderboard/full', (req, res) => {
  res.json({
    top: stmts.leaderboardFull.all().map(u => ({
      username: u.username, avatarName: u.avatarName, wagered: u.season_wagered / 100,
    })),
  });
});

app.get('/api/leaderboard/season', (req, res) => {
  const startAt = getSeasonStart();
  res.json({ startAt, endAt: startAt + SEASON_LENGTH_MS });
});

// ---- games ---------------------------------------------------------------------

const battles = require('./battles');
const roulette = require('./roulette');
const mcBot = require('./mcBot');
const crypto2 = crypto; // alias

function battleRoute(fn) {
  return (req, res) => {
    try { res.json(fn(req, res)); }
    catch (e) {
      if (e instanceof battles.BattleError || e instanceof games.GameError) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'something broke on our end' });
    }
  };
}

app.get('/api/battles', battleRoute((req) => ({ battles: battles.list(req.session.userId) })));
app.get('/api/battles/history', battleRoute((req) => ({ battles: battles.history(req.session.userId) })));
app.get('/api/battles/:id', battleRoute((req) => ({ battle: battles.get(Number(req.params.id), req.session.userId) })));
app.post('/api/battles/create', requireAuth, throttle, battleRoute((req) => battles.create(req.session.userId, req.body || {})));
app.post('/api/battles/join', requireAuth, throttle, battleRoute((req) => ({ battle: battles.join(req.session.userId, Number((req.body || {}).id)) })));
app.post('/api/battles/bots', requireAuth, throttle, battleRoute((req) => ({ battle: battles.callBots(req.session.userId, Number((req.body || {}).id)) })));
app.post('/api/battles/addbot', requireAuth, throttle, battleRoute((req) => ({ battle: battles.addBot(req.session.userId, Number((req.body || {}).id)) })));

// ---- block roulette: one shared server-driven round, everyone bets in -----------

app.get('/api/roulette/state', (req, res) => res.json(roulette.publicState(req.session.userId)));
app.post('/api/roulette/bet', requireAuth, throttle, gameRoute(roulette.placeBet));

app.post('/api/chicken/start', requireAuth, throttle, gameRoute(games.chickenStart));
app.post('/api/chicken/step', requireAuth, throttle, gameRoute(games.chickenStep));
app.post('/api/chicken/cashout', requireAuth, throttle, gameRoute(games.chickenCashout));

app.get('/api/cases', (req, res) => res.json({ cases: games.casesPublic() }));
app.post('/api/cases/open', requireAuth, throttle, gameRoute(games.casesOpen));

// ---- free daily case -------------------------------------------------------------

app.get('/api/daily', (req, res) => {
  const items = games.dailyPublic();
  let readyAt = 0;
  if (req.session.userId) {
    const u = stmts.getUserById.get(req.session.userId);
    if (u) readyAt = u.last_daily + BONUS_COOLDOWN;
  }
  res.json({ items, readyAt });
});

app.post('/api/daily/open', requireAuth, throttle, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  const now = Date.now();
  if (now - u.last_daily < BONUS_COOLDOWN) {
    return res.status(400).json({ error: 'daily case not ready yet', readyAt: u.last_daily + BONUS_COOLDOWN });
  }
  stmts.setDaily.run(now, u.id);
  res.json({ ...games.dailyOpen(u.id), readyAt: now + BONUS_COOLDOWN });
});

// ---- chat ----------------------------------------------------------------------

const lastChat = new Map();
app.get('/api/chat', (req, res) => {
  const after = Number(req.query.after) || 0;
  const messages = stmts.recentChat.all(after).reverse().map((m) => ({
    id: m.id, message: m.message, created_at: m.created_at, username: m.username,
    level: rewards.levelForWagered(m.total_wagered / 100),
  }));
  res.json({ messages });
});
app.post('/api/chat', requireAuth, (req, res) => {
  const now = Date.now();
  const u = stmts.getUserById.get(req.session.userId);
  if (u.muted_until > now) {
    return res.status(403).json({ error: `you have been muted for ${formatDuration(u.muted_until - now)}` });
  }
  if (now - (lastChat.get(req.session.userId) || 0) < 2000) {
    return res.status(429).json({ error: 'chill for a sec between messages' });
  }
  const msg = String((req.body || {}).message || '').trim().slice(0, 200);
  if (!msg) return res.status(400).json({ error: 'empty message' });
  lastChat.set(req.session.userId, now);
  stmts.insertChat.run(req.session.userId, msg, now);
  res.json({ ok: true });
});

app.post('/api/dice', requireAuth, throttle, gameRoute(games.dice));
app.post('/api/coinflip', requireAuth, throttle, gameRoute(games.coinflip));
app.post('/api/mines/start', requireAuth, throttle, gameRoute(games.minesStart));
app.post('/api/mines/reveal', requireAuth, throttle, gameRoute(games.minesReveal));
app.post('/api/mines/cashout', requireAuth, throttle, gameRoute(games.minesCashout));
app.post('/api/towers/start', requireAuth, throttle, gameRoute(games.towersStart));
app.post('/api/towers/pick', requireAuth, throttle, gameRoute(games.towersPick));
app.post('/api/towers/cashout', requireAuth, throttle, gameRoute(games.towersCashout));
app.post('/api/blackjack/start', requireAuth, throttle, gameRoute(games.bjStart));
app.post('/api/blackjack/hit', requireAuth, throttle, gameRoute(games.bjHit));
app.post('/api/blackjack/stand', requireAuth, throttle, gameRoute(games.bjStand));
app.post('/api/blackjack/double', requireAuth, throttle, gameRoute(games.bjDouble));

// ---- Minecraft linking -------------------------------------------------------

app.get('/api/mc/bots', (req, res) => res.json({ bots: mcBot.BOT_NAMES, online: mcBot.isOnline() }));

app.post('/api/mc/link/start', (req, res) => {
  const bots = mcBot.BOT_NAMES;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const amount = Math.floor(Math.random() * 999) + 1;
  const token = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000;
  // referral attribution rides along on the link token - if this /pay ends up
  // creating a brand-new account, mcBot.js credits it to this referrer
  const refCode = String((req.body || {}).refCode || '').trim();
  const referrer = refCode ? stmts.getUserByReferralCode.get(refCode) : null;
  stmts.insertLinkToken.run(token, bot, amount, expires, referrer ? referrer.id : null);
  req.session.pendingLinkToken = token;
  res.json({ bot, amount, expiresAt: expires });
});

app.get('/api/mc/link/poll', (req, res) => {
  const token = req.session.pendingLinkToken;
  if (!token) return res.json({ status: 'no_token' });
  const row = stmts.getLinkTokenByToken.get(token);
  if (!row) return res.json({ status: 'expired' });
  if (!row.user_id) {
    return res.json({ status: 'pending', bot: row.bot_name, amount: row.amount, expiresAt: row.expires_at });
  }
  req.session.userId = row.user_id;
  req.session.pendingLinkToken = null;
  stmts.deleteLinkToken.run(token);
  const u = stmts.getUserById.get(row.user_id);
  res.json({ status: 'linked', user: publicUser(u) });
});

app.post('/api/mc/unlink', requireAuth, (req, res) => {
  stmts.setMcUsername.run(null, req.session.userId);
  res.json({ ok: true });
});

app.post('/api/anonymous', requireAuth, (req, res) => {
  const enabled = !!(req.body || {}).enabled;
  stmts.setAnonymous.run(enabled ? 1 : 0, req.session.userId);
  res.json({ ok: true, anonymous: enabled });
});

// ---- rewards: rakeback + wagered level milestones ----------------------------

app.get('/api/rewards', requireAuth, (req, res) => {
  res.json(rewards.getRewards(req.session.userId));
});

// ---- referrals: a shareable code, and a small cut of every wager placed by
// whoever signs up through it - not their deposits, not a one-time bonus,
// just a slice of the house edge on their play, forever. --------------------

const REFERRAL_CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function genReferralCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)]).join('');
  } while (stmts.getUserByReferralCode.get(code));
  return code;
}

app.get('/api/referrals', requireAuth, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  let code = u.referral_code;
  if (!code) { code = genReferralCode(); stmts.setReferralCode.run(code, u.id); }
  const referred = stmts.getReferredUsers.all(u.id).map(r => ({
    username: r.mc_username || r.username,
    wagered: r.total_wagered / 100,
    // derived, not stored per-pair - exact as long as REFERRAL_RATE never
    // changes retroactively, since referred_by is set before a player's
    // first-ever wager and every wager since has paid at this same rate
    earned: Math.floor(r.total_wagered * games.REFERRAL_RATE) / 100,
    joinedAt: r.created_at,
  }));
  res.json({
    code,
    link: `${req.protocol}://${req.get('host')}/?ref=${code}`,
    rate: games.REFERRAL_RATE,
    referredCount: referred.length,
    totalEarned: u.referral_earned / 100,
    claimableBalance: u.referral_balance / 100,
    referredUsers: referred,
    // whether THIS user was themselves referred by someone - once true it's
    // permanent (same one-time guard as the automatic ?ref= link path), so
    // the client only needs to show the "enter a code" field before this
    referredBy: !!u.referred_by,
  });
});

app.post('/api/referrals/code', requireAuth, throttle, (req, res) => {
  const raw = String((req.body || {}).code || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,16}$/.test(raw)) return res.status(400).json({ error: 'code: 3-16 letters, numbers or _' });
  const existing = stmts.getUserByReferralCode.get(raw);
  if (existing && existing.id !== req.session.userId) return res.status(400).json({ error: 'that code is taken' });
  stmts.setReferralCode.run(raw, req.session.userId);
  res.json({ code: raw });
});

// manually redeem someone else's referral code - the automatic ?ref= URL
// capture only ever applies at account creation (see mcBot.js), so this is
// the only way an already-existing account can retroactively get a
// referrer. Same one-time guard (setReferredBy is a WHERE referred_by IS
// NULL update) - works here for exactly the same reason it works there.
app.post('/api/referrals/enter', requireAuth, throttle, (req, res) => {
  const raw = String((req.body || {}).code || '').trim().toLowerCase();
  if (!raw) return res.status(400).json({ error: 'enter a code' });
  const u = stmts.getUserById.get(req.session.userId);
  if (u.referred_by) return res.status(400).json({ error: 'you already have a referrer' });
  const referrer = stmts.getUserByReferralCode.get(raw);
  if (!referrer) return res.status(400).json({ error: 'no account with that code' });
  if (referrer.id === u.id) return res.status(400).json({ error: "you can't refer yourself" });
  const result = stmts.setReferredBy.run(referrer.id, u.id);
  if (result.changes === 0) return res.status(400).json({ error: 'you already have a referrer' });
  res.json({ ok: true });
});

app.post('/api/referrals/claim', requireAuth, throttle, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  if (!u.referral_balance) return res.status(400).json({ error: 'nothing to claim yet' });
  const claimed = u.referral_balance;
  stmts.claimReferralBalance.run(req.session.userId);
  const updated = stmts.getUserById.get(req.session.userId);
  res.json({ ok: true, claimed: claimed / 100, balance: updated.balance / 100 });
});

// public profile lookup (chat/leaderboard "click a name" card) - no balance,
// no deposit/withdraw history, nothing private. anonymous players resolve to
// nothing since their displayed name is literally "Anonymous", not a real one.
app.get('/api/user/:username', (req, res) => {
  // chat and the live feed display mc_username, so try that first
  const u = stmts.getUserByMc.get(req.params.username) || stmts.getUserByName.get(req.params.username);
  if (!u || u.anonymous) return res.status(404).json({ error: 'user not found' });
  const level = rewards.getRewards(u.id).level;
  res.json({
    username: u.mc_username || u.username,
    level: level.level,
    totalWagered: u.total_wagered / 100,
    createdAt: u.created_at,
    // recent bets are already broadcast publicly on the live feed for
    // non-anonymous players, so this exposes nothing new. balance and
    // deposit/withdraw history stay private.
    recentBets: stmts.myBets.all(u.id).map(b => ({
      game: b.game, amount: b.amount / 100, payout: b.payout / 100,
      multiplier: b.multiplier, created_at: b.created_at,
    })),
  });
});

// direct player-to-player balance transfer. Deliberately NOT routed through
// games.takeBet - a tip isn't a wager, and letting it touch season_wagered/
// referral commissions/rakeback bases would let two accounts a player
// controls farm all three just by tipping back and forth with no real bet
// ever placed. tryDeductPlain is the same guarded (no negative balance)
// debit /api/mc/withdraw already uses.
app.post('/api/tip', requireAuth, throttle, (req, res) => {
  const { username, amount } = req.body || {};
  const target = stmts.getUserByMc.get(String(username || '')) || stmts.getUserByName.get(String(username || ''));
  if (!target || target.anonymous) return res.status(400).json({ error: 'player not found' });
  if (target.id === req.session.userId) return res.status(400).json({ error: "you can't tip yourself" });
  let cents;
  try { cents = games.parseAmount(amount); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const result = stmts.tryDeductPlain.run(cents, req.session.userId, cents);
  if (result.changes === 0) return res.status(400).json({ error: 'not enough balance' });
  stmts.addBalance.run(cents, target.id);
  const now = Date.now();
  stmts.insertTx.run(req.session.userId, 'Tip', `Sent to ${target.mc_username || target.username}`, -cents, now);
  stmts.insertTx.run(target.id, 'Tip', `Received from ${stmts.getUserById.get(req.session.userId).username}`, cents, now);
  const updated = stmts.getUserById.get(req.session.userId);
  res.json({ ok: true, balance: updated.balance / 100 });
});

app.get('/api/profile', requireAuth, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  const level = rewards.getRewards(req.session.userId).level;
  res.json({
    username: u.username,
    mcUsername: u.mc_username || null,
    level: level.level,
    wageredCoins: level.wageredCoins,
    curFloor: level.curFloor,
    nextCeil: level.nextCeil,
    totalDeposited: u.total_deposited / 100,
    totalWithdrawn: u.total_withdrawn / 100,
    totalWagered: u.total_wagered / 100,
    profit: (u.balance + u.total_withdrawn - u.total_deposited) / 100,
    transactions: stmts.myTx.all(req.session.userId).map(t => ({ ...t, amount: t.amount / 100 })),
  });
});

app.post('/api/rewards/rakeback', requireAuth, throttle, (req, res) => {
  try {
    res.json(rewards.claimRakeback(req.session.userId, String((req.body || {}).kind || '')));
  } catch (e) {
    if (e instanceof rewards.RewardsError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'something broke on our end' });
  }
});

app.post('/api/rewards/level', requireAuth, throttle, (req, res) => {
  try {
    res.json(rewards.claimLevelRewards(req.session.userId, Number((req.body || {}).level)));
  } catch (e) {
    if (e instanceof rewards.RewardsError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'something broke on our end' });
  }
});

app.post('/api/mc/withdraw', requireAuth, (req, res) => {
  if (!mcBot.isOnline()) return res.status(503).json({ error: 'BOT IS CURRENTLY DOWN' });
  const u = stmts.getUserById.get(req.session.userId);
  if (!u.mc_username) return res.status(400).json({ error: 'Link your Minecraft account first' });
  const amount = Math.floor(Number((req.body || {}).amount) || 0);
  if (amount < 1) return res.status(400).json({ error: 'Enter a valid amount' });
  const bank = mcBot.getBankBalance();
  if (bank !== null && amount > bank) return res.status(503).json({ error: 'Withdraw is currently down' });
  const amountCents = amount * 100;
  const result = stmts.tryDeductPlain.run(amountCents, req.session.userId, amountCents);
  if (result.changes === 0) return res.status(400).json({ error: 'Not enough balance' });
  stmts.addWithdrawn.run(amountCents, req.session.userId);
  stmts.insertTx.run(req.session.userId, 'Minecraft', 'Withdraw', -amountCents, Date.now());
  mcBot.queueWithdraw(u.mc_username, amount, u.id);
  const updated = stmts.getUserById.get(req.session.userId);
  res.json({ ok: true, balance: updated.balance / 100 });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DonutWager running on http://localhost:${PORT}`);
  mcBot.init();
  roulette.init();
  startBackupSchedule();
});
