// A tiny express-session Store backed by the same SQLite database everything
// else uses. The built-in MemoryStore (the default if you don't configure one)
// loses every session the instant the process restarts - which happens on every
// deploy, crash, or (during development) every file save under `--watch`. That
// silently logs every real account out and replaces them with a fresh guest,
// since ensureUser() just creates a new guest whenever req.session.userId is
// missing. Persisting sessions to disk fixes that at the root.
const session = require('express-session');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const stmts = {
  get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
  set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
  destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
  prune: db.prepare('DELETE FROM sessions WHERE expires < ?'),
};

class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = stmts.get.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      stmts.set.run(sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { stmts.destroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      stmts.touch.run(expires, sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
}

// sweep expired rows once an hour so the table doesn't grow forever
setInterval(() => { try { stmts.prune.run(Date.now()); } catch {} }, 3600000).unref();

module.exports = SqliteStore;
