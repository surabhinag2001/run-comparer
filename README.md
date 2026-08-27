# Run Comparer

## The story

A friend of mine asked why Strava doesn't have a built-in way to compare
two runs and pointed out how ridiculous that is, for an app that's
entirely about running. I didn't have a good answer. So I built it myself.

## What it does

Compare two or more runs from Strava — overview stats, kilometer-by-kilometer
splits with heart rate, and pace/elevation/heart-rate charts. Anyone who
visits connects their **own** Strava account (a standard "Connect with
Strava" login, nothing shared with you), picks their own runs, and can
generate a link to share a comparison with someone else — the person opening
that link doesn't need a Strava account at all to view it.


## Why it's built this way

Strava's API does not allow fetching another athlete's activity data just
because it's "public" on strava.com — every activity fetch is scoped to the
token of the athlete who authorized it, full stop. So "paste anyone's public
run link, no login for anyone" genuinely isn't possible against Strava's
API. What *is* possible, and what this app does:

1. Each visitor connects their own Strava account (one-time OAuth login) to
   browse and add their own runs.
2. Once 2+ runs are added, click **Share this comparison** — the app saves a
   read-only snapshot of each run's data (fetched with that person's own
   token, so only their own runs can ever be snapshotted) and hands back a
   link like `yourapp.com/s/AbC123,XyZ789`.
3. Anyone who opens that link sees the full comparison immediately — no
   login required to *view* it. If they want to add one of their own runs to
   the comparison, they connect their own Strava, add it, and can re-share a
   new combined link.

Nobody's Strava credentials are ever shared with anybody else, and the only
data ever stored is what a person explicitly chose to share via that link.

## Before you build/deploy: read Strava's API Agreement

Strava tightened its Developer Agreement in November 2024 (restrictions
around how third-party apps may display/store athlete data, and a ban on
AI/ML training use) and has continued adjusting API access terms since.
This app only displays data back to the person who authorized it (and to
whoever they explicitly choose to share a link with) and doesn't do
anything with the data beyond that — but you should read the current
agreement yourself at https://www.strava.com/legal/api and satisfy yourself
it's compliant before deploying this somewhere other people will use. This
is a terms-of-service judgment call for you to make, not something built
into the code.

## Local setup

Requires Node.js 18+. Local dev uses a plain SQLite file via
`@libsql/client` — no database server or account to set up.

```bash
npm install
cp .env.example .env
```

### Try it without a real Strava app (mock mode)

To poke around the UI without registering anything with Strava:

```bash
MOCK_STRAVA=1 STRAVA_CLIENT_ID=x STRAVA_CLIENT_SECRET=x npm start
```

Open http://localhost:3000 and click "Connect with Strava" — it logs you in
as a fake athlete with two canned runs, no real Strava account touched.
**Never set `MOCK_STRAVA=1` in production** — it serves the same fake data
to every visitor.

### Run it against your real Strava account

1. Register an API application at https://www.strava.com/settings/api
   (any name/website works; "Authorization Callback Domain" should be
   `localhost` for local dev).
2. Put the Client ID and Client Secret it gives you into `.env`.
3. `npm start` (or `npm run dev` to auto-restart on file changes), then
   open http://localhost:3000.

## Deploying

Deployed on [Render](https://render.com) (web service) with
[Turso](https://turso.tech) (`@libsql/client`, SQLite-compatible) as the
database — Render's free tier has no persistent disk, so Turso is what
makes logged-in-athlete records and shared snapshots survive a redeploy.

## Project structure

```
server/
  index.js        Express app entry, static file serving, SPA fallback route
  db.js           SQLite schema + queries (athletes, sessions, snapshots)
  strava.js       OAuth + Strava API calls (token exchange/refresh, streams, activities)
  mock-data.js    Canned data for MOCK_STRAVA=1 local testing
  routes/
    auth.js       /auth/strava/login, /auth/strava/callback, /auth/logout
    api.js        /api/me, /api/activities*, /api/snapshots*
public/
  index.html      Page shell
  style.css       All styling (design carried over from the original claude.ai version)
  app.js          All client-side logic: picker, splits/pace math, SVG charts, share flow
test_e2e.py       Playwright end-to-end test (run against MOCK_STRAVA=1)
```

## Notes on the split-pace math

Kilometer splits are computed client-side from the raw distance/time/moving
streams (Strava's own `laps` only reflect manually-pressed laps, not fixed
1km splits). Split pace uses **moving time, not elapsed time** — a red
light or water stop doesn't inflate a split's pace, because time spent with
`moving:false` is excluded before computing pace. This only works
accurately with **full-resolution** streams — an earlier version of this
app (the claude.ai artifact this was built from) fetched streams capped at
`resolution:200`, and Strava's downsampling at that resolution smooths
right through short stops, badly undercounting stoppage. `strava.js`
intentionally omits the `resolution` parameter to get full granularity.

## Running the test

```bash
pip install playwright && playwright install chromium   # once
MOCK_STRAVA=1 STRAVA_CLIENT_ID=x STRAVA_CLIENT_SECRET=x PORT=3417 node server/index.js &
python3 test_e2e.py
```
