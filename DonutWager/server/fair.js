// fair.js - provably fair RNG
// result = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${cursor}`)
// Players get sha256(serverSeed) up front and the seed itself after rotating,
// so every roll can be re-derived and checked.
const crypto = require('crypto');

function newServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// stream of floats in [0,1) from one (seed, clientSeed, nonce) triple
function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  let cursor = 0;
  while (out.length < count) {
    const buf = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${cursor}`)
      .digest();
    // 4 bytes -> one float, 8 floats per digest
    for (let i = 0; i + 4 <= buf.length && out.length < count; i += 4) {
      out.push(buf.readUInt32BE(i) / 4294967296);
    }
    cursor++;
  }
  return out;
}

// Fisher-Yates using the fair float stream
function shuffle(arr, serverSeed, clientSeed, nonce, offset = 0) {
  const rand = floats(serverSeed, clientSeed, nonce, arr.length + offset).slice(offset);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand[a.length - 1 - i] * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { newServerSeed, hashSeed, floats, shuffle };
