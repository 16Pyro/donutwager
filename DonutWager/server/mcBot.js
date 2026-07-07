// Mineflayer bot — detects in-game payments, links accounts, pays out winnings
require('dotenv').config();
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const { db, stmts } = require('./db');

const START_BALANCE = 0;

const MC_HOST    = process.env.MC_HOST    || 'localhost';
const MC_PORT    = parseInt(process.env.MC_PORT || '25565');
const MC_VERSION = process.env.MC_VERSION || null;
const MC_ONLINE  = process.env.MC_ONLINE  !== 'false';
const PAY_CMD    = (process.env.PAY_COMMAND || '/pay').trim();
const BOT_NAMES  = (process.env.BOT_NAMES || 'DonutWager')
  .split(',').map(s => s.trim()).filter(Boolean);

// Single command queue — all bot.chat() calls go through here with 500ms spacing
const cmdQueue = [];
let cmdTimer = null;

function botChat(msg) {
  cmdQueue.push(msg);
  if (!cmdTimer) drainCmdQueue();
}

function drainCmdQueue() {
  if (!_activeBot || cmdQueue.length === 0) { cmdTimer = null; return; }
  _activeBot.chat(cmdQueue.shift());
  cmdTimer = setTimeout(drainCmdQueue, 500);
}

let _activeBot = null;

function queueWithdraw(mcUsername, amount) {
  botChat(`${PAY_CMD} ${mcUsername} ${amount}`);
  botChat(`/msg ${mcUsername} Your withdrawal of ${amount.toLocaleString()} Donuts has been sent!`);
}

// Payment message patterns — DonutSMP format: "Y5AK paid you $37." or "$5K"
const PAID_PATTERNS = [
  /^(\w+) paid you \$?([\d,]+(?:\.\d+)?[kmb]?)[.\s]*$/i,
  /^you (?:have )?received \$?([\d,]+(?:\.\d+)?[kmb]?) from (\w+)/i,
  /^\[Economy\]\s*(\w+)\s*[→>]\s*(?:you|bot)[\s:]+\$?([\d,]+(?:\.\d+)?[kmb]?)/i,
];

function parseMcAmount(raw) {
  const s = raw.replace(/,/g, '').toLowerCase();
  const m = s.match(/^([\d.]+)([kmb]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.floor(n * mult);
}

function parsePayment(text) {
  for (const re of PAID_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const nameFirst = !text.toLowerCase().startsWith('you');
    const name   = nameFirst ? m[1] : m[2];
    const rawAmt = nameFirst ? m[2] : m[1];
    const amount = parseMcAmount(rawAmt);
    if (name && amount > 0) return { name, amount };
  }
  return null;
}

function getOrCreateUser(mcUsername) {
  // First check by mc_username (already linked account)
  let user = stmts.getUserByMc.get(mcUsername);
  if (user) return user;
  // Also check by username in case a site account exists with same name
  user = stmts.getUserByName.get(mcUsername);
  if (user) {
    stmts.setMcUsername.run(mcUsername, user.id);
    return user;
  }
  // Create account using MC username, random unusable password
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  stmts.createMcUser.run({
    username: mcUsername,
    passhash: crypto.randomBytes(32).toString('hex'),
    balance: START_BALANCE,
    created_at: Date.now(),
    client_seed: crypto.randomBytes(8).toString('hex'),
    server_seed: serverSeed,
    server_seed_hash: serverSeedHash,
  });
  user = stmts.getUserByName.get(mcUsername);
  stmts.setMcUsername.run(mcUsername, user.id);
  console.log(`[mcBot] Created account for ${mcUsername} (id=${user.id})`);
  return user;
}

function handlePayment(bot, botName, senderName, amount) {
  stmts.cleanLinkTokens.run(Date.now());

  // 1. Check if this is a link token payment
  const token = stmts.getLinkToken.get(botName, amount, Date.now());
  if (token) {
    const user = getOrCreateUser(senderName);
    stmts.fulfillLinkToken.run(senderName, user.id, token.token);
    // Add the link fee to their site balance instead of refunding in-game
    stmts.addBalance.run(amount * 100, user.id);
    botChat(`/msg ${senderName} Linked! +${amount} added to your DonutWager balance.`);
    console.log(`[mcBot] Linked ${senderName} (user_id=${user.id}), added ${amount} to balance`);
    return;
  }

  // 2. Deposit — add to site balance if linked
  const user = stmts.getUserByMc.get(senderName);
  console.log(`[mcBot] Lookup ${senderName} →`, user ? `id=${user.id}` : 'NOT FOUND');
  if (user) {
    stmts.addBalance.run(amount * 100, user.id);
    botChat(`/msg ${senderName} +${amount.toLocaleString()} Donuts added to your DonutWager balance!`);
    console.log(`[mcBot] Deposited ${amount} for ${senderName} (user_id=${user.id})`);
  } else {
    // Not linked — refund so they don't lose money
    botChat(`${PAY_CMD} ${senderName} ${amount}`);
    botChat(`/msg ${senderName} Link at donutwager.org first, then pay ${botName} to deposit!`);
  }
}

function createBot(name) {
  let bot;
  try {
    const botOpts = {
      host: MC_HOST,
      port: MC_PORT,
      username: name,
      auth: MC_ONLINE ? 'microsoft' : 'offline',
      profilesFolder: require('path').join(process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'), '.bot-auth', name),
      hideErrors: false,
      checkTimeoutInterval: 60000,
      closeTimeout: 240000,
    };
    if (MC_VERSION) botOpts.version = MC_VERSION;
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    console.error(`[mcBot] Cannot create ${name}:`, err.message);
    setTimeout(() => createBot(name), 30000);
    return;
  }

  console.log(`[mcBot] ${name} attempting connection...`);

  const connectTimeout = setTimeout(() => {
    console.error(`[mcBot] ${name} connection timed out after 3min — server may be blocking or wrong version`);
    bot.end();
  }, 180000);

  bot.on('login', () => {
    clearTimeout(connectTimeout);
    console.log(`[mcBot] ${name} connected to ${MC_HOST}:${MC_PORT}`);
    _activeBot = bot;
    if (!cmdTimer) drainCmdQueue();
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().replace(/§./g, '').trim();
    console.log(`[mcBot] CHAT: ${text}`);
    const parsed = parsePayment(text);
    if (parsed) {
      console.log(`[mcBot] ${name} received ${parsed.amount} from ${parsed.name}`);
      handlePayment(bot, name, parsed.name, parsed.amount);
    }
  });

  bot.on('messagestr', (msg) => {
    if (msg.includes('microsoft.com/devicelogin') || msg.includes('device')) {
      console.log(`\n[mcBot] ${name} Microsoft login required:\n${msg}\n`);
    }
  });

  bot.on('kicked', (reason) => {
    console.error(`[mcBot] ${name} was KICKED:`, reason);
  });

  bot.on('error', (err) => {
    console.error(`[mcBot] ${name} ERROR:`, err.message);
  });

  bot.on('end', (reason) => {
    console.log(`[mcBot] ${name} disconnected (${reason || 'unknown'}), reconnecting in 10s…`);
    _activeBot = null;
    setTimeout(() => createBot(name), 10000);
  });
}

function init() {
  if (!MC_HOST || MC_HOST === 'localhost') {
    console.log('[mcBot] Set MC_HOST in .env to enable bots.');
    return;
  }
  console.log(`[mcBot] Starting ${BOT_NAMES.length} bot(s) → ${MC_HOST}:${MC_PORT}`);
  BOT_NAMES.forEach((name, i) => setTimeout(() => createBot(name), i * 3000));
}

module.exports = { init, BOT_NAMES, queueWithdraw };
