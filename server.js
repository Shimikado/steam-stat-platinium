import crypto from 'node:crypto';
import express from 'express';
import cookieSession from 'cookie-session';
import { rateLimit } from 'express-rate-limit';
import {
  SteamError,
  getAchievementSummaries,
  getFriends,
  getGameAchievements,
  getDifficulties,
  getProfile,
  resolveSteamId,
} from './src/steam.js';
import { getAdditions, getMarks, getSnapshot, importMarks, initDb, saveSnapshot, setMark } from './src/db.js';

try {
  process.loadEnvFile();
} catch {
  // Pas de fichier .env : on utilise les variables d'environnement du shell.
}

const PORT = Number(process.env.PORT) || 3000;
// Render fournit RENDER_EXTERNAL_URL automatiquement ; BASE_URL permet de forcer un domaine personnalisé.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const HTTPS = BASE_URL.startsWith('https://');
const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const RETURN_TO = `${BASE_URL}/auth/steam/return`;
const STEAMID_RE = /^\d{17}$/;
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');

if (!process.env.STEAM_API_KEY && !DEMO) {
  console.warn('⚠  STEAM_API_KEY absente : copie .env.example en .env et renseigne ta clé.');
}

// Base Postgres facultative (cache persistant, succès ajoutés, marquages synchronisés).
const DB = DEMO ? false : await initDb();
console.log(DB ? 'Base de données : connectée.' : 'Base de données : aucune (fonctionnement local).');

if (!process.env.SESSION_SECRET && HTTPS) {
  console.warn('⚠  SESSION_SECRET absente : les connexions seront perdues à chaque redémarrage.');
}

const app = express();
app.disable('x-powered-by');
// Derrière le proxy de l'hébergeur (Render…), pour avoir la vraie IP du visiteur et le HTTPS.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? (process.env.RENDER ? 1 : 0)));

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});

// Session dans un cookie signé : rien à stocker côté serveur, elle survit aux redémarrages.
app.use(
  cookieSession({
    name: 'steamstats',
    keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: HTTPS,
  }),
);
app.use(express.static('public'));

app.get('/healthz', (req, res) => res.send('ok'));

// ---------------------------------------------------------------- connexion Steam (OpenID 2.0)

app.get('/auth/steam', (req, res) => {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': RETURN_TO,
    'openid.realm': BASE_URL,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect(`${OPENID_ENDPOINT}?${params}`);
});

app.get('/auth/steam/return', async (req, res) => {
  const q = req.query;
  if (q['openid.mode'] !== 'id_res') return res.redirect('/?auth=cancel');

  const claimed = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(q['openid.claimed_id'] ?? '');
  if (q['openid.op_endpoint'] !== OPENID_ENDPOINT || q['openid.return_to'] !== RETURN_TO || !claimed) {
    return res.redirect('/?auth=invalid');
  }

  // On demande à Steam de confirmer la signature de la réponse.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (k.startsWith('openid.')) body.set(k, String(v));
  body.set('openid.mode', 'check_authentication');

  try {
    const check = await fetch(OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!/is_valid\s*:\s*true/.test(await check.text())) return res.redirect('/?auth=invalid');
  } catch {
    return res.redirect('/?auth=error');
  }

  req.session = { steamid: claimed[1] };
  res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

// ---------------------------------------------------------------- API

// Limites par IP : protègent le quota de la clé Steam (100 000 appels/jour) contre les abus.
const limiterOptions = { windowMs: 5 * 60 * 1000, standardHeaders: 'draft-8', legacyHeaders: false };
const apiLimiter = rateLimit({
  ...limiterOptions,
  limit: 400, // une grosse bibliothèque + quelques profils d'amis tiennent largement dedans
  message: { error: 'Trop de requêtes, réessaie dans quelques minutes.' },
});
const imgLimiter = rateLimit({ ...limiterOptions, limit: 80 });

const api = express.Router();
api.use('/img', imgLimiter);
api.use(apiLimiter);

function steamidParam(req) {
  const id = req.params.steamid;
  if (!STEAMID_RE.test(id)) throw new SteamError('SteamID invalide', 400);
  return id;
}

api.get('/me', (req, res) => {
  res.json({ steamid: req.session?.steamid ?? null, sync: Boolean(DB) });
});

// ---------------------------------------------------------------- données liées à la base

function requireDb() {
  if (!DB) throw new SteamError('Base de données non configurée', 503);
}

/** Les marquages et l'instantané ne concernent que le compte connecté. */
function selfId(req) {
  requireDb();
  const id = req.session?.steamid;
  if (!id) throw new SteamError('Connexion Steam requise', 401);
  return id;
}

const appidList = (raw, max) =>
  String(raw ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, max);

api.get('/additions', async (req, res) => {
  requireDb();
  res.json(await getAdditions(appidList(req.query.appids, 3000)));
});

api.get('/marks', async (req, res) => {
  res.json(await getMarks(selfId(req)));
});

api.put('/marks', express.json({ limit: '4kb' }), async (req, res) => {
  const id = selfId(req);
  const { appid, kind, on } = req.body ?? {};
  if (!Number.isInteger(appid) || appid <= 0 || !['goal', 'dlc'].includes(kind)) throw new SteamError('Marquage invalide', 400);
  res.json(await setMark(id, appid, kind, Boolean(on)));
});

api.post('/marks/import', express.json({ limit: '64kb' }), async (req, res) => {
  const id = selfId(req);
  const clean = (list) => (Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n > 0) : []);
  res.json(await importMarks(id, { goal: clean(req.body?.goal), dlc: clean(req.body?.dlc) }));
});

api.get('/snapshot', async (req, res) => {
  res.json({ snapshot: await getSnapshot(selfId(req)) });
});

api.put('/snapshot', express.json({ limit: '64kb' }), async (req, res) => {
  const id = selfId(req);
  const plats = Array.isArray(req.body?.plats) ? req.body.plats.filter(Number.isInteger).slice(0, 5000) : null;
  const rank = typeof req.body?.rank === 'string' ? req.body.rank.slice(0, 20) : null;
  if (!plats || !rank) throw new SteamError('Instantané invalide', 400);
  await saveSnapshot(id, { plats, rank });
  res.status(204).end();
});

api.get('/resolve', async (req, res) => {
  res.json({ steamid: await resolveSteamId(req.query.q) });
});

api.get('/profile/:steamid', async (req, res) => {
  res.json(await getProfile(steamidParam(req), { refresh: req.query.refresh === '1' }));
});

api.get('/achievements/:steamid', async (req, res) => {
  const steamid = steamidParam(req);
  const appids = String(req.query.appids ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
  res.json(await getAchievementSummaries(steamid, appids, { refresh: req.query.refresh === '1' }));
});

// Proxy d'images Steam : le canvas de la carte de chasseur ne peut exporter que des images de même origine.
const IMG_HOSTS = new Set([
  'cdn.cloudflare.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'avatars.steamstatic.com',
  'avatars.cloudflare.steamstatic.com',
  'avatars.akamai.steamstatic.com',
  'media.steampowered.com',
  'steamcdn-a.akamaihd.net',
]);

api.get('/img', async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.url));
  } catch {
    throw new SteamError('URL invalide', 400);
  }
  if (url.protocol !== 'https:' || !IMG_HOSTS.has(url.hostname)) throw new SteamError('Hôte non autorisé', 400);

  const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const type = upstream?.headers.get('content-type') ?? '';
  if (!upstream?.ok || !type.startsWith('image/')) return res.status(404).end();
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) return res.status(413).end();
  res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' }).send(buf);
});

api.get('/friends/:steamid', async (req, res) => {
  res.json(await getFriends(steamidParam(req)));
});

api.get('/difficulty/:steamid', async (req, res) => {
  const appids = String(req.query.appids ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
  res.json(await getDifficulties(steamidParam(req), appids));
});

api.get('/game/:steamid/:appid', async (req, res) => {
  const appid = Number(req.params.appid);
  if (!Number.isInteger(appid) || appid <= 0) throw new SteamError('appid invalide', 400);
  res.json(await getGameAchievements(steamidParam(req), appid));
});

if (DEMO) {
  const { demoRouter } = await import('./src/demo.js');
  app.use('/api', demoRouter());
  console.log('Mode démo actif : données fictives.');
}
app.use('/api', api);

app.use((err, req, res, _next) => {
  const status = err instanceof SteamError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erreur interne' });
});

app.listen(PORT, () => {
  console.log(`Steam Stats → ${BASE_URL}`);
});
