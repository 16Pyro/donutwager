// Mineflayer bot — detects in-game payments, links accounts, pays out winnings
require('dotenv').config();
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { stmts } = require('./db');

const START_BALANCE = 0;

const MC_HOST    = process.env.MC_HOST    || 'localhost';
const MC_PORT    = parseInt(process.env.MC_PORT || '25565');
const MC_VERSION = process.env.MC_VERSION || null;
const MC_ONLINE  = process.env.MC_ONLINE  !== 'false';
const MC_CHAT    = process.env.MC_CHAT    || 'commandsOnly';
const PAY_CMD    = (process.env.PAY_COMMAND || '/pay').trim();
const BOT_NAMES  = (process.env.BOT_NAMES || 'DonutWager').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Route the game connection through a residential SOCKS5 proxy so the server
// sees a home IP instead of Railway's datacenter range, which anti-bot/anti-VPN
// plugins reject outright. Only affects the Minecraft connection — the web
// server itself is untouched.
const PROXY_HOST = process.env.PROXY_HOST || null;
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
  /^([\w.]+) paid you \$?\s*([\d,]+(?:\.\d+)?[kmb]?)/i,
  /^you (?:have )?received \$?\s*([\d,]+(?:\.\d+)?[kmb]?) from ([\w.]+)/i,
  /^\[Economy\]\s*([\w.]+)\s*[→>]\s*(?:you|bot)[\s:]+\$?\s*([\d,]+(?:\.\d+)?[kmb]?)/i,
];

let _activeBot      = null;
let awaitingBalance = false; // true right after we send /bal, until the reply lands or times out
let balanceTimeout  = null;

// Single command queue — all bot.chat() calls go through here with 500 ms spacing
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

// How much the bot currently has to pay out in-game — kept current automatically
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
  const n    = parseFloat(m[1]);
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

// returns { user, created } - callers that need to attribute a referral only
// want to act on `created === true` (a brand-new account), never on an
// existing player who just happens to be linking/re-linking their MC name
function getOrCreateUser(mcUsername) {
  let user = stmts.getUserByMc.get(mcUsername);
  if (user) return { user, created: false };
  user = stmts.getUserByName.get(mcUsername);
  if (user) {
    stmts.setMcUsername.run(mcUsername, user.id);
    return { user, created: false };
  }
  const serverSeed     = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  stmts.createMcUser.run({
    username:        mcUsername,
    passhash:        crypto.randomBytes(32).toString('hex'),
    balance:         START_BALANCE,
    created_at:      Date.now(),
    client_seed:     crypto.randomBytes(8).toString('hex'),
    server_seed:     serverSeed,
    server_seed_hash: serverSeedHash,
  });
  user = stmts.getUserByName.get(mcUsername);
  stmts.setMcUsername.run(mcUsername, user.id);
  console.log(`[mcBot] Created account for ${mcUsername} (id=${user.id})`);
  return { user, created: true };
}

function handlePayment(botName, senderName, amount) {
  stmts.cleanLinkTokens.run(Date.now());

  // banned usernames never get an account (or a deposit) - refund like an
  // unlinked payment so a banned player can't strand their in-game money
  if (stmts.isBanned.get(senderName)) {
    console.log(`[mcBot] Rejected payment from banned user ${senderName}, refunding`);
    botChat(`${PAY_CMD} ${senderName} ${amount}`);
    return;
  }

  // Link-token payment (used to prove ownership of an MC account)
  const token = stmts.getLinkToken.get(botName, amount, Date.now());
  if (token) {
    const { user, created } = getOrCreateUser(senderName);
    stmts.fulfillLinkToken.run(senderName, user.id, token.token);
    // only a genuinely new account can be attributed to a referrer - and
    // setReferredBy itself is guarded to fire once (WHERE referred_by IS
    // NULL), so this can never reassign an existing player's referrer
    if (created && token.referrer_id) stmts.setReferredBy.run(token.referrer_id, user.id);
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
    // Not linked — refund so they don't lose money
    botChat(`${PAY_CMD} ${senderName} ${amount}`);
  }
}

let recentConnectFails = 0; // consecutive fast disconnects — drives reconnect backoff

async function createBot(name) {
  let bot;
  try {
    const botOpts = {
      host:                 MC_HOST,
      port:                 MC_PORT,
      username:             name,
      auth:                 MC_ONLINE ? 'microsoft' : 'offline',
      profilesFolder:       path.join(DATA_DIR, '.bot-auth', name),
      hideErrors:           false,
      checkTimeoutInterval: 60000,
      closeTimeout:         240000,
      chat:                 MC_CHAT,
    };
    if (MC_VERSION) botOpts.version = MC_VERSION;
    if (PROXY_HOST) {
      console.log(`[mcBot] ${name} connecting via residential proxy ${PROXY_HOST}...`);
      botOpts.stream = await connectViaProxy(MC_HOST, MC_PORT);
    }
    bot = mineflayer.createBot(botOpts);
    bot._name = name;

    // Removed write interception block that delayed pong or keep_alive packets
    // as it can cause protocol mismatches and invalid sequence kicks.

    // Full packet-level debug trail. "Invalid sequence" is a Paper-side check
    // on use_item/use_item_on/player_action packets carrying sequence < 0 -
    // log every packet type once per connection, both directions, with ms
    // timing, and specifically flag any outgoing packet whose params include
    // a sequence field so we can see the exact value we're sending.
    const debugStart = Date.now();
    const seenIn = new Set();
    const seenOut = new Set();
    try {
      bot._client.on('packet', (data, meta) => {
        if (!seenIn.has(meta.name)) {
          seenIn.add(meta.name);
          console.log(`[mcBot] ${name} <-in ${meta.name} +${Date.now() - debugStart}ms`);
        }
      });
      const rawWrite = bot._client.write.bind(bot._client);
      bot._client.write = (packetName, params) => {
        if (!seenOut.has(packetName)) {
          seenOut.add(packetName);
          console.log(`[mcBot] ${name} ->out ${packetName} +${Date.now() - debugStart}ms`);
        }
        if (params && typeof params.sequence === 'number') {
          console.log(`[mcBot] ${name} ->out ${packetName} sequence=${params.sequence}`);
        }
        return rawWrite(packetName, params);
      };
    } catch (e) {
      console.error(`[mcBot] ${name} failed to attach packet debug hooks:`, e.message);
    }
  } catch (err) {
    console.error(`[mcBot] Cannot create ${name}:`, err.message);
    setTimeout(() => createBot(name), 30000);
    return;
  }

  const loginAt = Date.now();
  let reconnectScheduled = false;

  function scheduleReconnect(reason) {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    clearTimeout(bot.balTimer);
    _activeBot = null;
    const wasStable = Date.now() - loginAt > 20000;
    recentConnectFails = wasStable ? 0 : recentConnectFails + 1;
    const delay = wasStable ? 10000 : Math.min(120000, 10000 * Math.pow(2, recentConnectFails - 1));
    console.log(`[mcBot] ${name} disconnected (${reason || 'unknown'}), reconnecting in ${Math.round(delay / 1000)}s…`);
    setTimeout(() => createBot(name), delay);
  }

  // mineflayer's own connect-timeout can take minutes to give up if a proxy
  // stream stalls mid-handshake, so back it with a shorter one of our own.
  const connectTimeout = setTimeout(() => {
    console.error(`[mcBot] ${name} connection timed out — no login after 60s`);
    bot.end();
    setTimeout(() => scheduleReconnect('connect timeout'), 5000);
  }, 60000);

  bot.on('login', () => {
    clearTimeout(connectTimeout);
    console.log(`[mcBot] ${name} connected to ${MC_HOST}:${MC_PORT}`);
    _activeBot = bot;

    // 1.21.2+ vanilla clients end every simulation tick with tick_end
    // (20/sec, always). Mineflayer never sends it on its own - this exact
    // gap was confirmed (via packet-timeline logging) to be what triggers
    // the "Invalid sequence" kick, independent of chat/commands/anything
    // else the bot sends. A client that never ends a tick is a trivially
    // detectable bot signature. Hooked to physicsTick (mineflayer's own
    // 20/sec loop) rather than a separate timer so it never drifts out of
    // sync with the game's actual tick rate.
    bot.on('physicsTick', () => {
      try { bot._client.write('tick_end', {}); } catch (e) {}
    });

    // Poll /bal once shortly after login, then every 60s to keep bank balance current.
    function pollBalance() {
      if (!_activeBot || _activeBot !== bot) return;
      awaitingBalance = true;
      clearTimeout(balanceTimeout);
      balanceTimeout = setTimeout(() => { awaitingBalance = false; }, 8000);
      botChat('/bal');
      bot.balTimer = setTimeout(pollBalance, 60000);
    }
    setTimeout(pollBalance, 1500);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().replace(/§./g, '').trim();
    console.log(`[mcBot] CHAT: ${text}`);

    // /bal response — only trusted right after we asked
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
    // login-phase kicks (e.g. "max accounts online") arrive NBT-tagged
    // ({type, value} wrappers all the way down) instead of the plain chat-
    // component JSON a play-phase kick uses - unwrap NBT tags first or the
    // flattener silently produces '' even though the server sent real text.
    function unwrapNbt(n) {
      if (n == null || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(unwrapNbt);
      if ('type' in n && 'value' in n) {
        if (n.type === 'compound') {
          const out = {};
          for (const k in n.value) out[k] = unwrapNbt(n.value[k]);
          return out;
        }
        if (n.type === 'list') return (n.value.value || []).map(unwrapNbt);
        return n.value;
      }
      const out = {};
      for (const k in n) out[k] = unwrapNbt(n[k]);
      return out;
    }
    function flattenComponent(c) {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      let out = typeof c.text === 'string' ? c.text : (typeof c.translate === 'string' ? c.translate : '');
      if (Array.isArray(c.extra)) out += c.extra.map(flattenComponent).join('');
      return out;
    }
    let parsed = reason;
    try { parsed = typeof reason === 'string' ? JSON.parse(reason) : reason; } catch (e) {}
    parsed = unwrapNbt(parsed);
    const readable = flattenComponent(parsed).replace(/§./g, '').trim();
    // the server always sends something - if flattening produced nothing,
    // that's our parser not recognizing this particular format, not the
    // server sending no reason. dump the raw value instead of hiding it.
    console.error(`[mcBot] ${name} was KICKED: ${readable || `(unparsed reason) ${JSON.stringify(reason)}`}`);
    console.error(`[mcBot] ${name} raw kick payload: ${JSON.stringify(reason)}`);
    console.error(`[mcBot] ${name} time since login: ${Date.now() - loginAt}ms`);
  });

  bot.on('error', (err) => {
    console.error(`[mcBot] ${name} ERROR:`, err.message);
    // Only wipe session cache if Microsoft explicitly rejects the authentication token,
    // rather than on transient Minecraft profile ownership checking failures.
    if (err.message.includes('Invalid credentials') || err.message.includes('Active directory error')) {
      const authFolder = path.join(DATA_DIR, '.bot-auth', name);
      try {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log(`[mcBot] Cleared invalid auth cache at ${authFolder}`);
      } catch (e) {
        console.error(`[mcBot] Failed to clear auth cache:`, e.message);
      }
      bot.end();
      clearTimeout(connectTimeout);
      scheduleReconnect('invalid auth cache cleared');
    }
  });

  bot.on('end', (reason) => {
    clearTimeout(connectTimeout);
    scheduleReconnect(reason || 'unknown');
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

function isOnline() { return _activeBot !== null; }

module.exports = { init, BOT_NAMES, queueWithdraw, isOnline, getBankBalance, setBankBalance };