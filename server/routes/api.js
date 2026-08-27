import express from 'express';
import { getSessionAthlete, createSnapshot, getSnapshot } from '../db.js';
import { listActivities, getActivity, getActivityStreams, getActivityPerformance, StravaApiError } from '../strava.js';
import { SESSION_COOKIE } from './auth.js';

const router = express.Router();

const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
function isRunType(sportType) { return RUN_TYPES.indexOf(sportType) !== -1; }

async function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const athlete = await getSessionAthlete(token);
  if (!athlete) return res.status(401).json({ error: { code: 'not_connected', message: 'Not connected to Strava.' } });
  req.athlete = athlete;
  next();
}

function handleStravaError(res, e) {
  if (e instanceof StravaApiError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message } });
  }
  console.error(e);
  return res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong.' } });
}

// Who's logged in, if anyone. Never requires auth itself.
router.get('/me', async (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  const athlete = await getSessionAthlete(token);
  if (!athlete) return res.json({ authenticated: false });
  res.json({ authenticated: true, athlete: { id: athlete.id, first_name: athlete.first_name, last_name: athlete.last_name } });
});

function summarizeActivity(a) {
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type || a.type,
    start_local: a.start_date_local,
    summary: {
      distance: a.distance,
      moving_time: a.moving_time,
      elapsed_time: a.elapsed_time,
      elevation_gain: a.total_elevation_gain,
      avg_speed: a.average_speed,
      max_speed: a.max_speed,
      total_calories: a.calories ?? null,
      relative_effort: a.suffer_score ?? null
    }
  };
}

router.get('/activities', requireAuth, async (req, res) => {
  try {
    const perPage = Math.min(Number(req.query.per_page) || 60, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const activities = await listActivities(req.athlete.id, { perPage, page });
    res.json({ activities: activities.map(summarizeActivity), page, has_more: activities.length === perPage });
  } catch (e) { handleStravaError(res, e); }
});

// Resolves a Strava mobile-app share link (strava.app.link/xxxxx, a
// Branch.io short link) to the activity id it points at. These don't
// carry the id in the URL itself — Branch's server only reveals the real
// strava.com destination via a 307 redirect, and only to requests that
// carry a real-looking User-Agent (a missing one gets a 200 HTML
// fallback page instead, which is what breaks this when a browser tries
// to resolve it directly client-side — that request is also blocked by
// CORS regardless). The hostname is pinned to a fixed literal so this
// can't be used as an open redirect-following proxy.
const APP_LINK_RE = /^https:\/\/strava\.app\.link\/[A-Za-z0-9_-]+\/?(\?.*)?$/i;

router.get('/resolve-link', requireAuth, async (req, res) => {
  const url = String(req.query.url || '');
  if (!APP_LINK_RE.test(url)) {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Not a recognized Strava share link.' } });
  }
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const location = resp.headers.get('location') || '';
    const m = location.match(/strava\.com\/activities\/(\d+)/i);
    if (!m) return res.status(404).json({ error: { code: 'not_found', message: 'That link didn’t resolve to an activity.' } });
    res.json({ id: m[1] });
  } catch (e) {
    console.error('resolve-link failed:', e);
    res.status(502).json({ error: { code: 'resolve_failed', message: 'Couldn’t resolve that link right now.' } });
  }
});

// Look up a single activity by id — used for "paste a link/ID". Strava
// itself enforces that this only succeeds for an activity the logged-in
// athlete owns (or has been granted access to); anything else 403s.
router.get('/activities/:id', requireAuth, async (req, res) => {
  try {
    const a = await getActivity(req.athlete.id, req.params.id);
    res.json(summarizeActivity(a));
  } catch (e) { handleStravaError(res, e); }
});

router.get('/activities/:id/streams', requireAuth, async (req, res) => {
  try {
    const streams = await getActivityStreams(req.athlete.id, req.params.id);
    res.json(streams);
  } catch (e) { handleStravaError(res, e); }
});

router.get('/activities/:id/performance', requireAuth, async (req, res) => {
  try {
    const perf = await getActivityPerformance(req.athlete.id, req.params.id);
    res.json(perf);
  } catch (e) { handleStravaError(res, e); }
});

// ---- snapshots (shareable, read-only copies of one run's data) ----
// Creating a snapshot requires being logged in (you can only snapshot
// data you were able to fetch, i.e. your own runs). Reading one back
// does NOT require auth — that's the whole point: the person you share
// a link with doesn't need a Strava account, let alone yours.
router.post('/snapshots', requireAuth, async (req, res) => {
  const { activity_id, name, sport_type, start_local, summary, perf, streams } = req.body || {};
  if (!activity_id || !streams || !streams.distance || !streams.time) {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Missing activity data to snapshot.' } });
  }
  if (sport_type && !isRunType(sport_type)) {
    return res.status(400).json({ error: { code: 'not_a_run', message: 'Only runs can be shared here.' } });
  }
  const id = await createSnapshot({
    activity_id, owner_athlete_id: req.athlete.id, name, sport_type, start_local, summary, perf, streams
  });
  res.json({ id });
});

router.get('/snapshots', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  const found = (await Promise.all(ids.map(getSnapshot))).filter(Boolean);
  res.json({ snapshots: found });
});

router.get('/snapshots/:id', async (req, res) => {
  const snap = await getSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: { code: 'not_found', message: 'That shared run link doesn’t exist (or was mistyped).' } });
  res.json(snap);
});

export default router;
