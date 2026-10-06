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
};

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
  const profile = await getProfile(steamid);
  const games = profile.games.filter((g) => g.hasStats);
  let known = 0;
  const plats = [];
  for (const g of games) {
    const cached = await caches.achievements.get(`${steamid}:${g.appid}`);
    if (cached === undefined) continue;
    const list = cached.l;
    known++;
    if (list?.length && list.every(([, achieved]) => achieved === 1)) {
      plats.push({ appid: g.appid, at: Math.max(...list.map(([, , t]) => t || 0)) });
    }
  }
  // On ne publie pas un score partiel : il faut que l'analyse soit (quasi) complète.
  if (games.length && known / games.length < 0.9) return null;

  const latest = plats.reduce((m, p) => (p.at > (m?.at ?? -1) ? p : m), null);
  let rarest = null;
  for (const p of plats) {
    const global = await caches.global.get(p.appid);
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
  const [list, schema, schemaEn, global] = await Promise.all([
    getPlayerAchievementList(steamid, appid),
    getSchema(appid).catch(() => ({})),
    // Nom original anglais, pratique pour chercher un succès sur internet.
    getSchema(appid, 'english').catch(() => ({})),
    getGlobalPercentages(appid).catch(() => ({})),
  ]);
  if (!list) return { appid, achievements: [] };

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
    };
  });
  return { appid, achievements };
}
