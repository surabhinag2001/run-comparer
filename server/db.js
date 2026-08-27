// Persistence layer on Turso's @libsql/client (SQLite-compatible). Points
// at a plain local file for dev (no account needed — see DB_URL below) and
// at a real Turso database in production, so data survives redeploys on
// hosts (like Render's free tier) that don't offer a persistent disk.
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// DB_URL examples:
//   file:./data/app.db            (local dev, default)
//   libsql://your-db.turso.io     (production, with DB_AUTH_TOKEN set)
const DB_URL = process.env.DB_URL || `file:${path.join(process.cwd(), 'data', 'app.db')}`;
if (DB_URL.startsWith('file:')) {
  fs.mkdirSync(path.dirname(DB_URL.slice('file:'.length)), { recursive: true });
}

const db = createClient({
  url: DB_URL,
  authToken: process.env.DB_AUTH_TOKEN || undefined
});

await db.execute('PRAGMA foreign_keys = ON;');

await db.batch([
  `CREATE TABLE IF NOT EXISTS athletes (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    athlete_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
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
  )`
], 'write');

// ---- athletes ----
export async function upsertAthlete({ id, first_name, last_name, access_token, refresh_token, expires_at }) {
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `
      INSERT INTO athletes (id, first_name, last_name, access_token, refresh_token, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        first_name=excluded.first_name, last_name=excluded.last_name,
        access_token=excluded.access_token, refresh_token=excluded.refresh_token,
        expires_at=excluded.expires_at, updated_at=excluded.updated_at
    `,
    args: [id, first_name || null, last_name || null, access_token, refresh_token, expires_at, now, now]
  });
}

export async function getAthlete(id) {
  const res = await db.execute({ sql: 'SELECT * FROM athletes WHERE id = ?', args: [id] });
  return res.rows[0] || null;
}

export async function updateAthleteTokens(id, { access_token, refresh_token, expires_at }) {
  await db.execute({
    sql: `
      UPDATE athletes SET access_token=?, refresh_token=?, expires_at=?, updated_at=?
      WHERE id=?
    `,
    args: [access_token, refresh_token, expires_at, Math.floor(Date.now() / 1000), id]
  });
}

// ---- sessions ----
export async function createSession(athleteId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.execute({
    sql: 'INSERT INTO sessions (token, athlete_id, created_at) VALUES (?, ?, ?)',
    args: [token, athleteId, Math.floor(Date.now() / 1000)]
  });
  return token;
}

export async function getSessionAthlete(token) {
  if (!token) return null;
  const res = await db.execute({
    sql: `
      SELECT athletes.* FROM sessions
      JOIN athletes ON athletes.id = sessions.athlete_id
      WHERE sessions.token = ?
    `,
    args: [token]
  });
  return res.rows[0] || null;
}

export async function deleteSession(token) {
  await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
}

// ---- oauth CSRF state ----
export async function createOauthState() {
  const state = crypto.randomBytes(16).toString('hex');
  await db.execute({
    sql: 'INSERT INTO oauth_states (state, created_at) VALUES (?, ?)',
    args: [state, Math.floor(Date.now() / 1000)]
  });
  return state;
}

export async function consumeOauthState(state) {
  const res = await db.execute({ sql: 'SELECT * FROM oauth_states WHERE state = ?', args: [state] });
  const row = res.rows[0];
  if (!row) return false;
  await db.execute({ sql: 'DELETE FROM oauth_states WHERE state = ?', args: [state] });
  // states older than 10 minutes are treated as invalid
  return (Math.floor(Date.now() / 1000) - row.created_at) < 600;
}

export async function pruneOauthStates() {
  const cutoff = Math.floor(Date.now() / 1000) - 600;
  await db.execute({ sql: 'DELETE FROM oauth_states WHERE created_at < ?', args: [cutoff] });
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

export async function createSnapshot({ activity_id, owner_athlete_id, name, sport_type, start_local, summary, perf, streams }) {
  let id = randomSlug();
  // vanishingly unlikely to collide, but guard anyway
  while ((await db.execute({ sql: 'SELECT 1 FROM snapshots WHERE id = ?', args: [id] })).rows.length) {
    id = randomSlug();
  }
  await db.execute({
    sql: `
      INSERT INTO snapshots (id, activity_id, owner_athlete_id, name, sport_type, start_local, summary_json, perf_json, streams_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id, String(activity_id), owner_athlete_id || null, name || null, sport_type || null, start_local || null,
      JSON.stringify(summary || {}), JSON.stringify(perf || {}), JSON.stringify(streams || {}),
      Math.floor(Date.now() / 1000)
    ]
  });
  return id;
}

export async function getSnapshot(id) {
  const res = await db.execute({ sql: 'SELECT * FROM snapshots WHERE id = ?', args: [id] });
  const row = res.rows[0];
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
