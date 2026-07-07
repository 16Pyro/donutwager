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
  if (process.env.NODE_ENV === 'production') {
    const isHttp = !req.secure;
    const isNonWww = req.headers.host && !req.headers.host.startsWith('www.');
    if (isHttp || isNonWww) {
      return res.redirect(301, 'https://www.donutwager.org' + req.url);
    }
  }
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'dw.sid',
  secret: fs.readFileSync(secretFile, 'utf8'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- helpers ---------------------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'not signed in' });
  next();
}

// guests can play instantly: first bet quietly creates a Guest_xxxx account
// tied to their session. Everything still settles server-side under a real user row.
function makeGuest() {
  for (;;) {
    const username = 'Guest_' + crypto.randomInt(1000, 999999);
    if (stmts.getUserByName.get(username)) continue;
    const serverSeed = fair.newServerSeed();
    return stmts.createUser.run({
      username,
      passhash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 8),
      balance: START_BALANCE,
      created_at: Date.now(),
      client_seed: crypto.randomBytes(8).toString('hex'),
      server_seed: serverSeed,
      server_seed_hash: fair.hashSeed(serverSeed),
    }).lastInsertRowid;
  }
}

function ensureUser(req, res, next) {
  if (!req.session.userId) req.session.userId = makeGuest();
  next();
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
    guest: u.username.startsWith('Guest_'),
    totalWagered: u.total_wagered / 100,
    mcUsername: u.mc_username || null,
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
  if (!u) { req.session.destroy(() => {}); return res.json({ user: null }); }
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

app.post('/api/bonus', ensureUser, (req, res) => {
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
app.post('/api/seeds/rotate', ensureUser, (req, res) => {
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

app.get('/api/leaderboard', (req, res) => {
  res.json({ top: stmts.leaderboard.all().map(u => ({ username: u.username, wagered: u.total_wagered / 100 })) });
});

// ---- games ---------------------------------------------------------------------

const battles = require('./battles');
const mcBot   = require('./mcBot');
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

app.get('/api/battles', battleRoute(() => ({ battles: battles.list() })));
app.get('/api/battles/history', battleRoute(() => ({ battles: battles.history() })));
app.get('/api/battles/:id', battleRoute((req) => ({ battle: battles.get(Number(req.params.id)) })));
app.post('/api/battles/create', ensureUser, throttle, battleRoute((req) => battles.create(req.session.userId, req.body || {})));
app.post('/api/battles/join', ensureUser, throttle, battleRoute((req) => ({ battle: battles.join(req.session.userId, Number((req.body || {}).id)) })));
app.post('/api/battles/bots', ensureUser, throttle, battleRoute((req) => ({ battle: battles.callBots(req.session.userId, Number((req.body || {}).id)) })));
app.post('/api/battles/addbot', ensureUser, throttle, battleRoute((req) => ({ battle: battles.addBot(req.session.userId, Number((req.body || {}).id)) })));

app.post('/api/chicken/start', ensureUser, throttle, gameRoute(games.chickenStart));
app.post('/api/chicken/step', ensureUser, throttle, gameRoute(games.chickenStep));
app.post('/api/chicken/cashout', ensureUser, throttle, gameRoute(games.chickenCashout));

app.get('/api/cases', (req, res) => res.json({ cases: games.casesPublic() }));
app.post('/api/cases/open', ensureUser, throttle, gameRoute(games.casesOpen));

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

app.post('/api/daily/open', ensureUser, throttle, (req, res) => {
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
  res.json({ messages: stmts.recentChat.all(after).reverse() });
});
app.post('/api/chat', ensureUser, (req, res) => {
  const now = Date.now();
  if (now - (lastChat.get(req.session.userId) || 0) < 2000) {
    return res.status(429).json({ error: 'chill for a sec between messages' });
  }
  const msg = String((req.body || {}).message || '').trim().slice(0, 200);
  if (!msg) return res.status(400).json({ error: 'empty message' });
  lastChat.set(req.session.userId, now);
  stmts.insertChat.run(req.session.userId, msg, now);
  res.json({ ok: true });
});

app.post('/api/dice', ensureUser, throttle, gameRoute(games.dice));
app.post('/api/coinflip', ensureUser, throttle, gameRoute(games.coinflip));
app.post('/api/mines/start', ensureUser, throttle, gameRoute(games.minesStart));
app.post('/api/mines/reveal', ensureUser, throttle, gameRoute(games.minesReveal));
app.post('/api/mines/cashout', ensureUser, throttle, gameRoute(games.minesCashout));
app.post('/api/towers/start', ensureUser, throttle, gameRoute(games.towersStart));
app.post('/api/towers/pick', ensureUser, throttle, gameRoute(games.towersPick));
app.post('/api/towers/cashout', ensureUser, throttle, gameRoute(games.towersCashout));
app.post('/api/blackjack/start', ensureUser, throttle, gameRoute(games.bjStart));
app.post('/api/blackjack/hit', ensureUser, throttle, gameRoute(games.bjHit));
app.post('/api/blackjack/stand', ensureUser, throttle, gameRoute(games.bjStand));
app.post('/api/blackjack/double', ensureUser, throttle, gameRoute(games.bjDouble));

// ---- Minecraft linking -------------------------------------------------------

app.get('/api/mc/bots', (req, res) => res.json({ bots: mcBot.BOT_NAMES }));

app.post('/api/mc/link/start', (req, res) => {
  const bots = mcBot.BOT_NAMES;
  const bot  = bots[Math.floor(Math.random() * bots.length)];
  const amount = Math.floor(Math.random() * 999) + 1;
  const token  = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000;
  stmts.insertLinkToken.run(token, bot, amount, expires);
  req.session.pendingLinkToken = token;
  res.json({ bot, amount, expiresAt: expires });
});

app.get('/api/mc/link/poll', (req, res) => {
  const token = req.session.pendingLinkToken;
  if (!token) return res.json({ status: 'no_token' });
  const row = stmts.getLinkTokenByToken.get(token);
  if (!row) return res.json({ status: 'expired' });
  if (!row.user_id) return res.json({ status: 'pending' });
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

app.post('/api/mc/withdraw', requireAuth, (req, res) => {
  const u = stmts.getUserById.get(req.session.userId);
  if (!u.mc_username) return res.status(400).json({ error: 'Link your Minecraft account first' });
  const amount = Math.floor(Number((req.body || {}).amount) || 0);
  if (amount < 1) return res.status(400).json({ error: 'Enter a valid amount' });
  const amountCents = amount * 100;
  const result = stmts.tryDeduct.run(amountCents, amountCents, req.session.userId, amountCents);
  if (result.changes === 0) return res.status(400).json({ error: 'Not enough balance' });
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
});
