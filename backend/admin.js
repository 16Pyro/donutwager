// Usage: node admin.js <cmd> [args]
// node admin.js bal Y5AK
// node admin.js addbal Y5AK 1000000
// node admin.js setbal Y5AK 0
const { stmts } = require('./server/db');
const [,, cmd, target, val] = process.argv;

function getUser(name) {
  return stmts.getUserByMc.get(name) || stmts.getUserByName.get(name);
}

if (cmd === 'bal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  console.log(`${u.username}: ${(u.balance / 100).toLocaleString()} Donuts`);

} else if (cmd === 'addbal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  const amt = Math.floor(parseFloat(val) * 100);
  stmts.addBalance.run(amt, u.id);
  const updated = stmts.getUserByName.get(u.username);
  console.log(`Added ${parseFloat(val).toLocaleString()} → ${u.username} now has ${(updated.balance / 100).toLocaleString()}`);

} else if (cmd === 'setbal') {
  const u = getUser(target);
  if (!u) return console.log('User not found');
  const amt = Math.floor(parseFloat(val) * 100);
  stmts.setBalance.run(amt, u.id);
  console.log(`Set ${u.username} balance to ${parseFloat(val).toLocaleString()}`);

} else if (cmd === 'list') {
  const users = stmts.leaderboard.all();
  users.forEach(u => console.log(`${u.username}: ${(u.total_wagered/100).toLocaleString()}`));

} else {
  console.log('Commands: bal <user> | addbal <user> <amount> | setbal <user> <amount> | list');
}
