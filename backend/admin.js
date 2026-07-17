// Usage: node admin.js <cmd> [args]
// node admin.js bal Y5AK
// node admin.js addbal Y5AK 1000000
// node admin.js setbal Y5AK 0
// node admin.js winchance 75
// node admin.js winchance off
// node admin.js resetseason
// node admin.js fullreset Y5AK
// node admin.js ban Y5AK [reason...]
// node admin.js unban Y5AK
// node admin.js mute Y5AK 10m [reason...]
// node admin.js unmute Y5AK
const { stmts } = require('./server/db');
const games = require('./server/games');
const [,, cmd, target, val, ...rest] = process.argv;

function getUser(name) {
  return stmts.getUserByMc.get(name) || stmts.getUserByName.get(name);
}

function parseMcAmount(raw) {
  const s = raw.toString().replace(/,/g, '').toLowerCase();
  const m = s.match(/^([\d.]+)([kmb]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.floor(n * mult);
}

// "10m" / "2h" / "1d" / "45s" -> milliseconds
function parseDuration(raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Math.floor(n * mult);
}

if (cmd === 'bal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  console.log(`${u.username}: ${(u.balance / 100).toLocaleString()} Donuts`);

} else if (cmd === 'addbal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  const amtCents = Math.floor(parseMcAmount(val) * 100);
  stmts.addBalance.run(amtCents, u.id);
  const updated = stmts.getUserByName.get(u.username);
  console.log(`Added ${parseMcAmount(val).toLocaleString()} → ${u.username} now has ${(updated.balance / 100).toLocaleString()}`);

} else if (cmd === 'setbal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  const amtCents = Math.floor(parseMcAmount(val) * 100);
  stmts.setBalance.run(amtCents, u.id);
  console.log(`Set ${u.username} balance to ${parseMcAmount(val).toLocaleString()}`);

} else if (cmd === 'list') {
  const users = stmts.leaderboard.all();
  users.forEach(u => console.log(`${u.username}: ${(u.season_wagered/100).toLocaleString()}`));

} else if (cmd === 'resetseason') {
  stmts.resetSeasonWagered.run();
  stmts.setSetting.run('seasonStartAt', String(Date.now()));
  console.log('Season wagered reset to 0 for all users - new 30-day race starts now.');

} else if (cmd === 'winchance') {
  if (!target || /^off$/i.test(target)) {
    games.setWinChance(null);
    console.log('Win chance override OFF — games back to normal provably-fair odds');
  } else {
    const pct = Number(target);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      console.log('Usage: node admin.js winchance <0-100> | off');
    } else {
      games.setWinChance(pct);
      console.log(`Win chance set to ${pct}% for all games`);
    }
  }

} else if (cmd === 'fullreset') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  stmts.fullResetUser.run(u.id);
  stmts.clearActiveForUser.run(u.id);
  console.log(`${u.username} fully reset — balance, wagered/level progress, rakeback and referral earnings all zeroed. Username/MC link/referral code untouched.`);

} else if (cmd === 'ban') {
  if (!target) return console.log('Usage: node admin.js ban <mc-username> [reason...]');
  const reason = [val, ...rest].filter(Boolean).join(' ') || null;
  stmts.insertBan.run(target, reason, Date.now());
  const u = getUser(target);
  if (u) stmts.setBanned.run(1, u.id);
  console.log(`${target} banned${reason ? ` (${reason})` : ''}. They can never link or play under that name again${u ? ' — their session was killed' : ''}.`);

} else if (cmd === 'unban') {
  if (!target) return console.log('Usage: node admin.js unban <mc-username>');
  stmts.deleteBan.run(target);
  const u = getUser(target);
  if (u) stmts.setBanned.run(0, u.id);
  console.log(`${target} unbanned.`);

} else if (cmd === 'mute') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  const ms = parseDuration(val);
  if (!ms) return console.log('Usage: node admin.js mute <user> <duration e.g. 10m|2h|1d> [reason...]');
  stmts.setMuted.run(Date.now() + ms, u.id);
  console.log(`${u.username} muted for ${val}${rest.length ? ` (${rest.join(' ')})` : ''}.`);

} else if (cmd === 'unmute') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  stmts.setMuted.run(0, u.id);
  console.log(`${u.username} unmuted.`);

} else {
  console.log('Commands: bal <user> | addbal <user> <amount> | setbal <user> <amount> | list | winchance <0-100|off> | resetseason | fullreset <user> | ban <user> [reason] | unban <user> | mute <user> <duration> [reason] | unmute <user>');
}
