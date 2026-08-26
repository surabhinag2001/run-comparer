// Strava OAuth + API helpers. Every Strava call here is made with a
// specific athlete's own access token — this app never fetches an
// activity that doesn't belong to the token's owner, because Strava's
// API doesn't allow that regardless (public visibility on strava.com is
// not the same as API access; see README).
import { getAthlete, updateAthleteTokens } from './db.js';
import { MOCK_ATHLETE, MOCK_ACTIVITIES, mockGetActivity, mockGetStreams } from './mock-data.js';

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const AUTH_BASE = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API_BASE = 'https://www.strava.com/api/v3';

// MOCK_STRAVA=1 swaps every real Strava network call for canned local data —
// used for local end-to-end testing without registering a real Strava API
// application. Never set this in production.
export const MOCK = process.env.MOCK_STRAVA === '1';

// Scopes: activity:read_all so runs marked "Only Me" still show up for
// their own owner (matches what people expect from "my recent runs").
const SCOPES = 'read,activity:read_all';

export function buildAuthorizeUrl({ redirectUri, state }) {
  const u = new URL(AUTH_BASE);
  u.searchParams.set('client_id', STRAVA_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('approval_prompt', 'auto');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Strava token request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function exchangeCodeForToken(code) {
  if (MOCK) {
    return {
      access_token: 'mock-access-' + code, refresh_token: 'mock-refresh-' + code,
      expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: MOCK_ATHLETE
    };
  }
  return postForm(TOKEN_URL, {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code'
  });
}

async function refreshToken(refresh_token) {
  return postForm(TOKEN_URL, {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token'
  });
}

// Returns a valid access token for this athlete, refreshing if it's
// expired or about to expire (60s buffer).
export async function getValidAccessToken(athleteId) {
  const athlete = getAthlete(athleteId);
  if (!athlete) return null;
  if (MOCK) return athlete.access_token;
  const now = Math.floor(Date.now() / 1000);
  if (athlete.expires_at - now > 60) return athlete.access_token;
  const refreshed = await refreshToken(athlete.refresh_token);
  updateAthleteTokens(athleteId, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: refreshed.expires_at
  });
  return refreshed.access_token;
}

class StravaApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function callStravaApi(athleteId, pathAndQuery) {
  const token = await getValidAccessToken(athleteId);
  if (!token) throw new StravaApiError('Not connected to Strava.', 401, 'not_connected');
  const res = await fetch(API_BASE + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (res.status === 401) throw new StravaApiError('Your Strava connection needs to be reconnected.', 401, 'needs_reauth');
  if (res.status === 403) throw new StravaApiError('That activity isn’t visible to your connected Strava account.', 403, 'forbidden');
  if (res.status === 404) throw new StravaApiError('Activity not found.', 404, 'not_found');
  if (res.status === 429) throw new StravaApiError('Strava is rate-limiting requests right now — try again shortly.', 429, 'rate_limited');
  if (!res.ok) throw new StravaApiError(`Strava reported an error (${res.status}).`, res.status, 'upstream_error');
  return res.json();
}

function mockWrap(fn) {
  try { return fn(); }
  catch (e) { throw new StravaApiError(e.message || 'Not found.', e.status || 404, e.status === 404 ? 'not_found' : 'upstream_error'); }
}

export function listActivities(athleteId, { perPage = 60 } = {}) {
  if (MOCK) return mockWrap(() => MOCK_ACTIVITIES.slice(0, perPage));
  return callStravaApi(athleteId, `/athlete/activities?per_page=${perPage}`);
}

export function getActivity(athleteId, activityId) {
  if (MOCK) return mockWrap(() => mockGetActivity(activityId));
  return callStravaApi(athleteId, `/activities/${encodeURIComponent(activityId)}`);
}

export async function getActivityStreams(athleteId, activityId) {
  // Confirmed against Strava's official OpenAPI spec: the stream key is
  // `heartrate` (no underscore), and `key_by_type=true` is required.
  // No `resolution` param on purpose — see content note in the frontend
  // and the project doc: a capped resolution smooths right through short
  // stops and makes moving-time exclusion wildly inaccurate.
  const keys = 'time,distance,altitude,heartrate,velocity_smooth,moving';
  const data = MOCK
    ? mockWrap(() => mockGetStreams(activityId))
    : await callStravaApi(athleteId, `/activities/${encodeURIComponent(activityId)}/streams?keys=${keys}&key_by_type=true`);
  // Strava's raw stream response is keyed by type with {data:[...]} wrappers;
  // normalize to flat arrays under the same names the frontend chart/splits
  // code expects (heart_rate, with underscore — this is our own app's
  // internal convention, kept consistent with the earlier claude.ai version).
  const out = {};
  if (data.time) out.time = data.time.data;
  if (data.distance) out.distance = data.distance.data;
  if (data.altitude) out.altitude = data.altitude.data;
  if (data.heartrate) out.heart_rate = data.heartrate.data;
  if (data.velocity_smooth) out.velocity_smooth = data.velocity_smooth.data;
  if (data.moving) out.moving = data.moving.data;
  return out;
}

export async function getActivityPerformance(athleteId, activityId) {
  // Strava's public API doesn't have a single "performance" endpoint the
  // way the MCP connector did — pull the same numbers off the activity
  // detail response. average_heartrate/max_heartrate/calories aren't in
  // Strava's formally documented schema but are present in practice on
  // HR-equipped/premium activities, so we read them defensively.
  const a = MOCK
    ? mockWrap(() => mockGetActivity(activityId))
    : await callStravaApi(athleteId, `/activities/${encodeURIComponent(activityId)}`);
  return {
    has_heartrate: !!a.has_heartrate || a.average_heartrate != null,
    average_heartrate: a.average_heartrate ?? null,
    max_heartrate: a.max_heartrate ?? null,
    calories: a.calories ?? null,
    laps: (a.laps || []).map(l => ({
      elapsed_time: l.elapsed_time, moving_time: l.moving_time, distance: l.distance,
      elevation_gain: l.total_elevation_gain
    }))
  };
}

export { StravaApiError };
