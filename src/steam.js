import path from 'node:path';
import { TtlCache } from './cache.js';
import { recordTotals } from './db.js';
import { countCall, overBudget } from './usage.js';

const API = 'https://api.steampowered.com';
const CACHE_DIR = path.resolve('.cache');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class SteamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const caches = {
  profile: new TtlCache({ ttlMs: 10 * 60 * 1000 }),
  // Succès d'un joueur : valables tant que le jeu n'a pas été rejoué (voir isFresh), 30 jours au plus.
  achievements: new TtlCache({ ttlMs: 30 * DAY, file: path.join(CACHE_DIR, 'achievements.json'), ns: 'ach2' }),
  // Liste des succès d'un jeu et pourcentages mondiaux : ils bougent très lentement.
  schema: new TtlCache({ ttlMs: 30 * DAY, file: path.join(CACHE_DIR, 'schema.json'), ns: 'schema' }),
  global: new TtlCache({ ttlMs: 7 * DAY, file: path.join(CACHE_DIR, 'global.json'), ns: 'global' }),
  friendList: new TtlCache({ ttlMs: 6 * HOUR, ns: 'friendlist' }),
  // Version allégée du profil (nom, avatar, jeux à succès), gardée 2 jours en base : le score et le
  // résumé du classement s'en contentent, sans rappeler Steam ni subir un redémarrage du serveur.
  profileLite: new TtlCache({ ttlMs: 2 * DAY, ns: 'profilelite' }),
};

/** Listes de succès en cache des jeux donnés, lues en une fois : [[appid, liste]]. */
async function cachedLists(steamid, games) {
  const cached = await Promise.all(games.map((g) => caches.achievements.get(`${steamid}:${g.appid}`)));
  return games.flatMap((g, i) => (cached[i] === undefined ? [] : [[g.appid, cached[i].l ?? []]]));
}

/** Profil suffisant pour les calculs faits depuis le cache (score, résumé) : aucun appel Steam s'il est connu. */
async function getProfileLite(steamid) {
  return (await caches.profile.get(steamid)) ?? (await caches.profileLite.get(steamid)) ?? getProfile(steamid);
}

async function call(endpoint, params = {}, { allowError = false } = {}) {
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new SteamError('STEAM_API_KEY manquante côté serveur (voir .env)', 500);

  if (overBudget()) throw new SteamError('Quota Steam du jour presque épuisé, réessaie demain', 429);
  countCall();

  const url = new URL(API + endpoint);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new SteamError(`Steam injoignable (${err.name})`, 504);
  }

  if (res.status === 429) throw new SteamError('Limite de requêtes Steam atteinte, réessaie dans un instant', 429);
  if (res.status === 401 || (res.status === 403 && !allowError)) {
    throw new SteamError('Clé API Steam refusée ou profil privé', 403);
  }

  // Certaines méthodes (ex. GetPlayerAchievements) renvoient un 400/403 avec un corps JSON utile.
  let body = null;
  try {
    body = await res.json();
  } catch {
    // corps non JSON
  }
  if (!res.ok && !(allowError && body)) {
    throw new SteamError(`Steam a répondu HTTP ${res.status} sur ${endpoint}`, 502);
  }
  return { status: res.status, body };
}

/** Applique fn à chaque élément avec au plus `limit` appels simultanés. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- profils

export async function resolveSteamId(input) {
  const q = String(input ?? '').trim();
  if (!q) throw new SteamError('Saisis un SteamID, une URL de profil ou un pseudo personnalisé', 400);

  const id = /(?:^|\/profiles\/)(\d{17})\/?$/.exec(q);
  if (id) return id[1];

  const vanity = /\/id\/([^/?#]+)/.exec(q)?.[1] ?? (/^[\w-]{2,32}$/.test(q) ? q : null);
  if (!vanity) throw new SteamError('Format non reconnu', 400);

  const { body } = await call('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity });
  if (body?.response?.success !== 1) throw new SteamError(`Aucun profil Steam trouvé pour « ${vanity} »`, 404);
  return body.response.steamid;
}

export async function getProfile(steamid, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await caches.profile.get(steamid);
    if (cached) return cached;
  }

  const [summary, owned] = await Promise.all([
    call('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamid }),
    call('/IPlayerService/GetOwnedGames/v1/', {
      steamid,
      include_appinfo: 1,
      include_played_free_games: 1,
    }),
  ]);

  const p = summary.body?.response?.players?.[0];
  if (!p) throw new SteamError('Profil Steam introuvable', 404);

  const games = (owned.body?.response?.games ?? []).map((g) => ({
    appid: g.appid,
    name: g.name ?? `App ${g.appid}`,
    icon: g.img_icon_url || null,
    playtime: g.playtime_forever ?? 0, // minutes
    playtime2w: g.playtime_2weeks ?? 0,
    playtimeDeck: g.playtime_deck_forever ?? 0,
    lastPlayed: g.rtime_last_played ?? 0, // timestamp unix
    hasStats: Boolean(g.has_community_visible_stats),
  }));

  const profile = {
    player: {
      steamid: p.steamid,
      name: p.personaname,
      avatar: p.avatarfull,
      url: p.profileurl,
      country: p.loccountrycode ?? null,
      createdAt: p.timecreated ?? null,
      isPublic: p.communityvisibilitystate === 3,
    },
    // Si la liste des jeux est vide alors que le profil en a, les « détails des jeux » sont privés.
    gamesHidden: owned.body?.response?.game_count === undefined,
    // Jeux lancés ces 2 dernières semaines, déduits de la liste des jeux (évite un appel).
    recent: games.filter((g) => g.playtime2w > 0).map((g) => g.appid),
    games,
  };

  caches.profile.set(steamid, profile);
  caches.profileLite.set(steamid, {
    player: { name: profile.player.name, avatar: profile.player.avatar },
    games: games.filter((g) => g.hasStats).map((g) => ({ appid: g.appid, hasStats: true })),
  });
  return profile;
}

const friendCache = new TtlCache({ ttlMs: 5 * 60 * 1000 });

/** Amis du joueur avec leur statut. { private: true } si la liste d'amis n'est pas publique. */
export async function getFriends(steamid) {
  const cached = await friendCache.get(steamid);
  if (cached) return cached;

  let list = await caches.friendList.get(steamid);
  if (list === undefined) {
    try {
      const { body } = await call('/ISteamUser/GetFriendList/v1/', { steamid, relationship: 'friend' });
      list = body?.friendslist?.friends ?? [];
    } catch (err) {
      if (err.status !== 403) throw err;
      list = null; // liste privée
    }
    caches.friendList.set(steamid, list);
  }
  if (list === null) return { private: true, friends: [] };

  const since = new Map(list.map((f) => [f.steamid, f.friend_since]));
  const ids = [...since.keys()];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const summaries = (
    await mapLimit(chunks, 3, async (chunk) => {
      const { body } = await call('/ISteamUser/GetPlayerSummaries/v2/', { steamids: chunk.join(',') });
      return body?.response?.players ?? [];
    })
  ).flat();

  const friends = summaries
    .map((p) => ({
      steamid: p.steamid,
      name: p.personaname,
      avatar: p.avatarmedium,
      online: p.personastate > 0,
      game: p.gameextrainfo ?? null,
      isPublic: p.communityvisibilitystate === 3,
      since: since.get(p.steamid) ?? null,
    }))
    .sort((a, b) => Number(Boolean(b.game)) - Number(Boolean(a.game)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

  const result = { private: false, friends };
  friendCache.set(steamid, result);
  return result;
}

// ---------------------------------------------------------------- succès

/**
 * Un jeu ne peut gagner de succès que s'il a été joué : tant que son temps de jeu et sa date de
 * dernière session n'ont pas bougé, la liste en cache reste valable, quel que soit son âge.
 * Sans repère fiable (temps de jeu masqué par le joueur), on se rabat sur 6 h.
 * stamp = { pt: temps de jeu, lp: dernière session, trust: repères fiables } ; sans stamp, tout cache convient.
 */
function isFresh(cached, stamp, refresh) {
  if (!stamp) return true;
  const sameActivity = cached.pt === stamp.pt && cached.lp === stamp.lp;
  if (stamp.trust && sameActivity) return true;
  if (refresh) return false;
  return Date.now() - cached.t < 6 * HOUR;
}

/** Liste brute [[apiname, achieved, unlocktime]] d'un joueur pour un jeu, ou null si le jeu n'a pas de succès. */
async function getPlayerAchievementList(steamid, appid, { refresh = false, stamp = null } = {}) {
  const key = `${steamid}:${appid}`;
  const cached = await caches.achievements.get(key);
  if (cached && isFresh(cached, stamp, refresh)) return cached.l;
  const store = (l) => caches.achievements.set(key, { l, pt: stamp?.pt ?? null, lp: stamp?.lp ?? null, t: Date.now() });

  const { body } = await call('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid, appid }, { allowError: true });
  const ps = body?.playerstats;

  if (!ps?.success) {
    const msg = ps?.error ?? '';
    if (/not public|private/i.test(msg)) throw new SteamError('Les succès de ce profil sont privés', 403);
    // « Requested app has no stats » : jeu sans succès, c'est un résultat valide.
    store(null);
    return null;
  }

  const list = (ps.achievements ?? []).map((a) => [a.apiname, a.achieved, a.unlocktime]);
  const value = list.length ? list : null;
  store(value);
  return value;
}

function summarize(appid, list) {
  if (!list) return { appid, total: 0, unlocked: 0, percent: null, times: [] };
  const times = [];
  let unlocked = 0;
  for (const [, achieved, unlocktime] of list) {
    if (achieved === 1) {
      unlocked++;
      if (unlocktime) times.push(unlocktime);
    }
  }
  times.sort((a, b) => a - b);
  return { appid, total: list.length, unlocked, percent: (unlocked / list.length) * 100, times };
}

export async function getAchievementSummaries(steamid, appids, { refresh = false } = {}) {
  // Repères d'activité de chaque jeu, tirés de la liste des jeux (déjà en cache).
  const profile = await getProfile(steamid);
  const trust = profile.games.some((g) => g.playtime > 0); // temps de jeu masqué → repères inutilisables
  const byId = new Map(profile.games.map((g) => [g.appid, g]));
  let privateError = null;
  const results = await mapLimit(appids, 6, async (appid) => {
    const g = byId.get(appid);
    const stamp = g ? { pt: g.playtime, lp: g.lastPlayed, trust } : null;
    try {
      return summarize(appid, await getPlayerAchievementList(steamid, appid, { refresh, stamp }));
    } catch (err) {
      if (err.status === 403) privateError = err;
      return { appid, error: err.message };
    }
  });
  if (privateError && results.every((r) => r.error)) throw privateError;
  // Le total de succès d'un jeu est le même pour tous : chaque analyse alimente la détection des ajouts.
  recordTotals(results.filter((r) => r.total > 0).map((r) => [r.appid, r.total]));
  return results;
}

/** Liste des succès d'un jeu (noms, descriptions, icônes) dans une langue donnée. */
async function getSchema(appid, lang = 'french') {
  const key = `${appid}:${lang}`;
  const cached = await caches.schema.get(key);
  if (cached !== undefined) return cached;

  const { body } = await call('/ISteamUserStats/GetSchemaForGame/v2/', { appid, l: lang }, { allowError: true });
  const list = body?.game?.availableGameStats?.achievements ?? [];
  const schema = Object.fromEntries(
    list.map((a) => [
      a.name,
      { name: a.displayName, description: a.description ?? '', icon: a.icon, iconGray: a.icongray, hidden: a.hidden === 1 },
    ]),
  );
  caches.schema.set(key, schema);
  return schema;
}

async function getGlobalPercentages(appid) {
  const cached = await caches.global.get(appid);
  if (cached) return cached;

  const { body } = await call('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', { gameid: appid }, { allowError: true });
  const map = Object.fromEntries(
    (body?.achievementpercentages?.achievements ?? []).map((a) => [a.name, Number.parseFloat(a.percent)]),
  );
  caches.global.set(appid, map);
  return map;
}

// ---------------------------------------------------------------- Steam Hunters (temps et difficulté du 100 %)

const SH_HEADERS = { Accept: 'application/json', 'User-Agent': 'SteamStats (vitrine de platines)' };
const hunterCache = new TtlCache({ ttlMs: 7 * DAY, ns: 'hunters' });

// Steam Hunters limite fortement les requêtes (réponse 429 + Retry-After) : on respecte la pause demandée.
let shPausedUntil = 0;
const shPaused = () => Date.now() < shPausedUntil;

async function shFetch(path) {
  if (shPaused()) return { retry: true };
  try {
    const res = await fetch(`https://steamhunters.com/api/${path}`, { headers: SH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) {
      shPausedUntil = Date.now() + (Number(res.headers.get('retry-after')) || 60) * 1000;
      return { retry: true };
    }
    if (res.status === 404) return { data: null };
    return { data: await res.json() }; // page de vérification anti-robots → JSON invalide → on réessaiera plus tard
  } catch {
    return { retry: true };
  }
}

/**
 * Statistiques de complétion publiées par Steam Hunters (steamhunters.com), pour ses membres :
 * temps médian pour atteindre 100 %, part de joueurs ayant tout débloqué, succès impossibles,
 * présence de DLC payants, points du jeu. Ne consomme pas le quota de la clé Steam.
 * Renvoie { appid: { median, perfected, started, unobtainable, paidDlc, points, count } | null }.
 */
export async function getHunterStats(appids) {
  const out = {};
  const missing = [];
  const cachedAll = await Promise.all(appids.map((appid) => hunterCache.get(appid)));
  appids.forEach((appid, i) => {
    const cached = cachedAll[i];
    // Les entrées d'avant le score n'ont pas les points du jeu : on les rafraîchit.
    if (cached === undefined || (cached && cached.points === undefined)) missing.push(appid);
    else out[appid] = cached;
  });

  for (let i = 0; i < missing.length; i += 100) {
    const ids = missing.slice(i, i + 100);
    const { data: list } = await shFetch(`apps?appIds=${ids.join(',')}`);
    if (!Array.isArray(list)) continue;
    const byId = new Map(list.map((g) => [g.appId, g]));
    for (const appid of ids) {
      const g = byId.get(appid);
      const stats = g
        ? {
            median: g.medianCompletionTime || null, // minutes
            perfected: g.playersPerfectedCount ?? 0,
            started: g.playersStartedCount ?? 0,
            unobtainable: g.unobtainableAchievementCount ?? 0,
            paidDlc: Boolean(g.hasPaidDlc),
            points: g.points ?? 0, // somme des points de ses succès
            count: g.achievementCount ?? 0,
          }
        : null;
      out[appid] = stats;
      hunterCache.set(appid, stats);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Steam Hunters : points des succès

const pointsCache = new TtlCache({ ttlMs: 30 * DAY, ns: 'shpoints' });

/** Télécharge les points des succès d'un jeu. Renvoie la table, ou undefined s'il faut réessayer plus tard. */
async function fetchHunterPoints(appid) {
  const { data, retry } = await shFetch(`apps/${appid}/achievements`);
  if (retry || (data !== null && !Array.isArray(data))) return undefined;
  const out = { p: {}, x: [] };
  for (const a of data ?? []) {
    out.p[a.apiName] = a.points ?? 0;
    if (a.obtainability) out.x.push(a.apiName);
  }
  pointsCache.set(appid, out);
  return out;
}

/**
 * Points Steam Hunters des succès d'un jeu : plus un succès est rare chez les chasseurs, plus il rapporte.
 * Les succès devenus impossibles à débloquer valent 0 et sont listés à part.
 * Renvoie { p: { apiname: points }, x: [apiname impossible] }, ou null si indisponible pour l'instant.
 */
export async function getHunterPoints(appid) {
  const cached = await pointsCache.get(appid);
  if (cached !== undefined) return cached;
  return (await fetchHunterPoints(appid)) ?? null;
}

// File d'attente : les points succès par succès arrivent au compte-gouttes, en arrière-plan,
// puis profitent à tous les profils (cache partagé en base).
const SH_GAP_MS = 2500;
const pointsQueue = new Set();
let pumping = false;
// La file est sauvegardée en base : l'hébergeur gratuit met le serveur en veille, elle reprend au réveil.
const queueStore = new TtlCache({ ttlMs: 14 * DAY, ns: 'shqueue' });
let queueSaveTimer = null;
function saveQueue() {
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => queueStore.set('pending', [...pointsQueue]), 5000);
}

/** Relance au démarrage les points qui restaient à récupérer. */
export async function resumeHunterQueue() {
  const pending = await queueStore.get('pending');
  if (pending?.length) queuePoints(pending);
}

function queuePoints(appids, { urgent = false } = {}) {
  if (urgent) {
    const rest = [...pointsQueue];
    pointsQueue.clear();
    for (const id of [...appids, ...rest]) pointsQueue.add(id);
  } else {
    for (const id of appids) pointsQueue.add(id);
  }
  saveQueue();
  pumpPoints();
}

async function pumpPoints() {
  if (pumping) return;
  pumping = true;
  try {
    while (pointsQueue.size) {
      if (shPaused()) await new Promise((ok) => setTimeout(ok, shPausedUntil - Date.now() + 500));
      const [appid] = pointsQueue;
      if ((await pointsCache.get(appid)) !== undefined) {
        pointsQueue.delete(appid); // déjà connu (autre profil, ou file reprise après redémarrage) : pas de pause
        continue;
      }
      if ((await fetchHunterPoints(appid)) !== undefined) pointsQueue.delete(appid);
      saveQueue();
      await new Promise((ok) => setTimeout(ok, SH_GAP_MS));
    }
  } finally {
    pumping = false;
  }
}

/**
 * Score de chasseur, calculé depuis le cache des succès du joueur (aucun appel Steam) :
 * somme des points Steam Hunters de ses succès débloqués.
 * - jeu platiné : tous ses points (une seule requête Steam Hunters pour 100 jeux) ;
 * - jeu entamé : points exacts de ses succès si on les a, sinon estimation au prorata,
 *   le temps que la file d'attente les récupère.
 * Relève aussi les « reliques » : succès débloqués qui ne peuvent plus l'être aujourd'hui.
 * Renvoie null tant que l'analyse des succès ou Steam Hunters ne couvrent pas (presque) tout le profil.
 */
export function computeScore(steamid) {
  // Deux demandes simultanées pour le même profil partagent le même calcul.
  if (!scoreInFlight.has(steamid)) {
    scoreInFlight.set(steamid, scoreOf(steamid).finally(() => scoreInFlight.delete(steamid)));
  }
  return scoreInFlight.get(steamid);
}
const scoreInFlight = new Map();

async function scoreOf(steamid) {
  const profile = await getProfileLite(steamid);
  const games = profile.games.filter((g) => g.hasStats);
  const lists = await cachedLists(steamid, games);
  if (games.length && lists.length / games.length < 0.9) return null;

  // Seuls les jeux où le joueur a débloqué quelque chose rapportent des points.
  const started = lists.filter(([, list]) => list.some(([, achieved]) => achieved === 1));
  const stats = await getHunterStats(started.map(([appid]) => appid));
  if (started.length && started.filter(([appid]) => appid in stats).length / started.length < 0.9) return null;

  // Points succès par succès, lus d'un coup (seuls les jeux entamés ou à reliques en ont besoin).
  const needPoints = started.filter(([appid, list]) => stats[appid] && (stats[appid].unobtainable || list.some(([, a]) => a !== 1)));
  const pointsOf = new Map(
    await Promise.all(needPoints.map(async ([appid]) => [appid, await pointsCache.get(appid)])),
  );

  let score = 0;
  let estimated = 0;
  const relics = [];
  const toFetch = [];
  const urgent = [];
  for (const [appid, list] of started) {
    const st = stats[appid];
    if (!st) continue; // jeu inconnu de Steam Hunters
    const unlocked = list.filter(([, achieved]) => achieved === 1);
    const platinum = unlocked.length === list.length;
    const pts = pointsOf.get(appid);

    if (platinum) score += st.points;
    else if (pts) score += unlocked.reduce((t, [name]) => t + (pts.p[name] ?? 0), 0);
    else if (st.points) {
      score += list.length ? Math.round((st.points * unlocked.length) / list.length) : 0;
      estimated++;
      toFetch.push(appid);
    }

    if (st.unobtainable) {
      if (platinum) relics.push({ appid, count: st.unobtainable, platinum: true });
      else if (pts) {
        const impossible = new Set(pts.x);
        const count = unlocked.filter(([name]) => impossible.has(name)).length;
        if (count) relics.push({ appid, count, platinum: false });
      } else urgent.push(appid);
    }
  }
  if (urgent.length) queuePoints(urgent, { urgent: true });
  if (toFetch.length) queuePoints(toFetch);
  relics.sort((x, y) => y.platinum - x.platinum || y.count - x.count);
  // Délai avant que les points de ce profil soient tous arrivés : le client ne revient qu'à ce moment-là.
  const queue = [...pointsQueue];
  const last = Math.max(-1, ...[...toFetch, ...urgent].map((id) => queue.indexOf(id)));
  const etaMs = last < 0 ? 0 : (last + 1) * SH_GAP_MS + Math.max(0, shPausedUntil - Date.now());
  return { steamid, score, estimated, etaMs, relics };
}

// ---------------------------------------------------------------- visuels des jeux

const STORE_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const artCache = new TtlCache({ ttlMs: 7 * 24 * HOUR, ns: 'art' });

/**
 * Vraies adresses des visuels d'un jeu. Depuis 2024, Steam range ceux des jeux récents sous un
 * identifiant (…/apps/<id>/<hash>/header.jpg) et certains fichiers ont des noms inattendus
 * (portrait.png…) : on les demande donc au magasin plutôt que de les deviner.
 * Renvoie { appid: { header, capsule, hero } | null }.
 */
export async function getArt(appids) {
  const out = {};
  const missing = [];
  for (const appid of appids) {
    const cached = await artCache.get(appid);
    if (cached === undefined) missing.push(appid);
    else out[appid] = cached;
  }

  for (let i = 0; i < missing.length; i += 50) {
    const ids = missing.slice(i, i + 50);
    const input = {
      ids: ids.map((appid) => ({ appid })),
      context: { language: 'french', country_code: 'FR' },
      data_request: { include_assets: true },
    };
    let items = [];
    try {
      const url = `${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      items = (await res.json())?.response?.store_items ?? [];
    } catch {
      continue; // magasin injoignable : on réessaiera plus tard (rien n'est mis en cache)
    }
    const byId = new Map(items.map((it) => [it.appid, it]));
    for (const appid of ids) {
      const a = byId.get(appid)?.assets;
      const make = (file) => (a?.asset_url_format && file ? STORE_ASSETS + a.asset_url_format.replace('${FILENAME}', file) : null);
      const art = a ? { header: make(a.header), capsule: make(a.library_capsule), hero: make(a.library_hero) } : null;
      out[appid] = art;
      artCache.set(appid, art);
    }
  }
  return out;
}

/**
 * Résumé d'un profil (nombre de platines, dernier, plus rare) calculé uniquement à partir du cache :
 * aucun appel à Steam. Renvoie null si la bibliothèque n'a pas été (assez) analysée.
 */
export async function computeSummary(steamid) {
  const profile = await getProfileLite(steamid);
  const games = profile.games.filter((g) => g.hasStats);
  const lists = await cachedLists(steamid, games);
  const known = lists.length;
  const plats = [];
  for (const [appid, list] of lists) {
    if (list?.length && list.every(([, achieved]) => achieved === 1)) {
      plats.push({ appid, at: Math.max(...list.map(([, , t]) => t || 0)) });
    }
  }
  // On ne publie pas un score partiel : il faut que l'analyse soit (quasi) complète.
  if (games.length && known / games.length < 0.9) return null;

  const latest = plats.reduce((m, p) => (p.at > (m?.at ?? -1) ? p : m), null);
  let rarest = null;
  const globals = await Promise.all(plats.map((p) => caches.global.get(p.appid)));
  for (const [i, p] of plats.entries()) {
    const global = globals[i];
    const values = Object.values(global ?? {}).filter(Number.isFinite);
    if (!values.length) continue;
    const pct = Math.min(...values);
    if (!rarest || pct < rarest.pct) rarest = { appid: p.appid, pct };
  }
  return {
    steamid,
    name: profile.player.name,
    avatar: profile.player.avatar,
    platinum: plats.length,
    latestAppid: latest?.appid ?? null,
    latestAt: latest?.at ?? null,
    rarestAppid: rarest?.appid ?? null,
    rarestPct: rarest?.pct ?? null,
  };
}

/**
 * Difficulté des platines, d'après les pourcentages mondiaux de déblocage :
 * - platinumMax : % du succès le plus rare du jeu, qui majore le % de joueurs ayant tout débloqué ;
 * - hardest : % du succès le plus rare parmi ceux qu'il reste au joueur (null s'il n'en reste aucun) ;
 * - remaining : nombre de succès restants.
 */
export async function getDifficulties(steamid, appids) {
  return mapLimit(appids, 6, async (appid) => {
    try {
      const [list, global] = await Promise.all([getPlayerAchievementList(steamid, appid), getGlobalPercentages(appid)]);
      const values = Object.values(global).filter(Number.isFinite);
      const locked = (list ?? []).filter(([, achieved]) => achieved !== 1).map(([name]) => global[name]);
      const known = locked.filter(Number.isFinite);
      return {
        appid,
        platinumMax: values.length ? Math.min(...values) : null,
        hardest: locked.length && known.length === locked.length ? Math.min(...known) : null,
        remaining: locked.length,
      };
    } catch {
      return { appid, platinumMax: null, hardest: null, remaining: null };
    }
  });
}

export async function getGameAchievements(steamid, appid) {
  const [list, schema, schemaEn, global, points] = await Promise.all([
    getPlayerAchievementList(steamid, appid),
    getSchema(appid).catch(() => ({})),
    // Nom original anglais, pratique pour chercher un succès sur internet.
    getSchema(appid, 'english').catch(() => ({})),
    getGlobalPercentages(appid).catch(() => ({})),
    getHunterPoints(appid),
  ]);
  if (!list) return { appid, achievements: [] };
  const impossible = new Set(points?.x ?? []);

  const achievements = list.map(([apiname, achieved, unlocktime]) => {
    const s = schema[apiname] ?? {};
    const en = schemaEn[apiname]?.name;
    return {
      id: apiname,
      name: s.name ?? apiname,
      nameEn: en && en !== s.name ? en : null,
      description: s.description ?? '',
      icon: achieved === 1 ? s.icon : s.iconGray ?? s.icon,
      hidden: s.hidden ?? false,
      achieved: achieved === 1,
      unlocktime: unlocktime || null,
      rarity: Number.isFinite(global[apiname]) ? global[apiname] : null,
      points: points?.p[apiname] ?? null,
      impossible: impossible.has(apiname),
    };
  });
  return { appid, achievements };
}
