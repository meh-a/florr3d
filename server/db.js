// Account storage: one SQLite file next to the server. Each account is a
// Discord user; game progress (inventory, loadout, level/xp) lives in a
// single JSON `save` blob — at this scale there's nothing to query inside
// it, so a blob keeps the schema honest about that.
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const DB_PATH = process.env.DB_PATH
  || fileURLToPath(new URL('../accounts.db', import.meta.url));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY,
    discord_id TEXT UNIQUE NOT NULL,
    username   TEXT NOT NULL,
    avatar     TEXT,
    save       TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO accounts (discord_id, username, avatar, created_at, last_seen)
  VALUES (@discordId, @username, @avatar, @now, @now)
  ON CONFLICT(discord_id) DO UPDATE SET
    username = @username, avatar = @avatar, last_seen = @now
  RETURNING id, username, avatar, save
`);
const getStmt = db.prepare('SELECT id, username, avatar, save FROM accounts WHERE id = ?');
const saveStmt = db.prepare('UPDATE accounts SET save = ?, last_seen = ? WHERE id = ?');

// login upsert: returns the account row, creating it on first login
export function upsertAccount({ discordId, username, avatar }) {
  return upsertStmt.get({ discordId, username, avatar, now: Date.now() });
}

export function getAccount(id) {
  return getStmt.get(id) ?? null;
}

// `save` is whatever Player.serializeSave() produced
export function writeSave(id, save) {
  saveStmt.run(JSON.stringify(save), Date.now(), id);
}

export function loadSave(id) {
  const row = getStmt.get(id);
  if (!row?.save) return null;
  try { return JSON.parse(row.save); } catch { return null; }
}
