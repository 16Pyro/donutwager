// backup.js - periodic point-in-time snapshots of the database. Real money/
// tradeable value lives in this DB, so losing the file (disk failure, bad
// deploy, a fat-fingered rm) shouldn't mean losing everyone's balance from
// scratch. better-sqlite3's .backup() takes a safe, consistent snapshot even
// while the live DB is being written to under WAL mode.
const path = require('path');
const fs = require('fs');
const { db } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 14;                       // keep the last 14 snapshots
const INTERVAL = 6 * 60 * 60 * 1000;   // every 6 hours

function backupOnce() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `donutwager-${stamp}.db`);
  db.backup(dest)
    .then(() => {
      console.log('db backup written:', dest);
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
      while (files.length > KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    })
    .catch((e) => console.error('db backup failed:', e));
}

function startBackupSchedule() {
  backupOnce(); // one right away so a fresh deploy isn't unprotected for hours
  setInterval(backupOnce, INTERVAL).unref();
}

module.exports = { startBackupSchedule, backupOnce };
