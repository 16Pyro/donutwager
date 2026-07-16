// Mineflayer bot — detects in-game payments, links accounts, pays out winnings
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { stmts } = require('./db');

const START_BALANCE = 0;

const MC_HOST    = process.env.MC_HOST    || 'localhost';
const MC_PORT    = parseInt(process.env.MC_PORT || '25565');
const MC_VERSION = process.env.MC_VERSION || null;
const MC_ONLINE  = process.env.MC_ONLINE  !== 'false';
const PAY_CMD    = (process.env.PAY_COMMAND || '/pay').trim();
const BOT_NAMES  = (process.env.BOT_NAMES || 'DonutWager')
  .split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Optional SOCKS5 proxy for the Minecraft connection. Off unless PROXY_ENABLED
// is explicitly 'true' - the PROXY_* credentials can stay in the environment
// (they're a paid service shared with other projects) without this bot using
// them. Setting PROXY_HOST alone does nothing; enabling is a deliberate act.
// Only affects the game connection - the web server is untouched either way.
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_HOST = PROXY_ENABLED ? (process.env.PROXY_HOST || null) : null;
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '0');
const PROXY_USER = process.env.PROXY_USER || undefined;
const PROXY_PASS = process.env.PROXY_PASS || undefined;

function connectViaProxy(host, port) {
  return SocksClient.createConnection({
    proxy: { host: PROXY_HOST, port: PROXY_PORT, type: 5, userId: PROXY_USER, password: PROXY_PASS },
    command: 'connect',
    destination: { host, port },
    timeout: 15000,
  }).then((info) => info.socket);
}

const PAID_PATTERNS = [
  /^([\w.]+) paid you \$?\s*([\d,]+(?:\.\d+)?[kmb]?)[.\s]*$/i,
  /^you (?:have )?received \$?\s*([\d,]+(?:\.\d+)?[kmb]?) from ([\w.]+)/i,
  /^\[Economy\]\s*([\w.]+)\s*[→>]\s*(?:you|bot)[\s:]+\$?\s*([\d,]+(?:\.\d+)?[kmb]?)/i,
];

let _activeBot = null;
let awaitingBalance = false;   // true right after we send /bal, until the reply lands or times out
let balanceTimeout = null;

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

// how much the bot currently has to pay out in-game - kept current automatically
// by polling /bal periodically. null = no cap tracked, withdrawals always allowed.
function getBankBalance() {
  const row = stmts.getSetting.get('botBank');
  if (!row || row.value === '') return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}
function setBankBalance(amt) {
  stmts.setSetting.run('botBank', amt === null ? '' : String(Math.max(0, Math.floor(amt))));
}

function queueWithdraw(mcUsername, amount) {
  const bank = getBankBalance();
  if (bank !== null) setBankBalance(bank - amount);
  botChat(`${PAY_CMD} ${mcUsername} ${amount}`);
}

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
  let user = stmts.getUserByMc.get(mcUsername);
  if (user) return user;
  user = stmts.getUserByName.get(mcUsername);
  if (user) {
    stmts.setMcUsername.run(mcUsername, user.id);
    return user;
  }
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

function handlePayment(botName, senderName, amount) {
  stmts.cleanLinkTokens.run(Date.now());

  // link-token payment (used to prove ownership of an MC account)
  const token = stmts.getLinkToken.get(botName, amount, Date.now());
  if (token) {
    const user = getOrCreateUser(senderName);
    stmts.fulfillLinkToken.run(senderName, user.id, token.token);
    stmts.addBalance.run(amount * 100, user.id);
    stmts.addDeposited.run(amount * 100, user.id);
    stmts.insertTx.run(user.id, 'Minecraft', 'Deposit', amount * 100, Date.now());
    console.log(`[mcBot] Linked ${senderName} (user_id=${user.id}), added ${amount} to balance`);
    return;
  }

  const user = stmts.getUserByMc.get(senderName);
  if (user) {
    stmts.addBalance.run(amount * 100, user.id);
    stmts.addDeposited.run(amount * 100, user.id);
    stmts.insertTx.run(user.id, 'Minecraft', 'Deposit', amount * 100, Date.now());
    console.log(`[mcBot] Deposited ${amount} for ${senderName} (user_id=${user.id})`);
  } else {
    // not linked — refund so they don't lose money
    botChat(`${PAY_CMD} ${senderName} ${amount}`);
  }
}

let recentConnectFails = 0; // consecutive fast disconnects - drives reconnect backoff

async function createBot(name) {
  let bot;
  // set once prismarine-auth asks for a device login, cleared once we're in.
  // the connect timeout below refuses to fire while this is true - a human has
  // to open a browser and type the code, which takes far longer than any
  // reasonable connect timeout, and tearing the bot down mid-flow just issues
  // a fresh code on the next attempt and loops forever.
  let authPending = false;
  try {
    const authFolder = path.join(DATA_DIR, '.bot-auth', name);
    const botOpts = {
      host: MC_HOST,
      port: MC_PORT,
      username: name,
      auth: MC_ONLINE ? 'microsoft' : 'offline',
      profilesFolder: authFolder,
      hideErrors: false,
      checkTimeoutInterval: 60000,
      closeTimeout: 240000,
      onMsaCode: (data) => {
        authPending = true;
        console.log(
          `\n[mcBot] ${name} NEEDS MICROSOFT LOGIN — open ${data.verification_uri} ` +
          `and enter code ${data.user_code}\n` +
          `[mcBot] code valid for ${Math.round((data.expires_in || 900) / 60)} min. ` +
          `caching to ${authFolder} — if that path is not on a mounted volume, ` +
          `this login is lost on the next deploy and you will be asked again.\n`
        );
      },
    };
    if (MC_VERSION) botOpts.version = MC_VERSION;
    if (PROXY_HOST) {
      console.log(`[mcBot] ${name} connecting via residential proxy ${PROXY_HOST}...`);
      botOpts.stream = await connectViaProxy(MC_HOST, MC_PORT);
    }
    bot = mineflayer.createBot(botOpts);
    bot._name = name;
  } catch (err) {
    console.error(`[mcBot] Cannot create ${name}:`, err.message);
    setTimeout(() => createBot(name), 30000);
    return;
  }

  let reconnectScheduled = false;
  function scheduleReconnect(reason) {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    clearInterval(bot.balInterval);
    _activeBot = null;
    const wasStable = Date.now() - loginAt > 20000;
    recentConnectFails = wasStable ? 0 : recentConnectFails + 1;
    const delay = wasStable ? 10000 : Math.min(120000, 10000 * Math.pow(2, recentConnectFails - 1));
    console.log(`[mcBot] ${name} disconnected (${reason || 'unknown'}), reconnecting in ${Math.round(delay / 1000)}s…`);
    setTimeout(() => createBot(name), delay);
  }

  // mineflayer's own connect-timeout can take minutes to give up if the stream
  // stalls mid-handshake, so back it with one of our own. re-arms instead of
  // firing while a device login is outstanding.
  let connectTimer = null;
  function armConnectTimeout(ms) {
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (authPending) {
        console.log(`[mcBot] ${name} still waiting on Microsoft device login — holding connection open`);
        return armConnectTimeout(120000);
      }
      console.error(`[mcBot] ${name} connection timed out — no login after 180s`);
      bot.end();
      setTimeout(() => scheduleReconnect('connect timeout'), 5000);
    }, ms);
  }
  armConnectTimeout(180000);

  const loginAt = Date.now();

  bot.on('login', () => {
    authPending = false;
    clearTimeout(connectTimer);
    console.log(`[mcBot] ${name} connected to ${MC_HOST}:${MC_PORT}`);
    _activeBot = bot;

    // restart the command queue. drainCmdQueue() bails and nulls cmdTimer the
    // moment _activeBot goes away, so without this a /pay queued just before a
    // disconnect strands in memory forever - and index.js has already debited
    // the player's balance by then. must run on every login, not just the first.
    if (cmdQueue.length) {
      console.log(`[mcBot] ${name} resuming ${cmdQueue.length} queued command(s)`);
    }
    if (!cmdTimer) drainCmdQueue();

    // keep the tracked bank balance current - queueWithdraw only decrements it
    // locally, so without a periodic re-read it drifts from the real in-game
    // balance for as long as the connection stays up
    function pollBalance() {
      awaitingBalance = true;
      clearTimeout(balanceTimeout);
      balanceTimeout = setTimeout(() => { awaitingBalance = false; }, 8000);
      botChat('/bal');
    }
    setTimeout(pollBalance, 1500);
    bot.balInterval = setInterval(pollBalance, 60000);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().replace(/§./g, '').trim();
    console.log(`[mcBot] CHAT: ${text}`);

    // /bal response - only trusted right after we asked
    if (awaitingBalance) {
      const balMatch = text.match(/\$\s*([\d,]+(?:\.\d+)?[kmb]?)/i);
      if (balMatch) {
        const amount = parseMcAmount(balMatch[1]);
        if (amount > 0) {
          awaitingBalance = false;
          clearTimeout(balanceTimeout);
          setBankBalance(amount);
          console.log(`[mcBot] ${name} bank balance updated: ${amount.toLocaleString()}`);
          return;
        }
      }
    }

    const parsed = parsePayment(text);
    if (parsed) handlePayment(name, parsed.name, parsed.amount);
  });

  bot.on('messagestr', (msg) => {
    if (msg.includes('microsoft.com/devicelogin') || msg.includes('device')) {
      console.log(`\n[mcBot] ${name} Microsoft login required:\n${msg}\n`);
    }
  });

  bot.on('kicked', (reason) => {
    function flattenComponent(c) {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      let out = typeof c.text === 'string' ? c.text : '';
      if (Array.isArray(c.extra)) out += c.extra.map(flattenComponent).join('');
      return out;
    }
    let parsed = reason;
    try { parsed = typeof reason === 'string' ? JSON.parse(reason) : reason; } catch (e) {}
    const readable = flattenComponent(parsed).replace(/§./g, '').trim();
    console.error(`[mcBot] ${name} was KICKED: ${readable || '(empty reason)'}`);
  });

  bot.on('error', (err) => {
    console.error(`[mcBot] ${name} ERROR:`, err.message);
    if (err.message.includes('Failed to obtain profile data') || err.message.includes('own minecraft')) {
      // deliberately NOT deleting the auth cache here. this error is often
      // transient (MS outage, rate limit), and wiping the tokens forces a full
      // device login - which nobody can complete on a headless host, so one
      // blip would strand the bot permanently. if the cache really is bad,
      // clear DATA_DIR/.bot-auth by hand and restart to re-run the login.
      console.error(
        `[mcBot] ${name} could not load its Minecraft profile. Leaving the auth cache in place — ` +
        `if this persists, delete ${path.join(DATA_DIR, '.bot-auth', name)} and restart to re-authenticate.`
      );
      bot.end();
      clearTimeout(connectTimer);
      scheduleReconnect('profile load failed');
    }
  });

  bot.on('end', (reason) => {
    clearTimeout(connectTimer);
    scheduleReconnect(reason || 'unknown');
  });
}

function init() {
  if (!MC_HOST || MC_HOST === 'localhost') {
    console.log('[mcBot] Set MC_HOST in .env to enable bots.');
    return;
  }
  console.log(`[mcBot] Starting ${BOT_NAMES.length} bot(s) → ${MC_HOST}:${MC_PORT}`);
  console.log(`[mcBot] Auth cache dir: ${path.join(DATA_DIR, '.bot-auth')}`);
  console.log(`[mcBot] Proxy: ${
    PROXY_ENABLED
      ? `ENABLED → ${process.env.PROXY_HOST || '(PROXY_ENABLED set but PROXY_HOST missing!)'}`
      : `disabled — connecting directly${process.env.PROXY_HOST ? ' (PROXY_* creds present but unused; set PROXY_ENABLED=true to use them)' : ''}`
  }`);
  console.log(`[mcBot] DATA_DIR ${process.env.DATA_DIR ? `= ${process.env.DATA_DIR}` : 'is UNSET — using the app dir, which is wiped on every deploy'}`);
  BOT_NAMES.forEach((name, i) => setTimeout(() => createBot(name), i * 3000));
}

function isOnline() { return _activeBot !== null; }

module.exports = { init, BOT_NAMES, queueWithdraw, isOnline, getBankBalance, setBankBalance };
