import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vercel's filesystem is read-only except /tmp. Data there lives as long as the server instance does.
const path = process.env.DB_PATH ?? (process.env.VERCEL ? '/tmp/one-record.db' : fileURLToPath(new URL('../data/app.db', import.meta.url)));
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sex TEXT,
  dob TEXT,
  blood_group TEXT,
  city TEXT
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL,          -- visit lab medicine vaccine document allergy condition note discharge
  date TEXT,                   -- YYYY-MM-DD, null = undated
  title TEXT NOT NULL,
  detail TEXT,
  source TEXT,                 -- who produced it
  source_kind TEXT NOT NULL,   -- imported | hospital | patient
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON records(patient_id, date);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  scope TEXT NOT NULL,         -- emergency | full
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id TEXT NOT NULL REFERENCES shares(id),
  at TEXT NOT NULL DEFAULT (datetime('now')),
  who TEXT NOT NULL,
  action TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  body BLOB NOT NULL
);
`);

const parse = (r) => (r ? { ...r, data: JSON.parse(r.data ?? '{}') } : r);

export const q = {
  patients: () => db.prepare('SELECT * FROM patients ORDER BY name').all(),
  patient: (id) => db.prepare('SELECT * FROM patients WHERE id = ?').get(id),
  records: (pid) =>
    db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY (date IS NULL), date DESC, created_at DESC').all(pid).map(parse),
  insertRecord: (r) => {
    db.prepare(
      `INSERT INTO records (id, patient_id, kind, date, title, detail, source, source_kind, data)
       VALUES (@id, @patient_id, @kind, @date, @title, @detail, @source, @source_kind, @data)`,
    ).run({ detail: null, source: null, date: null, ...r, data: JSON.stringify(r.data ?? {}) });
    return r.id;
  },
  share: (code) => db.prepare('SELECT * FROM shares WHERE code = ?').get(code),
  shareById: (id) => db.prepare('SELECT * FROM shares WHERE id = ?').get(id),
  sharesFor: (pid) => db.prepare('SELECT * FROM shares WHERE patient_id = ? ORDER BY created_at DESC').all(pid),
  log: (shareId, who, action) => db.prepare('INSERT INTO access_log (share_id, who, action) VALUES (?, ?, ?)').run(shareId, who, action),
  logFor: (pid) =>
    db.prepare(
      `SELECT l.at, l.who, l.action, s.code FROM access_log l JOIN shares s ON s.id = l.share_id
       WHERE s.patient_id = ? ORDER BY l.id DESC LIMIT 100`,
    ).all(pid),
};

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
