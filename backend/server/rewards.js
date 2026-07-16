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

// levels claimed one at a time are tracked as a set (level_claimed_list), not a
// single "highest claimed" threshold - a threshold can't represent "claimed #10
// but not #7" if a player skips around, which is exactly what letting someone
// claim one specific unlocked milestone (instead of always claiming all of them
// at once) requires. level_claimed (the old threshold column) is kept only as a
// one-time migration fallback for accounts that claimed under the old system.
function claimedSet(u) {
  const set = new Set((u.level_claimed_list || '').split(',').filter(Boolean).map(Number));
  if (u.level_claimed > 0) for (const m of MILESTONES) if (m.level <= u.level_claimed) set.add(m.level);
  return set;
}

function levelInfo(u) {
  const wageredCoins = u.total_wagered / 100;
  const level = levelForWagered(wageredCoins);
  const maxed = level >= MAX_LEVEL;
  const curFloor = wageredForLevel(level);
  const nextCeil = maxed ? curFloor : wageredForLevel(level + 1);
  const progress = maxed ? 1 : (nextCeil > curFloor ? (wageredCoins - curFloor) / (nextCeil - curFloor) : 1);
  const remainingCoins = maxed ? 0 : Math.max(0, Math.ceil(nextCeil - wageredCoins));
  const claimed = claimedSet(u);
  const milestones = MILESTONES.map(m => ({
    level: m.level, reward: m.reward,
    unlocked: level >= m.level,
    claimed: claimed.has(m.level),
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

// claims exactly one milestone (the one the player clicked), not every unlocked
// milestone at once
function claimLevelRewards(userId, milestoneLevel) {
  const u = stmts.getUserById.get(userId);
  const level = levelForWagered(u.total_wagered / 100);
  const m = MILESTONES.find(x => x.level === milestoneLevel);
  if (!m) throw new RewardsError('bad milestone');
  if (m.level > level) throw new RewardsError('not unlocked yet');
  const claimed = claimedSet(u);
  if (claimed.has(m.level)) throw new RewardsError('already claimed');
  claimed.add(m.level);
  stmts.addBalance.run(m.reward * 100, userId);
  stmts.insertTx.run(userId, 'Level Rewards', 'Currency', m.reward * 100, Date.now());
  stmts.setLevelClaimedList.run([...claimed].sort((a, b) => a - b).join(','), userId);
  return { amount: m.reward, levels: [m.level], balance: stmts.getUserById.get(userId).balance / 100 };
}

module.exports = { getRewards, claimRakeback, claimLevelRewards, levelForWagered, RewardsError };
