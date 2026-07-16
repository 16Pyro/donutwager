// games.js - every game resolves here, on the server.
// The client never decides an outcome; it just asks and renders the answer.
const { db, stmts } = require('./db');
const fair = require('./fair');

const MIN_BET = 10;                  // 0.10 coins
const MAX_BET = 10_000_000_000_000;  // 100B coins, in cents
const HOUSE_EDGE = 0.99;             // 1% edge baked into multipliers

class GameError extends Error {}

// ---- admin win-chance override --------------------------------------------
// null = normal provably-fair play. 0-100 = force every round's win probability
// to this percentage across every game: dice, coinflip, mines, towers, chicken,
// blackjack, cases, and daily case. Set via the bot's !winchance command or
// `node admin.js winchance`. Persisted in the settings table (not an in-memory
// var) so both the server and one-off admin scripts running as separate
// processes see the same value. Intentionally bypasses fairness while active.
function setWinChance(pct) {
  const clamped = pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  stmts.setSetting.run('winChanceOverride', clamped === null ? '' : String(clamped));
}
function getWinChance() {
  const row = stmts.getSetting.get('winChanceOverride');
  if (!row || row.value === '') return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}
// returns true (win/safe), false (lose/unsafe), or null (no override - play fair)
function overrideRoll() {
  const pct = getWinChance();
  if (pct === null) return null;
  return Math.random() * 100 < pct;
}

// ---- shared bet plumbing -------------------------------------------------

// accepts plain numbers plus shorthand like "500k", "2.5m", "1b"
const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

function parseAmount(raw) {
  let n;
  if (typeof raw === 'string') {
    const m = raw.trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb]?)$/i);
    if (!m) throw new GameError('bad amount');
    n = Number(m[1]) * (SUFFIX[m[2].toLowerCase()] || 1);
  } else {
    n = Number(raw);
  }
  if (!Number.isFinite(n)) throw new GameError('bad amount');
  const cents = Math.round(n * 100);
  if (cents < MIN_BET) throw new GameError('minimum bet is 0.10');
  if (cents > MAX_BET) throw new GameError('maximum bet is 100B');
  return cents;
}

function takeBet(userId, cents) {
  const r = stmts.tryDeduct.run(cents, cents, userId, cents);
  if (r.changes === 0) throw new GameError('insufficient balance');
}

function refund(userId, cents) {
  stmts.addBalance.run(cents, userId);
}

function settle(userId, game, amount, payout, multiplier, detail) {
  if (payout > 0) stmts.addBalance.run(payout, userId);
  stmts.insertBet.run(userId, game, amount, payout, multiplier, JSON.stringify(detail || null), Date.now());
}

// grab the user's seed pair, then advance the nonce so it's spent
function useNonce(userId) {
  const u = stmts.getUserById.get(userId);
  stmts.bumpNonce.run(userId);
  return { serverSeed: u.server_seed, clientSeed: u.client_seed, nonce: u.nonce };
}

function balanceOf(userId) {
  return stmts.getUserById.get(userId).balance;
}

// ---- dice ----------------------------------------------------------------

function dice(userId, body) {
  const amount = parseAmount(body.amount);
  const target = Number(body.target);
  const dir = body.dir === 'over' ? 'over' : 'under';
  if (!Number.isFinite(target) || target < 2 || target > 98) throw new GameError('target must be 2-98');

  takeBet(userId, amount);
  const seeds = useNonce(userId);
  let roll = Math.floor(fair.floats(seeds.serverSeed, seeds.clientSeed, seeds.nonce, 1)[0] * 10001) / 100;

  const chance = dir === 'under' ? target : 100 - target;
  const mult = Math.floor((HOUSE_EDGE * 100 / chance) * 10000) / 10000;
  let won = dir === 'under' ? roll < target : roll > target;
  const ov = overrideRoll();
  if (ov !== null) {
    won = ov;
    roll = dir === 'under'
      ? (won ? Math.random() * (target - 1) : target + Math.random() * (100 - target))
      : (won ? target + Math.random() * (100 - target) : Math.random() * target);
    roll = Math.floor(roll * 100) / 100;
  }
  const payout = won ? Math.floor(amount * mult) : 0;

  settle(userId, 'dice', amount, payout, won ? mult : 0, { roll, target, dir });
  return { roll, won, mult, payout: payout / 100, balance: balanceOf(userId) / 100, nonce: seeds.nonce };
}

// ---- coinflip --------------------------------------------------------------

function coinflip(userId, body) {
  const amount = parseAmount(body.amount);
  const side = body.side === 'glazed' ? 'glazed' : 'frosted';

  takeBet(userId, amount);
  const seeds = useNonce(userId);
  let landed = fair.floats(seeds.serverSeed, seeds.clientSeed, seeds.nonce, 1)[0] < 0.5 ? 'glazed' : 'frosted';
  let won = landed === side;
  const ov = overrideRoll();
  if (ov !== null) { won = ov; landed = won ? side : (side === 'glazed' ? 'frosted' : 'glazed'); }
  const mult = 2 * HOUSE_EDGE; // 1.98
  const payout = won ? Math.floor(amount * mult) : 0;

  settle(userId, 'coinflip', amount, payout, won ? mult : 0, { side, landed });
  return { landed, won, payout: payout / 100, balance: balanceOf(userId) / 100, nonce: seeds.nonce };
}

// ---- mines -----------------------------------------------------------------

function minesMult(mineCount, picks) {
  let m = HOUSE_EDGE;
  for (let i = 0; i < picks; i++) m *= (25 - i) / (25 - mineCount - i);
  return Math.floor(m * 10000) / 10000;
}

function minesState(userId) {
  const row = stmts.getActive.get(userId, 'mines');
  return row ? JSON.parse(row.state) : null;
}

function minesStart(userId, body) {
  if (minesState(userId)) throw new GameError('finish your current mines game first');
  const amount = parseAmount(body.amount);
  const mineCount = Math.floor(Number(body.mines));
  if (!(mineCount >= 1 && mineCount <= 24)) throw new GameError('mines must be 1-24');

  takeBet(userId, amount);
  const seeds = useNonce(userId);
  const tiles = fair.shuffle([...Array(25).keys()], seeds.serverSeed, seeds.clientSeed, seeds.nonce);
  const state = { amount, mineCount, mines: tiles.slice(0, mineCount), revealed: [], nonce: seeds.nonce };
  stmts.setActive.run(userId, 'mines', JSON.stringify(state));
  return { revealed: [], mineCount, nextMult: minesMult(mineCount, 1), balance: balanceOf(userId) / 100 };
}

function minesReveal(userId, body) {
  const st = minesState(userId);
  if (!st) throw new GameError('no mines game running');
  const tile = Math.floor(Number(body.tile));
  if (!(tile >= 0 && tile <= 24)) throw new GameError('bad tile');
  if (st.revealed.includes(tile)) throw new GameError('already revealed');

  const ov = overrideRoll();
  const hitMine = ov !== null ? !ov : st.mines.includes(tile);
  // keep the displayed mine layout consistent with the forced outcome - if the
  // override says "lose" on a tile that wasn't naturally a mine, mark it as one
  // so what's shown to the player always matches what just happened (and vice
  // versa for a forced win on a tile that was naturally a mine)
  if (ov !== null) {
    if (hitMine && !st.mines.includes(tile)) st.mines.push(tile);
    else if (!hitMine && st.mines.includes(tile)) st.mines = st.mines.filter((m) => m !== tile);
  }
  if (hitMine) {
    stmts.clearActive.run(userId, 'mines');
    settle(userId, 'mines', st.amount, 0, 0, { mines: st.mineCount, picks: st.revealed.length, boom: true });
    return { boom: true, tile, mines: st.mines, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }

  st.revealed.push(tile);
  const picks = st.revealed.length;
  const mult = minesMult(st.mineCount, picks);
  // board cleared? auto cashout
  if (picks === 25 - st.mineCount) {
    stmts.clearActive.run(userId, 'mines');
    const payout = Math.floor(st.amount * mult);
    settle(userId, 'mines', st.amount, payout, mult, { mines: st.mineCount, picks, cleared: true });
    return { boom: false, tile, cleared: true, mult, payout: payout / 100, mines: st.mines, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }
  stmts.setActive.run(userId, 'mines', JSON.stringify(st));
  return { boom: false, tile, mult, nextMult: minesMult(st.mineCount, picks + 1), balance: balanceOf(userId) / 100 };
}

function minesCashout(userId) {
  const st = minesState(userId);
  if (!st) throw new GameError('no mines game running');
  if (st.revealed.length === 0) throw new GameError('reveal at least one tile first');
  stmts.clearActive.run(userId, 'mines');
  const mult = minesMult(st.mineCount, st.revealed.length);
  const payout = Math.floor(st.amount * mult);
  settle(userId, 'mines', st.amount, payout, mult, { mines: st.mineCount, picks: st.revealed.length });
  return { mult, payout: payout / 100, mines: st.mines, balance: balanceOf(userId) / 100, nonce: st.nonce };
}

// ---- towers ----------------------------------------------------------------

const TOWER_ROWS = 8;
const TOWER_DIFF = {
  easy:  { bombs: 1, mult: 1.5 * HOUSE_EDGE },  // 2 of 3 safe
  hard:  { bombs: 2, mult: 3.0 * HOUSE_EDGE },  // 1 of 3 safe
};

function towerMult(diff, rows) {
  return Math.floor(Math.pow(TOWER_DIFF[diff].mult, rows) * 10000) / 10000;
}

function towersState(userId) {
  const row = stmts.getActive.get(userId, 'towers');
  return row ? JSON.parse(row.state) : null;
}

function towersStart(userId, body) {
  if (towersState(userId)) throw new GameError('finish your current tower first');
  const amount = parseAmount(body.amount);
  const diff = body.diff === 'hard' ? 'hard' : 'easy';

  takeBet(userId, amount);
  const seeds = useNonce(userId);
  const bombs = [];
  for (let r = 0; r < TOWER_ROWS; r++) {
    const cols = fair.shuffle([0, 1, 2], seeds.serverSeed, seeds.clientSeed, seeds.nonce, r * 3 + 5);
    bombs.push(cols.slice(0, TOWER_DIFF[diff].bombs));
  }
  const state = { amount, diff, bombs, row: 0, nonce: seeds.nonce };
  stmts.setActive.run(userId, 'towers', JSON.stringify(state));
  return { row: 0, diff, nextMult: towerMult(diff, 1), balance: balanceOf(userId) / 100 };
}

function towersPick(userId, body) {
  const st = towersState(userId);
  if (!st) throw new GameError('no tower running');
  const col = Math.floor(Number(body.col));
  if (!(col >= 0 && col <= 2)) throw new GameError('bad column');

  const ov = overrideRoll();
  const hitBomb = ov !== null ? !ov : st.bombs[st.row].includes(col);
  if (ov !== null) {
    if (hitBomb && !st.bombs[st.row].includes(col)) st.bombs[st.row].push(col);
    else if (!hitBomb && st.bombs[st.row].includes(col)) st.bombs[st.row] = st.bombs[st.row].filter((c) => c !== col);
  }
  if (hitBomb) {
    stmts.clearActive.run(userId, 'towers');
    settle(userId, 'towers', st.amount, 0, 0, { diff: st.diff, rows: st.row, boom: true });
    return { boom: true, col, bombs: st.bombs, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }

  st.row++;
  const mult = towerMult(st.diff, st.row);
  if (st.row === TOWER_ROWS) {
    stmts.clearActive.run(userId, 'towers');
    const payout = Math.floor(st.amount * mult);
    settle(userId, 'towers', st.amount, payout, mult, { diff: st.diff, rows: st.row, topped: true });
    return { boom: false, col, topped: true, mult, payout: payout / 100, bombs: st.bombs, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }
  stmts.setActive.run(userId, 'towers', JSON.stringify(st));
  return { boom: false, col, row: st.row, mult, nextMult: towerMult(st.diff, st.row + 1), balance: balanceOf(userId) / 100 };
}

function towersCashout(userId) {
  const st = towersState(userId);
  if (!st) throw new GameError('no tower running');
  if (st.row === 0) throw new GameError('climb at least one row first');
  stmts.clearActive.run(userId, 'towers');
  const mult = towerMult(st.diff, st.row);
  const payout = Math.floor(st.amount * mult);
  settle(userId, 'towers', st.amount, payout, mult, { diff: st.diff, rows: st.row });
  return { mult, payout: payout / 100, bombs: st.bombs, balance: balanceOf(userId) / 100, nonce: st.nonce };
}

// ---- cases -----------------------------------------------------------------
// Cases have a FIXED price. Opening one draws a single item by weight; the item
// carries a fixed coin value (not a multiplier of a bet). The reveal animation
// is cosmetic - the item is chosen the instant the case is opened.
//
// Every case is auto-balanced to ~99% RTP: junk weight is solved so that
// sum(value*weight)/sum(weight) == 0.99 * price. Three risk profiles vary the
// variance while keeping that same house edge.

// Each case is built from a coherent THEME: a full junk->hero ladder of real MC
// items that belong together. This gives every case a distinct, sensible drop
// table (no more dirt & gravel in everything). The theme's hero names the case.
// tiers: junk, common, uncommon, rare, epic, legendary, hero  (all icons exist)
// lower tiers list several items (weight is split evenly among them) so each case
// has a fuller, hand-picked drop table (~10 items) instead of one per tier.
const THEMES = [
  { name: 'Poultry Farm', items: {
    junk: [['Feather', 'feather'], ['Wheat', 'wheat'], ['Apple', 'apple']],
    common: [['Egg', 'egg'], ['Raw Chicken', 'chicken']],
    uncommon: [['Cooked Chicken', 'cooked_chicken'], ['Hay Bale', 'hay_bale']],
    rare: [['Golden Carrot', 'golden_carrot']], epic: [['Golden Apple', 'golden_apple']],
    legendary: [['Diamond', 'diamond']], hero: [['Enchanted Golden Apple', 'enchanted_golden_apple']] } },
  { name: 'Deep Mine', items: {
    junk: [['Cobblestone', 'cobblestone'], ['Gravel', 'gravel'], ['Coal', 'coal']],
    common: [['Iron Nugget', 'iron_nugget'], ['Redstone', 'redstone']],
    uncommon: [['Gold Nugget', 'gold_nugget'], ['Lapis Block', 'lapis_block']],
    rare: [['Amethyst Shard', 'amethyst_shard'], ['Raw Gold', 'raw_gold']], epic: [['Gold Ingot', 'gold_ingot']],
    legendary: [['Emerald', 'emerald']], hero: [['Diamond Block', 'diamond_block']] } },
  { name: 'Nether Run', items: {
    junk: [['Netherrack', 'netherrack']],
    common: [['Fire Charge', 'fire_charge'], ['Nether Quartz', 'nether_quartz']],
    uncommon: [['Blaze Rod', 'blaze_rod']],
    rare: [['Gold Ingot', 'gold_ingot']], epic: [['Golden Apple', 'golden_apple']],
    legendary: [['Ancient Debris', 'ancient_debris']], hero: [['Nether Star', 'nether_star']] } },
  { name: 'End Expedition', items: {
    junk: [['End Stone', 'end_stone'], ['Purpur Block', 'purpur_block']],
    common: [['Chorus Fruit', 'chorus_fruit'], ['Ender Pearl', 'ender_pearl'], ['End Rod', 'end_rod']],
    uncommon: [['Eye of Ender', 'eye_of_ender'], ['Shulker Shell', 'shulker_shell'], ['Phantom Membrane', 'phantom_membrane']],
    rare: [['Enchanted Book', 'enchanted_book']], epic: [['XP Bottle', 'experience_bottle']],
    legendary: [['Beacon', 'beacon']], hero: [['Dragon Egg', 'dragon_egg']] } },
  { name: 'Redstone Lab', items: {
    junk: [['Cobblestone', 'cobblestone'], ['Redstone Torch', 'redstone_torch']],
    common: [['Redstone', 'redstone'], ['Repeater', 'repeater'], ['Iron Nugget', 'iron_nugget']],
    uncommon: [['Clock', 'clock'], ['Piston', 'piston'], ['Observer', 'observer']],
    rare: [['Redstone Block', 'redstone_block'], ['TNT', 'tnt']], epic: [['Gold Ingot', 'gold_ingot']],
    legendary: [['Enchanted Book', 'enchanted_book']], hero: [['Command Block', 'command_block']] } },
  { name: 'Explorer Cache', items: {
    junk: [['Oak Planks', 'oak_planks']],
    common: [['Compass', 'compass']],
    uncommon: [['Barrel', 'barrel'], ['Spyglass', 'spyglass']],
    rare: [['Name Tag', 'name_tag'], ['Filled Map', 'filled_map']], epic: [['Diamond', 'diamond']],
    legendary: [['Heart of the Sea', 'heart_of_the_sea']], hero: [['Elytra', 'elytra']] } },
  { name: 'Treasure Vault', items: {
    junk: [['Gold Nugget', 'gold_nugget'], ['Iron Nugget', 'iron_nugget']],
    common: [['Lapis Block', 'lapis_block'], ['Amethyst Shard', 'amethyst_shard']],
    uncommon: [['Gold Ingot', 'gold_ingot'], ['Emerald', 'emerald']],
    rare: [['Diamond', 'diamond']], epic: [['Gold Block', 'gold_block']],
    legendary: [['Emerald Block', 'emerald_block']], hero: [['Netherite Ingot', 'netherite_ingot']] } },
  { name: "Rabbit's Luck", items: {
    junk: [['Grass Block', 'grass_block'], ['Carrot', 'carrot']],
    common: [['Wheat', 'wheat'], ['Egg', 'egg']],
    uncommon: [['Golden Carrot', 'golden_carrot'], ['Saddle', 'saddle'], ['Feather', 'feather']],
    rare: [['Golden Apple', 'golden_apple']], epic: [['Emerald', 'emerald']],
    legendary: [['Rabbit\'s Foot', 'rabbit_foot']], hero: [['Totem of Undying', 'totem']] } },
];
const CASE_SUFFIX = ['Case', 'Crate', 'Stash', 'Hoard', 'Vault', 'Trove', 'Box', 'Chest', 'Cache', 'Bounty'];

const LADDER = [
  { rarity: 'junk',      mult: 0.1 },
  { rarity: 'common',    mult: 0.4 },
  { rarity: 'uncommon',  mult: 0.9 },
  { rarity: 'rare',      mult: 1.8 },
  { rarity: 'epic',      mult: 4 },
  { rarity: 'legendary', mult: 12 },
  { rarity: 'hero',      mult: 50 },
];
const RISK = {
  low:    { label: 'Low',    weights: [380, 260, 120, 30, 6, 0.4] },
  medium: { label: 'Medium', weights: [300, 250, 150, 55, 14, 1] },
  high:   { label: 'High',   weights: [150, 180, 180, 90, 30, 4] },
};
const RTP = 0.88, JUNK_MULT = 0.1; // nerfed from 0.99 - cases were paying out too generously overall

const CASES = {};
(function buildCases() {
  const N = 50, minP = 50_000, maxP = 100_000_000;
  const N_EXTRA = 15, minExtra = 1_000_000, maxExtra = 50_000_000;
  const prices = [];
  for (let i = 0; i < N; i++) prices.push(Math.round(minP * Math.pow(maxP / minP, i / (N - 1)) / 1000) * 1000);
  for (let i = 0; i < N_EXTRA; i++) prices.push(Math.round(minExtra * Math.pow(maxExtra / minExtra, i / (N_EXTRA - 1)) / 1000) * 1000);

  const themeOccurrence = {};
  prices.forEach((priceCoins, i) => {
    const id = 'c' + (i + 1);
    const price = priceCoins * 100;
    const riskKey = ['low', 'medium', 'high'][(i * 7) % 3];
    const risk = RISK[riskKey];
    const theme = THEMES[i % THEMES.length];
    const occ = themeOccurrence[theme.name] || 0;
    themeOccurrence[theme.name] = occ + 1;
    const coverPool = [...theme.items.hero, ...theme.items.legendary, ...theme.items.epic, ...theme.items.rare].map(([, icon]) => icon);
    const heroIcon = coverPool[occ % coverPool.length];

    const items = [];
    let num = 0, otherW = 0;
    for (let t = 1; t < LADDER.length; t++) {
      const tier = LADDER[t];
      const w = risk.weights[t - 1];
      if (w <= 0) continue;
      const arr = theme.items[tier.rarity];
      const each = w / arr.length;
      for (const [name, icon] of arr) {
        items.push({ name, icon, rarity: tier.rarity, mult: tier.mult, value: Math.round(price * tier.mult), weight: each });
        num += tier.mult * each; otherW += each;
      }
    }
    const junkW = Math.max(1, Math.round((num - RTP * otherW) / (RTP - JUNK_MULT)));
    const jarr = theme.items.junk;
    for (const [jn, ji] of jarr) {
      items.unshift({ name: jn, icon: ji, rarity: 'junk', mult: JUNK_MULT, value: Math.round(price * JUNK_MULT), weight: junkW / jarr.length });
    }

    const name = `${theme.name} ${CASE_SUFFIX[i % CASE_SUFFIX.length]}`;
    CASES[id] = { id, name, price, riskKey, risk: risk.label, cover: heroIcon, theme: theme.name, items };
  });
})();

const CASE_LIST = Object.values(CASES);
const totalWeight = (items) => items.reduce((s, it) => s + it.weight, 0);

// free daily case — max 5M coins (500_000_000 cents)
const DAILY_CASE = [
  { name: 'XP Bottle',      icon: 'experience_bottle', amount:   5_000_000, weight: 350, rarity: 'common' },
  { name: 'Golden Carrot',  icon: 'golden_carrot',     amount:  15_000_000, weight: 250, rarity: 'common' },
  { name: 'Amethyst Shard', icon: 'amethyst_shard',    amount:  40_000_000, weight: 160, rarity: 'uncommon' },
  { name: 'Emerald',        icon: 'emerald',           amount: 100_000_000, weight: 90,  rarity: 'rare' },
  { name: 'Diamond',        icon: 'diamond',           amount: 250_000_000, weight: 35,  rarity: 'epic' },
  { name: 'Nether Star',    icon: 'nether_star',       amount: 500_000_000, weight: 8,   rarity: 'legendary' },
];

function casePublic(c) {
  const tw = totalWeight(c.items);
  return {
    id: c.id, name: c.name, price: c.price / 100, risk: c.risk, riskKey: c.riskKey, cover: c.cover,
    items: c.items
      .map(i => ({ name: i.name, icon: i.icon, rarity: i.rarity, value: i.value / 100, chance: Math.round(i.weight / tw * 10000) / 100 }))
      .sort((a, b) => a.value - b.value),
  };
}

function casesPublic() {
  return CASE_LIST.map(casePublic);
}

function dailyPublic() {
  return DAILY_CASE.map(i => ({ name: i.name, icon: i.icon, amount: i.amount / 100, rarity: i.rarity, chance: i.weight / 10 }));
}

// frac in [0,1) -> index, weighted by each item's weight (any total)
function weightedIndex(items, frac) {
  const target = frac * totalWeight(items);
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight;
    if (target < acc) return i;
  }
  return items.length - 1;
}

function dailyOpen(userId) {
  const seeds = useNonce(userId);
  const roll = fair.floats(seeds.serverSeed, seeds.clientSeed, seeds.nonce, 1)[0];
  let idx = weightedIndex(DAILY_CASE, roll);
  const ov = overrideRoll();
  if (ov !== null) {
    const avg = DAILY_CASE.reduce((s, it) => s + it.amount, 0) / DAILY_CASE.length;
    const pool = DAILY_CASE.filter((it) => (it.amount >= avg) === ov);
    if (pool.length) idx = DAILY_CASE.indexOf(pool[weightedIndex(pool, Math.random())]);
  }
  const item = DAILY_CASE[idx];
  stmts.addBalance.run(item.amount, userId);
  stmts.insertBet.run(userId, 'daily', 0, item.amount, 0, JSON.stringify({ item: item.name }), Date.now());
  return {
    itemIndex: idx,
    item: { name: item.name, icon: item.icon, rarity: item.rarity },
    amount: item.amount / 100,
    balance: balanceOf(userId) / 100,
  };
}

function casesOpen(userId, body) {
  const c = CASES[body.caseId];
  if (!c) throw new GameError('unknown case');
  const qty = Math.min(5, Math.max(1, Math.floor(Number(body.qty) || 1)));

  takeBet(userId, c.price * qty);
  const sorted = casePublic(c).items; // value-sorted, matches client display order

  const results = [];
  let totalPayout = 0;
  for (let q = 0; q < qty; q++) {
    const seeds = useNonce(userId);
    const roll = fair.floats(seeds.serverSeed, seeds.clientSeed, seeds.nonce, 1)[0];
    let item = c.items[weightedIndex(c.items, roll)];
    const ov = overrideRoll();
    if (ov !== null) {
      const pool = c.items.filter((it) => (it.value >= c.price) === ov);
      if (pool.length) item = pool[weightedIndex(pool, Math.random())];
    }
    totalPayout += item.value;
    const shownIndex = sorted.findIndex((s) => s.name === item.name && s.value === item.value / 100);
    settle(userId, 'cases', c.price, item.value, c.price > 0 ? item.value / c.price : 0, { caseId: c.id, item: item.name });
    results.push({
      itemIndex: shownIndex < 0 ? 0 : shownIndex,
      item: { name: item.name, icon: item.icon, rarity: item.rarity, value: item.value / 100, chance: shownIndex >= 0 ? sorted[shownIndex].chance : undefined },
    });
  }
  return { results, qty, payout: totalPayout / 100, balance: balanceOf(userId) / 100 };
}

// ---- chicken ---------------------------------------------------------------
// cross 10 lava lanes. Each lane has an independent survival chance; the whole
// run is pre-rolled from one nonce so the path can be verified afterwards.

const CHICKEN_LANES = 10;
const CHICKEN_DIFF = {
  easy:   0.85,
  medium: 0.75,
  hard:   0.60,
};

function chickenMult(diff, lanes) {
  return Math.floor((HOUSE_EDGE / Math.pow(CHICKEN_DIFF[diff], lanes)) * 10000) / 10000;
}

function chickenState(userId) {
  const row = stmts.getActive.get(userId, 'chicken');
  return row ? JSON.parse(row.state) : null;
}

function chickenStart(userId, body) {
  if (chickenState(userId)) throw new GameError('your chicken is still out there');
  const amount = parseAmount(body.amount);
  const diff = CHICKEN_DIFF[body.diff] ? body.diff : 'easy';

  takeBet(userId, amount);
  const seeds = useNonce(userId);
  const rolls = fair.floats(seeds.serverSeed, seeds.clientSeed, seeds.nonce, CHICKEN_LANES);
  // first lane the chicken gets roasted on (CHICKEN_LANES = made it across)
  let deathLane = CHICKEN_LANES;
  for (let i = 0; i < CHICKEN_LANES; i++) {
    if (rolls[i] >= CHICKEN_DIFF[diff]) { deathLane = i; break; }
  }
  const state = { amount, diff, deathLane, lane: 0, nonce: seeds.nonce };
  stmts.setActive.run(userId, 'chicken', JSON.stringify(state));
  return { lane: 0, diff, nextMult: chickenMult(diff, 1), balance: balanceOf(userId) / 100 };
}

function chickenStep(userId) {
  const st = chickenState(userId);
  if (!st) throw new GameError('no chicken run going');

  const ov = overrideRoll();
  const roasted = ov !== null ? !ov : st.lane === st.deathLane;
  if (ov !== null) st.deathLane = roasted ? st.lane : -1;
  if (roasted) {
    stmts.clearActive.run(userId, 'chicken');
    settle(userId, 'chicken', st.amount, 0, 0, { diff: st.diff, lanes: st.lane, roasted: true });
    return { roasted: true, lane: st.lane, deathLane: st.deathLane, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }

  st.lane++;
  const mult = chickenMult(st.diff, st.lane);
  if (st.lane === CHICKEN_LANES) {
    stmts.clearActive.run(userId, 'chicken');
    const payout = Math.floor(st.amount * mult);
    settle(userId, 'chicken', st.amount, payout, mult, { diff: st.diff, lanes: st.lane, crossed: true });
    return { roasted: false, lane: st.lane, crossed: true, mult, payout: payout / 100, deathLane: st.deathLane, balance: balanceOf(userId) / 100, nonce: st.nonce };
  }
  stmts.setActive.run(userId, 'chicken', JSON.stringify(st));
  return { roasted: false, lane: st.lane, mult, nextMult: chickenMult(st.diff, st.lane + 1), balance: balanceOf(userId) / 100 };
}

function chickenCashout(userId) {
  const st = chickenState(userId);
  if (!st) throw new GameError('no chicken run going');
  if (st.lane === 0) throw new GameError('cross at least one lane first');
  stmts.clearActive.run(userId, 'chicken');
  const mult = chickenMult(st.diff, st.lane);
  const payout = Math.floor(st.amount * mult);
  settle(userId, 'chicken', st.amount, payout, mult, { diff: st.diff, lanes: st.lane });
  return { mult, payout: payout / 100, deathLane: st.deathLane, balance: balanceOf(userId) / 100, nonce: st.nonce };
}

// ---- blackjack ---------------------------------------------------------------

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];

function freshShoe(seeds) {
  const shoe = [];
  for (let d = 0; d < 4; d++)
    for (const s of SUITS)
      for (const r of RANKS) shoe.push(r + s);
  return fair.shuffle(shoe, seeds.serverSeed, seeds.clientSeed, seeds.nonce);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === 'A') { aces++; total += 11; }
    else if (['K', 'Q', 'J', '10'].includes(r)) total += 10;
    else total += Number(r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function bjState(userId) {
  const row = stmts.getActive.get(userId, 'blackjack');
  return row ? JSON.parse(row.state) : null;
}

function bjView(st, done) {
  return {
    player: st.player,
    playerValue: handValue(st.player),
    dealer: done ? st.dealer : [st.dealer[0], '??'],
    dealerValue: done ? handValue(st.dealer) : null,
    canDouble: !done && st.player.length === 2 && !st.doubled,
  };
}

function bjFinish(userId, st, outcome) {
  stmts.clearActive.run(userId, 'blackjack');
  const ov = overrideRoll();
  if (ov !== null && outcome !== 'blackjack') outcome = ov ? 'win' : 'lose';
  const total = st.amount * (st.doubled ? 2 : 1);
  let mult = 0;
  if (outcome === 'blackjack') mult = 2.5;
  else if (outcome === 'win') mult = 2;
  else if (outcome === 'push') mult = 1;
  const payout = Math.floor(total * mult);
  settle(userId, 'blackjack', total, payout, mult, { outcome });
  return { ...bjView(st, true), outcome, payout: payout / 100, balance: balanceOf(userId) / 100, nonce: st.nonce, done: true };
}

function bjDealerPlay(st) {
  while (handValue(st.dealer) < 17) st.dealer.push(st.shoe.shift());
}

function bjStart(userId, body) {
  if (bjState(userId)) throw new GameError('finish your current hand first');
  const amount = parseAmount(body.amount);
  takeBet(userId, amount);
  const seeds = useNonce(userId);
  const shoe = freshShoe(seeds);
  const st = {
    amount, doubled: false, nonce: seeds.nonce,
    player: [shoe.shift(), shoe.shift()],
    dealer: [shoe.shift(), shoe.shift()],
    shoe,
  };

  const pBJ = handValue(st.player) === 21;
  const dBJ = handValue(st.dealer) === 21;
  if (pBJ || dBJ) {
    return bjFinish(userId, st, pBJ && dBJ ? 'push' : pBJ ? 'blackjack' : 'lose');
  }
  stmts.setActive.run(userId, 'blackjack', JSON.stringify(st));
  return { ...bjView(st, false), done: false, balance: balanceOf(userId) / 100 };
}

function bjHit(userId) {
  const st = bjState(userId);
  if (!st) throw new GameError('no hand running');
  st.player.push(st.shoe.shift());
  const v = handValue(st.player);
  if (v > 21) return bjFinish(userId, st, 'lose');
  if (v === 21) { bjDealerPlay(st); return bjFinish(userId, st, resolveBj(st)); }
  stmts.setActive.run(userId, 'blackjack', JSON.stringify(st));
  return { ...bjView(st, false), done: false, balance: balanceOf(userId) / 100 };
}

function resolveBj(st) {
  const p = handValue(st.player), d = handValue(st.dealer);
  if (d > 21 || p > d) return 'win';
  if (p === d) return 'push';
  return 'lose';
}

function bjStand(userId) {
  const st = bjState(userId);
  if (!st) throw new GameError('no hand running');
  bjDealerPlay(st);
  return bjFinish(userId, st, resolveBj(st));
}

function bjDouble(userId) {
  const st = bjState(userId);
  if (!st) throw new GameError('no hand running');
  if (st.player.length !== 2 || st.doubled) throw new GameError('can only double on first move');
  takeBet(userId, st.amount); // second stake, same server-side guard
  st.doubled = true;
  st.player.push(st.shoe.shift());
  if (handValue(st.player) > 21) return bjFinish(userId, st, 'lose');
  bjDealerPlay(st);
  return bjFinish(userId, st, resolveBj(st));
}

module.exports = {
  GameError,
  dice, coinflip,
  casesPublic, casePublic, casesOpen, dailyPublic, dailyOpen,
  chickenStart, chickenStep, chickenCashout, chickenState,
  CASES, weightedIndex, parseAmount, takeBet, settle,
  minesStart, minesReveal, minesCashout, minesState,
  towersStart, towersPick, towersCashout, towersState,
  bjStart, bjHit, bjStand, bjDouble, bjState, bjView,
  setWinChance, getWinChance,
};
