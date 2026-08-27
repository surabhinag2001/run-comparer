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
    const activities = await listActivities(req.athlete.id, { perPage });
    res.json({ activities: activities.map(summarizeActivity) });
  } catch (e) { handleStravaError(res, e); }
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
