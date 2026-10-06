import pg from 'pg';

// Base Postgres (Neon) facultative : sans DATABASE_URL, l'app garde son fonctionnement local
// (cache disque/mémoire, marquages dans le navigateur).

let pool = null;

export const hasDb = () => Boolean(pool);

/** À appeler après le chargement du .env (les imports ESM s'exécutent avant). */
export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  // « verify-full » : le comportement actuel de « require » dans pg, rendu explicite (évite un avertissement).
  pool = new pg.Pool({ connectionString: url.replace('sslmode=require', 'sslmode=verify-full'), max: 5, idleTimeoutMillis: 30000 });
  pool.on('error', (err) => console.warn('Postgres :', err.message));
  try {
    await migrate();
    return true;
  } catch (err) {
    console.warn('Base de données indisponible, fonctionnement local :', err.message);
    await pool.end().catch(() => {});
    pool = null;
    return false;
  }
}

async function migrate() {
  await pool.query(`
    create table if not exists kv_cache (
      ns text not null,
      key text not null,
      value jsonb,
      updated_at timestamptz not null default now(),
      primary key (ns, key)
    );
    create table if not exists game_totals (
      appid integer primary key,
      total integer not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists game_additions (
      appid integer not null,
      from_total integer not null,
      to_total integer not null,
      detected_at timestamptz not null default now(),
      primary key (appid, to_total)
    );
    create table if not exists user_marks (
      steamid text not null,
      appid integer not null,
      kind text not null,
      created_at timestamptz not null default now(),
      primary key (steamid, appid, kind)
    );
    create table if not exists profile_summaries (
      steamid text primary key,
      name text not null,
      avatar text,
      platinum integer not null,
      latest_appid integer,
      latest_at bigint,
      rarest_appid integer,
      rarest_pct real,
      updated_at timestamptz not null default now()
    );
    create table if not exists api_usage (
      day date primary key,
      calls integer not null default 0
    );
    create table if not exists user_snapshots (
      steamid text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
  `);
  // Types de marquages autorisés (la contrainte est recréée pour les bases déjà existantes).
  await pool.query(`
    alter table user_marks drop constraint if exists user_marks_kind_check;
    alter table user_marks add constraint user_marks_kind_check check (kind in ('goal', 'dlc', 'pin'));
  `);
  await cleanup();
  setInterval(cleanup, 12 * 3600 * 1000).unref();
}

/** Garde la base sous le quota gratuit : le cache expiré depuis longtemps est supprimé. */
async function cleanup() {
  try {
    // Les succès d'un jeu non joué restent valables longtemps : on garde 45 jours.
    // « ach » est l'ancien format du cache des succès (remplacé par « ach2 »).
    await pool.query(`delete from kv_cache where updated_at < now() - interval '45 days' or ns = 'ach'`);
  } catch (err) {
    console.warn('Nettoyage du cache :', err.message);
  }
}

// ---------------------------------------------------------------- cache clé/valeur

export async function kvGet(ns, key, ttlMs) {
  if (!pool) return undefined;
  const { rows } = await pool.query(
    `select value from kv_cache where ns = $1 and key = $2 and updated_at > now() - make_interval(secs => $3)`,
    [ns, key, ttlMs / 1000],
  );
  return rows.length ? rows[0].value : undefined;
}

// Les écritures sont groupées toutes les 2 s : une analyse de bibliothèque en produit des centaines.
const pending = new Map(); // `${ns}\u0000${key}` -> [ns, key, value]
let flushTimer = null;

export function kvSet(ns, key, value) {
  if (!pool) return;
  pending.set(`${ns}\u0000${key}`, [ns, key, value]);
  flushTimer ??= setTimeout(flush, 2000);
}

async function flush() {
  flushTimer = null;
  const rows = [...pending.values()];
  pending.clear();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const values = chunk.map(([ns, key, value], j) => {
      params.push(ns, key, JSON.stringify(value));
      return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::jsonb, now())`;
    });
    try {
      await pool.query(
        `insert into kv_cache (ns, key, value, updated_at) values ${values.join(',')}
         on conflict (ns, key) do update set value = excluded.value, updated_at = now()`,
        params,
      );
    } catch (err) {
      console.warn('Écriture du cache :', err.message);
    }
  }
}

// ---------------------------------------------------------------- succès ajoutés par des mises à jour

/**
 * Enregistre le nombre total de succès de chaque jeu (identique pour tous les joueurs)
 * et note une « addition » quand ce total augmente.
 */
export async function recordTotals(entries) {
  if (!pool || !entries.length) return;
  const params = entries.flat();
  const values = entries.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::int)`).join(',');
  try {
    await pool.query(
      `with incoming (appid, total) as (values ${values}),
       grown as (
         select i.appid, g.total as from_total, i.total as to_total
         from incoming i join game_totals g using (appid)
         where i.total > g.total
       ),
       added as (
         insert into game_additions (appid, from_total, to_total)
         select appid, from_total, to_total from grown
         on conflict do nothing
       )
       insert into game_totals (appid, total)
       select appid, total from incoming
       on conflict (appid) do update set total = excluded.total, updated_at = now()
       where game_totals.total <> excluded.total`,
      params,
    );
  } catch (err) {
    console.warn('Suivi des totaux :', err.message);
  }
}

/** Ajouts de succès des 60 derniers jours pour ces jeux : appid -> { from, to, at }. */
export async function getAdditions(appids) {
  if (!pool || !appids.length) return {};
  const { rows } = await pool.query(
    `select appid, min(from_total) as from_total, max(to_total) as to_total, max(detected_at) as at
     from game_additions
     where appid = any($1::int[]) and detected_at > now() - interval '60 days'
     group by appid`,
    [appids],
  );
  return Object.fromEntries(
    rows.map((r) => [r.appid, { from: r.from_total, to: r.to_total, at: Math.floor(new Date(r.at).getTime() / 1000) }]),
  );
}

// ---------------------------------------------------------------- marquages & instantanés (par compte)

export const MAX_PINS = 3;

export async function getMarks(steamid) {
  const { rows } = await pool.query(`select appid, kind from user_marks where steamid = $1 order by created_at`, [steamid]);
  const of = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.appid);
  return { goal: of('goal'), dlc: of('dlc'), pin: of('pin') };
}

/**
 * Active/désactive un marquage. Objectif et DLC s'excluent pour un même jeu ;
 * l'épingle (platine mis en avant) est indépendante, limitée à MAX_PINS.
 */
export async function setMark(steamid, appid, kind, on) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (kind === 'pin') {
      await client.query(`delete from user_marks where steamid = $1 and appid = $2 and kind = 'pin'`, [steamid, appid]);
      if (on) {
        const { rows } = await client.query(`select count(*)::int as n from user_marks where steamid = $1 and kind = 'pin'`, [steamid]);
        if (rows[0].n >= MAX_PINS) throw Object.assign(new Error(`${MAX_PINS} platines épinglés au maximum`), { status: 409 });
      }
    } else {
      await client.query(`delete from user_marks where steamid = $1 and appid = $2 and kind <> 'pin'`, [steamid, appid]);
    }
    if (on) await client.query(`insert into user_marks (steamid, appid, kind) values ($1, $2, $3)`, [steamid, appid, kind]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return getMarks(steamid);
}

/** Import des marquages faits dans le navigateur avant la synchronisation (sans écraser l'existant). */
export async function importMarks(steamid, marks) {
  const rows = [
    ...marks.goal.map((appid) => [appid, 'goal']),
    ...marks.dlc.filter((appid) => !marks.goal.includes(appid)).map((appid) => [appid, 'dlc']),
    ...marks.pin.slice(0, MAX_PINS).map((appid) => [appid, 'pin']),
  ].slice(0, 2000);
  if (rows.length) {
    const params = [steamid];
    const values = rows.map(([appid, kind], i) => {
      params.push(appid, kind);
      return `($1, $${i * 2 + 2}::int, $${i * 2 + 3})`;
    });
    await pool.query(
      `insert into user_marks (steamid, appid, kind)
       select v.steamid, v.appid, v.kind from (values ${values.join(',')}) as v (steamid, appid, kind)
       where not exists (
         select 1 from user_marks m
         where m.steamid = v.steamid and m.appid = v.appid
           and (m.kind = v.kind or (m.kind <> 'pin' and v.kind <> 'pin'))
       )`,
      params,
    );
  }
  return getMarks(steamid);
}

// ---------------------------------------------------------------- compteur d'appels Steam

export async function getUsage(day) {
  if (!pool) return 0;
  const { rows } = await pool.query(`select calls from api_usage where day = $1`, [day]);
  return rows[0]?.calls ?? 0;
}

export async function addUsage(day, n) {
  if (!pool || !n) return;
  await pool.query(
    `insert into api_usage (day, calls) values ($1, $2)
     on conflict (day) do update set calls = api_usage.calls + excluded.calls`,
    [day, n],
  );
}

// ---------------------------------------------------------------- résumés de profils (classement entre amis)

export async function saveSummary(s) {
  await pool.query(
    `insert into profile_summaries (steamid, name, avatar, platinum, latest_appid, latest_at, rarest_appid, rarest_pct, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (steamid) do update set
       name = excluded.name, avatar = excluded.avatar, platinum = excluded.platinum,
       latest_appid = excluded.latest_appid, latest_at = excluded.latest_at,
       rarest_appid = excluded.rarest_appid, rarest_pct = excluded.rarest_pct, updated_at = now()`,
    [s.steamid, s.name, s.avatar, s.platinum, s.latestAppid, s.latestAt, s.rarestAppid, s.rarestPct],
  );
}

export async function getSummaries(steamids) {
  if (!steamids.length) return [];
  const { rows } = await pool.query(
    `select steamid, name, avatar, platinum, latest_appid, latest_at, rarest_appid, rarest_pct, updated_at
     from profile_summaries where steamid = any($1::text[])`,
    [steamids],
  );
  return rows.map((r) => ({
    steamid: r.steamid,
    name: r.name,
    avatar: r.avatar,
    platinum: r.platinum,
    latestAppid: r.latest_appid,
    latestAt: r.latest_at == null ? null : Number(r.latest_at),
    rarestAppid: r.rarest_appid,
    rarestPct: r.rarest_pct,
    updatedAt: Math.floor(new Date(r.updated_at).getTime() / 1000),
  }));
}

export async function getSnapshot(steamid) {
  const { rows } = await pool.query(`select data from user_snapshots where steamid = $1`, [steamid]);
  return rows[0]?.data ?? null;
}

export async function saveSnapshot(steamid, data) {
  await pool.query(
    `insert into user_snapshots (steamid, data) values ($1, $2)
     on conflict (steamid) do update set data = excluded.data, updated_at = now()`,
    [steamid, JSON.stringify(data)],
  );
}
