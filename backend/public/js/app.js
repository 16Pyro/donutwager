// DonutWager client. Renders what the server says — no game logic lives here.
(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let me = null; // { username, balance, ... }
// matches server/db.js - the name shown for anyone in anonymous mode
const HIDDEN_NAME = 'Anonymous';

// ---------- tiny api helper ----------
async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  // opportunistically refresh identity if we don't have one cached yet (e.g.
  // right after a Minecraft link gets confirmed) - cheap no-op otherwise
  if (!me && path !== 'me') await loadMe();
  return data;
}

async function loadMe() {
  try { applyUser((await api('me')).user); } catch {}
}

// 2500000000 -> "2.5B", 1500 -> "1.5K", 42.5 -> "42.50"
function fmt(n) {
  n = Number(n);
  const abs = Math.abs(n);
  const trim = (v) => {
    let s = v.toFixed(2);
    if (s.endsWith('00')) s = s.slice(0, -3);
    else if (s.endsWith('0')) s = s.slice(0, -1);
    return s;
  };
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "1.5b" / "500K" / "1,000" -> number of coins (NaN if garbage)
function parseAmt(str) {
  const m = String(str).trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb]?)$/i);
  if (!m) return NaN;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1);
}

function toast(msg, gold) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (gold ? ' gold' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function setBalance(b) {
  if (b === undefined || !me) return;
  me.balance = b;
  const el = $('#balance');
  el.textContent = fmt(b);
  el.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 200 });
}

// ---------- sounds ----------
// short synthesized blips - envelope-shaped so nothing clicks or drones.
const SND = (() => {
  let ac = null;
  let muted = localStorage.getItem('dw-muted') === '1';
  const ctx = () => (ac ||= new (window.AudioContext || window.webkitAudioContext)());

  function tone(freq, dur, { type = 'square', vol = 0.05, glide = 0, delay = 0 } = {}) {
    if (muted) return;
    try {
      const c = ctx(), t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + glide), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch {}
  }

  function noise(dur, { vol = 0.12, cutoff = 800, delay = 0 } = {}) {
    if (muted) return;
    try {
      const c = ctx(), t = c.currentTime + delay;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(c.destination);
      src.start(t);
    } catch {}
  }

  return {
    tick: () => tone(2200, 0.03, { type: 'square', vol: 0.02 }),
    pop: () => tone(520, 0.09, { type: 'triangle', vol: 0.06, glide: 260 }),
    boom: () => { noise(0.5, { vol: 0.14, cutoff: 500 }); tone(120, 0.4, { type: 'sine', vol: 0.1, glide: -70 }); },
    coin: () => { tone(988, 0.07, { type: 'square', vol: 0.035 }); tone(1319, 0.12, { type: 'square', vol: 0.035, delay: 0.07 }); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.11, { type: 'triangle', vol: 0.05, delay: i * 0.08 })),
    click: () => tone(700, 0.04, { type: 'square', vol: 0.025 }),
    hover: () => tone(1600, 0.02, { type: 'sine', vol: 0.012 }),
    // metallic rattle while the case charges up — escalating ticks
    rattle: () => { for (let i = 0; i < 5; i++) noise(0.04, { vol: 0.03 + i * 0.008, cutoff: 2600, delay: i * 0.09 }); },
    lock: () => { tone(180, 0.08, { type: 'square', vol: 0.05, glide: -40 }); noise(0.05, { vol: 0.04, cutoff: 1400, delay: 0.02 }); },
    // lid bursts open: airy noise sweep + rising chord
    lid: () => { noise(0.28, { vol: 0.12, cutoff: 3200 }); [392, 523, 784].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.05, delay: i * 0.03 })); },
    // deep bass impact — intensity 0..1 scales volume & length (legendary/hero)
    impact: (k = 1) => { tone(70, 0.35 + k * 0.25, { type: 'sine', vol: 0.08 + k * 0.09, glide: -30 }); noise(0.18, { vol: 0.05 + k * 0.05, cutoff: 420 }); },
    // reward stinger, brighter & longer with rarity tier (0..6)
    reveal: (tier = 0) => {
      const scales = [
        [660], [660, 880], [660, 880, 990], [523, 784, 1047],
        [523, 659, 784, 1047], [523, 659, 784, 1047, 1319], [523, 659, 784, 1047, 1319, 1568],
      ];
      const notes = scales[Math.min(tier, 6)];
      notes.forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.045 + tier * 0.004, delay: i * 0.07 }));
    },
    get muted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem('dw-muted', muted ? '1' : '0'); return muted; },
  };
})();

// ---------- routing ----------
let lastRoutedPage = null;
function route() {
  const page = (location.hash.replace('#/', '') || 'home').split('?')[0];
  const target = $(`[data-page="${page}"]`) ? page : 'home';
  // leaving Cases (whether you were on single-case or spectating a battle) always
  // resets back to the battles lobby for next time - it should never resume in place
  if (lastRoutedPage === 'cases' && target !== 'cases') showCasesView('battles');
  lastRoutedPage = target;
  $$('.page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== target));
  $$('.sidenav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === target));
  if (target === 'fair') renderFair();
  if (target === 'cases') refreshBattles();
  if (target === 'leaderboard') renderLeaderboard();
  if (target === 'rewards') renderRewards();
  if (target === 'stats') renderStats();
  if (target === 'settings') renderSettings();
  syncActiveGame(target);
  document.body.classList.remove('nav-open');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- resume in-flight games ----------
// A game started earlier lives on the server until it's finished. Restore it into
// its page UI so navigating to (or reloading) the page keeps it active.
const STATEFUL_GAMES = { mines: 1, towers: 1, chicken: 1, blackjack: 1 };
const bjShowingHand = () => $('#bj-deal').classList.contains('hidden');
function clientGameActive(page) {
  return (page === 'mines' && minesActive)
    || (page === 'towers' && towActive)
    || (page === 'chicken' && ckActive)
    || (page === 'blackjack' && bjShowingHand());
}
function applyActive(active, balance) {
  if (!active) return;
  if (active.mines && !minesActive) {
    minesActive = true; minesUI(); buildMinesGrid(active.mines.revealed);
    $('#mines-count').value = active.mines.mineCount;
    $('#mines-count-label').textContent = active.mines.mineCount;
    minesEl.msg.textContent = 'Picked up where you left off.';
  }
  if (active.towers && !towActive) {
    towActive = true; towDiff = active.towers.diff; towUI();
    buildTower(active.towers.row); towSetRow(active.towers.row);
    towEl.msg.textContent = `Back on floor ${active.towers.row + 1}.`;
  }
  if (active.chicken && !ckActive) {
    ckActive = true; ckDiff = active.chicken.diff; ckLane = active.chicken.lane;
    ckUI(); buildRoad(ckLane);
    $('#chicken-msg').textContent = 'Your chicken waited for you.';
  }
  if (active.blackjack && !bjShowingHand()) {
    renderBj({ ...active.blackjack, done: false, balance });
  }
}
// on landing on a game page with nothing active locally, pull the server's truth
let activeSyncing = false;
async function syncActiveGame(page) {
  if (!me || !STATEFUL_GAMES[page] || clientGameActive(page) || activeSyncing) return;
  activeSyncing = true;
  try { const d = await api('me'); if (d.user) applyActive(d.active, d.user.balance); }
  catch {} finally { activeSyncing = false; }
}

// ---------- auth (Minecraft account linking - no passwords) ----------
function showModal(name) {
  $('#modal-backdrop').classList.remove('hidden');
  $('#modal-link').classList.toggle('hidden', name !== 'link');
  $('#modal-deposit').classList.toggle('hidden', name !== 'deposit');
  $('#modal-withdraw').classList.toggle('hidden', name !== 'withdraw');
  if (name === 'link') openLinkModal();
  if (name === 'deposit') openDepositModal();
  if (name === 'withdraw') { $('#withdraw-error').textContent = ''; $('#withdraw-amount').value = ''; }
}
function hideModal() { $('#modal-backdrop').classList.add('hidden'); stopLinkPoll(); }

document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-modal]');
  if (m) { e.preventDefault(); showModal(m.dataset.modal); }
});
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') hideModal(); });

// ---- deposit / withdraw (bot-verified, no passwords) ----
let _botNames = null;
let _depositBot = 'AALV1N';
function updateDepositCmd() {
  const raw = $('#deposit-amount').value.trim();
  const amount = parseAmt(raw);
  const amountText = amount > 0 ? Math.floor(amount) : '<amount>';
  $('#deposit-cmd').textContent = `/pay ${_depositBot} ${amountText}`;
}
async function openDepositModal() {
  if (!_botNames) {
    try { const d = await api('mc/bots'); _botNames = d.bots; } catch { _botNames = ['AALV1N']; }
  }
  _depositBot = _botNames[0];
  $('#deposit-amount').value = '';
  updateDepositCmd();
}
$('#deposit-amount').addEventListener('input', updateDepositCmd);
$('#deposit-close-btn').onclick = hideModal;

$('#withdraw-go-btn').onclick = async () => {
  $('#withdraw-error').textContent = '';
  const amount = parseAmt($('#withdraw-amount').value);
  if (!amount || amount < 1) { $('#withdraw-error').textContent = 'Enter a valid amount'; return; }
  try {
    const d = await api('mc/withdraw', { amount: Math.floor(amount) });
    setBalance(d.balance);
    hideModal();
    toast('Withdrawal sent — check in-game!', true);
  } catch (e) { $('#withdraw-error').textContent = e.message; }
};

$('#wallet-deposit-btn').onclick = () => showModal('deposit');
$('#wallet-withdraw-btn').onclick = () => showModal('withdraw');

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const text = $('#' + btn.dataset.copy).textContent;
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', true)).catch(() => toast('Could not copy'));
});

function applyUser(user) {
  me = user;
  $('#wallet').classList.toggle('hidden', !user);
  $('#rewards-btn').classList.toggle('hidden', !user);
  $('#auth-buttons').classList.toggle('hidden', !!(user && user.mcUsername));
  $('#user-menu').classList.toggle('hidden', !user);
  if (user) {
    $('#username-label').textContent = user.mcUsername || user.username;
    $('#balance').textContent = fmt(user.balance);
    $('#profile-avatar').src = `https://minotar.net/helm/${user.mcUsername || user.username}/64.png`;
    $('#profile-avatar').alt = `${user.mcUsername || user.username} avatar`;
  }
}

// ---- Minecraft account linking flow: generate a bot + amount to /pay ->
// poll until the bot detects the in-game payment (see server/mcBot.js) ----
let linkPollId = null;
function stopLinkPoll() { clearInterval(linkPollId); linkPollId = null; }
function showLinkStep(step) {
  $('#link-step-start').classList.toggle('hidden', step !== 'start');
  $('#link-step-pay').classList.toggle('hidden', step !== 'pay');
}
async function openLinkModal() {
  $('#link-error').textContent = '';
  try {
    const s = await api('mc/link/poll');
    if (s.status === 'pending') showLinkPending();
    else showLinkStep('start');
  } catch { showLinkStep('start'); }
}
function updateLinkExpiry(expiresAt) {
  const left = expiresAt - Date.now();
  $('#link-expiry').textContent = left > 0 ? `Code expires in ${Math.ceil(left / 60000)} min` : 'Code expired — generate a new one';
}
function showLinkPending(d) {
  showLinkStep('pay');
  if (d) {
    $('#link-cmd').textContent = `/pay ${d.bot} ${d.amount}`;
    updateLinkExpiry(d.expiresAt);
    stopLinkPoll();
    linkPollId = setInterval(() => pollLinkStatus(d.expiresAt), 3000);
  }
}
async function pollLinkStatus(expiresAt) {
  if (expiresAt) updateLinkExpiry(expiresAt);
  try {
    const s = await api('mc/link/poll');
    if (s.status === 'linked') {
      stopLinkPoll();
      applyUser(s.user);
      hideModal();
      toast(`Linked! Welcome, ${s.user.mcUsername || s.user.username}.`, true);
    } else if (s.status === 'expired' || s.status === 'no_token') {
      stopLinkPoll();
      showLinkStep('start');
    }
  } catch {}
}
$('#link-start-btn').onclick = async () => {
  $('#link-error').textContent = '';
  try {
    const d = await api('mc/link/start', {});
    SND.click();
    showLinkPending(d);
  } catch (e) { $('#link-error').textContent = e.message; }
};
$('#link-cancel-btn').onclick = () => {
  stopLinkPoll();
  showLinkStep('start');
};

$('#settings-logout-btn').onclick = async () => { await api('logout', {}); applyUser(null); location.hash = '#/'; };

// ---------- bet amount helpers ----------
document.addEventListener('click', (e) => {
  const h = e.target.closest('[data-half]'); const d = e.target.closest('[data-double]'); const m = e.target.closest('[data-max]');
  if (h) { const i = $('#' + h.dataset.half); i.value = fmt(Math.max(0.1, (parseAmt(i.value) || 0) / 2)); }
  if (d) { const i = $('#' + d.dataset.double); i.value = fmt((parseAmt(i.value) || 0) * 2); }
  if (m) { const i = $('#' + m.dataset.max); i.value = me ? fmt(me.balance) : ''; if (!me) toast('place a bet to load your balance'); }
});

// send the raw text ("1.5b" etc) - the server does the real parsing
const amt = (id) => $('#' + id).value;

// ---------- sidebar / chat toggles ----------
$('#burger').onclick = () => document.body.classList.toggle('nav-open');
$('#chat-close').onclick = () => document.body.classList.add('chat-closed');
if (window.innerWidth < 1100) document.body.classList.add('chat-closed');

// ---------- profile dropdown ----------
$('#profile-btn').onclick = (e) => { e.stopPropagation(); $('#profile-dropdown').classList.toggle('hidden'); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('#user-menu')) $('#profile-dropdown').classList.add('hidden');
});
$('#dd-rewards-btn').onclick = () => { $('#profile-dropdown').classList.add('hidden'); location.hash = '#/rewards'; };
$('#rewards-btn').onclick = () => { location.hash = '#/rewards'; };
$('#dd-stats-btn').onclick = () => { $('#profile-dropdown').classList.add('hidden'); location.hash = '#/stats'; };
$('#dd-settings-btn').onclick = () => { $('#profile-dropdown').classList.add('hidden'); location.hash = '#/settings'; };

// ================= CASES: shared bits =================
let caseList = [];          // array of public cases (fixed price, item values)
let caseById = {};          // id -> case
let caseSpinning = false;
let detailCase = null;      // case currently open in the detail view
let caseSort = 'asc', caseQuery = '';
const itemIcon = (i) => `<img src="/img/items/${i.icon}.png" alt="${i.name || i.icon}">`;

// rarity ladder: label + reveal intensity used across the premium case flow.
// tier drives sound, particle count, flash/shake and reveal timing.
const RARITY = {
  junk:      { label: 'Junk',      tier: 0, sparks: 6,  flash: false, shake: 0,  hold: 260 },
  common:    { label: 'Common',    tier: 1, sparks: 8,  flash: false, shake: 0,  hold: 300 },
  uncommon:  { label: 'Uncommon',  tier: 2, sparks: 11, flash: false, shake: 0,  hold: 360 },
  rare:      { label: 'Rare',      tier: 3, sparks: 16, flash: false, shake: 4,  hold: 480 },
  epic:      { label: 'Epic',      tier: 4, sparks: 22, flash: true,  shake: 8,  hold: 640 },
  legendary: { label: 'Legendary', tier: 5, sparks: 30, flash: true,  shake: 12, hold: 820 },
  hero:      { label: 'Divine',    tier: 6, sparks: 40, flash: true,  shake: 16, hold: 1000 },
};
const rarityOf = (r) => RARITY[r] || RARITY.common;
// case "identity" colour, derived from its risk — matches the site's green/gold/red
const CASE_THEME = {
  low:    { c: '#6fbf3f', g: '#4c8f2a' },
  medium: { c: '#f3c94b', g: '#b98f22' },
  high:   { c: '#e05b4b', g: '#a3392c' },
};
const caseTheme = (c) => CASE_THEME[c.riskKey] || CASE_THEME.medium;

function lootCard(i, valueLabel) {
  return `<div class="loot-card rarity-${i.rarity} r-${i.rarity}">${itemIcon(i)}<b>${i.name}</b>
    <span class="amt">${valueLabel}</span><span class="chance">${i.chance}%</span></div>`;
}

// premium 3D-style case object for the browse grid (scoped .lux styling)
function luxCaseTile(c) {
  const el = document.createElement('div');
  el.className = 'case-tile';
  const th = caseTheme(c);
  el.style.setProperty('--ct', th.c);
  el.style.setProperty('--ctg', th.g);
  el.innerHTML = `<span class="risk-badge ${c.riskKey}">${c.risk}</span>
    ${caseObjHTML(c)}
    <b>${c.name}</b><span class="case-price">${fmt(c.price)}</span>`;
  el.onclick = () => openDetail(c);
  return el;
}

// shared case-object markup so single-case and battles look identical:
// just the case's hero item, big, on a themed glow disc - no chest prop.
function caseObjHTML(c, cls = '') {
  const th = caseTheme(c);
  return `<div class="case-obj ${cls}" style="--ct:${th.c};--ctg:${th.g}">
    <div class="case-glow"></div>
    <img class="case-item" src="/img/items/${c.cover}.png" alt="${c.name} case">
  </div>`;
}

function reelItemEl(item) {
  const div = document.createElement('div');
  div.className = 'reel-item rarity-' + item.rarity;
  div.innerHTML = `${itemIcon(item)}<b>${item.name}</b><span class="mult">${fmt(item.value ?? item.amount)}</span>`;
  return div;
}

// build a long strip of weighted-random filler with the real drop at a fixed slot,
// then slide the strip so the needle lands on it. Visual only - result is server-decided.
// used only by the Daily Case (not the muted Cases page), so it keeps real sound.
function spinReel(items, winIdx, reelSel = '#case-reel') {
  const reel = $(reelSel);
  reel.style.transition = 'none';
  reel.style.transform = 'translateX(0)';
  reel.innerHTML = '';
  const SLOTS = 40, WIN_SLOT = 34, W = 116; // item width + gap
  const DUR = 4200;
  const weightPick = () => {
    let r = Math.random() * items.reduce((s, i) => s + i.chance, 0);
    for (const i of items) { r -= i.chance; if (r <= 0) return i; }
    return items[0];
  };
  for (let s = 0; s < SLOTS; s++) reel.appendChild(reelItemEl(s === WIN_SLOT ? items[winIdx] : weightPick()));
  const winEl = reel.children[WIN_SLOT];
  const windowW = reel.parentElement.clientWidth;
  // land dead-center under the needle line - no jitter
  const target = WIN_SLOT * W + W / 2 - windowW / 2;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    reel.style.transition = `transform ${DUR}ms cubic-bezier(.45,.05,.15,1)`;
    reel.style.transform = `translateX(${-target}px)`;
  }));
  // guard every sound with "are we still looking at the daily case" so leaving
  // mid-spin doesn't leave ticks/win jingle playing behind you
  driveReelTicks(reel, W, 'x', DUR, () => { if (onDailyPage()) SND.tick(); });
  // once it settles dead-center, pop the winning item so it's unmistakable what you pulled
  setTimeout(() => winEl.classList.add('bt-win-pop'), DUR);
}
function onDailyPage() {
  const p = $('[data-page="daily"]');
  return !!p && !p.classList.contains('hidden');
}

async function loadCases() {
  try {
    caseList = (await api('cases')).cases;
    caseById = Object.fromEntries(caseList.map((c) => [c.id, c]));
    renderCaseGrid();
  } catch {}
}

// ---- browse grid ----
// log scale 50K..100M -> 0..100% for the little price bar
function priceBarPct(price) {
  const min = Math.log(50000), max = Math.log(100000000);
  return Math.round((Math.log(Math.max(price, 50000)) - min) / (max - min) * 100);
}
function caseTileEl(c, opts = {}) {
  const el = document.createElement('div');
  el.className = 'case-tile';
  el.innerHTML = `<span class="risk-badge ${c.riskKey}">${c.risk}</span>
    <div class="case-art">${itemIcon({ icon: c.cover })}</div>
    <b>${c.name}</b><span class="case-price">${fmt(c.price)}</span>
    <div class="price-bar"><span style="left:${priceBarPct(c.price)}%"></span></div>`;
  if (opts.onclick) el.onclick = () => opts.onclick(c, el);
  return el;
}

function visibleCases() {
  let list = caseList.filter((c) => c.name.toLowerCase().includes(caseQuery));
  list = list.slice().sort((a, b) => caseSort === 'asc' ? a.price - b.price : b.price - a.price);
  return list;
}

function renderCaseGrid() {
  const grid = $('#case-grid');
  if (!grid) return;
  grid.innerHTML = '';
  visibleCases().forEach((c) => grid.appendChild(luxCaseTile(c)));
}
$('#case-search').addEventListener('input', (e) => { caseQuery = e.target.value.toLowerCase(); renderCaseGrid(); });
$('#case-sort').onclick = () => {
  caseSort = caseSort === 'asc' ? 'desc' : 'asc';
  $('#case-sort').textContent = 'Price ' + (caseSort === 'asc' ? '↑' : '↓');
  renderCaseGrid();
};

// ---- case detail / open ----
let caseQty = 1;
$$('#case-qty .qty-btn').forEach((b) => b.onclick = () => {
  if (caseSpinning) return;
  caseQty = Number(b.dataset.qty); SND.click();
  $$('#case-qty .qty-btn').forEach((x) => x.classList.toggle('active', x === b));
  if (detailCase) $('#detail-price').textContent = fmt(detailCase.price * caseQty);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// smoothly count a number element up to its final value (ease-out cubic)
function countUp(el, to, ms = 750) {
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / ms);
    el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick); else el.textContent = fmt(to);
  };
  requestAnimationFrame(tick);
}

function screenFlash(stage) { const f = document.createElement('div'); f.className = 'flash'; stage.appendChild(f); setTimeout(() => f.remove(), 500); }
function screenShake(stage) { stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake'); setTimeout(() => stage.classList.remove('shake'), 500); }

function openDetail(c) {
  SND.click();
  detailCase = c; caseQty = 1;
  $$('#case-qty .qty-btn').forEach((x) => x.classList.toggle('active', x.dataset.qty === '1'));
  $('#single-view').classList.add('hidden');
  $('#case-detail').classList.remove('hidden');
  $('#detail-cover').src = `/img/items/${c.cover}.png`;
  $('#detail-cover').alt = `${c.name} case cover`;
  $('#detail-name').textContent = c.name;
  $('#detail-sub').textContent = `${c.risk} risk · ${c.items.length} possible drops`;
  $('#detail-price').textContent = fmt(c.price);
  $('#case-stage').classList.remove('dim');
  $('#open-arena').innerHTML = `<div class="cs-idle">${caseObjHTML(c, 'lg')}</div>`;
  $('#case-loot').innerHTML = c.items.slice().reverse().map((i) => lootCard(i, fmt(i.value))).join('');
  $('#cases-msg').textContent = 'Contents below — every drop chance is shown.';
  $('#cases-msg').className = 'stage-msg';
}
$('#detail-back').onclick = () => {
  if (caseSpinning) return;
  SND.click();
  $('#case-detail').classList.add('hidden');
  $('#single-view').classList.remove('hidden');
};

async function openSingle() {
  if (caseSpinning || !detailCase) return;
  const btn = $('#cases-open'), msg = $('#cases-msg');
  const stage = $('#case-stage'), arena = $('#open-arena');
  let d;
  try { d = await api('cases/open', { caseId: detailCase.id, qty: caseQty }); }
  catch (e) { toast(e.message); return; }

  caseSpinning = true; btn.disabled = true;
  msg.textContent = 'Grabbing EOS Block...'; msg.className = 'stage-msg';
  await sleep(550);
  msg.textContent = 'Opening…'; msg.className = 'stage-msg';
  const pool = detailCase.items;
  // the rarest pull drives the intensity of the climax
  const top = d.results.reduce((m, r) => rarityOf(r.item.rarity).tier > m.tier ? rarityOf(r.item.rarity) : m, rarityOf('junk'));

  // darken + build one vertical slide spinner per opened case (like battles)
  stage.classList.add('dim');
  arena.innerHTML = '<div class="cs-spins fit-row"></div>';
  const spinsWrap = arena.querySelector('.cs-spins');
  const reels = d.results.map(() => {
    const col = document.createElement('div');
    col.className = 'cs-col';
    col.innerHTML = '<div class="bt-spin"><div class="bt-reel"></div><div class="bt-line"></div></div>';
    spinsWrap.appendChild(col);
    return col.querySelector('.bt-reel');
  });

  const DUR = 4200;
  await Promise.all(d.results.map((r, i) => btSpin(reels[i], pool, r.item, DUR)));

  // land: flourish scaled by the best pull
  reels.forEach((reel) => reel.parentElement.classList.add('landed'));
  if (top.flash) screenFlash(stage);
  if (top.tier >= 5) SND.impact(top.tier === 6 ? 1 : 0.7); else SND.reveal(top.tier);
  await sleep(200);

  // settle
  stage.classList.remove('dim');
  setBalance(d.balance);
  const profit = d.payout - detailCase.price * d.qty;
  if (profit >= 0) SND.win(); else SND.boom();
  const names = d.results.map((r) => r.item.name).join(', ');
  msg.textContent = `${names} — total ${fmt(d.payout)} (${profit >= 0 ? '+' : ''}${fmt(profit)})`;
  msg.className = 'stage-msg ' + (profit >= 0 ? 'good' : 'bad');
  caseSpinning = false; btn.disabled = false;
}
$('#cases-open').onclick = openSingle;

// provably-fair buttons everywhere route to the fairness page
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-fair]')) { e.preventDefault(); location.hash = '#/fair'; }
});

// ================= CASES: battle lobby =================
const SPEED_DELAY = { normal: 700, quick: 280, instant: 0 };
const MAX_PER_CASE = 100;   // effectively no per-case cap in a battle lineup
let battleSpeed = 'normal', battleMode = 'standard', battleSize = '1v1';
let lineup = [];            // [{caseId, count}]
let watchingId = null;      // battle id currently in the room
let roomPoll = null, animatedDone = false;
let lastArenaFp = null;     // fingerprint of the last-rendered open-lobby seat state

function showCasesView(view) {
  $('#battles-view').classList.toggle('hidden', view !== 'battles');
  $('#battle-create-view').classList.toggle('hidden', view !== 'create');
  $('#battle-room').classList.toggle('hidden', view !== 'room');
  $('#single-view').classList.toggle('hidden', view !== 'single');
  $('#case-detail').classList.add('hidden');
  $('#tab-battles').classList.toggle('active', view !== 'single');
  $('#tab-single').classList.toggle('active', view === 'single');
  $('#battle-create-btn').classList.toggle('hidden', view === 'single');
  if (view !== 'room') { clearInterval(roomPoll); roomPoll = null; watchingId = null; }
}
$('#tab-battles').onclick = () => { SND.click(); showCasesView('battles'); refreshBattles(); };
$('#tab-single').onclick = () => { SND.click(); showCasesView('single'); };
$('#battle-create-btn').onclick = () => { SND.click(); showCasesView('create'); renderLineup(); };
$('#battle-back').onclick = () => { SND.click(); showCasesView('battles'); refreshBattles(); };
$('#room-back').onclick = () => { SND.click(); showCasesView('battles'); refreshBattles(); };

$$('#speed-pick .side-btn').forEach((b) => b.onclick = () => {
  battleSpeed = b.dataset.speed;
  $$('#speed-pick .side-btn').forEach((x) => x.classList.toggle('active', x === b));
});
$$('#mode-grid .mode-btn').forEach((b) => b.onclick = () => {
  battleMode = b.dataset.bmode;
  $$('#mode-grid .mode-btn').forEach((x) => x.classList.toggle('active', x === b));
});
$$('#size-pick .side-btn').forEach((b) => b.onclick = () => {
  battleSize = b.dataset.bsize;
  $$('#size-pick .side-btn').forEach((x) => x.classList.toggle('active', x === b));
});

function battleTotal() {
  return lineup.reduce((s, l) => s + (caseById[l.caseId]?.price || 0) * l.count, 0);
}

function renderLineup() {
  const wrap = $('#lineup');
  const addBtn = $('#lineup-add-btn');   // capture BEFORE clearing (it may live inside #lineup)
  wrap.innerHTML = '';
  lineup.forEach((l, i) => {
    const c = caseById[l.caseId];
    const card = document.createElement('div');
    card.className = 'lineup-card';
    card.innerHTML = `
      <button class="lineup-del" title="remove">🗑</button>
      ${caseObjHTML(c, 'sm')}
      <b>${c.name}</b><span class="case-price">${fmt(c.price)}</span>
      <div class="lineup-step">
        <button class="btn btn-tiny step-minus">−</button>
        <b>${l.count}</b>
        <button class="btn btn-tiny step-plus">+</button>
      </div>`;
    card.querySelector('.lineup-del').onclick = () => { lineup.splice(i, 1); renderLineup(); };
    card.querySelector('.step-minus').onclick = () => { l.count--; if (l.count < 1) lineup.splice(i, 1); renderLineup(); };
    card.querySelector('.step-plus').onclick = () => { l.count = Math.min(MAX_PER_CASE, l.count + 1); renderLineup(); };
    wrap.appendChild(card);
  });
  if (addBtn) wrap.appendChild(addBtn); // keep the add tile at the end of the row
  updateTotal();
}
function updateTotal() {
  const total = battleTotal();
  $('#battle-total').textContent = fmt(total);
  const costBadge = $('#battle-create-btn-cost');
  costBadge.classList.toggle('hidden', total <= 0);
  costBadge.textContent = ` - ${fmt(total)}`;
}

// ---- case picker modal ----
let pickerSel = {};   // caseId -> count (working copy)
function openPicker() {
  SND.click();
  pickerSel = {};
  lineup.forEach((l) => { pickerSel[l.caseId] = l.count; });
  $('#picker-search').value = '';
  renderPicker('');
  $('#picker-backdrop').classList.remove('hidden');
}
function renderPicker(q) {
  const grid = $('#picker-grid');
  grid.innerHTML = '';
  caseList.filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => a.price - b.price)
    .forEach((c) => {
      const el = caseTileEl(c, { onclick: () => {
        SND.click();
        pickerSel[c.id] = Math.min(MAX_PER_CASE, (pickerSel[c.id] || 0) + 1);
        renderPicker($('#picker-search').value.toLowerCase());
      }});
      if (pickerSel[c.id]) {
        el.classList.add('selected');
        const badge = document.createElement('span');
        badge.className = 'sel-count'; badge.textContent = 'x' + pickerSel[c.id];
        el.appendChild(badge);
        const minus = document.createElement('button');
        minus.className = 'btn btn-ghost btn-tiny sel-minus-btn'; minus.title = 'remove one'; minus.textContent = '− Remove one';
        minus.onclick = (e) => {
          e.stopPropagation();
          if (pickerSel[c.id] > 1) pickerSel[c.id]--; else delete pickerSel[c.id];
          renderPicker($('#picker-search').value.toLowerCase());
        };
        el.appendChild(minus);
      }
      grid.appendChild(el);
    });
  const count = Object.values(pickerSel).reduce((s, n) => s + n, 0);
  const cost = Object.entries(pickerSel).reduce((s, [id, n]) => s + (caseById[id]?.price || 0) * n, 0);
  $('#picker-total').innerHTML = `${count} selected · <span class="coin">${fmt(cost)}</span>`;
}
$('#picker-search').addEventListener('input', (e) => renderPicker(e.target.value.toLowerCase()));
// closing the picker any way (X, clicking off to the side, or Done) keeps the
// selection - there's no separate "discard" action, so it should just save
function commitPicker() {
  lineup = Object.entries(pickerSel).map(([caseId, count]) => ({ caseId, count }));
  $('#picker-backdrop').classList.add('hidden');
  renderLineup();
}
$('#picker-close').onclick = commitPicker;
$('#picker-backdrop').addEventListener('click', (e) => { if (e.target.id === 'picker-backdrop') commitPicker(); });
$('#picker-clear').onclick = () => { pickerSel = {}; renderPicker($('#picker-search').value.toLowerCase()); };
$('#picker-done').onclick = commitPicker;
$('#lineup-add-btn').onclick = openPicker;

$('#battle-create-go').onclick = async () => {
  if (!lineup.length) return toast('add at least one case');
  try {
    const d = await api('battles/create', { lineup, mode: battleMode, size: battleSize });
    SND.pop();
    lineup = [];
    enterRoom(d.id, d.battle);
  } catch (e) { toast(e.message); }
};

async function refreshBattles() {
  if ($('[data-page="cases"]').classList.contains('hidden')) return;
  try {
    const { battles } = await api('battles');
    const list = $('#battle-list');
    $('#battles-empty').classList.toggle('hidden', battles.length > 0);
    list.innerHTML = '';
    battles.forEach((b) => list.appendChild(battleRow(b)));
  } catch {}
  refreshHistory();
}
setInterval(refreshBattles, 2000);

// ---- previous (finished) battles ----
function historyRow(b) {
  const r = b.result;
  const per = b.size === '2v2' ? 2 : 1;
  const row = document.createElement('div');
  row.className = 'history-row';
  row.title = `Battle #${b.id} — click to watch the replay`;
  const casesCount = b.lineup.reduce((s, l) => s + l.count, 0);
  const meta = document.createElement('div');
  meta.className = 'hr-meta';
  meta.innerHTML = `<span class="hr-mode">${r.mode}</span><span class="hr-size">${b.size}</span>
    <span class="hr-cases">${casesCount}📦</span><span class="hr-pot coin">${fmt(r.pot)}</span>`;
  row.appendChild(meta);

  const players = document.createElement('div');
  players.className = 'hr-players';
  b.players.forEach((p, i) => {
    if (i > 0 && i % per === 0) {
      const vs = document.createElement('span'); vs.className = 'hr-vs'; vs.textContent = 'vs';
      players.appendChild(vs);
    }
    const won = r.winnerSeats.includes(i);
    const cell = document.createElement('div');
    cell.className = 'hr-player ' + (won ? 'won' : 'lost');
    const skin = avatarSkin(p, (p.name || '?') + ':' + i);
    cell.innerHTML = `<div class="hr-pfp"><img src="https://minotar.net/helm/${skin}/40.png" alt="${p.name} avatar" loading="lazy">${won ? '<span class="hr-crown">🏆</span>' : ''}</div>
      <span class="hr-name">${p.name}</span>
      <span class="hr-amt">${won ? '+' + fmt(r.share) : fmt(r.totals[i])}</span>`;
    players.appendChild(cell);
  });
  row.appendChild(players);
  row.onclick = () => { SND.click(); enterRoom(b.id, b); };
  return row;
}

async function refreshHistory() {
  const wrap = $('#history-list');
  if (!wrap) return;
  try {
    const { battles } = await api('battles/history');
    $('#history-head').classList.toggle('hidden', battles.length === 0);
    wrap.innerHTML = '';
    battles.forEach((b) => wrap.appendChild(historyRow(b)));
  } catch {}
}

function seatEls(b) {
  const frag = document.createDocumentFragment();
  const per = b.size === '2v2' ? 2 : 1;
  for (let i = 0; i < b.seats; i++) {
    if (i > 0 && i % per === 0) {
      const vs = document.createElement('span'); vs.className = 'b-vs'; vs.textContent = 'VS';
      frag.appendChild(vs);
    }
    const seat = document.createElement('span');
    const p = b.players[i];
    seat.className = 'b-seat' + (p ? ' filled' + (p.bot ? ' bot' : '') : '');
    seat.innerHTML = p ? `<img src="https://minotar.net/helm/${avatarSkin(p, p.name + ':' + i)}/32.png" alt="${p.name} avatar" loading="lazy">` : '·';
    seat.title = p ? p.name : 'open seat';
    frag.appendChild(seat);
  }
  return frag;
}

function battleRow(b) {
  const row = document.createElement('div');
  row.className = 'battle-row';
  const count = b.lineup.reduce((s, l) => s + l.count, 0);
  row.innerHTML = `<span class="b-count">${count}</span><span class="b-cost coin">${fmt(b.cost)}</span>`;
  const cases = document.createElement('span');
  cases.className = 'b-cases';
  b.lineup.forEach((l) => {
    const c = document.createElement('span');
    c.className = 'b-case clickable';
    c.innerHTML = `<img src="/img/items/${l.cover}.png" alt="${l.name}">` + (l.count > 1 ? `<i>x${l.count}</i>` : '');
    c.title = `${l.name} — click to see drops`;
    c.onclick = (e) => { e.stopPropagation(); showCasePeek(l.caseId); };
    cases.appendChild(c);
  });
  row.appendChild(cases);
  const mode = document.createElement('span');
  mode.className = 'b-mode'; mode.textContent = b.mode;
  row.appendChild(mode);
  const players = document.createElement('span');
  players.className = 'b-players';
  players.appendChild(seatEls(b));
  row.appendChild(players);
  const isMine = (b.youSeat ?? -1) >= 0;
  const actions = document.createElement('span');
  actions.className = 'b-actions';
  const peek = document.createElement('button');
  peek.className = 'btn btn-ghost btn-small b-peek'; peek.title = 'Spectate this battle';
  peek.innerHTML = `<img src="/img/icons/eye.png" alt="Preview drops">`;
  peek.onclick = (e) => { e.stopPropagation(); SND.click(); enterRoom(b.id); };
  actions.appendChild(peek);
  const btn = document.createElement('button');
  btn.className = 'btn ' + (isMine ? 'btn-ghost' : 'btn-green');
  btn.textContent = isMine ? 'View' : `Join for ${fmt(b.cost)}`;
  btn.onclick = async () => {
    if (isMine) return enterRoom(b.id);
    try {
      const d = await api('battles/join', { id: b.id });
      SND.pop();
      enterRoom(b.id, d.battle);
    } catch (e) { toast(e.message); }
  };
  actions.appendChild(btn);
  row.appendChild(actions);
  return row;
}

function enterRoom(id, battle) {
  watchingId = id;
  animatedDone = false;
  lastArenaFp = null;
  showCasesView('room');
  $('#room-msg').textContent = '';
  if (battle) renderRoom(battle);
  const poll = async () => {
    if (watchingId !== id) return;
    try { renderRoom((await api('battles/' + id)).battle); } catch {}
  };
  if (!battle || battle.status !== 'done') poll();
  clearInterval(roomPoll);
  // fast enough that every spectator learns "done" within a few hundred ms of
  // each other, not a second - see animateBattle()'s resolvedAt skew-catchup too
  roomPoll = setInterval(poll, 350);
}

function renderRoom(b) {
  $('#room-title').textContent = `Battle #${b.id} · ${fmt(b.cost)} entry`;
  $('#room-mode').textContent = b.mode + ' · ' + b.size;
  const isCreator = !!b.youAreCreator;
  const botsBtn = $('#room-bots');
  botsBtn.classList.toggle('hidden', !(b.status === 'open' && isCreator));
  botsBtn.disabled = false;
  botsBtn.onclick = async () => {
    if (botsBtn.disabled) return; // guard against double-clicks firing duplicate requests
    botsBtn.disabled = true;
    try { renderRoom((await api('battles/bots', { id: b.id })).battle); }
    catch (e) {
      // another click (or the poller) already resolved this battle - not a real error
      if (!/already started/i.test(e.message)) toast(e.message);
      botsBtn.disabled = false;
    }
  };

  if (b.status === 'open') {
    // only rebuild the seat DOM when it actually changed - rebuilding on every
    // 350ms poll tick (even when nobody joined) can yank a button out from under
    // an in-progress click, which is why "Add Bot" used to need several tries
    const fp = b.status + '|' + b.players.map(p => p.name + (p.bot ? '1' : '0')).join(',');
    if (fp !== lastArenaFp) { lastArenaFp = fp; buildBattleArena(b, false); }
    $('#room-msg').textContent = `Waiting for players (${b.players.length}/${b.seats})...`;
    $('#room-msg').className = 'stage-msg';
    return;
  }

  if (b.status === 'done' && b.result && !animatedDone) {
    animatedDone = true;
    clearInterval(roomPoll); roomPoll = null;
    animateBattle(b);
  }
}

// drop a single bot into the next open seat, then re-render the room
let addBotInFlight = false;
async function addBotToBattle(id) {
  if (addBotInFlight) return; // guard against double-clicks firing duplicate requests
  addBotInFlight = true;
  try {
    SND.click();
    renderRoom((await api('battles/addbot', { id })).battle);
  } catch (e) {
    // another click (or the poller) already changed this seat - not a real error
    if (!/already started|battle is full/i.test(e.message)) toast(e.message);
  } finally { addBotInFlight = false; }
}

// popover showing a case's full drop table (item, value, chance %)
function showCasePeek(caseId) {
  const c = caseById[caseId];
  if (!c) return;
  SND.click();
  let back = $('#case-peek');
  if (!back) {
    back = document.createElement('div');
    back.id = 'case-peek';
    back.className = 'modal-backdrop hidden';
    back.innerHTML = `<div class="modal lux case-peek-modal">
      <div class="picker-head"><h3 id="case-peek-name"></h3>
        <button class="btn btn-ghost btn-tiny" id="case-peek-close">✕</button></div>
      <p class="hint" id="case-peek-sub"></p>
      <div class="loot-grid" id="case-peek-grid"></div></div>`;
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.id === 'case-peek-close') back.classList.add('hidden'); });
  }
  $('#case-peek-name').textContent = c.name;
  $('#case-peek-sub').textContent = `${c.risk} risk · ${fmt(c.price)} · ${c.items.length} drops`;
  $('#case-peek-grid').innerHTML = c.items.slice().sort((a, b) => b.value - a.value)
    .map((i) => lootCard(i, fmt(i.value))).join('');
  back.classList.remove('hidden');
}

// ---- battle arena rendering (case strip + player columns + spinners + inventory) ----
const RCOLOR = {
  junk: ['#8b93a7', '#8b93a7'], common: ['#c3ccdd', '#9fb0cc'], uncommon: ['#4ade80', '#22c55e'],
  rare: ['#4f8cff', '#2f6bff'], epic: ['#b06eff', '#a855f7'], legendary: ['#ffb020', '#ff8a00'], hero: ['#ffe259', '#ffc21a'],
};
// bots aren't real Minecraft accounts, so they get a randomized placeholder
// skin (deterministic per seat so it doesn't flicker across the 2.5s room polls).
// Real players always render their own actual skin via their username.
const AV_SKINS = ['y5ak', 'y67ak'];
function skinFor(key) {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AV_SKINS[h % AV_SKINS.length];
}
function avatarSkin(p, seatKey) {
  return p.bot ? skinFor(seatKey) : p.name;
}
function playerAvatarHTML(p, seat = 0) {
  if (!p) return `<div class="bt-avatar empty">·</div>`;
  const skin = avatarSkin(p, (p.name || '?') + ':' + seat);
  return `<div class="bt-avatar${p.bot ? ' bot' : ''}"><img src="https://minotar.net/helm/${skin}/48.png" alt="${p.name} avatar" loading="lazy"></div>`;
}
function weightedPick(items) {
  let r = Math.random() * items.reduce((s, i) => s + i.chance, 0);
  for (const i of items) { r -= i.chance; if (r <= 0) return i; }
  return items[items.length - 1];
}
function btSpinCell(it) {
  const d = document.createElement('div');
  d.className = 'bt-cell r-' + it.rarity;
  d.innerHTML = `${itemIcon(it)}<span class="bt-cell-v">${fmt(it.value)}</span>`;
  return d;
}
function btInvItem(it) {
  const d = document.createElement('div');
  d.className = 'bt-invitem r-' + it.rarity;
  d.innerHTML = `<span class="bt-chance">${it.chance}%</span>${itemIcon(it)}<b>${it.name}</b><span class="bt-iv">${fmt(it.value)}</span>`;
  return d;
}

// build the whole arena; returns handles for the animation to drive
function buildBattleArena(b, playing) {
  const board = $('#room-board');
  const rounds = playing && b.result ? b.result.rounds
    : b.lineup.flatMap((l) => Array(l.count).fill({ caseId: l.caseId }));
  const per = b.size === '2v2' ? 2 : 1;
  const arena = document.createElement('div');
  arena.className = 'bt-arena';

  // top case strip
  const strip = document.createElement('div');
  strip.className = 'bt-strip';
  rounds.forEach((rd) => {
    const c = caseById[rd.caseId];
    const el = document.createElement('div');
    el.className = 'bt-scase clickable';
    el.title = c ? `${c.name} — click to see drops` : '';
    el.innerHTML = `<img src="/img/items/${c ? c.cover : ''}.png" alt="${c ? c.name : 'case'}">`;
    el.onclick = () => showCasePeek(rd.caseId);
    strip.appendChild(el);
  });
  const counter = document.createElement('div');
  counter.className = 'bt-counter';
  counter.textContent = `0/${rounds.length}`;
  strip.appendChild(counter);
  arena.appendChild(strip);

  // player columns
  const cols = document.createElement('div');
  cols.className = 'bt-cols';
  const teamed = per > 1;                 // 2v2 -> allies share a team
  if (teamed) cols.classList.add('has-teams');
  const TEAM_C = ['#6fbf3f', '#e05b4b', '#f3c94b', '#55e0cf'];
  const seats = playing ? b.players.length : b.seats;
  const isCreator = !!b.youAreCreator;
  const isSpectator = (b.youSeat ?? -1) < 0;
  const handles = { reels: [], vals: [], invs: [], wons: [], colEls: [], counter, strip };
  for (let i = 0; i < seats; i++) {
    const team = Math.floor(i / per);
    if (i > 0 && i % per === 0) {
      const vs = document.createElement('div'); vs.className = 'bt-vs'; vs.textContent = 'VS';
      cols.appendChild(vs);
    }
    const p = b.players[i];
    const emptySeat = !playing && !p;
    const col = document.createElement('div');
    col.className = 'bt-col' + (teamed ? ' teamed' : '') + (emptySeat ? ' open' : '');
    if (teamed) col.style.setProperty('--team-c', TEAM_C[team % TEAM_C.length]);
    // waiting on an empty seat: creator can drop in a bot, a spectator can join it,
    // everyone else (already in the battle) just waits
    const body = emptySeat
      ? `<div class="bt-openseat">${isCreator
          ? `<button class="btn btn-gold btn-small bt-addbot">+ Add Bot</button>`
          : isSpectator
            ? `<button class="btn btn-green bt-joinseat">Join<br>for ${fmt(b.cost)}</button>`
            : `<span class="bt-waiting">waiting for player…</span>`}</div>`
      : `<div class="bt-spin"><div class="bt-reel"></div><div class="bt-line"></div></div>
         <div class="bt-inv"></div>`;
    col.innerHTML = `
      <div class="bt-phead">${playerAvatarHTML(p, i)}
        <div class="bt-pinfo"><span class="bt-pname">${p ? p.name : 'Open seat'}</span>
          <span class="bt-pval">${fmt(0)}</span>
          <span class="bt-won"></span></div>
        ${teamed ? `<span class="bt-team-tag">TEAM ${String.fromCharCode(65 + team)}</span>` : ''}</div>
      ${body}`;
    const addBtn = col.querySelector('.bt-addbot');
    if (addBtn) addBtn.onclick = () => addBotToBattle(b.id);
    const joinBtn = col.querySelector('.bt-joinseat');
    if (joinBtn) joinBtn.onclick = async () => {
      try {
        const d = await api('battles/join', { id: b.id });
        SND.pop();
        renderRoom(d.battle);
      } catch (e) { toast(e.message); }
    };
    cols.appendChild(col);
    handles.colEls.push(col);
    handles.reels.push(col.querySelector('.bt-reel'));
    handles.vals.push(col.querySelector('.bt-pval'));
    handles.wons.push(col.querySelector('.bt-won'));
    handles.invs.push(col.querySelector('.bt-inv'));
  }
  arena.appendChild(cols);
  board.innerHTML = '';
  board.appendChild(arena);
  return handles;
}

// drives a tick callback off the reel's REAL animated position each frame (reading
// the live transform matrix) instead of a guessed time schedule, so the sound/tick
// can never drift out of sync with what's actually sliding past the needle line.
function driveReelTicks(reel, pitch, axis, durationMs, tickFn) {
  const start = performance.now();
  let lastIdx = null;
  function frame(now) {
    const m = new DOMMatrixReadOnly(getComputedStyle(reel).transform);
    const pos = axis === 'x' ? -m.m41 : -m.m42;
    const idx = Math.round(pos / pitch);
    if (idx !== lastIdx) { lastIdx = idx; tickFn(); }
    if (now - start < durationMs) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// vertical spinner: fill a reel with weighted filler + the real drop, slide to it
function btSpin(reel, pool, winItem, dur) {
  return new Promise((resolve) => {
    const SLOTS = 44, WIN = 38;
    reel.style.transition = 'none';
    reel.style.transform = 'translateY(0)';
    reel.innerHTML = '';
    for (let s = 0; s < SLOTS; s++) reel.appendChild(btSpinCell(s === WIN ? winItem : weightedPick(pool)));
    const winCell = reel.children[WIN];
    const viewport = reel.parentElement.clientHeight;
    // land dead-center under the needle line - no jitter, so the line always
    // ends up exactly on the winning item
    const target = winCell.offsetTop + winCell.offsetHeight / 2 - viewport / 2;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      reel.style.transition = `transform ${dur}ms cubic-bezier(.45,.05,.15,1)`;
      reel.style.transform = `translateY(${-target}px)`;
    }));
    const pitch = reel.children[1].offsetTop - reel.children[0].offsetTop;
    driveReelTicks(reel, pitch, 'y', dur, () => SND.tick());
    // once it settles dead-center, pop the winning item so it's unmistakable what you pulled
    setTimeout(() => { winCell.classList.add('bt-win-pop'); resolve(); }, dur);
  });
}

function jpCellEl(p, seat, pct) {
  const d = document.createElement('div');
  d.className = 'jp-cell';
  d.innerHTML = `${playerAvatarHTML(p, seat)}<b>${p.name}</b><span class="jp-pct">${pct.toFixed(1)}%</span>`;
  return d;
}
// weighted wheel of every player's head - the winner is already decided
// server-side (winnerSeat); this just spins the real drop into view, same
// "no jitter, dead-center landing" rules as the case reels.
function jackpotSpin(players, totals, winnerSeat, dur) {
  return new Promise((resolve) => {
    const wrap = $('#jp-wrap'), reel = $('#jp-reel');
    wrap.classList.remove('hidden');
    reel.style.transition = 'none';
    reel.style.transform = 'translateX(0)';
    reel.innerHTML = '';
    const pot = totals.reduce((s, t) => s + t, 0) || 1;
    const weights = players.map((p, i) => Math.max(totals[i], pot * 0.001));
    const totalW = weights.reduce((s, w) => s + w, 0);
    const pick = () => {
      let x = Math.random() * totalW;
      for (let i = 0; i < players.length; i++) { x -= weights[i]; if (x <= 0) return i; }
      return 0;
    };
    const SLOTS = 36, WIN_SLOT = 30, W = 128;
    for (let s = 0; s < SLOTS; s++) {
      const seat = s === WIN_SLOT ? winnerSeat : pick();
      reel.appendChild(jpCellEl(players[seat], seat, totals[seat] / pot * 100));
    }
    const windowW = reel.parentElement.clientWidth;
    const target = WIN_SLOT * W + W / 2 - windowW / 2;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      reel.style.transition = `transform ${dur}ms cubic-bezier(.45,.05,.15,1)`;
      reel.style.transform = `translateX(${-target}px)`;
    }));
    driveReelTicks(reel, W, 'x', dur, () => SND.tick());
    setTimeout(() => { reel.children[WIN_SLOT].classList.add('bt-win-pop'); resolve(); }, dur);
  });
}

async function animateBattle(b) {
  const r = b.result;
  // if this client only found out the battle resolved a while after it actually
  // did (slow poll tick, tab was backgrounded, etc), skip the fixed intro delay
  // so it doesn't fall even further out of sync with everyone else watching
  const skewMs = Date.now() - (r.resolvedAt || Date.now());
  $('#room-msg').textContent = 'Grabbing EOS Block...';
  $('#room-msg').className = 'stage-msg';
  if (battleSpeed !== 'instant' && skewMs < 400) await sleep(550);
  const h = buildBattleArena(b, true);
  const roundsN = r.rounds.length;
  $('#room-msg').textContent = `Mode: ${r.mode}. Opening…`;
  $('#room-msg').className = 'stage-msg';
  $('#jp-wrap').classList.add('hidden'); // reset from any previous jackpot reveal

  const scases = h.strip.querySelectorAll('.bt-scase');
  const spinDur = battleSpeed === 'instant' ? 0 : battleSpeed === 'quick' ? 1500 : 2700;
  const running = b.players.map(() => 0);

  for (let round = 0; round < roundsN; round++) {
    scases.forEach((e, i) => e.classList.toggle('active', i === round));
    h.counter.textContent = `${round + 1}/${roundsN}`;
    const c = caseById[r.rounds[round].caseId];
    const pool = c && c.items && c.items.length ? c.items : null;

    await Promise.all(b.players.map((p, pi) => {
      const it = r.pulls[pi][round];
      if (spinDur === 0) {
        h.reels[pi].style.transition = 'none';
        h.reels[pi].style.transform = 'translateY(0)';
        h.reels[pi].innerHTML = '';
        const cell = btSpinCell(it);
        h.reels[pi].appendChild(cell);
        // center the single cell
        const vp = h.reels[pi].parentElement.clientHeight;
        h.reels[pi].style.transform = `translateY(${-(cell.offsetHeight / 2 - vp / 2)}px)`;
        return Promise.resolve();
      }
      return btSpin(h.reels[pi], pool || [it], it, spinDur);
    }));

    let topTier = 0;
    b.players.forEach((p, pi) => {
      const it = r.pulls[pi][round];
      topTier = Math.max(topTier, rarityOf(it.rarity).tier);
      const inv = btInvItem(it);
      h.invs[pi].appendChild(inv);
      requestAnimationFrame(() => inv.classList.add('in'));
      running[pi] += it.value;
      countUp(h.vals[pi], running[pi], 450);
    });
    if (topTier >= 5) SND.impact(0.6); else SND.reveal(Math.min(topTier, 4));
    // brief pause on the landed item before the next case spins up - long enough to
    // actually read what you pulled, short enough not to drag out a multi-round battle
    await sleep(battleSpeed === 'instant' ? 150 : 800);
  }

  // winner columns are identified by SEAT (names aren't unique — all bots are "bots")
  const winnerSeats = r.winnerSeats || b.players.map((p, i) => (r.winners.includes(p.name) ? i : -1)).filter((i) => i >= 0);

  // jackpot: the pot goes to one seat/team picked with odds proportional to what
  // each side pulled - spin the wheel so that's visible before revealing the winner
  if (r.mode === 'jackpot' && battleSpeed !== 'instant') {
    $('#room-msg').textContent = 'Spinning the jackpot…';
    await jackpotSpin(b.players, r.totals, winnerSeats[0], 4200);
  }

  scases.forEach((e) => e.classList.remove('active'));
  b.players.forEach((p, i) => {
    h.vals[i].textContent = fmt(r.totals[i]);
    // glow each column by its best pull's rarity
    const best = r.pulls[i].reduce((a, it) => (it.value > a.value ? it : a), r.pulls[i][0]);
    const [rc, rg] = RCOLOR[best.rarity] || RCOLOR.common;
    h.colEls[i].style.setProperty('--rc', rc);
    h.colEls[i].style.setProperty('--rg', rg);
    // show how much this player won (their share of the pot, or nothing)
    const won = winnerSeats.includes(i);
    if (h.wons[i]) {
      h.wons[i].textContent = won ? `WON +${fmt(r.share)}` : 'no win';
      h.wons[i].className = 'bt-won ' + (won ? 'win' : 'loss');
    }
    if (won) h.colEls[i].classList.add('winner');
  });
  const mySeat = b.youSeat ?? -1;
  const inIt = mySeat >= 0;
  const iWon = inIt && winnerSeats.includes(mySeat);
  if (inIt) { if (iWon) SND.win(); else SND.boom(); loadMe(); }
  const winNames = [...new Set(r.winners)];
  $('#room-msg').textContent = `${winNames.join(' & ')} take${r.winners.length > 1 ? '' : 's'} the pot: ${fmt(r.pot)} (${fmt(r.share)} each)`;
  $('#room-msg').className = 'stage-msg ' + (inIt ? (iWon ? 'good' : 'bad') : '');
}

// ================= DAILY CASE =================
let dailyItems = null, dailyReadyAt = 0, dailySpinning = false;

function dailyStatus() {
  const el = $('#daily-status');
  if (!el) return;
  const left = dailyReadyAt - Date.now();
  if (left <= 0) { el.textContent = 'READY'; return; }
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  el.textContent = `${h}h ${m}m`;
}
setInterval(dailyStatus, 30000);

async function loadDaily() {
  try {
    const d = await api('daily');
    dailyItems = d.items;
    dailyReadyAt = d.readyAt;
    dailyStatus();
    $('#daily-loot').innerHTML = dailyItems.map((i) => lootCard(i, '+' + fmt(i.amount))).join('');
    const reel = $('#daily-reel');
    reel.innerHTML = '';
    dailyItems.forEach((i) => reel.appendChild(reelItemEl(i)));
  } catch {}
}

$('#daily-open').onclick = async () => {
  if (dailySpinning || !dailyItems) return;
  const btn = $('#daily-open'), msg = $('#daily-msg');
  try {
    const d = await api('daily/open', {});
    dailySpinning = true; btn.disabled = true;
    dailyReadyAt = d.readyAt; dailyStatus();
    msg.textContent = 'Opening...'; msg.className = 'stage-msg';
    spinReel(dailyItems, d.itemIndex, '#daily-reel');
    setTimeout(() => {
      setBalance(d.balance);
      if (onDailyPage()) SND.win();
      msg.textContent = `${d.item.name}! +${fmt(d.amount)} coins. See you tomorrow.`;
      msg.className = 'stage-msg good';
      dailySpinning = false; btn.disabled = false;
    }, 4400);
  } catch (e) {
    toast(e.message);
    if (e.message.includes('not ready')) loadDaily();
  }
};

// ================= DICE =================
const diceState = { dir: 'under' };
function diceRecalc() {
  const t = Number($('#dice-target').value);
  const chance = diceState.dir === 'under' ? t : 100 - t;
  $('#dice-target-label').textContent = t.toFixed(2);
  $('#dice-dir-label').textContent = diceState.dir;
  $('#dice-chance').textContent = chance + '%';
  $('#dice-mult').textContent = (Math.floor((99 / chance) * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '×';
  const fill = $('#dice-fill');
  if (diceState.dir === 'under') { fill.style.left = '0'; fill.style.width = t + '%'; }
  else { fill.style.left = t + '%'; fill.style.width = (100 - t) + '%'; }
}
$('#dice-target').addEventListener('input', diceRecalc);
$('#dice-flip-dir').onclick = () => {
  diceState.dir = diceState.dir === 'under' ? 'over' : 'under';
  $('#dice-flip-dir').textContent = '↕ switch to ' + (diceState.dir === 'under' ? 'over' : 'under');
  diceRecalc();
};
$('#dice-roll').onclick = async () => {
  const btn = $('#dice-roll'); btn.disabled = true;
  try {
    const d = await api('dice', { amount: amt('dice-amount'), target: Number($('#dice-target').value), dir: diceState.dir });
    $('#dice-marker').style.left = d.roll + '%';
    $('#dice-result').textContent = d.roll.toFixed(2);
    setTimeout(() => {
      setBalance(d.balance);
      if (d.won) SND.coin(); else SND.pop();
      const msg = $('#dice-msg');
      msg.textContent = d.won ? `Rolled ${d.roll.toFixed(2)} — you win ${fmt(d.payout)}!` : `Rolled ${d.roll.toFixed(2)} — no dice.`;
      msg.className = 'stage-msg ' + (d.won ? 'good' : 'bad');
    }, 750);
  } catch (e) { toast(e.message); }
  setTimeout(() => { btn.disabled = false; }, 800);
};

// ================= COINFLIP =================
let cfSide = 'frosted', cfSpins = 0;
$$('.side-pick .side-btn[data-side]').forEach((b) => b.onclick = () => {
  cfSide = b.dataset.side;
  SND.click();
  $$('.side-btn[data-side]').forEach((x) => x.classList.toggle('active', x === b));
});
$('#cf-flip').onclick = async () => {
  const btn = $('#cf-flip'); btn.disabled = true;
  try {
    const d = await api('coinflip', { amount: amt('cf-amount'), side: cfSide });
    cfSpins += 5;
    const end = cfSpins * 360 + (d.landed === 'glazed' ? 180 : 0);
    $('#coin').style.transform = `rotateY(${end}deg)`;
    setTimeout(() => {
      setBalance(d.balance);
      if (d.won) SND.coin(); else SND.pop();
      const msg = $('#cf-msg');
      const label = d.landed === 'frosted' ? 'Emerald' : 'Gold';
      msg.textContent = d.won
        ? `${label}! That's ${fmt(d.payout)} coins to you.`
        : `Landed ${label.toLowerCase()}. Better luck next flip.`;
      msg.className = 'stage-msg ' + (d.won ? 'good' : 'bad');
      btn.disabled = false;
    }, 1650);
  } catch (e) { toast(e.message); btn.disabled = false; }
};

// ================= MINES =================
const minesEl = { grid: $('#mines-grid'), msg: $('#mines-msg'), start: $('#mines-start'), cash: $('#mines-cashout') };
let minesActive = false;
const DIAMOND_IMG = '<img src="/img/items/diamond.png" alt="Diamond">';
const TNT_IMG = '<img src="/img/items/tnt.png" alt="TNT">';

function buildMinesGrid(revealed = []) {
  minesEl.grid.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const b = document.createElement('button');
    b.className = 'mine-tile'; b.innerHTML = DIAMOND_IMG; b.dataset.tile = i;
    if (revealed.includes(i)) { b.classList.add('safe'); b.disabled = true; }
    b.onclick = () => minesReveal(i, b);
    minesEl.grid.appendChild(b);
  }
}
function minesUI() {
  minesEl.start.classList.toggle('hidden', minesActive);
  minesEl.cash.classList.toggle('hidden', !minesActive);
  $('#mines-amount').disabled = minesActive;
  $('#mines-count').disabled = minesActive;
}
function minesShowMines(mines, hitTile) {
  $$('#mines-grid .mine-tile').forEach((t) => {
    const i = Number(t.dataset.tile);
    t.disabled = true;
    if (mines.includes(i)) { t.innerHTML = TNT_IMG; t.classList.add(i === hitTile ? 'boom' : 'shown-mine'); }
  });
}
$('#mines-count').addEventListener('input', () => { $('#mines-count-label').textContent = $('#mines-count').value; });

minesEl.start.onclick = async () => {
  try {
    const d = await api('mines/start', { amount: amt('mines-amount'), mines: Number($('#mines-count').value) });
    minesActive = true; minesUI(); buildMinesGrid();
    setBalance(d.balance);
    SND.click();
    $('#mines-current').textContent = '1.00×';
    $('#mines-next').textContent = d.nextMult.toFixed(2) + '×';
    minesEl.msg.textContent = 'Game on. Pick a tile.'; minesEl.msg.className = 'stage-msg';
  } catch (e) { toast(e.message); }
};

async function minesReveal(tile, btn) {
  if (!minesActive) return;
  try {
    const d = await api('mines/reveal', { tile });
    if (d.boom) {
      minesActive = false; minesUI();
      minesShowMines(d.mines, tile);
      setBalance(d.balance);
      SND.boom();
      minesEl.msg.textContent = '💥 Boom. Bet gone.'; minesEl.msg.className = 'stage-msg bad';
      $('#mines-current').textContent = '—'; $('#mines-next').textContent = '—';
      return;
    }
    btn.classList.add('safe'); btn.disabled = true;
    SND.pop();
    if (d.cleared) {
      minesActive = false; minesUI();
      minesShowMines(d.mines, -1);
      setBalance(d.balance);
      SND.win();
      minesEl.msg.textContent = `Full clear! ${d.mult.toFixed(2)}× pays ${fmt(d.payout)}.`;
      minesEl.msg.className = 'stage-msg good';
      return;
    }
    $('#mines-current').textContent = d.mult.toFixed(2) + '×';
    $('#mines-next').textContent = d.nextMult.toFixed(2) + '×';
  } catch (e) { toast(e.message); }
}

minesEl.cash.onclick = async () => {
  try {
    const d = await api('mines/cashout', {});
    minesActive = false; minesUI();
    minesShowMines(d.mines, -1);
    setBalance(d.balance);
    SND.win();
    minesEl.msg.textContent = `Cashed out at ${d.mult.toFixed(2)}× for ${fmt(d.payout)} coins.`;
    minesEl.msg.className = 'stage-msg good';
    $('#mines-current').textContent = '—'; $('#mines-next').textContent = '—';
  } catch (e) { toast(e.message); }
};

// ================= TOWERS =================
const towEl = { tower: $('#tower'), msg: $('#towers-msg'), start: $('#towers-start'), cash: $('#towers-cashout') };
let towActive = false, towDiff = 'easy', towRow = 0;
const TOW_MULT = { easy: 1.485, hard: 2.97 };
const LADDER_IMG = '<img src="/img/items/ladder.png" alt="Ladder">';
const FIREBALL_IMG = '<img src="/img/items/fire_charge.png" alt="Fireball">';

$$('.side-btn[data-diff]').forEach((b) => b.onclick = () => {
  if (towActive) return;
  towDiff = b.dataset.diff;
  SND.click();
  $$('.side-btn[data-diff]').forEach((x) => x.classList.toggle('active', x === b));
});

function buildTower(row = 0) {
  towEl.tower.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    const div = document.createElement('div');
    div.className = 'tower-row' + (r === row ? ' current' : r < row ? ' done' : '');
    div.dataset.row = r;
    for (let c = 0; c < 3; c++) {
      const b = document.createElement('button');
      b.className = 'tower-tile'; b.innerHTML = LADDER_IMG; b.dataset.col = c;
      b.disabled = r !== row || !towActive;
      b.onclick = () => towersPick(r, c, b);
      div.appendChild(b);
    }
    const m = document.createElement('span');
    m.className = 'tower-mult';
    m.textContent = (Math.floor(Math.pow(TOW_MULT[towDiff], r + 1) * 100) / 100).toFixed(2) + '×';
    div.appendChild(m);
    towEl.tower.appendChild(div);
  }
}
function towUI() {
  towEl.start.classList.toggle('hidden', towActive);
  towEl.cash.classList.toggle('hidden', !towActive);
  $('#towers-amount').disabled = towActive;
}
function towSetRow(row) {
  towRow = row;
  $$('#tower .tower-row').forEach((div) => {
    const r = Number(div.dataset.row);
    div.className = 'tower-row' + (r === row ? ' current' : r < row ? ' done' : '');
    div.querySelectorAll('.tower-tile').forEach((t) => { if (!t.classList.contains('safe')) t.disabled = r !== row || !towActive; });
  });
}
function towShowBombs(bombs, hitRow, hitCol) {
  $$('#tower .tower-row').forEach((div) => {
    const r = Number(div.dataset.row);
    div.querySelectorAll('.tower-tile').forEach((t) => {
      t.disabled = true;
      const c = Number(t.dataset.col);
      if (bombs[r] && bombs[r].includes(c)) {
        t.innerHTML = FIREBALL_IMG;
        t.classList.add(r === hitRow && c === hitCol ? 'boom' : 'shown-bomb');
      }
    });
  });
}

towEl.start.onclick = async () => {
  try {
    const d = await api('towers/start', { amount: amt('towers-amount'), diff: towDiff });
    towActive = true; towUI(); buildTower(0); towSetRow(0);
    setBalance(d.balance);
    SND.click();
    $('#towers-current').textContent = '1.00×';
    $('#towers-next').textContent = d.nextMult.toFixed(2) + '×';
    towEl.msg.textContent = 'Floor 1 — pick a tile.'; towEl.msg.className = 'stage-msg';
  } catch (e) { toast(e.message); }
};

async function towersPick(row, col, btn) {
  if (!towActive || row !== towRow) return;
  try {
    const d = await api('towers/pick', { col });
    if (d.boom) {
      towActive = false; towUI();
      towShowBombs(d.bombs, row, col);
      setBalance(d.balance);
      SND.boom();
      towEl.msg.textContent = '💥 Wrong tile. Down you go.'; towEl.msg.className = 'stage-msg bad';
      $('#towers-current').textContent = '—'; $('#towers-next').textContent = '—';
      return;
    }
    btn.classList.add('safe');
    SND.pop();
    if (d.topped) {
      towActive = false; towUI();
      towShowBombs(d.bombs, -1, -1);
      setBalance(d.balance);
      SND.win();
      towEl.msg.textContent = `Top of the tower! ${d.mult.toFixed(2)}× pays ${fmt(d.payout)}.`;
      towEl.msg.className = 'stage-msg good';
      return;
    }
    towSetRow(d.row);
    $('#towers-current').textContent = d.mult.toFixed(2) + '×';
    $('#towers-next').textContent = d.nextMult.toFixed(2) + '×';
    towEl.msg.textContent = `Floor ${d.row + 1} — keep going or cash out.`;
  } catch (e) { toast(e.message); }
}

towEl.cash.onclick = async () => {
  try {
    const d = await api('towers/cashout', {});
    towActive = false; towUI();
    towShowBombs(d.bombs, -1, -1);
    setBalance(d.balance);
    SND.win();
    towEl.msg.textContent = `Cashed out at ${d.mult.toFixed(2)}× for ${fmt(d.payout)} coins.`;
    towEl.msg.className = 'stage-msg good';
    $('#towers-current').textContent = '—'; $('#towers-next').textContent = '—';
  } catch (e) { toast(e.message); }
};

// ================= CHICKEN =================
const CHICKEN_LANES = 10;
const CK_MULT_BASE = { easy: 0.85, medium: 0.75, hard: 0.60 };
let ckActive = false, ckDiff = 'easy', ckLane = 0;

$$('.side-btn[data-cdiff]').forEach((b) => b.onclick = () => {
  if (ckActive) return;
  ckDiff = b.dataset.cdiff;
  SND.click();
  $$('.side-btn[data-cdiff]').forEach((x) => x.classList.toggle('active', x === b));
  buildRoad(0);
});

const ckMult = (k) => Math.floor((0.99 / Math.pow(CK_MULT_BASE[ckDiff], k)) * 100) / 100;

function buildRoad(lane) {
  const road = $('#chicken-road');
  road.innerHTML = '';
  const pad = document.createElement('div');
  pad.className = 'chicken-start-pad';
  if (lane === 0) pad.innerHTML = '<img src="/img/items/chicken.png" alt="chicken">';
  road.appendChild(pad);
  for (let i = 0; i < CHICKEN_LANES; i++) {
    const l = document.createElement('div');
    l.className = 'chicken-lane' + (i < lane ? ' crossed' : '');
    l.dataset.lane = i;
    const m = ckMult(i + 1);
    l.innerHTML = `<span class="lane-mult${m >= 2 ? ' hi' : ''}">${m}×</span>`;
    if (i === lane - 1) l.innerHTML += '<img class="walker" src="/img/items/chicken.png" alt="chicken">';
    road.appendChild(l);
  }
}

function ckUI() {
  $('#chicken-start').classList.toggle('hidden', ckActive);
  $('#chicken-actions').classList.toggle('hidden', !ckActive);
  $('#chicken-amount').disabled = ckActive;
}
buildRoad(0); // show the empty tracks on first load

$('#chicken-start').onclick = async () => {
  try {
    const d = await api('chicken/start', { amount: amt('chicken-amount'), diff: ckDiff });
    ckActive = true; ckLane = 0; ckUI(); buildRoad(0);
    setBalance(d.balance);
    SND.click();
    $('#chicken-current').textContent = '1.00×';
    $('#chicken-next').textContent = d.nextMult.toFixed(2) + '×';
    $('#chicken-msg').textContent = 'Chicken is at the edge. Step when ready.';
    $('#chicken-msg').className = 'stage-msg';
  } catch (e) { toast(e.message); }
};

function ckShowDeath(deathLane) {
  const lane = $(`.chicken-lane[data-lane="${deathLane}"]`);
  if (lane && deathLane < CHICKEN_LANES) {
    lane.classList.add('fried');
    lane.innerHTML += '<img class="hazard" src="/img/items/fire_charge.png" alt="fireball">';
  }
}

$('#chicken-step').onclick = async () => {
  if (!ckActive) return;
  try {
    const d = await api('chicken/step', {});
    if (d.roasted) {
      ckActive = false; ckUI();
      buildRoad(d.lane); ckShowDeath(d.deathLane);
      setBalance(d.balance);
      SND.boom();
      $('#chicken-msg').textContent = '💥 Splat. That lane got the chicken.';
      $('#chicken-msg').className = 'stage-msg bad';
      $('#chicken-current').textContent = '—'; $('#chicken-next').textContent = '—';
      return;
    }
    ckLane = d.lane;
    buildRoad(d.lane);
    SND.pop();
    if (d.crossed) {
      ckActive = false; ckUI();
      setBalance(d.balance);
      SND.win();
      $('#chicken-msg').textContent = `Made it across! ${d.mult.toFixed(2)}× pays ${fmt(d.payout)}.`;
      $('#chicken-msg').className = 'stage-msg good';
      return;
    }
    $('#chicken-current').textContent = d.mult.toFixed(2) + '×';
    $('#chicken-next').textContent = d.nextMult.toFixed(2) + '×';
    $('#chicken-msg').textContent = `Lane ${d.lane}/${CHICKEN_LANES} crossed.`;
  } catch (e) { toast(e.message); }
};

$('#chicken-cashout').onclick = async () => {
  try {
    const d = await api('chicken/cashout', {});
    ckActive = false; ckUI();
    ckShowDeath(d.deathLane);
    setBalance(d.balance);
    SND.win();
    $('#chicken-msg').textContent = `Cashed out at ${d.mult.toFixed(2)}× for ${fmt(d.payout)} coins.`;
    $('#chicken-msg').className = 'stage-msg good';
    $('#chicken-current').textContent = '—'; $('#chicken-next').textContent = '—';
  } catch (e) { toast(e.message); }
};

// ================= BLACKJACK =================
const bjEl = { msg: $('#bj-msg'), deal: $('#bj-deal'), actions: $('#bj-actions') };
const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };

function renderCard(code) {
  const el = document.createElement('div');
  if (code === '??') { el.className = 'card facedown'; return el; }
  const suit = code.slice(-1), rank = code.slice(0, -1);
  el.className = 'card' + (suit === 'H' || suit === 'D' ? ' red' : '');
  el.innerHTML = `<span>${rank}</span><span class="suit">${SUIT_CHAR[suit]}</span>`;
  return el;
}
// Reconcile a hand's DOM against the new list of card codes so untouched cards
// stay put (no re-render flicker). Only newly dealt cards animate in, and a card
// whose code changed (dealer hole-card reveal) flips in place.
const DEAL_STEP = 340; // ms between cards — each is inserted on its own beat
// Reconcile both hands and insert any NEW/changed cards ONE AT A TIME on a shared
// clock, interleaved player→dealer (like a real deal). Untouched cards stay put.
let dealClock = 0;
function dealHands(hands) {
  // fresh-deal reset for any hand whose first card changed / shrank
  hands.forEach(([c, codes]) => {
    const prev = c._codes || [];
    if (codes.length < prev.length || (prev.length && codes[0] !== prev[0])) { c.innerHTML = ''; c._codes = []; }
  });
  // gather ops in round order (index 0 of every hand, then index 1, ...)
  const maxLen = Math.max(0, ...hands.map(([, codes]) => codes.length));
  const ops = [];
  for (let i = 0; i < maxLen; i++) {
    hands.forEach(([c, codes]) => {
      const prev = c._codes || [];
      if (i < codes.length && prev[i] !== codes[i]) ops.push({ c, code: codes[i], i });
    });
  }
  hands.forEach(([c, codes]) => { c._codes = codes.slice(); }); // commit intended state
  const token = ++dealClock; // a newer deal supersedes stragglers from this one
  ops.forEach((op, k) => setTimeout(() => {
    if (token !== dealClock) return; // a new hand started; drop this stale insert
    const card = renderCard(op.code);
    if (op.i < op.c.children.length) { card.classList.add('flip'); op.c.replaceChild(card, op.c.children[op.i]); }
    else op.c.appendChild(card);
    SND.tick();
  }, k * DEAL_STEP));
}
function renderBj(d) {
  const dc = $('#bj-dealer-cards'), pc = $('#bj-player-cards');
  dealHands([[pc, d.player], [dc, d.dealer]]); // player, dealer, player, dealer…
  $('#bj-dealer-value').textContent = d.dealerValue ?? '';
  $('#bj-player-value').textContent = d.playerValue;
  bjEl.deal.classList.toggle('hidden', !d.done);
  bjEl.actions.classList.toggle('hidden', d.done);
  $('#bj-double').disabled = !d.canDouble;
  $('#bj-amount').disabled = !d.done;
  if (d.done) {
    setBalance(d.balance);
    if (d.outcome === 'win' || d.outcome === 'blackjack') SND.win();
    else if (d.outcome === 'lose') SND.pop();
    const texts = {
      blackjack: `Blackjack! Paid ${fmt(d.payout)}.`,
      win: `You win ${fmt(d.payout)}!`,
      push: 'Push — bet returned.',
      lose: 'Dealer takes it.',
    };
    bjEl.msg.textContent = texts[d.outcome];
    bjEl.msg.className = 'stage-msg ' + (d.outcome === 'lose' ? 'bad' : d.outcome === 'push' ? '' : 'good');
  } else {
    setBalance(d.balance);
    bjEl.msg.textContent = 'Hit, stand, or double.';
    bjEl.msg.className = 'stage-msg';
  }
}
bjEl.deal.onclick = async () => {
  try { renderBj(await api('blackjack/start', { amount: amt('bj-amount') })); }
  catch (e) { toast(e.message); }
};
$('#bj-hit').onclick = async () => { try { renderBj(await api('blackjack/hit', {})); } catch (e) { toast(e.message); } };
$('#bj-stand').onclick = async () => { try { renderBj(await api('blackjack/stand', {})); } catch (e) { toast(e.message); } };
$('#bj-double').onclick = async () => { try { renderBj(await api('blackjack/double', {})); } catch (e) { toast(e.message); } };

// ================= FAIRNESS =================
async function renderFair() {
  const has = !!me;
  $('#fair-user').classList.toggle('hidden', !has);
  $('#fair-signin').classList.toggle('hidden', has);
  if (!has) return;
  $('#fair-hash').textContent = me.serverSeedHash;
  $('#fair-client').textContent = me.clientSeed;
  $('#fair-nonce').textContent = me.nonce;
}
$('#fair-rotate').onclick = async () => {
  try {
    const d = await api('seeds/rotate', { clientSeed: $('#fair-newclient').value.trim() });
    $('#fair-revealed').classList.remove('hidden');
    $('#fair-revealed-seed').textContent = d.revealedServerSeed;
    me.serverSeedHash = d.newServerSeedHash;
    me.clientSeed = d.clientSeed;
    me.nonce = 0;
    renderFair();
    toast('Seeds rotated — old seed revealed below.');
  } catch (e) { toast(e.message); }
};

// ================= CHAT =================
let chatLastId = 0;
function chatAdd(m) {
  const body = $('#chat-body');
  const el = document.createElement('div');
  el.className = 'chat-msg' + (m.mine ? ' mine' : '');
  const pfp = document.createElement('img');
  pfp.className = 'chat-pfp'; pfp.alt = ''; pfp.loading = 'lazy';
  pfp.src = `https://minotar.net/helm/${m.username === HIDDEN_NAME ? 'MHF_Question' : m.username}/24.png`;
  el.appendChild(pfp);
  const card = document.createElement('div');
  card.className = 'chat-card';
  const nameLine = document.createElement('div');
  nameLine.className = 'chat-name-line';
  const who = document.createElement('span');
  who.className = 'who'; who.textContent = m.username;
  nameLine.appendChild(who);
  if (typeof m.level === 'number') {
    const lvl = document.createElement('span');
    lvl.className = 'chat-level'; lvl.textContent = `Lvl ${m.level}`;
    nameLine.appendChild(lvl);
  }
  card.appendChild(nameLine);
  card.appendChild(document.createTextNode(m.message)); // textContent path = no HTML injection
  el.appendChild(card);
  body.appendChild(el);
}
async function refreshChat() {
  try {
    const { messages } = await api('chat?after=' + chatLastId);
    if (!messages.length) {
      if (chatLastId === 0 && !$('#chat-body').children.length) {
        $('#chat-body').innerHTML = '<p class="chat-empty">Nobody\'s said anything yet. Break the ice.</p>';
      }
      return;
    }
    const empty = $('#chat-body .chat-empty'); if (empty) empty.remove();
    const body = $('#chat-body');
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    messages.forEach(chatAdd);
    chatLastId = messages[messages.length - 1].id;
    while (body.children.length > 80) body.removeChild(body.firstChild);
    if (stick) body.scrollTop = body.scrollHeight;
  } catch {}
}
async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('chat', { message: text });
    input.value = '';
    refreshChat();
  } catch (e) { toast(e.message); }
}
$('#chat-send').onclick = sendChat;
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
setInterval(refreshChat, 3000);

// ================= FEED + LEADERBOARD =================
const GAME_ICON = {
  cases: 'barrel', battle: 'barrel', mines: 'tnt', towers: 'ladder', coinflip: 'gold_nugget',
  blackjack: 'filled_map', dice: 'rabbit_foot', chicken: 'chicken',
};
const GAME_LABEL = {
  cases: 'Cases', battle: 'Case Battle', mines: 'Mines', towers: 'Towers', coinflip: 'Coinflip',
  blackjack: 'Blackjack', dice: 'Dice', chicken: 'Chicken',
};
let lastFeedKey = '', lastFeedBets = [], feedFilter = 'all';
function feedRow(b, isNew) {
  const won = b.payout > 0;
  const mult = b.multiplier || 0;
  return `<tr class="${isNew ? 'new-row' : ''}">
    <td><span class="feed-game"><img src="/img/items/${GAME_ICON[b.game] || 'barrel'}.png" alt="${GAME_LABEL[b.game] || b.game}">${GAME_LABEL[b.game] || b.game}</span></td>
    <td><span class="feed-user"><img class="feed-avatar" src="https://minotar.net/helm/${b.username}/32.png" alt="${b.username} avatar" loading="lazy">${b.username}</span></td>
    <td><span class="feed-amt coin">${fmt(b.amount)}</span></td>
    <td><span class="feed-mult">${mult ? 'x' + mult.toFixed(2) : 'x0.00'}</span></td>
    <td><span class="feed-payout ${won ? 'good' : 'bad'} coin">${won ? '+' + fmt(b.payout) : '0'}</span></td>
    <td><span class="feed-time">${new Date(b.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></td>
  </tr>`;
}
function renderFeed() {
  const tbody = $('#feed-table tbody');
  if (!tbody) return;
  let bets = lastFeedBets;
  if (feedFilter === 'high') bets = bets.filter((b) => b.payout > 0).slice().sort((a, b) => b.payout - a.payout);
  else if (feedFilter === 'lucky') bets = bets.filter((b) => (b.multiplier || 0) >= 3).slice().sort((a, b) => b.multiplier - a.multiplier);
  tbody.innerHTML = bets.map((b, i) => feedRow(b, feedFilter === 'all' && i === 0 && lastFeedIsNew)).join('');
}
let lastFeedIsNew = false;
$$('#feed-tabs .feed-tab').forEach((btn) => btn.onclick = () => {
  feedFilter = btn.dataset.filter;
  $$('#feed-tabs .feed-tab').forEach((b) => b.classList.toggle('active', b === btn));
  renderFeed();
});
async function refreshFeed() {
  try {
    const { bets } = await api('feed');
    const key = JSON.stringify(bets[0] || {});
    lastFeedIsNew = key !== lastFeedKey && lastFeedKey !== '';
    lastFeedKey = key;
    lastFeedBets = bets;
    renderFeed();
  } catch { /* server asleep, whatever */ }
}
async function refreshBoard() {
  try {
    const { top } = await api('leaderboard');
    $('#leaderboard').innerHTML = top.map((u) => `<li>${u.username} <b>${fmt(u.wagered)}</b></li>`).join('')
      || '<li>Nobody yet — be the first degenerate.</li>';
  } catch {}
}
setInterval(refreshFeed, 5000);
setInterval(refreshBoard, 30000);

// ---- dedicated leaderboard page: top-3 podium + ranks 4-20 ----
// fixed prizes for the top 3 wagerers - nobody else on the board gets a reward
const LB_PRIZE = { 1: 500_000_000, 2: 200_000_000, 3: 100_000_000 };
function lbAvatar(name) {
  // anonymous players have no avatarName from the server - show a neutral icon instead
  return name
    ? `<img src="https://minotar.net/helm/${encodeURIComponent(name)}/64.png" alt="${name} avatar" loading="lazy">`
    : `<img src="/img/donut.svg" alt="Anonymous player" loading="lazy">`;
}
function lbPodiumCard(u, rank) {
  const place = rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd';
  return `<div class="lb-card lb-p${rank}">
    <span class="lb-place">${place} place</span>
    <div class="lb-pfp">${lbAvatar(u.avatarName)}</div>
    <b class="lb-name">${u.username}</b>
    <div class="lb-wagered"><span>Total wagered</span><b>${fmt(u.wagered)}</b></div>
    <div class="lb-prize">Prize: ${fmt(LB_PRIZE[rank])}</div>
  </div>`;
}
function lbRow(u, rank) {
  return `<li class="lb-row">
    <span class="lb-rank">${rank}</span>
    <div class="lb-row-pfp">${lbAvatar(u.avatarName)}</div>
    <span class="lb-row-name">${u.username}</span>
    <span class="lb-row-wagered">${fmt(u.wagered)}</span>
  </li>`;
}
async function renderLeaderboard() {
  const podium = $('#lb-podium'), list = $('#lb-list');
  if (!podium || !list) return;
  try {
    const { top } = await api('leaderboard/full');
    if (!top.length) {
      podium.innerHTML = '';
      list.innerHTML = '<li class="lb-empty">Nobody has wagered yet — be the first degenerate.</li>';
      return;
    }
    // podium order: 2nd, 1st, 3rd (matches the classic centered-1st layout)
    const [p1, p2, p3] = [top[0], top[1], top[2]];
    podium.innerHTML = [p2 && lbPodiumCard(p2, 2), p1 && lbPodiumCard(p1, 1), p3 && lbPodiumCard(p3, 3)]
      .filter(Boolean).join('');
    list.innerHTML = top.slice(3).map((u, i) => lbRow(u, i + 4)).join('');
  } catch {}
}

// ================= REWARDS (rakeback + level milestones) =================
const RB_LABEL = { instant: 'Instant Rakeback', daily: 'Daily Rakeback', weekly: 'Weekly Rakeback', monthly: 'Monthly Rakeback' };
function countdown(ms) {
  if (ms <= 0) return '';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return d > 0 ? `${d}d ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function rbCard(kind, info) {
  const ready = info.ready && info.amount > 0;
  const timeLeft = info.readyAt ? info.readyAt - Date.now() : 0;
  const btnLabel = !info.ready ? countdown(timeLeft) : 'Claim';
  return `<div class="rw-rb-card">
    <span class="rw-rb-title">${RB_LABEL[kind]}</span>
    <span class="rw-rb-amt"><img src="/img/donut.svg" alt="Donuts">${fmt(info.amount)}</span>
    <button class="rw-rb-btn" data-rbkind="${kind}" ${ready ? '' : 'disabled'}>${btnLabel}</button>
  </div>`;
}
function milestoneRow(m) {
  const cls = 'rw-milestone' + (m.unlocked ? ' unlocked' : '') + (m.claimed ? ' claimed' : '');
  const claimBtn = m.unlocked && !m.claimed ? `<button class="rw-milestone-claim" data-mlevel="${m.level}">Claim</button>` : '';
  return `<div class="${cls}">
    <span class="rw-milestone-level">Level ${m.level}</span>
    <div class="rw-milestone-right">
      <span class="rw-milestone-amt"><img src="/img/donut.svg" alt="Donuts">${fmt(m.reward)}</span>
      ${claimBtn}
    </div>
  </div>`;
}
async function renderRewards() {
  const page = $('[data-page="rewards"]');
  if (!page || page.classList.contains('hidden')) return;
  $('#rewards-signin').classList.toggle('hidden', !!me);
  $('.rw-tabs').classList.toggle('hidden', !me);
  if (!me) { $('#rw-panel-rakeback').classList.add('hidden'); $('#rw-panel-levels').classList.add('hidden'); return; }
  const activeTab = $('.rw-tab.active')?.dataset.rwtab || 'rakeback';
  $('#rw-panel-rakeback').classList.toggle('hidden', activeTab !== 'rakeback');
  $('#rw-panel-levels').classList.toggle('hidden', activeTab !== 'levels');
  try {
    const d = await api('rewards');
    const grid = $('#rw-rb-grid');
    if (grid) grid.innerHTML = ['instant'].map((k) => rbCard(k, d.rakeback[k])).join('');
    grid.querySelectorAll('[data-rbkind]').forEach((btn) => btn.onclick = async () => {
      try {
        const r = await api('rewards/rakeback', { kind: btn.dataset.rbkind });
        setBalance(r.balance); SND.coin(); toast(`Claimed +${fmt(r.amount)} coins`, true);
        renderRewards();
      } catch (e) { toast(e.message); }
    });

    const lv = d.level;
    $('#rw-level-num').textContent = lv.level;
    $('#rw-level-pill').textContent = `Level ${lv.level}${lv.maxed ? ' (MAX)' : ''}`;
    $('#rw-level-fill').style.width = lv.progressPct + '%';
    $('#rw-level-cur').textContent = `Level ${lv.level}`;
    $('#rw-level-pct').textContent = lv.maxed ? 'Max level' : `${fmt(lv.remainingCoins)} to go`;
    $('#rw-level-next').textContent = lv.maxed ? `Level ${lv.maxLevel}` : `Level ${lv.level + 1}`;
    const ms = $('#rw-milestones');
    ms.innerHTML = lv.milestones.map(milestoneRow).join('');
    ms.querySelectorAll('[data-mlevel]').forEach((btn) => btn.onclick = async () => {
      try {
        const r = await api('rewards/level', {});
        setBalance(r.balance); SND.coin(); toast(`Claimed +${fmt(r.amount)} coins`, true);
        renderRewards();
      } catch (e) { toast(e.message); }
    });
  } catch {}
}
$$('.rw-tab').forEach((tab) => tab.onclick = () => {
  $$('.rw-tab').forEach((t) => t.classList.toggle('active', t === tab));
  $('#rw-panel-rakeback').classList.toggle('hidden', tab.dataset.rwtab !== 'rakeback');
  $('#rw-panel-levels').classList.toggle('hidden', tab.dataset.rwtab !== 'levels');
});
setInterval(renderRewards, 5000);

// ================= STATS =================
function statsBetRow(b) {
  const time = new Date(b.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<tr>
    <td>${GAME_LABEL[b.game] || b.game}</td>
    <td><span class="coin">${fmt(b.amount)}</span></td>
    <td>${b.multiplier ? 'x' + b.multiplier.toFixed(2) : '—'}</td>
    <td class="${b.payout > 0 ? 'win' : 'loss'}">${b.payout > 0 ? '+' + fmt(b.payout) : '0'}</td>
    <td>${time}</td>
  </tr>`;
}
async function renderStats() {
  const page = $('[data-page="stats"]');
  if (!page || page.classList.contains('hidden') || !me) return;
  const cards = $('#stats-cards');
  const profile = await api('profile').catch(() => null);
  cards.innerHTML = `
    <div class="stat-card"><span>Balance</span><b class="coin">${fmt(me.balance)}</b></div>
    <div class="stat-card"><span>Total wagered</span><b class="coin">${profile ? fmt(profile.totalWagered) : fmt(me.totalWagered)}</b></div>
    <div class="stat-card"><span>Level</span><b>${profile ? profile.level : '—'}</b></div>
    <div class="stat-card"><span>Total deposited</span><b class="coin">${profile ? fmt(profile.totalDeposited) : '—'}</b></div>
    <div class="stat-card"><span>Total withdrawn</span><b class="coin">${profile ? fmt(profile.totalWithdrawn) : '—'}</b></div>
    <div class="stat-card"><span>Total profit</span><b class="${profile && profile.profit >= 0 ? 'win' : 'loss'}">${profile ? (profile.profit >= 0 ? '+' : '') + fmt(profile.profit) : '—'}</b></div>
  `;
  try {
    const { bets } = await api('history');
    $('#stats-table tbody').innerHTML = bets.length
      ? bets.map(statsBetRow).join('')
      : '<tr><td colspan="5" class="stage-msg">No bets yet — go make some questionable decisions.</td></tr>';
  } catch {}
  const txBody = $('#stats-tx-table tbody');
  if (txBody && profile) {
    txBody.innerHTML = profile.transactions.length
      ? profile.transactions.map(t => {
          const when = new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const sign = t.amount >= 0 ? '+' : '';
          return `<tr><td>${when}</td><td>${t.method}</td><td>${t.type}</td><td class="${t.amount >= 0 ? 'win' : 'loss'}">${sign}${fmt(t.amount)}</td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="stage-msg">No deposits or withdrawals yet.</td></tr>';
  }
}

// ================= SETTINGS =================
function renderSettings() {
  const page = $('[data-page="settings"]');
  if (!page || page.classList.contains('hidden') || !me) return;
  const anonBtn = $('#settings-anon-toggle');
  anonBtn.textContent = me.anonymous ? 'On' : 'Off';
  anonBtn.classList.toggle('active', !!me.anonymous);
  const soundBtn = $('#settings-sound-toggle');
  soundBtn.textContent = SND.muted ? 'Off' : 'On';
  soundBtn.classList.toggle('active', !SND.muted);
  $('#settings-account-info').textContent = `${me.mcUsername || me.username} · ${fmt(me.totalWagered)} wagered total`;
}
$('#settings-anon-toggle').onclick = async () => {
  if (!me) return;
  try {
    const r = await api('anonymous', { enabled: !me.anonymous });
    me.anonymous = r.anonymous;
    toast(r.anonymous ? 'You are now anonymous' : 'Anonymous mode off', true);
    renderSettings();
  } catch (e) { toast(e.message); }
};
$('#settings-sound-toggle').onclick = () => { SND.toggle(); renderSettings(); };

// ================= boot =================
(async () => {
  // drop a "Provably Fair" button into every game panel
  $$('.bet-panel').forEach((p) => {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-small fair-btn'; b.setAttribute('data-fair', '');
    b.textContent = '🛡 Provably Fair';
    p.appendChild(b);
  });
  diceRecalc();
  buildMinesGrid();
  buildTower();
  buildRoad(0);
  // Cases always starts on the battles lobby - never resumes single-case or a
  // watched battle room from a previous visit/reload.
  showCasesView('battles');
  route();
  refreshFeed(); refreshBoard(); loadCases(); loadDaily(); refreshChat();
  try {
    const d = await api('me');
    applyUser(d.user);
    if (d.user) { dailyReadyAt = d.user.dailyReadyAt; dailyStatus(); }
    // restore any game that was mid-flight before a refresh
    if (d.user) applyActive(d.active, d.user.balance);
  } catch {}
})();

})();
