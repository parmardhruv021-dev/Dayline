import './env.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataPath = resolve(process.env.DATABASE_PATH || `${root}/data/dayline.sqlite`);
mkdirSync(dirname(dataPath), { recursive: true });
export const db = new DatabaseSync(dataPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);
for (const file of readdirSync(`${root}/migrations`).filter((name) => name.endsWith('.sql')).sort()) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file)) continue;
  const sql = readFileSync(`${root}/migrations/${file}`, 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function audit(orgId, actorId, action, subjectType, subjectId, reason = null, details = {}) {
  db.prepare(`INSERT INTO audit_events
    (id, organization_id, actor_membership_id, action, subject_type, subject_id, reason, details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id(), orgId, actorId, action, subjectType, subjectId, reason, JSON.stringify(details), now());
}
export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}
