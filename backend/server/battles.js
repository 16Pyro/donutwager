// battles.js - case battle lobbies.
// Anyone creates a battle with a case lineup; others join (or the creator
// calls bots). When every seat is taken the whole thing resolves server-side
// in one shot from a dedicated battle seed - clients only animate the replay.
const crypto = require('crypto');
const { db, stmts } = require('./db');
const games = require('./games');

db.exec(`CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

const bstmts = {
  insert: db.prepare('INSERT INTO battles (status, state, created_at) VALUES (?, ?, ?)'),
  get: db.prepare('SELECT * FROM battles WHERE id = ?'),
  update: db.prepare('UPDATE battles SET status = ?, state = ? WHERE id = ?'),
  open: db.prepare(`SELECT id, state FROM battles WHERE status = 'open' ORDER BY id DESC LIMIT 30`),
  recentDone: db.prepare(`SELECT id, state FROM battles WHERE status = 'done' ORDER BY id DESC LIMIT 20`),
  cleanup: db.prepare(`DELETE FROM battles WHERE status = 'done' AND created_at < ?`),
};

class BattleError extends Error {}

const SIZES = { '1v1': { seats: 2, teams: null }, '1v1v1': { seats: 3, teams: null }, '1v1v1v1': { seats: 4, teams: null }, '2v2': { seats: 4, teams: [[0, 1], [2, 3]] } };
const MODES = ['standard', 'crazy', 'terminal', 'jackpot', 'degen'];
const SPEEDS = ['normal', 'quick', 'instant'];
const BOT_NAMES = ['bots'];

function load(id) {
  const row = bstmts.get.get(id);
  if (!row) throw new BattleError('battle not found');
  return { row, st: JSON.parse(row.state) };
}

function entryCost(lineup) {
  return lineup.reduce((s, l) => s + l.price * l.count, 0);
}

// how long the client-side reveal animation actually takes for this battle,
// so a battle doesn't drop out of the "active" list or appear in "previous
// battles" (full result, spoiling who won) before anyone watching could have
// actually seen the reveal finish. Mirrors the timing constants in
// animateBattle() client-side - keep these in sync if those ever change.
function revealDurationMs(st) {
  const speed = st.speed || 'normal';
  if (speed === 'instant') return 500; // still needs a beat for the UI to settle
  const rounds = st.lineup.reduce((s, l) => s + l.count, 0);
  const spinDur = speed === 'quick' ? 1500 : 2700;
  const perRound = spinDur + 800;
  const introWait = 3000;
  const jackpotDur = st.mode === 'jackpot' ? 4200 : 0;
  return introWait + rounds * perRound + jackpotDur + 2000; // +2s safety margin
}
function isRevealing(st) {
  return st.status === 'done' && st.result && (Date.now() - st.result.resolvedAt) < revealDurationMs(st);
}

function publicBattle(id, st, full, viewerId) {
  const youSeat = viewerId ? st.players.findIndex(p => p.id === viewerId) : -1;
  const out = {
    id,
    // lets every client compute "elapsed since resolvedAt" against the
    // SERVER's clock instead of its own - two players' devices can have
    // real clock skew (seconds, sometimes more), which otherwise desyncs
    // the intro-wait timing badly: one client thinks the reveal already
    // happened ages ago and skips straight to it, the other still waits
    // out the full delay. See animateBattle() client-side for the math.
    serverNow: Date.now(),
    status: st.status,
    revealing: isRevealing(st),
    mode: st.mode,
    speed: st.speed || 'normal',
    size: st.size,
    lineup: st.lineup.map(l => ({ caseId: l.caseId, count: l.count, price: l.price / 100, cover: games.CASES[l.caseId].cover, name: games.CASES[l.caseId].name })),
    cost: entryCost(st.lineup) / 100,
    seats: SIZES[st.size].seats,
    players: st.players.map(p => ({ name: p.name, bot: p.bot })),
    createdAt: st.createdAt,
    youAreCreator: !!viewerId && st.players[0] && st.players[0].id === viewerId,
    youSeat,
  };
  // resolvedAt alone (no pulls/winners/totals) lets the lobby estimate round
  // progress ("5/50") for a revealing battle without spoiling the outcome
  if (out.revealing) out.resolvedAt = st.result.resolvedAt;
  if (full && st.result) {
    out.result = st.result;
    out.fair = { serverSeed: st.seed, serverSeedHash: st.seedHash };
  } else {
    out.seedHash = st.seedHash;
  }
  return out;
}

function create(userId, body) {
  const user = stmts.getUserById.get(userId);
  // Object.hasOwn, not `SIZES[x]` truthiness - see casesOpen()/chickenStart()
  // in games.js for why a plain-object lookup on unsanitized client input is
  // exploitable (body.size="constructor" etc. resolves through
  // Object.prototype to a truthy non-SIZES value).
  const size = Object.hasOwn(SIZES, body.size) ? body.size : '1v1';
  let mode = MODES.includes(body.mode) ? body.mode : 'standard';
  const speed = SPEEDS.includes(body.speed) ? body.speed : 'normal';

  const MAX_TOTAL = 200, MAX_COUNT = 200;
  const rawLineup = Array.isArray(body.lineup) ? body.lineup.slice(0, MAX_TOTAL) : [];
  if (!rawLineup.length) throw new BattleError('add at least one case');
  const lineup = rawLineup.map(l => {
    // same Object.hasOwn guard - an unvalidated caseId here would otherwise
    // corrupt every other player's entry cost when the battle resolves
    // (pullFor() reads games.CASES[caseId].items, which throws on undefined),
    // losing their money with no winner determined and no refund.
    const c = Object.hasOwn(games.CASES, l.caseId) ? games.CASES[l.caseId] : null;
    if (!c) throw new BattleError('unknown case in lineup');
    const count = Math.floor(Number(l.count));
    if (!(count >= 1 && count <= MAX_COUNT)) throw new BattleError(`case count must be 1-${MAX_COUNT}`);
    return { caseId: l.caseId, count, price: c.price };
  });
  const totalRounds = lineup.reduce((s, l) => s + l.count, 0);
  if (totalRounds > MAX_TOTAL) throw new BattleError(`${MAX_TOTAL} cases max per battle`);

  const cost = entryCost(lineup);
  games.takeBet(userId, cost); // reuses the balance-guarded debit

  const seed = crypto.randomBytes(32).toString('hex');
  const st = {
    status: 'open', size, mode, speed, lineup, createdAt: Date.now(),
    seed, seedHash: crypto.createHash('sha256').update(seed).digest('hex'),
    players: [{ id: userId, name: user.username, bot: false }],
  };
  const info = bstmts.insert.run('open', JSON.stringify(st), Date.now());
  bstmts.cleanup.run(Date.now() - 30 * 60 * 1000);
  return { id: info.lastInsertRowid, battle: publicBattle(info.lastInsertRowid, st, false, userId) };
}

function join(userId, id) {
  const { st } = load(id);
  if (st.status !== 'open') throw new BattleError('battle already started');
  if (st.players.some(p => p.id === userId)) throw new BattleError("you're already in this one");
  if (st.players.length >= SIZES[st.size].seats) throw new BattleError('battle is full');

  const user = stmts.getUserById.get(userId);
  games.takeBet(userId, entryCost(st.lineup));
  st.players.push({ id: userId, name: user.username, bot: false });

  if (st.players.length === SIZES[st.size].seats) resolve(id, st);
  else bstmts.update.run('open', JSON.stringify(st), id);
  return publicBattle(id, st, true, userId);
}

function callBots(userId, id) {
  const { st } = load(id);
  if (st.status !== 'open') throw new BattleError('battle already started');
  if (st.players[0].id !== userId) throw new BattleError('only the creator can call bots');
  let b = 0;
  while (st.players.length < SIZES[st.size].seats) {
    st.players.push({ id: null, name: BOT_NAMES[b++ % BOT_NAMES.length], bot: true });
  }
  resolve(id, st);
  return publicBattle(id, st, true, userId);
}

// add a single bot to the next open seat (fills one card, not all)
function addBot(userId, id) {
  const { st } = load(id);
  if (st.status !== 'open') throw new BattleError('battle already started');
  if (st.players[0].id !== userId) throw new BattleError('only the creator can add bots');
  if (st.players.length >= SIZES[st.size].seats) throw new BattleError('battle is full');
  st.players.push({ id: null, name: BOT_NAMES[0], bot: true });
  if (st.players.length === SIZES[st.size].seats) resolve(id, st);
  else bstmts.update.run('open', JSON.stringify(st), id);
  return publicBattle(id, st, true, userId);
}

// derive every pull from the committed battle seed - player index + round index
function pullFor(st, p, r, caseId) {
  const buf = crypto.createHmac('sha256', st.seed).update(`battle:${p}:${r}`).digest();
  const roll = buf.readUInt32BE(0) / 4294967296;
  const items = games.CASES[caseId].items;
  const idx = games.weightedIndex(items, roll);
  const item = items[idx];
  const tw = items.reduce((s, it) => s + it.weight, 0);
  const chance = Math.round(item.weight / tw * 10000) / 100;
  return { name: item.name, icon: item.icon, rarity: item.rarity, value: item.value, chance };
}

function resolve(id, st) {
  // expand lineup into a flat round list
  const rounds = [];
  for (const l of st.lineup) for (let i = 0; i < l.count; i++) rounds.push({ caseId: l.caseId, price: l.price });

  let mode = st.mode;
  if (mode === 'degen') mode = ['standard', 'crazy', 'terminal', 'jackpot'][crypto.randomInt(4)];

  const pulls = st.players.map((_, p) => rounds.map((rd, r) => pullFor(st, p, r, rd.caseId)));
  const totals = pulls.map(ps => ps.reduce((s, x) => s + x.value, 0));
  const pot = totals.reduce((s, t) => s + t, 0);

  // score per seat depending on mode
  let scores;
  if (mode === 'crazy') scores = totals.map(t => -t);
  else if (mode === 'terminal') scores = pulls.map(ps => ps[ps.length - 1].value);
  else scores = totals.slice(); // standard + jackpot base

  const teams = SIZES[st.size].teams || st.players.map((_, i) => [i]);
  const teamScore = teams.map(seats => seats.reduce((s, i) => s + scores[i], 0));

  let winningTeams;
  if (mode === 'jackpot') {
    const weights = teams.map(seats => seats.reduce((s, i) => s + totals[i], 0));
    const sum = weights.reduce((s, w) => s + w, 0);
    let pick;
    if (sum <= 0) pick = crypto.randomInt(teams.length);
    else {
      const buf = crypto.createHmac('sha256', st.seed).update('battle:jackpot').digest();
      let r = (buf.readUInt32BE(0) / 4294967296) * sum;
      pick = teams.length - 1;
      for (let i = 0; i < teams.length; i++) { r -= weights[i]; if (r <= 0) { pick = i; break; } }
    }
    winningTeams = [pick];
  } else {
    const best = Math.max(...teamScore);
    winningTeams = teams.map((_, i) => i).filter(i => teamScore[i] === best);
  }

  // pot splits across winning teams, then across seats in each team
  const winnerSeats = winningTeams.flatMap(ti => teams[ti]);
  const share = Math.floor(pot / winnerSeats.length);
  for (const seat of winnerSeats) {
    const pl = st.players[seat];
    if (!pl.bot && pl.id) {
      stmts.addBalance.run(share, pl.id);
    }
  }
  // record a bet row per human so it shows in the feed
  const cost = entryCost(st.lineup);
  for (let i = 0; i < st.players.length; i++) {
    const pl = st.players[i];
    if (pl.bot || !pl.id) continue;
    const won = winnerSeats.includes(i) ? share : 0;
    stmts.insertBet.run(pl.id, 'battle', cost, won, cost > 0 ? won / cost : 0,
      JSON.stringify({ battle: id, mode }), Date.now());
  }

  st.status = 'done';
  st.result = {
    mode,
    rounds: rounds.map(r => ({ caseId: r.caseId, price: r.price / 100 })),
    pulls: pulls.map(ps => ps.map(x => ({ ...x, value: x.value / 100 }))),
    totals: totals.map(t => t / 100),
    pot: pot / 100,
    winners: winnerSeats.map(i => st.players[i].name),
    winnerSeats,
    share: share / 100,
    resolvedAt: Date.now(),
  };
  bstmts.update.run('done', JSON.stringify(st), id);
}

// battles that just resolved stay in the "active" list until their reveal
// animation would have finished (see revealDurationMs) - otherwise a battle
// you're mid-animation on vanishes from "active" and jumps straight to
// "previous battles" (full result, spoiling who won) before you've actually
// watched it happen. `full: false` here on purpose - the list view never
// includes st.result, so nobody can read the outcome off the lobby early.
function list(viewerId) {
  const open = bstmts.open.all().map(r => publicBattle(r.id, JSON.parse(r.state), false, viewerId));
  const revealing = bstmts.recentDone.all()
    .map(r => ({ id: r.id, st: JSON.parse(r.state) }))
    .filter(({ st }) => isRevealing(st))
    .map(({ id, st }) => publicBattle(id, st, false, viewerId));
  return [...open, ...revealing];
}

// recent finished battles (with results) for the "previous battles" list -
// held back until the reveal window has passed, so it can't spoil a battle
// that's still (or might still be) mid-animation for someone watching it
function history(viewerId) {
  return bstmts.recentDone.all()
    .map(r => ({ id: r.id, st: JSON.parse(r.state) }))
    .filter(({ st }) => !isRevealing(st))
    .map(({ id, st }) => publicBattle(id, st, true, viewerId))
    .filter(b => b.result);
}

function get(id, viewerId) {
  const { st } = load(id);
  return publicBattle(id, st, st.status === 'done', viewerId);
}

module.exports = { BattleError, create, join, callBots, addBot, list, history, get };
