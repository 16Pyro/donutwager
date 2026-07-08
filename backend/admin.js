// Usage: node admin.js <cmd> [args]
// node admin.js bal Y5AK
// node admin.js addbal Y5AK 1000000
// node admin.js setbal Y5AK 0
const { stmts } = require('./server/db');
const [,, cmd, target, val] = process.argv;

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
  users.forEach(u => console.log(`${u.username}: ${(u.total_wagered/100).toLocaleString()}`));

} else {
  console.log('Commands: bal <user> | addbal <user> <amount> | setbal <user> <amount> | list');
}
