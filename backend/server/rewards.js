// rewards.js - rakeback (a slice of what you've wagered, paid back to you) and
// the wagered-based level system with milestone rewards.
const { stmts } = require('./db');

// rakeback rate, applied to wagered volume accumulated since the last claim.
// instant has no cooldown - claim any time there's something owed.
const RB_RATE = { instant: 0.001 };

// level N needs this much TOTAL wagered (coins) to reach - grows quadratically so
// it stays a long-term grind even at this site's huge coin volumes. Capped at 50.
const LEVEL_UNIT = 10_000_000; // coins
const MAX_LEVEL = 50;
function wageredForLevel(n) { return LEVEL_UNIT * n * n; }
function levelForWagered(coins) { return Math.min(MAX_LEVEL, Math.floor(Math.sqrt(coins / LEVEL_UNIT))); }

// milestone levels with a fixed coin reward, in coins (not cents)
const MILESTONES = [
  { level: 1, reward: 50_000 }, { level: 3, reward: 100_000 }, { level: 5, reward: 250_000 },
  { level: 7, reward: 500_000 }, { level: 10, reward: 1_000_000 }, { level: 15, reward: 2_500_000 },
  { level: 20, reward: 5_000_000 }, { level: 25, reward: 10_000_000 }, { level: 30, reward: 20_000_000 },
  { level: 40, reward: 50_000_000 }, { level: 50, reward: 100_000_000 },
];

function rbInfo(u) {
  const wagered = u.total_wagered; // cents
  const now = Date.now();
  const mk = (base, rate, at, cooldown) => {
    const amount = Math.max(0, Math.round((wagered - base) * rate));
    const readyAt = cooldown ? at + cooldown : 0;
    return { amount: amount / 100, ready: !cooldown || now >= readyAt, readyAt };
  };
  return {
    instant: mk(u.rb_instant_base, RB_RATE.instant, 0, 0),
  };
}

function levelInfo(u) {
  const wageredCoins = u.total_wagered / 100;
  const level = levelForWagered(wageredCoins);
  const maxed = level >= MAX_LEVEL;
  const curFloor = wageredForLevel(level);
  const nextCeil = maxed ? curFloor : wageredForLevel(level + 1);
  const progress = maxed ? 1 : (nextCeil > curFloor ? (wageredCoins - curFloor) / (nextCeil - curFloor) : 1);
  const remainingCoins = maxed ? 0 : Math.max(0, Math.ceil(nextCeil - wageredCoins));
  const milestones = MILESTONES.map(m => ({
    level: m.level, reward: m.reward,
    unlocked: level >= m.level,
    claimed: u.level_claimed >= m.level,
  }));
  return {
    level, maxLevel: MAX_LEVEL, maxed, wageredCoins,
    progressPct: Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 10,
    curFloor, nextCeil, remainingCoins, milestones,
  };
}

function getRewards(userId) {
  const u = stmts.getUserById.get(userId);
  return { rakeback: rbInfo(u), level: levelInfo(u) };
}

class RewardsError extends Error {}

function claimRakeback(userId, kind) {
  if (kind !== 'instant') throw new RewardsError('bad rakeback type');
  const u = stmts.getUserById.get(userId);
  const info = rbInfo(u)[kind];
  if (info.amount <= 0) throw new RewardsError('nothing to claim');
  const now = Date.now();
  const cents = Math.round(info.amount * 100);
  stmts.addBalance.run(cents, userId);
  stmts.insertTx.run(userId, 'Rakeback Earnings', 'Currency', cents, now);
  stmts.claimInstantRb.run(u.total_wagered, userId);
  return { amount: info.amount, balance: stmts.getUserById.get(userId).balance / 100 };
}

function claimLevelRewards(userId) {
  const u = stmts.getUserById.get(userId);
  const level = levelForWagered(u.total_wagered / 100);
  const pending = MILESTONES.filter(m => m.level <= level && m.level > u.level_claimed);
  if (!pending.length) throw new RewardsError('nothing to claim');
  const total = pending.reduce((s, m) => s + m.reward, 0);
  stmts.addBalance.run(total * 100, userId);
  stmts.insertTx.run(userId, 'Level Rewards', 'Currency', total * 100, Date.now());
  stmts.setLevelClaimed.run(Math.max(...pending.map(m => m.level)), userId);
  return { amount: total, levels: pending.map(m => m.level), balance: stmts.getUserById.get(userId).balance / 100 };
}

module.exports = { getRewards, claimRakeback, claimLevelRewards, levelForWagered, RewardsError };
