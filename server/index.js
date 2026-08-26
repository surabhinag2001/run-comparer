import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRouter from './routes/auth.js';
import apiRouter from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
  console.error(
    '\nMissing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET.\n' +
    'Register an app at https://www.strava.com/settings/api, then set these\n' +
    '(see .env.example). The server will start but Strava login will fail.\n'
  );
}

const app = express();
app.set('trust proxy', true); // needed behind Render/Koyeb/etc.'s reverse proxy
app.use(cookieParser());
app.use(express.json({ limit: '8mb' })); // snapshots embed full-resolution streams

app.use('/auth', authRouter);
app.use('/api', apiRouter);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// SPA-style fallback: any non-API, non-auth GET route serves the app shell
// so pretty share links like /s/AbC123,XyZ789 load the client, which then
// reads the ids out of location.pathname itself.
app.get(/^\/(?!api|auth).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Run Comparer listening on port ${PORT}`);
});
