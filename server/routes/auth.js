import express from 'express';
import {
  createOauthState, consumeOauthState, pruneOauthStates,
  upsertAthlete, createSession, deleteSession
} from '../db.js';
import { buildAuthorizeUrl, exchangeCodeForToken, MOCK } from '../strava.js';

const router = express.Router();
const SESSION_COOKIE = 'rc_session';

function redirectUriFor(req) {
  // Respects a reverse proxy's forwarded protocol/host (Render, Koyeb,
  // etc. all sit behind one) so the callback URL matches what's
  // registered in the Strava API application settings.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/auth/strava/callback`;
}

router.get('/strava/login', (req, res) => {
  pruneOauthStates();
  const state = createOauthState();
  if (MOCK) {
    // Skip the real Strava consent screen entirely — go straight to our
    // own callback with a fake code, exactly like Strava would redirect
    // back after a real login.
    return res.redirect('/auth/strava/callback?code=mocked&state=' + encodeURIComponent(state));
  }
  const url = buildAuthorizeUrl({ redirectUri: redirectUriFor(req), state });
  res.redirect(url);
});

router.get('/strava/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect('/?auth_error=' + encodeURIComponent(String(error)));
  }
  if (!state || !consumeOauthState(String(state))) {
    return res.redirect('/?auth_error=invalid_state');
  }
  if (!code) {
    return res.redirect('/?auth_error=missing_code');
  }
  try {
    const token = await exchangeCodeForToken(String(code));
    const athlete = token.athlete || {};
    upsertAthlete({
      id: athlete.id,
      first_name: athlete.firstname,
      last_name: athlete.lastname,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at
    });
    const sessionToken = createSession(athlete.id);
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 1000 * 60 * 60 * 24 * 90 // 90 days
    });
    res.redirect('/');
  } catch (e) {
    console.error('Strava OAuth callback failed:', e);
    res.redirect('/?auth_error=exchange_failed');
  }
});

router.post('/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

export { SESSION_COOKIE };
export default router;
