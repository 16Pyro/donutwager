// roulette.js - "Block Roulette": one shared round everyone bets into, spins
// on a fixed clock. Unlike every other game here (private per-user state),
// this is server-driven - a single in-memory loop advances betting -> spin ->
// payout -> next round on its own, independent of any player's requests.
// Safe because this app runs as one Node process (same assumption battles.js
// and mcBot.js already make - no cross-process coordination needed).
const crypto = require('crypto');
const { db } = require('./db');
const games = require('./games');

db.exec(`
CREATE TABLE IF NOT EXISTS roulette_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  color TEXT,
  seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roulette_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  color TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

const rstmts = {
  insertRound: db.prepare('INSERT INTO roulette_rounds (color, seed, seed_hash, created_at) VALUES (?, ?, ?, ?)'),
  setRoundColor: db.prepare('UPDATE roulette_rounds SET color = ? WHERE id = ?'),
  recentRounds: db.prepare('SELECT id, color FROM roulette_rounds WHERE color IS NOT NULL ORDER BY id DESC LIMIT 7'),
  insertBet: db.prepare(`INSERT INTO roulette_bets (round_id, user_id, color, amount, payout, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  setBetPayout: db.prepare('UPDATE roulette_bets SET payout = ? WHERE id = ?'),
  roundBets: db.prepare(`SELECT rb.id, rb.user_id, rb.color, rb.amount, rb.payout,
      CASE WHEN u.anonymous THEN 'Anonymous' ELSE COALESCE(u.mc_username, u.username) END AS username
    FROM roulette_bets rb JOIN users u ON u.id = rb.user_id WHERE rb.round_id = ? ORDER BY rb.id ASC`),
  myBetOnColor: db.prepare('SELECT id FROM roulette_bets WHERE round_id = ? AND user_id = ? AND color = ?'),
};

// weights are literal slice counts out of 15 - see the RTP derivation in the
// commit message/PR: with red & purple at 2x and yellow at 14x, weights of
// 7/7/1 are the unique split that gives all three colors the exact same
// ~93.3% RTP (6.67% house edge). Any other split favors one color over another.
const COLORS = [
  { key: 'red',    weight: 7, mult: 2,  icon: 'redstone_block' },
  { key: 'purple', weight: 7, mult: 2,  icon: 'amethyst_shard' },
  { key: 'yellow', weight: 1, mult: 14, icon: 'gold_block' },
];
const COLOR_BY_KEY = Object.fromEntries(COLORS.map(c => [c.key, c]));

const BETTING_MS = 15000; // window to place bets
// "spinning" - bets are closed, outcome is decided but not shown yet. Sized to
// fit the client's full reveal theater: up to ~1.5s poll latency to notice the
// phase + ~1.3s EOS-block beat + an 8-10.5s randomized reel spin
const SPIN_MS = 13500;
const PAUSE_MS = 4000;    // reveal sits on screen before the next round opens

let round = null; // { id, status, bettingEndsAt, spinEndsAt, seed, seedHash, color }
let roundTimer = null;

function startRound() {
  const seed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(seed).digest('hex');
  const now = Date.now();
  const info = rstmts.insertRound.run(null, seed, seedHash, now);
  round = {
    id: info.lastInsertRowid,
    status: 'betting',
    startedAt: now,
    bettingEndsAt: now + BETTING_MS,
    spinEndsAt: now + BETTING_MS + SPIN_MS,
    seed, seedHash,
    color: null,
  };
  roundTimer = setTimeout(closeBetting, BETTING_MS);
}

function closeBetting() {
  if (!round) return;
  round.status = 'spinning';
  // outcome is decided the instant betting closes (using the seed committed
  // at round start, before anyone could see it) - only the reveal is delayed,
  // purely so the client's spin animation has something to build up to
  const roll = crypto.createHmac('sha256', round.seed).update(`roulette:${round.id}`).digest();
  const frac = roll.readUInt32BE(0) / 4294967296;
  const idx = games.weightedIndex(COLORS, frac);
  round.color = COLORS[idx].key;
  roundTimer = setTimeout(resolveRound, SPIN_MS);
}

function resolveRound() {
  if (!round) return;
  round.status = 'done';
  rstmts.setRoundColor.run(round.color, round.id);
  const mult = COLOR_BY_KEY[round.color].mult;
  for (const bet of rstmts.roundBets.all(round.id)) {
    const won = bet.color === round.color;
    const payout = won ? Math.floor(bet.amount * mult) : 0;
    rstmts.setBetPayout.run(payout, bet.id);
    // settle() both credits the payout AND records the bets-table row the
    // feed/stats/history pages already know how to read - don't also credit
    // balance here ourselves, that would double-pay every winning bet
    games.settle(bet.user_id, 'roulette', bet.amount, payout, won ? mult : 0, { color: bet.color, winner: round.color });
  }
  roundTimer = setTimeout(startRound, PAUSE_MS);
}

function init() {
  if (round) return; // don't double-start if something calls init() twice
  startRound();
}

function placeBet(userId, body) {
  if (!round || round.status !== 'betting') throw new games.GameError('betting is closed for this round');
  const color = String((body || {}).color || '');
  if (!Object.hasOwn(COLOR_BY_KEY, color)) throw new games.GameError('pick red, purple, or yellow');
  // one bet per color, but betting several different colors in one round is
  // allowed (matches the reference site - hedging red+gold etc. is part of
  // the game, and the house edge is identical on every color anyway)
  if (rstmts.myBetOnColor.get(round.id, userId, color)) throw new games.GameError(`you already bet on ${color} this round`);
  const amount = games.parseAmount((body || {}).amount);
  games.takeBet(userId, amount); // debits balance, tracks wagered/referral like every other game
  rstmts.insertBet.run(round.id, userId, color, amount, 0, Date.now());
  return publicState(userId);
}

function publicRound() {
  if (!round) return null;
  const out = {
    id: round.id, status: round.status,
    bettingEndsAt: round.bettingEndsAt, spinEndsAt: round.spinEndsAt,
    seedHash: round.seedHash,
  };
  // color is decided the instant betting closes (start of 'spinning'), and
  // safe to expose from that point on - betting is already locked, so unlike
  // a mid-bet leak this can't be acted on. Exposing it here (not only once
  // 'done') is what lets the client's spin animation land correctly synced
  // to the real result instead of guessing. seed (the fairness proof) still
  // waits for 'done' - only the round's fair-verify page needs it, not the
  // spin visual.
  if (round.status !== 'betting') out.color = round.color;
  if (round.status === 'done') out.seed = round.seed;
  return out;
}

function publicState(viewerId) {
  const r = publicRound();
  const bets = round ? rstmts.roundBets.all(round.id).map(b => ({
    username: b.username, color: b.color, amount: b.amount / 100,
    // `mine` (not username-matching client-side) is how the client finds the
    // viewer's own bets - usernames are 'Anonymous' for anon players, so a
    // name comparison would silently break for exactly those users
    mine: !!viewerId && b.user_id === viewerId,
    // payout is only meaningful (and only ever non-zero) once the round is
    // done - showing it mid-round would leak the outcome same as `color` above
    payout: round.status === 'done' ? b.payout / 100 : null,
  })) : [];
  return {
    round: r,
    colors: COLORS.map(c => ({ key: c.key, mult: c.mult, icon: c.icon, chance: Math.round(c.weight / 15 * 10000) / 100 })),
    bets,
    canBet: !!(round && round.status === 'betting'),
    recent: rstmts.recentRounds.all().map(r => r.color),
  };
}

module.exports = { init, placeBet, publicState };
