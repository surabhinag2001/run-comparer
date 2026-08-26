// Tiny persistence layer on top of Node's built-in SQLite (node:sqlite).
// No external DB dependency — the whole app runs off one file. Point
// DB_PATH at a persistent volume/disk in production (see README) or the
// data will be lost on redeploy on hosts with an ephemeral filesystem.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS athletes (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    athlete_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    owner_athlete_id INTEGER,
    name TEXT,
    sport_type TEXT,
    start_local TEXT,
    summary_json TEXT NOT NULL,
    perf_json TEXT,
    streams_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ---- athletes ----
export function upsertAthlete({ id, first_name, last_name, access_token, refresh_token, expires_at }) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO athletes (id, first_name, last_name, access_token, refresh_token, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      first_name=excluded.first_name, last_name=excluded.last_name,
      access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at
  `).run(id, first_name || null, last_name || null, access_token, refresh_token, expires_at, now, now);
}

export function getAthlete(id) {
  return db.prepare('SELECT * FROM athletes WHERE id = ?').get(id) || null;
}

export function updateAthleteTokens(id, { access_token, refresh_token, expires_at }) {
  db.prepare(`
    UPDATE athletes SET access_token=?, refresh_token=?, expires_at=?, updated_at=?
    WHERE id=?
  `).run(access_token, refresh_token, expires_at, Math.floor(Date.now() / 1000), id);
}

// ---- sessions ----
export function createSession(athleteId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, athlete_id, created_at) VALUES (?, ?, ?)')
    .run(token, athleteId, Math.floor(Date.now() / 1000));
  return token;
}

export function getSessionAthlete(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT athletes.* FROM sessions
    JOIN athletes ON athletes.id = sessions.athlete_id
    WHERE sessions.token = ?
  `).get(token);
  return row || null;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---- oauth CSRF state ----
export function createOauthState() {
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)').run(state, Math.floor(Date.now() / 1000));
  return state;
}

export function consumeOauthState(state) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!row) return false;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  // states older than 10 minutes are treated as invalid
  return (Math.floor(Date.now() / 1000) - row.created_at) < 600;
}

export function pruneOauthStates() {
  const cutoff = Math.floor(Date.now() / 1000) - 600;
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(cutoff);
}

// ---- snapshots ----
function randomSlug() {
  // base62, 10 chars — short enough to paste, long enough not to guess
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function createSnapshot({ activity_id, owner_athlete_id, name, sport_type, start_local, summary, perf, streams }) {
  let id = randomSlug();
  // vanishingly unlikely to collide, but guard anyway
  while (db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(id)) id = randomSlug();
  db.prepare(`
    INSERT INTO snapshots (id, activity_id, owner_athlete_id, name, sport_type, start_local, summary_json, perf_json, streams_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, String(activity_id), owner_athlete_id || null, name || null, sport_type || null, start_local || null,
    JSON.stringify(summary || {}), JSON.stringify(perf || {}), JSON.stringify(streams || {}),
    Math.floor(Date.now() / 1000)
  );
  return id;
}

export function getSnapshot(id) {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    activity_id: row.activity_id,
    name: row.name,
    sport_type: row.sport_type,
    start_local: row.start_local,
    summary: JSON.parse(row.summary_json),
    perf: JSON.parse(row.perf_json),
    streams: JSON.parse(row.streams_json),
    created_at: row.created_at
  };
}

export default db;
