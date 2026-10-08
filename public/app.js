// ---------------------------------------------------------------- utilitaires

import {
  $,
  nf,
  dateFmt,
  monthFmt,
  monthShort,
  ART_HOSTS,
  esc,
  icon,
  fmtHours,
  fmtDate,
  fmtPct,
  getJSON,
  artImg,
  gameIconUrl,
  rarityTier,
  rarityHalo,
  fmtRarity,
  fmtCompact,
  DIFFICULTY_TIERS,
  difficultyTier,
  fmtDuration,
  boxHTML,
  sendJSON,
} from './utils.js';
import { celebrate } from './celebrate.js';
import { trackNewAchievements } from './tracking.js';
import { byAccessibility, findNextPlatinums, renderNextPlatinums } from './nextplat.js';
import { openShareCard } from './sharecard.js';
import { hallHTML, revealPlaques } from './hall.js';
import { makeSpinnable } from './disc.js';
import { MAX_PINS, loadMarks, saveMarks, toggleMark } from './marks.js';
import { applyAmbient, restoreAmbient, updateAmbient } from './ambient.js';
import { installArtFallback, preloadArt, registerIcons } from './art.js';

const app = $('#app');
const SCAN_BATCH = 25;
const LIB_PAGE = 60;

const playLabel = (g) => (g.playtime ? fmtHours(g.playtime) : state.profile?.playtimeHidden ? 'Temps masqué' : 'Jamais lancé');

installArtFallback();

// ---------------------------------------------------------------- état

const state = {
  me: null,
  sync: false, // base de données disponible côté serveur
  steamid: null,
  profile: null,
  ach: new Map(), // appid -> { total, unlocked, percent, times }
  rarity: new Map(), // appid -> % de joueurs ayant platiné (exact chez les chasseurs, sinon majorant Steam)
  rarityHunt: new Set(), // jeux dont la rareté vient de Steam Hunters (part réelle de chasseurs l'ayant platiné)
  score: null, // score de chasseur { score, relics } (null = pas encore calculé, 'loading' = en cours)
  diff: new Map(), // appid -> { hardest, remaining, platinumMax } (difficulté du platine)
  diffScan: { done: 0, total: 0, running: false },
  added: new Map(), // appid -> { from, to, at } : succès ajoutés récemment par une mise à jour
  hunters: new Map(), // appid -> stats Steam Hunters { median, perfected, started, unobtainable, paidDlc }
  friends: [],
  summaries: new Map(), // steamid -> résumé (platines…) des profils déjà analysés
  friendView: 'all', // 'all' | 'ranking'
  next: null, // recommandations « prochain platine » (null = pas encore calculées)
  newPlats: new Set(), // platines obtenus depuis la dernière visite
  scan: { done: 0, total: 0, running: false, error: null },
  lib: { filter: 'all', sort: 'playtime', search: '', limit: LIB_PAGE },
  dlcBlocked: new Set(), // jeux dont le platine est bloqué par un DLC (marquage manuel)
  goals: new Set(), // objectifs de platine (marquage manuel)
  pins: new Set(), // platines épinglés (vitrine + carte de chasseur), dans l'ordre d'épinglage
  tierOpen: new Set(), // rangs de la tier list dépliés
  hallOpen: false, // salle des trophées affichée (#/u/<id>/trophees)
  token: 0,
};

function statusOf(g) {
  if (!g.hasStats) return { kind: 'none' };
  const a = state.ach.get(g.appid);
  if (!a) return { kind: state.scan.running ? 'pending' : 'none' };
  if (!a.total) return { kind: 'none' };
  if (a.unlocked === a.total) return { kind: 'platinum', a };
  if (a.unlocked === 0) return { kind: 'notstarted', a };
  return { kind: 'progress', a };
}

function compute() {
  const { games } = state.profile;
  const s = {
    totalMin: 0,
    min2w: 0,
    deckMin: 0,
    played: 0,
    never: 0,
    withAch: 0,
    unlocked: 0,
    available: 0,
    notStarted: 0,
    platinum: [],
    progress: [],
    times: [], // [timestamp, game]
    maxPlaytime: 0,
  };

  for (const g of games) {
    s.totalMin += g.playtime;
    s.min2w += g.playtime2w;
    s.deckMin += g.playtimeDeck;
    s.maxPlaytime = Math.max(s.maxPlaytime, g.playtime);
    if (g.playtime > 0) s.played++;
    else s.never++;

    const st = statusOf(g);
    g.status = st;
    if (!st.a?.total) continue;

    s.withAch++;
    s.unlocked += st.a.unlocked;
    s.available += st.a.total;
    for (const t of st.a.times) s.times.push([t, g]);

    if (st.kind === 'platinum') s.platinum.push({ g, a: st.a, date: st.a.times.at(-1) ?? 0 });
    else if (st.kind === 'progress') s.progress.push({ g, a: st.a });
    else s.notStarted++;
  }

  // Numéro de platine chronologique (n°1 = le tout premier) et durée de la chasse (premier succès → platine).
  s.platinum.sort((x, y) => x.date - y.date);
  s.platinum.forEach((p, i) => {
    p.num = i + 1;
    p.hunt = p.date - (p.a.times[0] ?? p.date);
  });
  s.platinum.reverse();
  s.progress.sort((x, y) => y.a.percent - x.a.percent || x.a.total - x.a.unlocked - (y.a.total - y.a.unlocked));
  s.times.sort((x, y) => x[0] - y[0]);

  const started = [...s.platinum, ...s.progress];
  s.avgCompletion = started.length ? started.reduce((t, x) => t + x.a.percent, 0) / started.length : null;
  return s;
}

// ---------------------------------------------------------------- navigation

async function boot() {
  const params = new URLSearchParams(location.search);
  const auth = params.get('auth');
  if (auth) {
    const msg = {
      cancel: 'Connexion Steam annulée.',
      invalid: 'La réponse de Steam n’a pas pu être vérifiée. Réessaie.',
      error: 'Steam est injoignable pour le moment. Réessaie plus tard.',
    }[auth];
    if (msg) showBanner(msg);
    history.replaceState(null, '', `/${location.hash}`);
  }

  try {
    const me = await getJSON('/api/me');
    state.me = me.steamid;
    state.sync = Boolean(me.sync);
  } catch {
    state.me = null;
  }

  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const m = /^#\/u\/(\d{17})(\/trophees)?/.exec(location.hash);
  const id = m?.[1] ?? state.me;
  state.hallOpen = Boolean(m?.[2]);
  renderTopbar(id);
  if (!id) {
    renderHall();
    state.token++;
    state.steamid = null;
    renderLanding();
    return;
  }
  if (id !== state.steamid || !state.profile) loadProfile(id);
  renderHall();
}

function showBanner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => (b.hidden = true), 8000);
}

async function goToProfile(q, onError) {
  const { steamid } = await getJSON(`/api/resolve?q=${encodeURIComponent(q)}`).catch((ex) => {
    onError(ex.message);
    return {};
  });
  if (steamid) location.hash = `#/u/${steamid}`;
  return Boolean(steamid);
}

$('#topSearch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.q;
  const q = input.value.trim();
  if (!q) return;
  input.disabled = true;
  const ok = await goToProfile(q, showBanner);
  input.disabled = false;
  if (ok) {
    input.value = '';
    input.blur();
  } else {
    input.focus();
  }
});

function renderTopbar(viewing) {
  // Sur l'accueil, le champ de recherche est déjà au centre de la page.
  $('#topSearch').hidden = !viewing;
  const nav = $('#topActions');
  if (state.me) {
    nav.innerHTML = `
      ${viewing && viewing !== state.me ? `<a class="btn" href="#/" aria-label="Mon profil">${icon("user")}<span class="btn-label">Mon profil</span></a>` : ''}
      <button class="btn" id="logoutBtn" type="button" aria-label="Déconnexion">${icon("logout")}<span class="btn-label">Déconnexion</span></button>`;
    $('#logoutBtn').onclick = async () => {
      await fetch('/auth/logout', { method: 'POST' });
      state.me = null;
      state.profile = null;
      location.hash = '';
      route();
    };
  } else {
    nav.innerHTML = `<a class="btn btn-primary" href="/auth/steam">${icon('steam')}<span class="btn-label">Se connecter</span></a>`;
  }
}

// ---------------------------------------------------------------- accueil

/** Teinte le fond de la page avec les couleurs de 1 à 3 jeux (voir ambientSources). */
let ambientKey = '';
function setAmbient(appids) {
  const ids = [...new Set(appids.filter(Boolean))].slice(0, 3);
  const key = ids.join(',');
  if (!ids.length || key === ambientKey) return;
  ambientKey = key;
  updateAmbient(state.steamid, ids);
}

/**
 * Jeux qui donnent leurs couleurs au fond : les platines épinglés d'abord,
 * complétés par le dernier platine, le plus rare, puis le jeu le plus joué.
 */
function ambientSources() {
  const plats = compute().platinum;
  const isPlat = new Set(plats.map((p) => p.g.appid));
  const rarest = plats
    .filter((p) => state.rarity.has(p.g.appid))
    .sort((x, y) => state.rarity.get(x.g.appid) - state.rarity.get(y.g.appid))[0];
  const mostPlayed = [...state.profile.games].sort((a, b) => b.playtime - a.playtime)[0];
  return [...[...state.pins].filter((id) => isPlat.has(id)), plats[0]?.g.appid, rarest?.g.appid, mostPlayed?.appid];
}

function renderLanding() {
  ambientKey = '';
  applyAmbient(null);
  app.innerHTML = `
    <section class="landing">
      <div class="landing-inner">
        <div class="landing-trophy">${icon('trophy')}</div>
        <h1>Ta bibliothèque Steam,<br><span class="plat-text">en vitrine.</span></h1>
        <p class="lead">Tes platines, tes succès et ton temps de jeu.</p>
        <a class="btn btn-primary btn-lg" href="/auth/steam">${icon('steam')} Se connecter avec Steam</a>
        <div class="divider">ou consulter un profil public</div>
        <form class="lookup" id="lookup">
          <input class="input" name="q" autocomplete="off" spellcheck="false"
            placeholder="URL de profil, SteamID64 ou pseudo personnalisé" aria-label="Profil Steam">
          <button class="btn" type="submit">Voir</button>
        </form>
        <div class="form-error" id="lookupError" role="alert"></div>
        <p class="note">Le profil et les « détails des jeux » doivent être publics dans les paramètres de confidentialité Steam.</p>
      </div>
    </section>`;

  $('#lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    const err = $('#lookupError');
    const btn = e.target.querySelector('button');
    if (!q) return;
    btn.disabled = true;
    err.textContent = '';
    await goToProfile(q, (msg) => (err.textContent = msg));
    btn.disabled = false;
  });
}

// ---------------------------------------------------------------- chargement

async function loadProfile(steamid, { refresh = false } = {}) {
  const token = ++state.token;
  state.steamid = steamid;
  state.profile = null;
  state.ach = new Map();
  state.rarity = new Map();
  state.rarityHunt = new Set();
  state.score = null;
  state.diff = new Map();
  state.diffScan = { done: 0, total: 0, running: false };
  state.added = new Map();
  state.hunters = new Map();
  // Objectifs, marquages DLC et épingles ne concernent que son propre profil, une fois connecté.
  ({ dlc: state.dlcBlocked, goal: state.goals, pin: state.pins } =
    state.me && steamid === state.me ? loadMarks(steamid) : { dlc: new Set(), goal: new Set(), pin: new Set() });
  state.tierOpen = new Set();
  state.friends = [];
  state.summaries = new Map();
  state.next = null;
  state.newPlats = new Set();
  state.lib.limit = LIB_PAGE;
  counted.clear();
  seenPlat.clear();
  lastRankKey = '';
  lastPlatKey = '';
  lastTierKey = '';
  lastHallKey = '';
  lastGoalKey = '';
  lastNext = undefined;
  window.scrollTo({ top: 0 });
  app.innerHTML = `<div class="loading"><div class="spinner"></div>Chargement de la bibliothèque…</div>`;

  let profile;
  try {
    profile = await getJSON(`/api/profile/${steamid}${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    if (token !== state.token) return;
    renderNotice('Impossible de charger ce profil', err.message);
    return;
  }
  if (token !== state.token) return;

  state.profile = profile;
  // Steam renvoie 0 partout quand le joueur a choisi de garder son temps de jeu privé.
  profile.playtimeHidden = profile.games.length > 0 && profile.games.every((g) => !g.playtime);
  if (!profile.games.length) {
    renderNotice(
      profile.gamesHidden ? 'Bibliothèque privée' : 'Aucun jeu',
      profile.gamesHidden
        ? `Les « détails des jeux » de ${esc(profile.player.name)} ne sont pas publics. Dans Steam : Profil → Modifier le profil → Paramètres de confidentialité → Détails des jeux : Public.`
        : `${esc(profile.player.name)} ne possède aucun jeu pour le moment.`,
      profile.gamesHidden && steamid === state.me
        ? `<a class="btn btn-primary" href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noopener">Ouvrir mes paramètres de confidentialité</a>`
        : '',
    );
    return;
  }

  registerIcons(profile.games);
  preloadArt(profile.games.map((g) => g.appid));
  renderDashboard();
  // Ambiance : celle mémorisée pour ce profil, sinon le jeu le plus joué en attendant l'analyse.
  const saved = restoreAmbient(steamid);
  if (saved?.appids?.length) ambientKey = saved.appids.join(',');
  else setAmbient([[...profile.games].sort((a, b) => b.playtime - a.playtime)[0]?.appid]);
  // Les amis ne s'affichent que sur son propre profil, une fois connecté.
  if (state.me && steamid === state.me) loadFriends(token);
  if (ownSynced()) syncMarks(token);
  scanAchievements(token, refresh);
}

async function scanAchievements(token, refresh) {
  const queue = state.profile.games.filter((g) => g.hasStats).sort((a, b) => b.playtime - a.playtime);
  state.scan = { done: 0, total: queue.length, running: queue.length > 0, error: null };
  update();

  for (let i = 0; i < queue.length; i += SCAN_BATCH) {
    const ids = queue.slice(i, i + SCAN_BATCH).map((g) => g.appid);
    try {
      const results = await getJSON(`/api/achievements/${state.steamid}?appids=${ids.join(',')}${refresh ? '&refresh=1' : ''}`);
      if (token !== state.token) return;
      for (const r of results) if (!r.error) state.ach.set(r.appid, r);
    } catch (err) {
      if (token !== state.token) return;
      if (err.status === 403) {
        state.scan.error = 'Les succès de ce profil sont privés : seuls les temps de jeu sont disponibles.';
        break;
      }
      state.scan.error = `Certains jeux n’ont pas pu être analysés (${err.message}).`;
    }
    state.scan.done = Math.min(i + SCAN_BATCH, queue.length);
    scheduleUpdate();
  }

  if (token !== state.token) return;
  state.scan.running = false;
  update();
  await detectAddedAchievements();
  if (token !== state.token) return;
  update();
  await Promise.all([loadDifficulty(token), loadHunters(token)]);
  if (token !== state.token) return;
  setAmbient(ambientSources());
  publishSummary(token).then(() => loadScore(token));
  if (token !== state.token) return;
  await loadNext(token);
  if (token !== state.token) return;
  $('#shareBtn').disabled = false;
  checkProgress();
}

let updateTimer = null;
let lastUpdate = 0;
function scheduleUpdate() {
  if (updateTimer) return;
  const wait = Math.max(0, 700 - (performance.now() - lastUpdate));
  updateTimer = setTimeout(() => {
    updateTimer = null;
    update();
  }, wait);
}

function renderNotice(title, text, action = '') {
  app.innerHTML = `
    <div class="notice">
      <h2>${esc(title)}</h2>
      <p>${text}</p>
      ${action}
      <div><a class="btn" href="#/" style="margin-top:12px">Retour</a></div>
    </div>`;
}

// ---------------------------------------------------------------- tableau de bord

function renderDashboard() {
  const { player } = state.profile;

  app.innerHTML = `
    <section class="profile">
      <div class="avatar-wrap" id="avatarWrap"><img class="avatar" src="${esc(player.avatar)}" alt=""></div>
      <div class="profile-main">
        <h1 class="profile-name">${esc(player.name)}</h1>
        <div class="rank" id="rank"></div>
        <div class="profile-sub">
          <a href="${esc(player.url)}" target="_blank" rel="noopener">Profil Steam ↗</a>
        </div>
      </div>
      <div class="profile-actions">
        <button class="btn btn-primary" id="shareBtn" type="button" disabled>${icon('share')} Carte de chasseur</button>
        <button class="btn" id="refreshBtn" type="button">${icon('refresh')} Rafraîchir</button>
      </div>
    </section>

    <section class="friends" id="friends" hidden></section>

    <div class="scan" id="scan"></div>
    <section class="tiles" id="tiles"></section>

    <section class="section trophy-case">
      <div class="section-head"><h2>Vitrine des platines<span class="count" id="platCount"></span></h2><a class="btn hall-btn" href="#/u/${state.steamid}/trophees">${icon('trophy')} Entrer dans la salle des trophées</a></div>
      <div class="plat-features" id="platFeature"></div>
      <div id="plat"></div>
    </section>

    <section class="section goals-section" id="goalsSection" hidden>
      <div class="section-head"><h2>${icon('star')} Mes objectifs de platine<span class="count" id="goalCount"></span></h2></div>
      <div id="goals"></div>
    </section>

    <section class="section" id="addedSection" hidden>
      <div class="section-head"><h2>Nouveaux succès ajoutés</h2></div>
      <div id="added"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Ton prochain platine</h2></div>
      <div id="nextPlat"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Tier list des platines à faire</h2><p>Selon le succès restant le plus rare</p></div>
      <div id="tiers"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Presque platinés</h2><p>75 % et plus</p></div>
      <div id="nearly"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Statistiques</h2></div>
      <div class="charts" id="charts"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Le saviez-vous ?</h2></div>
      <div class="facts" id="facts"></div>
    </section>

    <section class="section" id="library">
      <div class="section-head"><h2>Bibliothèque<span class="count" id="libCount"></span></h2></div>
      <div class="toolbar">
        <input class="input" id="libSearch" type="search" placeholder="Rechercher un jeu…" aria-label="Rechercher un jeu" value="${esc(state.lib.search)}">
        <div class="chips" id="libChips" role="group" aria-label="Filtrer"></div>
        <select class="select" id="libSort" aria-label="Trier">
          <option value="playtime">Temps de jeu</option>
          <option value="completion">Complétion</option>
          <option value="accessible">Platine le plus accessible</option>
          <option value="recent">Joué récemment</option>
          <option value="name">Nom</option>
        </select>
      </div>
      <div class="lib-grid" id="libGrid"></div>
      <div class="lib-more" id="libMore"></div>
    </section>`;

  $('#refreshBtn').onclick = () => loadProfile(state.steamid, { refresh: true });
  $('#shareBtn').onclick = shareCard;
  $('#libSort').value = state.lib.sort;
  $('#libSort').onchange = (e) => {
    state.lib.sort = e.target.value;
    state.lib.limit = LIB_PAGE;
    renderLibrary(compute());
  };
  $('#libSearch').oninput = (e) => {
    state.lib.search = e.target.value;
    state.lib.limit = LIB_PAGE;
    renderLibrary(compute());
  };

  app.onclick = (e) => {
    const el = e.target.closest('[data-appid]');
    if (el) openGame(Number(el.dataset.appid));
  };
  $('#tiers').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tier-toggle]');
    if (!btn) return;
    const id = btn.dataset.tierToggle;
    if (state.tierOpen.has(id)) state.tierOpen.delete(id);
    else state.tierOpen.add(id);
    renderTiers(compute());
  });

  update();
}

function update() {
  if (!state.profile || !$('#tiles')) return;
  lastUpdate = performance.now();
  const s = compute();
  renderScan();
  renderRank(s);
  renderTiles(s);
  renderPlatinum(s);
  renderAdded();
  renderNext();
  renderTiers(s);
  renderGoals(s);
  renderNearly(s);
  renderCharts(s);
  renderFacts(s);
  renderLibrary(s);
  renderHall(s);
}

function renderScan() {
  const el = $('#scan');
  const { done, total, running, error } = state.scan;
  if (!running && !error && state.diffScan.running) {
    const d = state.diffScan;
    el.hidden = false;
    el.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
       <span>Évaluation de la difficulté des platines… ${d.done} / ${d.total} jeux</span>
       <div class="bar"><i style="width:${d.total ? (d.done / d.total) * 100 : 0}%"></i></div>`;
    return;
  }
  if (!running && !error) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = running
    ? `<div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
       <span>Analyse des succès… ${done} / ${total} jeux</span>
       <div class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
       ${error ? `<span class="scan-error">${esc(error)}</span>` : ''}`
    : `<span class="scan-error">${esc(error)}</span>`;
}

function tile({ label, value, unit = '', hint = '', cls = '' }) {
  return `
    <div class="tile ${cls}">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${value}${unit ? `<small>${unit}</small>` : ''}</div>
      ${hint ? `<div class="tile-hint">${hint}</div>` : ''}
    </div>`;
}

const relicCount = () => (state.score?.relics ?? []).reduce((t, r) => t + r.count, 0);
const relicPlatCount = () => (state.score?.relics ?? []).filter((r) => r.platinum).length;

function renderTiles(s) {
  const games = state.profile.games.length;
  const hours = Math.round(s.totalMin / 60);
  const days = s.totalMin / 60 / 24;
  const pending = state.scan.running ? '…' : '—';
  const achReady = s.withAch > 0;

  const hidden = state.profile.playtimeHidden;
  $('#tiles').innerHTML = [
    hidden
      ? tile({ cls: 'hero', label: 'Temps de jeu total', value: 'Masqué', hint: 'Ce joueur garde son temps de jeu privé sur Steam' })
      : tile({
      cls: 'hero',
      label: 'Temps de jeu total',
      value: countSpan('hours', hours),
      unit: 'h',
      hint: `soit ${days.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} jours non-stop · ${(days / 365.25).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} an`,
    }),
    tile({
      cls: 'plat',
      label: `${icon('trophy')} Jeux platinés`,
      value: state.scan.running ? '…' : achReady ? countSpan('plat', s.platinum.length) : '—',
      hint: state.scan.running
        ? 'Analyse en cours…'
        : achReady
          ? [`sur ${nf.format(s.withAch)} jeux avec succès`, ultraCount(s) ? `dont ${ultraCount(s)} ultra-rare${ultraCount(s) > 1 ? 's' : ''}` : '']
              .filter(Boolean)
              .join(' · ')
          : '',
    }),
    tile({
      cls: 'score',
      label: `${icon('star')} Score de chasseur`,
      value:
        state.score?.score != null
          ? `${state.score.estimated ? '≈ ' : ''}${fmtCompact(state.score.score)}`
          : state.score === 'loading' || state.scan.running
            ? '…'
            : '—',
      unit: state.score?.score != null ? 'pts' : '',
      hint:
        state.score === 'loading'
          ? 'Calcul des points…'
          : state.score?.estimated
            ? `Points Steam Hunters · ${nf.format(state.score.estimated)} jeu${state.score.estimated > 1 ? 'x' : ''} encore estimé${state.score.estimated > 1 ? 's' : ''}, affinage en cours`
            : 'Points Steam Hunters : plus un succès est rare, plus il rapporte',
    }),
    relicCount() ? tile({
      cls: 'relic',
      label: 'Reliques',
      value: nf.format(relicCount()),
      hint: `succès devenus impossibles à obtenir${relicPlatCount() ? ` · dont ${relicPlatCount()} platine${relicPlatCount() > 1 ? 's' : ''}` : ''}`,
    }) : '',
    tile({
      label: 'Complétion moyenne',
      value: s.avgCompletion != null ? Math.round(s.avgCompletion) : pending,
      unit: s.avgCompletion != null ? '%' : '',
      hint: s.avgCompletion != null ? `sur ${nf.format(s.platinum.length + s.progress.length)} jeux commencés` : '',
    }),
    tile({
      label: 'Succès débloqués',
      value: achReady ? nf.format(s.unlocked) : pending,
      hint: achReady ? `sur ${nf.format(s.available)} · ${Math.round((s.unlocked / s.available) * 100)} %` : '',
    }),
    tile({ label: 'Jeux possédés', value: nf.format(games), hint: hidden ? '' : `${nf.format(s.played)} lancés au moins une fois` }),
    hidden ? '' : tile({
      label: 'Jamais lancés',
      value: nf.format(s.never),
      hint: `${Math.round((s.never / games) * 100)} % de la bibliothèque`,
    }),
    hidden ? '' : tile({
      label: '2 dernières semaines',
      value: fmtHours(s.min2w).replace(/ (h|min)$/, ''),
      unit: / min$/.test(fmtHours(s.min2w)) ? 'min' : 'h',
      hint: `${state.profile.recent.length} jeu${state.profile.recent.length > 1 ? 'x' : ''} lancé${state.profile.recent.length > 1 ? 's' : ''}`,
    }),
    s.deckMin > 0
      ? tile({
          label: 'Sur Steam Deck',
          value: nf.format(Math.round(s.deckMin / 60)),
          unit: 'h',
          hint: `${Math.round((s.deckMin / s.totalMin) * 100)} % du temps de jeu`,
        })
      : '',
  ].join('');
  runCountUps();
}

// ---------------------------------------------------------------- compteurs animés

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const counted = new Set(); // clés déjà animées pour le profil courant

const countSpan = (key, n) => `<span data-count="${n}" data-key="${key}">${nf.format(n)}</span>`;

/** Fait défiler les chiffres une seule fois par profil, quand la valeur finale est connue. */
function runCountUps() {
  for (const el of document.querySelectorAll('[data-count]')) {
    const key = el.dataset.key;
    if (counted.has(key)) continue;
    counted.add(key);
    const to = Number(el.dataset.count);
    if (reduceMotion.matches || to < 2) continue;

    const duration = Math.min(1400, 600 + to * 8);
    const start = performance.now();
    const token = state.token;
    const tick = (now) => {
      // Les rendus successifs remplacent l'élément : on le retrouve à chaque image.
      const node = document.querySelector(`[data-key="${key}"]`);
      if (!node || token !== state.token) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 4; // ease-out : rapide au début, se pose en douceur
      node.textContent = nf.format(Math.round(to * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ---------------------------------------------------------------- rang & rareté

const RANKS = [
  { min: 0, name: 'Recrue', tone: 'rookie' },
  { min: 1, name: 'Bronze', tone: 'bronze' },
  { min: 5, name: 'Argent', tone: 'silver' },
  { min: 15, name: 'Or', tone: 'gold' },
  { min: 30, name: 'Platine', tone: 'plat' },
  { min: 60, name: 'Diamant', tone: 'diamond' },
  { min: 100, name: 'Légende', tone: 'legend' },
];

function rankOf(count) {
  let i = 0;
  while (i + 1 < RANKS.length && count >= RANKS[i + 1].min) i++;
  return { ...RANKS[i], next: RANKS[i + 1] ?? null };
}

const ultraCount = (s) => s.platinum.filter((x) => state.rarity.get(x.g.appid) <= 5).length;

let lastRankKey = '';
function renderRank(s) {
  const el = $('#rank');
  if (state.scan.running) {
    if (lastRankKey !== 'pending') el.innerHTML = `<span class="rank-chip rank-pending">Calcul du rang…</span>`;
    lastRankKey = 'pending';
    return;
  }
  const n = s.platinum.length;
  const r = rankOf(n);
  const key = `${r.tone}:${n}`;
  if (key === lastRankKey) return;
  lastRankKey = key;

  $('#avatarWrap').className = `avatar-wrap tone-${r.tone}`;
  const progress = r.next ? ((n - r.min) / (r.next.min - r.min)) * 100 : 100;
  const left = r.next ? r.next.min - n : 0;
  el.innerHTML = `
    <span class="rank-chip tone-${r.tone}" title="Rang calculé sur le nombre de jeux platinés">${icon('trophy')} Rang ${r.name}</span>
    <span class="rank-progress">
      <span class="bar"><i style="width:${progress}%"></i></span>
      <span class="rank-next">${r.next ? `${left} platine${left > 1 ? 's' : ''} avant le rang ${r.next.name}` : 'Rang maximum atteint'}</span>
    </span>`;
}

// ---------------------------------------------------------------- difficulté des platines

/**
 * Récupère, pour chaque jeu avec succès, la rareté de son platine et la difficulté de ce qu'il reste.
 * Ordre : platinés (vitrine), puis jeux commencés (tier list).
 */
async function loadDifficulty(token) {
  const s = compute();
  const order = [...s.platinum, ...s.progress.sort((x, y) => y.a.percent - x.a.percent)].map((x) => x.g.appid);
  // Jeux jamais commencés exclus : leur difficulté sert peu et coûterait un appel Steam chacun.
  const ids = order.filter((id) => !state.diff.has(id));

  state.diffScan = { done: 0, total: ids.length, running: ids.length > 0 };
  update();
  for (let i = 0; i < ids.length; i += SCAN_BATCH) {
    try {
      const res = await getJSON(`/api/difficulty/${state.steamid}?appids=${ids.slice(i, i + SCAN_BATCH).join(',')}`);
      if (token !== state.token) return;
      for (const r of res) {
        state.diff.set(r.appid, r);
        if (r.platinumMax != null && !state.rarityHunt.has(r.appid)) state.rarity.set(r.appid, r.platinumMax);
      }
    } catch {
      break; // la difficulté est un bonus : on garde ce qui a pu être calculé
    }
    state.diffScan.done = Math.min(i + SCAN_BATCH, ids.length);
    scheduleUpdate();
  }
  if (token !== state.token) return;
  state.diffScan.running = false;
  update();
}

let lastTierKey = '';
function renderTiers(s) {
  const el = $('#tiers');
  const games = s.progress.filter((x) => state.diff.get(x.g.appid)?.hardest != null && !state.dlcBlocked.has(x.g.appid));
  const key = `${state.scan.running}|${state.diffScan.running}|${games.length}|${state.diff.size}|${[...state.dlcBlocked]}|${[...state.goals]}|${[...state.tierOpen]}|${state.hunters.size}`;
  if (key === lastTierKey) return;
  lastTierKey = key;

  if (!games.length) {
    el.innerHTML = `<div class="empty">${
      state.scan.running || state.diffScan.running ? 'Évaluation de la difficulté de tes platines…' : 'Aucun jeu commencé à classer pour le moment.'
    }</div>`;
    return;
  }

  const rows = DIFFICULTY_TIERS.map((tier) => ({
    tier,
    items: games
      .filter((x) => difficultyTier(state.diff.get(x.g.appid).hardest) === tier)
      .sort(byAccessibility(state.diff)),
  }));

  el.innerHTML = `<div class="tiers">${rows
    .map(({ tier, items }) => {
      const open = state.tierOpen.has(tier.id);
      const shown = open ? items : items.slice(0, TIER_PREVIEW);
      const hidden = items.length - shown.length;
      return `
      <div class="tier-row tier-${tier.id}">
        <div class="tier-label" title="${esc(tier.hint)}"><strong>${tier.label}</strong><span>${items.length} jeu${items.length > 1 ? 'x' : ''}</span></div>
        <div class="tier-body">
          ${
            items.length
              ? `<div class="tier-items">${shown.map(tierItem).join('')}</div>`
              : '<span class="tier-empty">Aucun jeu</span>'
          }
          ${
            items.length > TIER_PREVIEW
              ? `<button class="tier-more" type="button" data-tier-toggle="${tier.id}" aria-expanded="${open}">${open ? 'Replier' : `Voir les ${hidden} autres`}</button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

const TIER_PREVIEW = 6;

function tierItem({ g, a }) {
  const d = state.diff.get(g.appid);
  const median = medianLabel(g.appid);
  const tip = [
    g.name,
    `Plus que ${d.remaining} succès · ${Math.round(a.percent)} % fait`,
    `Succès restant le plus dur : ${fmtRarity(d.hardest)} des joueurs`,
    median ? `100 % en ${median} (médiane Steam Hunters)` : '',
    isImpossible(g.appid) ? 'Contient des succès impossibles à obtenir' : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `
    <button class="tier-item ${state.goals.has(g.appid) ? 'is-goal' : ''}" data-appid="${g.appid}" type="button" data-tip="${esc(tip)}">
      <span class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['header.jpg'], g.name)}</span>
      ${state.goals.has(g.appid) ? `<span class="goal-star" title="Objectif">${icon('star')}</span>` : ''}
      <span class="tier-name">${esc(g.name)}</span>
      <span class="tier-left">${d.remaining} restant${d.remaining > 1 ? 's' : ''} · ${Math.round(a.percent)} %${median ? ` · ${median}` : ''}</span>
      ${isImpossible(g.appid) ? '<span class="impossible-tag">Impossible</span>' : ''}
      <span class="bar"><i style="width:${a.percent}%"></i></span>
    </button>`;
}

// ---------------------------------------------------------------- salle des trophées

const hall = $('#hall');
let lastHallKey = '';

function renderHall(s) {
  if (!state.hallOpen || !state.profile) {
    if (!hall.hidden) {
      hall.hidden = true;
      document.body.classList.remove('hall-open');
      lastHallKey = '';
    }
    return;
  }
  s ??= compute();
  const scanning = state.scan.running ? `Préparation de la salle… ${state.scan.done} / ${state.scan.total} jeux analysés` : '';
  const key = `${state.steamid}|${scanning}|${s.platinum.map((p) => p.g.appid).join(',')}|${state.rarity.size}|${state.hunters.size}`;
  if (key === lastHallKey) return;
  const firstOpen = hall.hidden;
  lastHallKey = key;

  hall.innerHTML = `<div class="hall-inner">${hallHTML({
    steamid: state.steamid,
    player: state.profile.player,
    platinum: s.platinum,
    rarity: state.rarity,
    rarityLabel,
    isRelic,
    pill: rarityPill,
    scanning,
  })}</div>`;
  hall.hidden = false;
  document.body.classList.add('hall-open');
  if (firstOpen) hall.scrollTop = 0;
  revealPlaques(hall);
}

hall.addEventListener('click', (e) => {
  const el = e.target.closest('[data-appid]');
  if (el) openGame(Number(el.dataset.appid));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.hallOpen && !document.querySelector('dialog[open]')) location.hash = `#/u/${state.steamid}`;
});

// ---------------------------------------------------------------- objectifs de platine

let lastGoalKey = '';
function renderGoals(s) {
  const section = $('#goalsSection');
  const list = state.profile.games
    .filter((g) => state.goals.has(g.appid) && g.status.a?.total && g.status.kind !== 'platinum')
    .map((g) => ({ g, a: g.status.a, d: state.diff.get(g.appid) }))
    .sort((x, y) => y.a.percent - x.a.percent);
  const mine = state.steamid === state.me;
  const key = `${state.scan.running}|${list.map((x) => `${x.g.appid}:${x.d?.hardest}`).join(',')}|${mine}`;
  if (key === lastGoalKey) return;
  lastGoalKey = key;

  // Sur un autre profil, la section n'apparaît que s'il y a des objectifs.
  section.hidden = state.scan.running || (!list.length && !mine);
  $('#goalCount').textContent = list.length ? ` ${list.length}` : '';
  if (!list.length) {
    $('#goals').innerHTML = `<div class="empty goals-empty">${icon('star')} Aucun objectif pour l’instant. Ajoute-en depuis la fiche d’un jeu.</div>`;
    return;
  }
  $('#goals').innerHTML = `<div class="goal-list">${list
    .map(({ g, a, d }) => {
      const left = a.total - a.unlocked;
      const tier = difficultyTier(d?.hardest);
      return `
      <button class="goal-card" data-appid="${g.appid}" type="button">
        <span class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['library_hero.jpg', 'header.jpg'], g.name)}</span>
        <span class="goal-star" aria-hidden="true">${icon('star')}</span>
        <span class="goal-body">
          <span class="goal-title">${esc(g.name)}</span>
          <span class="goal-progress">
            <span class="goal-pct">${fmtPct(a.percent)}</span>
            <span class="goal-meta">
              <span>Plus que <strong>${left}</strong> succès sur ${a.total}</span>
              ${tier ? `<span class="difficulty diff-${tier.id}">${tier.label}</span>` : ''}
            </span>
          </span>
          <span class="bar goal-bar"><i style="width:${a.percent}%"></i></span>
          ${d?.hardest != null ? `<span class="goal-hint">Succès restant le plus dur : ${fmtRarity(d.hardest)} des joueurs</span>` : ''}
        </span>
      </button>`;
    })
    .join('')}</div>`;
}

// ---------------------------------------------------------------- Steam Hunters

/** Temps médian du 100 % et succès impossibles (Steam Hunters), pour les jeux platinés et en cours. */
const HUNT_MIN_STARTED = 30; // en dessous, la part de chasseurs ayant platiné n'est pas fiable

async function loadHunters(token) {
  const s = compute();
  // Tous les jeux à succès (100 par requête) : l'onglet « Succès impossibles » doit être complet.
  const ids = [...s.platinum, ...s.progress, ...state.profile.games.filter((g) => g.hasStats).map((g) => ({ g }))]
    .map((x) => x.g.appid)
    .filter((id, i, all) => !state.hunters.has(id) && all.indexOf(id) === i);
  for (let i = 0; i < ids.length; i += 300) {
    try {
      const res = await getJSON(`/api/hunters?appids=${ids.slice(i, i + 300).join(',')}`);
      if (token !== state.token) return;
      for (const [id, stats] of Object.entries(res)) {
        state.hunters.set(Number(id), stats);
        // Rareté du platine : part réelle des chasseurs qui l'ont fini parmi ceux qui l'ont commencé.
        if (stats?.started >= HUNT_MIN_STARTED) {
          state.rarity.set(Number(id), (Math.max(stats.perfected, 1) / stats.started) * 100);
          state.rarityHunt.add(Number(id));
        }
      }
    } catch {
      return; // données facultatives
    }
  }
  if (token === state.token) update();
}

/** « ≈ 12 h » : temps médian des chasseurs pour atteindre 100 %. */
const medianLabel = (appid) => {
  const h = state.hunters.get(appid);
  return h?.median ? `≈ ${fmtHours(h.median)}` : null;
};
const isImpossible = (appid) => (state.hunters.get(appid)?.unobtainable ?? 0) > 0;
/** Platine « relique » : le joueur l'a, mais certains de ses succès ne peuvent plus être débloqués. */
const isRelic = (appid) => isImpossible(appid) && statusOf(state.profile.games.find((g) => g.appid === appid)).kind === 'platinum';

/** « 0,4 % » (part réelle chez les chasseurs) ou « ≤ 3 % » (majorant d'après le succès le plus rare). */
const rarityLabel = (appid) => `${state.rarityHunt.has(appid) ? '' : '≤ '}${fmtRarity(state.rarity.get(appid))}`;

// ---------------------------------------------------------------- prochain platine

let lastNext;
function renderNext() {
  if (state.next === lastNext && $('#nextPlat').childElementCount) return;
  lastNext = state.next;
  const el = $('#nextPlat');
  if (state.next === null) {
    el.innerHTML = `<div class="empty">${state.scan.running ? 'Analyse en cours…' : 'Recherche des succès les plus accessibles…'}</div>`;
  } else if (!state.next.length) {
    el.innerHTML = `<div class="empty">Aucun jeu commencé à recommander.</div>`;
  } else {
    el.innerHTML = renderNextPlatinums(state.next, medianLabel);
  }
}

async function loadNext(token) {
  const progress = compute().progress.filter((x) => !state.dlcBlocked.has(x.g.appid) && !isImpossible(x.g.appid));
  const next = await findNextPlatinums(state.steamid, progress, state.diff);
  if (token !== state.token) return;
  state.next = next;
  update();
}

// ---------------------------------------------------------------- synchronisation (base de données)

/** Profil du compte connecté, avec la base disponible : marquages et instantané vivent côté serveur. */
/** Profil du compte connecté : seul endroit où l'on peut marquer des jeux (objectifs, DLC, épingles). */
const canMark = () => Boolean(state.me && state.steamid === state.me);
const ownSynced = () => state.sync && canMark();

async function syncMarks(token) {
  try {
    let marks = await getJSON('/api/marks');
    // Première synchronisation : on envoie les marquages déjà faits dans ce navigateur.
    const remoteEmpty = !marks.goal.length && !marks.dlc.length && !marks.pin?.length;
    if (remoteEmpty && (state.goals.size || state.dlcBlocked.size || state.pins.size)) {
      marks = await sendJSON('/api/marks/import', 'POST', { goal: [...state.goals], dlc: [...state.dlcBlocked], pin: [...state.pins] });
    }
    if (token !== state.token) return;
    applyMarks(marks);
  } catch {
    // base injoignable : on garde la copie locale
  }
}

function applyMarks(marks) {
  state.goals = new Set(marks.goal);
  state.dlcBlocked = new Set(marks.dlc);
  state.pins = new Set(marks.pin ?? []);
  saveMarks(state.steamid, marks);
  update();
  if (!state.scan.running && !state.diffScan.running) setAmbient(ambientSources());
}

// ---------------------------------------------------------------- succès ajoutés par des mises à jour

async function detectAddedAchievements() {
  const entries = [...state.ach.values()].filter((a) => a.total > 0).map((a) => [a.appid, a.total]);
  // Suivi local (ce navigateur), complété par le suivi partagé du serveur quand il existe.
  const added = trackNewAchievements(entries);
  if (state.sync) {
    const ids = entries.map(([appid]) => appid);
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const res = await getJSON(`/api/additions?appids=${ids.slice(i, i + 400).join(',')}`);
        for (const [appid, info] of Object.entries(res)) added.set(Number(appid), info);
      }
    } catch {
      // on garde le suivi local
    }
  }
  state.added = added;
}

/** Jeux de ce profil qui ont gagné des succès récemment, les platines « perdus » en premier. */
function addedForProfile() {
  return state.profile.games
    .filter((g) => state.added.has(g.appid) && state.ach.get(g.appid)?.total)
    .map((g) => {
      const info = state.added.get(g.appid);
      const a = state.ach.get(g.appid);
      // Tous les anciens succès sont faits mais pas les nouveaux : c'était un platine.
      const lostPlat = a.unlocked >= info.from && a.unlocked < a.total;
      return { g, a, info, lostPlat };
    })
    .sort((x, y) => Number(y.lostPlat) - Number(x.lostPlat) || y.info.at - x.info.at);
}

function renderAdded() {
  const section = $('#addedSection');
  const list = state.scan.running ? [] : addedForProfile();
  section.hidden = !list.length;
  if (!list.length) return;
  $('#added').innerHTML = `<div class="near-list">${list
    .map(
      ({ g, a, info, lostPlat }) => `
      <button class="near added-card ${lostPlat ? 'is-lost' : ''}" data-appid="${g.appid}" type="button">
        <div class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['header.jpg'], g.name)}</div>
        <div style="min-width:0">
          <div class="near-name">${esc(g.name)}</div>
          <div class="near-meta"><span><strong>+${info.to - info.from}</strong> succès · repéré le ${fmtDate(info.at)}</span></div>
          ${
            lostPlat
              ? `<span class="tag lost-tag">${icon('trophy')} Platine à reconquérir</span>`
              : `<span class="added-sub">${a.unlocked} / ${a.total} débloqués</span>`
          }
        </div>
      </button>`,
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------- nouveautés depuis la dernière visite

const storeKey = (id) => `steam-stats:v1:${id}`;

/** Compare avec la visite précédente (sur ce navigateur) et fête les nouveaux platines et rangs. */
async function checkProgress() {
  if (!state.me || state.steamid !== state.me) return;
  const s = compute();
  const rank = rankOf(s.platinum.length);
  const snapshot = { plats: s.platinum.map((x) => x.g.appid), rank: rank.tone };

  let prev = null;
  try {
    prev = JSON.parse(localStorage.getItem(storeKey(state.steamid)));
    localStorage.setItem(storeKey(state.steamid), JSON.stringify(snapshot));
  } catch {
    // stockage local indisponible (navigation privée…)
  }
  if (ownSynced()) {
    try {
      const { snapshot: remote } = await getJSON('/api/snapshot');
      prev = remote ?? prev; // la version du serveur fait foi : elle suit le compte d'un appareil à l'autre
      await sendJSON('/api/snapshot', 'PUT', snapshot);
    } catch {
      // on garde la comparaison locale
    }
  }
  if (!prev) return; // première visite : on mémorise sans célébrer

  const before = new Set(prev.plats);
  const newPlats = s.platinum.filter((x) => !before.has(x.g.appid));
  const tier = (tone) => RANKS.findIndex((r) => r.tone === tone);
  const rankUp = tier(rank.tone) > tier(prev.rank) ? rank : null;

  if (newPlats.length) {
    state.newPlats = new Set(newPlats.map((x) => x.g.appid));
    update();
  }
  celebrate({ plats: newPlats.map((x) => ({ appid: x.g.appid, name: x.g.name, goal: state.goals.has(x.g.appid) })), rank: rankUp });
}



// ---------------------------------------------------------------- platines épinglés

/** Bascule l'épingle d'un platine ; renvoie false si la limite est atteinte. */
function togglePin(appid) {
  if (!canMark()) return false;
  const on = !state.pins.has(appid);
  const marks = toggleMark(state.steamid, 'pin', appid);
  if (!marks) {
    showBanner(`${MAX_PINS} platines épinglés au maximum : retire-en un d’abord.`);
    return false;
  }
  ({ dlc: state.dlcBlocked, goal: state.goals, pin: state.pins } = marks);
  update();
  if (!state.scan.running) setAmbient(ambientSources());
  if (ownSynced()) {
    sendJSON('/api/marks', 'PUT', { appid, kind: 'pin', on })
      .then(applyMarks)
      .catch(() => showBanner('Épingle gardée sur cet appareil : la synchronisation a échoué.'));
  }
  return true;
}

const pinButton = (appid) => {
  const on = state.pins.has(appid);
  return `<button class="btn btn-sm cert-pin" type="button" data-mark="pin" data-appid="${appid}" aria-pressed="${on}">${icon('pin')} ${on ? 'Épinglé sur ma carte' : 'Épingler sur ma carte'}</button>`;
};

// ---------------------------------------------------------------- carte de chasseur

/** Contenu de la carte : platines épinglés d'abord, puis les plus rares pour compléter. */
function shareCardData() {
  const s = compute();
  const pinned = [...state.pins].map((id) => s.platinum.find((p) => p.g.appid === id)).filter(Boolean);
  const byRarity = s.platinum
    .filter((p) => state.rarity.has(p.g.appid))
    .sort((x, y) => state.rarity.get(x.g.appid) - state.rarity.get(y.g.appid));
  const rest = (byRarity.length ? byRarity : s.platinum).filter((p) => !state.pins.has(p.g.appid));
  return {
    player: state.profile.player,
    rank: rankOf(s.platinum.length),
    plats: s.platinum.length,
    featured: [...pinned, ...rest].slice(0, 3).map((p) => ({
      appid: p.g.appid,
      name: p.g.name,
      rarity: state.rarity.get(p.g.appid) ?? null,
      rarityLabel: state.rarity.has(p.g.appid) ? rarityLabel(p.g.appid) : null,
      pinned: state.pins.has(p.g.appid),
    })),
    // La carte ne parle que des platines : rien sur le reste de la bibliothèque.
    stats: platinumStats(s),
  };
}

function platinumStats(s) {
  const minutes = s.platinum.reduce((t, p) => t + p.g.playtime, 0);
  const achievements = s.platinum.reduce((t, p) => t + p.a.total, 0);
  const rarities = s.platinum.map((p) => state.rarity.get(p.g.appid)).filter((r) => r != null);
  const ultra = rarities.filter((r) => r <= 5).length;
  return [
    !state.profile.playtimeHidden && minutes ? [`${nf.format(Math.round(minutes / 60))} h`, 'pour les platiner'] : null,
    achievements ? [nf.format(achievements), 'succès décrochés'] : null,
    ultra
      ? [nf.format(ultra), ultra > 1 ? 'platines ultra-rares' : 'platine ultra-rare']
      : rarities.length
        ? [rarityLabel(s.platinum.filter((p) => state.rarity.has(p.g.appid)).sort((x, y) => state.rarity.get(x.g.appid) - state.rarity.get(y.g.appid))[0].g.appid), 'pour le plus rare']
        : null,
  ].filter(Boolean);
}

function shareCard() {
  const s = compute();
  // Choix proposés : du plus rare au plus commun, pour retrouver vite ses platines de prestige.
  const choices = [...s.platinum]
    .sort((x, y) => (state.rarity.get(x.g.appid) ?? 101) - (state.rarity.get(y.g.appid) ?? 101))
    .map((p) => ({ appid: p.g.appid, name: p.g.name }));
  // Le choix des platines épinglés n'est proposé que sur son propre profil.
  openShareCard(
    shareCardData(),
    canMark()
      ? {
          choices,
          maxPins: MAX_PINS,
          isPinned: (appid) => state.pins.has(appid),
          onToggle: (appid) => (togglePin(appid) ? shareCardData() : null),
        }
      : null,
  );
}

// ---------------------------------------------------------------- amis

async function loadFriends(token) {
  const el = $('#friends');
  let data;
  try {
    data = await getJSON(`/api/friends/${state.steamid}`);
  } catch {
    return;
  }
  if (token !== state.token || !el) return;

  if (data.private) {
    if (state.steamid !== state.me) return;
    el.hidden = false;
    el.innerHTML = `<p class="friends-private">${icon('lock')} Ta liste d’amis est privée : rends-la publique dans tes <a href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noopener">paramètres de confidentialité Steam</a> pour accéder aux profils de tes amis d’ici.</p>`;
    return;
  }
  if (!data.friends.length) return;

  state.friends = data.friends;
  const online = data.friends.filter((f) => f.online).length;
  el.hidden = false;
  el.innerHTML = `
    <div class="friends-head">
      <h2>${icon('users')} Amis <span class="count">${data.friends.length}</span>${online ? `<span class="online-count">${online} en ligne</span>` : ''}</h2>
      <div class="friends-tools">
        ${state.sync ? '<div class="chips" id="friendViews" role="group" aria-label="Affichage"></div>' : ''}
        ${data.friends.length > 12 ? '<input class="input friends-filter" id="friendsFilter" type="search" placeholder="Filtrer…" aria-label="Filtrer les amis">' : ''}
      </div>
    </div>
    <div id="friendsBody"></div>`;
  $('#friendsFilter')?.addEventListener('input', renderFriends);
  $('#friendViews')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-view]');
    if (!chip) return;
    state.friendView = chip.dataset.view;
    renderFriends();
  });
  renderFriends();

  // Nombre de platines des amis déjà analysés (et du profil affiché).
  if (state.sync) {
    try {
      const ids = [state.steamid, ...data.friends.map((f) => f.steamid)];
      for (let i = 0; i < ids.length; i += 300) {
        const list = await getJSON(`/api/summaries?ids=${ids.slice(i, i + 300).join(',')}`);
        for (const sum of list) state.summaries.set(sum.steamid, sum);
      }
      if (token === state.token) renderFriends();
    } catch {
      // pas de classement, la liste d'amis reste utilisable
    }
  }
}

/** Enregistre le résumé du profil affiché (calculé côté serveur) pour le classement entre amis. */
async function publishSummary(token) {
  if (!state.sync) return;
  try {
    const sum = await sendJSON(`/api/summary/${state.steamid}`, 'POST', {});
    if (token !== state.token) return;
    state.summaries.set(sum.steamid, sum);
    if ($('#friendsBody')) renderFriends();
  } catch {
    // analyse incomplète ou base indisponible : le profil n'entre simplement pas au classement
  }
}

/** Score de chasseur (points Steam Hunters des succès débloqués) et reliques. */
async function loadScore(token, round = 0) {
  if (!round) {
    state.score = 'loading';
    update();
  }
  try {
    const res = await sendJSON(`/api/score/${state.steamid}`, 'POST', {});
    if (token !== state.token) return;
    state.score = res;
    const sum = state.summaries.get(state.steamid);
    if (sum) state.summaries.set(state.steamid, { ...sum, score: res.score });
    if ($('#friendsBody')) renderFriends();
    // Des jeux sont encore estimés : leurs points arrivent en arrière-plan, on affine régulièrement.
    if (res.estimated && round < SCORE_ROUNDS) setTimeout(() => token === state.token && loadScore(token, round + 1), 90_000);
  } catch {
    if (token === state.token && !round) state.score = null;
  }
  if (token === state.token) update();
}
const SCORE_ROUNDS = 20;

function renderFriends() {
  const known = state.friends.filter((f) => state.summaries.has(f.steamid)).length;
  const views = $('#friendViews');
  if (views) {
    views.innerHTML = [
      ['all', 'Tous'],
      ['ranking', `${icon('trophy')} Classement <span class="n">${known}</span>`],
    ]
      .map(([id, label]) => `<button class="chip" type="button" data-view="${id}" aria-pressed="${state.friendView === id}">${label}</button>`)
      .join('');
  }
  const filter = $('#friendsFilter');
  if (filter) filter.hidden = state.friendView === 'ranking';
  if (state.friendView === 'ranking') renderRanking();
  else renderFriendList(filter?.value ?? '');
}

function renderFriendList(q) {
  const needle = q.trim().toLocaleLowerCase('fr');
  const list = state.friends.filter((f) => !needle || f.name.toLocaleLowerCase('fr').includes(needle));
  $('#friendsBody').innerHTML = list.length
    ? `<div class="friends-row">${list
        .map((f) => {
          const status = f.game ? 'ingame' : f.online ? 'online' : 'offline';
          const sum = state.summaries.get(f.steamid);
          const tip = [
            f.name,
            f.game ? `En jeu : ${f.game}` : f.online ? 'En ligne' : 'Hors ligne',
            sum?.score != null ? `${nf.format(sum.score)} points` : '',
            sum ? `${sum.platinum} platine${sum.platinum > 1 ? 's' : ''}` : '',
            f.isPublic ? '' : 'Profil privé',
          ]
            .filter(Boolean)
            .join('\n');
          return `
          <a class="friend ${f.isPublic ? '' : 'is-private'}" href="#/u/${f.steamid}" data-tip="${esc(tip)}">
            <span class="friend-avatar status-${status}">
              <img src="${esc(f.avatar)}" data-fallback="" alt="" loading="lazy">
              ${
                sum?.score != null
                  ? `<span class="friend-plat friend-points">${fmtCompact(sum.score)}</span>`
                  : sum
                    ? `<span class="friend-plat tone-${rankOf(sum.platinum).tone}">${icon('trophy')}${sum.platinum}</span>`
                    : ''
              }
            </span>
            <span class="friend-name">${esc(f.name)}</span>
            <span class="friend-game">${f.game ? esc(f.game) : f.isPublic ? '' : 'Privé'}</span>
          </a>`;
        })
        .join('')}</div>`
    : `<p class="friends-empty">Aucun ami ne correspond.</p>`;
}

/** Classement des amis déjà analysés, avec le profil affiché : au score de chasseur, puis au nombre de platines. */
function renderRanking() {
  const self = state.summaries.get(state.steamid);
  const rows = [
    ...state.friends.filter((f) => state.summaries.has(f.steamid)).map((f) => ({ ...state.summaries.get(f.steamid), avatar: f.avatar })),
    ...(self ? [{ ...self, isSelf: true }] : []),
  ].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.platinum - a.platinum || (a.rarestPct ?? 101) - (b.rarestPct ?? 101));

  if (rows.length < 2) {
    $('#friendsBody').innerHTML = `<p class="friends-empty">Ouvre le profil d’un ami pour l’ajouter au classement.</p>`;
    return;
  }

  $('#friendsBody').innerHTML = `<ol class="ranking">${rows
    .map((r, i) => {
      const rank = rankOf(r.platinum);
      const medal = i < 3 ? `medal-${i + 1}` : '';
      return `
      <li>
        <a class="ranking-row ${r.isSelf ? 'is-self' : ''}" href="#/u/${r.steamid}">
          <span class="ranking-pos ${medal}">${i + 1}</span>
          <img class="ranking-avatar" src="${esc(r.avatar)}" data-fallback="" alt="" loading="lazy">
          <span class="ranking-who">
            <span class="ranking-name">${esc(r.name)}</span>
            <span class="ranking-sub">
              <span class="rank-chip tone-${rank.tone}">${rank.name}</span>
              <span>${icon('trophy')} ${nf.format(r.platinum)} platine${r.platinum > 1 ? 's' : ''}</span>
            </span>
          </span>
          ${
            r.score != null
              ? `<span class="ranking-score" title="${nf.format(r.score)} points Steam Hunters">${fmtCompact(r.score)}<small>pts</small></span>`
              : `<span class="ranking-score is-unknown" title="Score pas encore calculé : ouvre ce profil pour le mettre à jour">—<small>pts</small></span>`
          }
        </a>
      </li>`;
    })
    .join('')}</ol>`;
}

const SPARKS = [
  [8, 22, 0], [18, 70, 1.1], [34, 14, 2.3], [62, 78, 0.6], [78, 20, 1.7], [90, 58, 2.9], [50, 40, 3.6],
];

function rarityPill(appid, { long = false } = {}) {
  const p = state.rarity.get(appid);
  const tier = rarityTier(p);
  if (!tier) return '';
  const hunt = state.rarityHunt.has(appid);
  const text = long ? `${tier.label} · ${rarityLabel(appid)} des ${hunt ? 'chasseurs' : 'joueurs'}` : rarityLabel(appid);
  const title = hunt
    ? `${fmtRarity(p)} des chasseurs Steam Hunters qui ont commencé ce jeu l’ont platiné`
    : `Au plus ${fmtRarity(p)} des joueurs ont platiné ce jeu (d’après son succès le plus rare)`;
  return `<span class="rarity-pill tier-${tier.id}" title="${title}">${text}</span>`;
}

function featureCard(label, { g, a, date, num }) {
  return `
    <button class="plat-feature" data-appid="${g.appid}" type="button">
      <div class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['library_hero.jpg', 'header.jpg'], g.name)}</div>
      <span class="feature-sparks" aria-hidden="true">${SPARKS.map(([x, y, d]) => `<i style="left:${x}%;top:${y}%;animation-delay:${d}s">${icon('sparkle')}</i>`).join('')}</span>
      <span class="feature-body">
        <span class="eyebrow">${icon('sparkle')} ${label} · n°${num}</span>
        <span class="feature-title">${esc(g.name)}</span>
        <span class="feature-meta">
          <span>Platiné le ${fmtDate(date)}</span>
          <span>${a.total} succès</span>
          ${g.playtime ? `<span>${fmtHours(g.playtime)}</span>` : ''}
          ${rarityPill(g.appid, { long: true })}
        </span>
      </span>
      <span class="feature-trophy" aria-hidden="true">${icon('trophy')}</span>
    </button>`;
}

/**
 * Halo de rareté de chaque platine : la couleur et l'intensité dépendent de la part de joueurs l'ayant obtenu.
 * Renvoie une Map appid -> 'rare-1' (≤ 1 %) | 'rare-2' (≤ 5 %) | 'rare-3' (≤ 20 %) | 'rare-4'.
 */
function rarityHighlights(s) {
  return new Map(
    s.platinum.filter((p) => state.rarity.has(p.g.appid)).map((p) => [p.g.appid, rarityHalo(state.rarity.get(p.g.appid))]),
  );
}

let lastPlatKey = '';
const seenPlat = new Set();

function renderPlatinum(s) {
  $('#platCount').textContent = s.platinum.length ? ` ${s.platinum.length}` : '';
  const el = $('#plat');
  const feat = $('#platFeature');

  // On ne reconstruit la vitrine que si son contenu change, pour ne pas casser les animations en cours.
  const key = `${state.scan.running}|${s.platinum.map((x) => x.g.appid).join(',')}|${state.rarity.size}|${state.newPlats.size}|${[...state.pins]}`;
  if (key === lastPlatKey) return;
  lastPlatKey = key;

  if (!s.platinum.length) {
    feat.innerHTML = '';
    el.innerHTML = `<div class="empty">${state.scan.running ? 'Recherche des jeux platinés…' : 'Aucun jeu platiné pour le moment. Les « presque platinés » ci-dessous sont un bon point de départ !'}</div>`;
    return;
  }

  if (state.scan.running) {
    feat.innerHTML = '';
  } else {
    const latest = s.platinum[0];
    const rarest = s.platinum
      .filter((x) => state.rarity.has(x.g.appid))
      .sort((x, y) => state.rarity.get(x.g.appid) - state.rarity.get(y.g.appid))[0];
    feat.innerHTML =
      featureCard('Dernier platine', latest) + (rarest && rarest !== latest ? featureCard('Ton platine le plus rare', rarest) : '');
  }

  // Platines épinglés en tête, dans l'ordre d'épinglage.
  const pinRank = (p) => { const i = [...state.pins].indexOf(p.g.appid); return i < 0 ? Infinity : i; };
  const shelf = [...s.platinum].sort((x, y) => pinRank(x) - pinRank(y));
  const highlight = rarityHighlights(s);
  el.innerHTML = `<div class="shelf">${shelf
    .map(({ g, date, num }) => {
      const tier = rarityTier(state.rarity.get(g.appid));
      const extra = `
        <span class="plat-badge" title="Platiné">${icon('trophy')}</span>
        ${rarityPill(g.appid)}
        ${state.newPlats.has(g.appid) ? '<span class="new-tag">Nouveau</span>' : ''}
        ${state.pins.has(g.appid) ? `<span class="pin-badge" title="Épinglé">${icon('pin')}</span>` : ''}`;
      return `
      <button class="shelf-slot holo ${tier ? `tier-${tier.id}` : ''} ${highlight.get(g.appid) ?? ''}" data-appid="${g.appid}" type="button" data-tip="${esc(`${g.name}\nPlatine n°${num} · ${fmtDate(date)}`)}" aria-label="${esc(g.name)}">
        ${boxHTML(g.appid, g.name, extra)}
        <span class="shelf-tag">n°${num}</span>
      </button>`;
    })
    .join('')}</div>`;

  // Apparition en cascade, uniquement pour les cartes qui n'étaient pas encore affichées.
  let i = 0;
  for (const card of el.querySelectorAll('.holo')) {
    const id = card.dataset.appid;
    if (seenPlat.has(id)) continue;
    seenPlat.add(id);
    if (reduceMotion.matches) continue;
    card.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(0.96)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 420, delay: Math.min(i++, 12) * 45, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
    );
  }
}


function renderNearly(s) {
  const list = s.progress.filter((x) => x.a.percent >= 75 && !state.dlcBlocked.has(x.g.appid)).slice(0, 12);
  const el = $('#nearly');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${state.scan.running ? 'Analyse en cours…' : 'Aucun jeu à plus de 75 % pour l’instant.'}</div>`;
    return;
  }
  el.innerHTML = `<div class="near-list">${list
    .map(({ g, a }) => {
      const left = a.total - a.unlocked;
      return `
      <button class="near" data-appid="${g.appid}" type="button">
        <div class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['header.jpg'], g.name)}</div>
        <div style="min-width:0">
          <div class="near-name">${esc(g.name)}</div>
          <div class="near-meta"><span><strong>${a.unlocked}</strong> / ${a.total} · ${left} restant${left > 1 ? 's' : ''}</span><strong>${fmtPct(a.percent)}</strong></div>
          <div class="bar"><i style="width:${a.percent}%"></i></div>
        </div>
      </button>`;
    })
    .join('')}</div>`;
}

// ---------------------------------------------------------------- graphiques

/** Histogramme vertical en SVG, une seule série. data: [{ label, value, tip, cls }] */
function barChart(container, data, { height = 200, showValues = false, labelEvery = 1 } = {}) {
  const W = Math.max(280, container.clientWidth || 600);
  const H = height;
  const pad = { l: 34, r: 4, t: showValues ? 20 : 10, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const rawMax = Math.max(1, ...data.map((d) => d.value));
  const max = niceMax(rawMax);
  const step = iw / data.length;
  const gap = 2;
  const bw = Math.max(2, Math.min(step - gap, 56));
  const y = (v) => pad.t + ih - (v / max) * ih;

  const ticks = [0, max / 2, max];
  const grid = ticks
    .map(
      (t) => `
      <line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="axis-label" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${nf.format(t)}</text>`,
    )
    .join('');

  const cols = data
    .map((d, i) => {
      const cx = pad.l + step * i + step / 2;
      const x = cx - bw / 2;
      const h = (d.value / max) * ih;
      const top = pad.t + ih - h;
      const r = Math.min(4, bw / 2, h);
      const bar =
        h > 0
          ? `<path class="bar-mark ${d.cls ?? ''}" d="M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z"/>`
          : '';
      const label =
        i % labelEvery === 0 || i === data.length - 1
          ? `<text class="axis-label" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`
          : '';
      const val = showValues && d.value > 0 ? `<text class="value-label" x="${cx}" y="${top - 6}" text-anchor="middle">${nf.format(d.value)}</text>` : '';
      return `<g class="col" data-tip="${esc(d.tip)}"><rect class="hit" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}"/>${bar}${val}${label}</g>`;
    })
    .join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${grid}${cols}</svg>`;
}

function niceMax(v) {
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return Math.max(2, m * exp);
  return v;
}

function renderCharts(s) {
  const el = $('#charts');
  if (!el.dataset.ready) {
    el.innerHTML = `
      <div class="card chart-card wide">
        <h3>Succès débloqués par mois</h3>
        <p class="chart-sub" id="monthsSub">24 derniers mois</p>
        <div class="chart" id="chartMonths"></div>
      </div>
      <div class="card chart-card">
        <h3>Top 10 du temps de jeu</h3>
        <p class="chart-sub">Heures cumulées par jeu</p>
        <div class="top-list" id="topPlayed"></div>
      </div>
      <div class="card chart-card">
        <h3>Répartition de la complétion</h3>
        <p class="chart-sub">Nombre de jeux avec succès, par tranche de complétion</p>
        <div class="chart" id="chartCompletion"></div>
      </div>`;
    el.dataset.ready = '1';
  }

  // Succès par mois, sur 24 mois glissants.
  const now = new Date();
  const months = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, date: d, value: 0 });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const [t] of s.times) {
    const d = new Date(t * 1000);
    const m = byKey.get(`${d.getFullYear()}-${d.getMonth()}`);
    if (m) m.value++;
  }
  const total24 = months.reduce((t, m) => t + m.value, 0);
  $('#monthsSub').textContent = `24 derniers mois · ${nf.format(total24)} succès`;
  barChart(
    $('#chartMonths'),
    months.map((m) => ({
      label: m.date.getMonth() === 0 ? String(m.date.getFullYear()) : monthShort.format(m.date).replace('.', ''),
      value: m.value,
      tip: `${monthFmt.format(m.date)}\n${nf.format(m.value)} succès`,
    })),
    { height: 210, labelEvery: window.innerWidth < 640 ? 4 : 2 },
  );

  // Top 10 temps de jeu.
  const top = [...state.profile.games].sort((a, b) => b.playtime - a.playtime).slice(0, 10).filter((g) => g.playtime > 0);
  const topMax = top[0]?.playtime || 1;
  $('#topPlayed').innerHTML = top.length
    ? top
        .map(
          (g, i) => `
        <button class="top-row" data-appid="${g.appid}" type="button" data-tip="${esc(`${g.name}\n${fmtHours(g.playtime)} · ${Math.round((g.playtime / s.totalMin) * 100)} % du total`)}">
          <span class="rank">${i + 1}</span>
          ${g.icon ? `<img src="${gameIconUrl(g)}" alt="" loading="lazy">` : '<span></span>'}
          <span class="name-bar"><span class="name">${esc(g.name)}</span><span class="bar"><i style="width:${(g.playtime / topMax) * 100}%"></i></span></span>
          <span class="val">${fmtHours(g.playtime)}</span>
        </button>`,
        )
        .join('')
    : `<div class="empty">${state.profile.playtimeHidden ? 'Temps de jeu privé sur ce profil.' : 'Aucun temps de jeu enregistré.'}</div>`;

  // Répartition de la complétion.
  const buckets = [
    { label: '0 %', test: (p) => p === 0 },
    { label: '1–24 %', test: (p) => p > 0 && p < 25 },
    { label: '25–49 %', test: (p) => p >= 25 && p < 50 },
    { label: '50–74 %', test: (p) => p >= 50 && p < 75 },
    { label: '75–99 %', test: (p) => p >= 75 && p < 100 },
    { label: '100 %', test: (p) => p === 100, cls: 'plat' },
  ].map((b) => ({ ...b, value: 0 }));
  for (const g of state.profile.games) {
    const a = g.status.a;
    if (!a?.total) continue;
    buckets.find((b) => b.test(a.percent)).value++;
  }
  barChart(
    $('#chartCompletion'),
    buckets.map((b) => ({ ...b, tip: `${b.label}\n${nf.format(b.value)} jeu${b.value > 1 ? 'x' : ''}` })),
    { height: 230, showValues: true },
  );
}

window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => state.profile && $('#charts') && renderCharts(compute()), 150);
});

// ---------------------------------------------------------------- faits

function renderFacts(s) {
  const facts = [];
  const games = state.profile.games;
  const most = games.reduce((m, g) => (g.playtime > (m?.playtime ?? 0) ? g : m), null);
  if (most) {
    facts.push({
      label: 'Jeu le plus joué',
      value: most.name,
      hint: `${fmtHours(most.playtime)} · ${Math.round((most.playtime / s.totalMin) * 100)} % de ton temps de jeu`,
      appid: most.appid,
    });
  }

  if (s.times.length) {
    const [t0, g0] = s.times[0];
    facts.push({ label: 'Premier succès', value: g0.name, hint: `le ${fmtDate(t0)}`, appid: g0.appid });

    const [tl, gl] = s.times.at(-1);
    facts.push({ label: 'Dernier succès', value: gl.name, hint: `le ${fmtDate(tl)}`, appid: gl.appid });

    const perDay = new Map();
    for (const [t, g] of s.times) {
      const d = new Date(t * 1000);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const e = perDay.get(key) ?? { t, n: 0, games: new Map() };
      e.n++;
      e.games.set(g.name, (e.games.get(g.name) ?? 0) + 1);
      perDay.set(key, e);
    }
    const best = [...perDay.values()].sort((a, b) => b.n - a.n)[0];
    const bestGame = [...best.games].sort((a, b) => b[1] - a[1])[0][0];
    facts.push({ label: 'Journée record', value: `${best.n} succès le ${fmtDate(best.t)}`, hint: `principalement sur ${bestGame}` });

    const monthsSpan = Math.max(1, (Date.now() / 1000 - t0) / (30.44 * 24 * 3600));
    facts.push({
      label: 'Rythme moyen',
      value: `${(s.times.length / monthsSpan).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} succès / mois`,
      hint: `depuis ton premier succès`,
    });
  }

  const rarest = s.platinum
    .filter((p) => state.rarity.has(p.g.appid))
    .sort((x, y) => state.rarity.get(x.g.appid) - state.rarity.get(y.g.appid))[0];
  if (rarest) {
    facts.push({
      label: 'Platine le plus rare',
      value: rarest.g.name,
      hint: state.rarityHunt.has(rarest.g.appid)
        ? `${fmtRarity(state.rarity.get(rarest.g.appid))} des chasseurs l’ont platiné`
        : `au plus ${fmtRarity(state.rarity.get(rarest.g.appid))} des joueurs l’ont platiné`,
      appid: rarest.g.appid,
    });
  }

  const plats = s.platinum.filter((p) => p.g.playtime > 0);
  if (plats.length) {
    const fastest = plats.reduce((m, p) => (p.g.playtime < m.g.playtime ? p : m));
    const longest = plats.reduce((m, p) => (p.g.playtime > m.g.playtime ? p : m));
    facts.push({ label: 'Platine le plus rapide', value: fastest.g.name, hint: `en ${fmtHours(fastest.g.playtime)}`, appid: fastest.g.appid });
    if (longest !== fastest) {
      facts.push({ label: 'Platine le plus long', value: longest.g.name, hint: `${fmtHours(longest.g.playtime)} de jeu`, appid: longest.g.appid });
    }
  }

  const forgotten = games
    .filter((g) => g.playtime >= 600 && g.lastPlayed && Date.now() / 1000 - g.lastPlayed > 365 * 24 * 3600)
    .sort((a, b) => b.playtime - a.playtime)[0];
  if (forgotten) {
    facts.push({
      label: 'Vieil amour délaissé',
      value: forgotten.name,
      hint: `${fmtHours(forgotten.playtime)}, mais pas lancé depuis le ${fmtDate(forgotten.lastPlayed)}`,
      appid: forgotten.appid,
    });
  }

  if (s.notStarted) {
    facts.push({ label: 'Succès en attente', value: `${s.notStarted} jeux à 0 %`, hint: 'avec des succès, mais aucun débloqué' });
  }

  $('#facts').innerHTML = facts.length
    ? facts
        .map(
          (f) => `
        <div class="fact" ${f.appid ? `data-appid="${f.appid}" style="cursor:pointer"` : ''}>
          <div class="fact-label">${f.label}</div>
          <div class="fact-value">${esc(f.value)}</div>
          <div class="fact-hint">${esc(f.hint)}</div>
        </div>`,
        )
        .join('')
    : `<div class="empty">Les anecdotes arrivent après l’analyse des succès…</div>`;
}

// ---------------------------------------------------------------- bibliothèque

const FILTERS = [
  { id: 'all', label: 'Tous', test: () => true },
  { id: 'platinum', label: 'Platinés', test: (g) => g.status.kind === 'platinum' },
  { id: 'goals', label: 'Objectifs', test: (g) => state.goals.has(g.appid) && g.status.kind !== 'platinum', hideWhen: () => !state.goals.size },
  { id: 'progress', label: 'En cours', test: (g) => g.status.kind === 'progress' && !state.dlcBlocked.has(g.appid) },
  { id: 'notstarted', label: 'Succès à 0 %', test: (g) => g.status.kind === 'notstarted' && !state.dlcBlocked.has(g.appid) },
  { id: 'none', label: 'Sans succès', test: (g) => g.status.kind === 'none' },
  { id: 'never', label: 'Jamais lancés', test: (g) => g.playtime === 0, hideWhen: () => state.profile.playtimeHidden },
  { id: 'dlc', label: 'Bloqués (DLC)', test: (g) => state.dlcBlocked.has(g.appid) && g.status.kind !== 'platinum', hideWhen: () => !state.dlcBlocked.size },
  { id: 'impossible', label: 'Succès impossibles', test: (g) => isImpossible(g.appid), hideWhen: () => !state.profile.games.some((g) => isImpossible(g.appid)) },
];

const SORTS = {
  playtime: (a, b) => b.playtime - a.playtime,
  completion: (a, b) => (b.status.a?.percent ?? -1) - (a.status.a?.percent ?? -1) || b.playtime - a.playtime,
  recent: (a, b) => b.lastPlayed - a.lastPlayed,
  // Platines restants les plus accessibles d'abord ; platinés et jeux sans données en fin de liste.
  accessible: (a, b) => {
    const da = a.status.kind === 'platinum' || state.dlcBlocked.has(a.appid) ? null : state.diff.get(a.appid);
    const db = b.status.kind === 'platinum' || state.dlcBlocked.has(b.appid) ? null : state.diff.get(b.appid);
    return (db?.hardest ?? -1) - (da?.hardest ?? -1) || (da?.remaining ?? 1e9) - (db?.remaining ?? 1e9) || b.playtime - a.playtime;
  },
  name: (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }),
};

function renderLibrary() {
  const games = state.profile.games;
  const { sort, search, limit } = state.lib;
  const q = search.trim().toLocaleLowerCase('fr');

  if (FILTERS.find((f) => f.id === state.lib.filter).hideWhen?.()) state.lib.filter = 'all';
  $('#libChips').innerHTML = FILTERS.filter((f) => !f.hideWhen?.()).map((f) => {
    const n = games.filter(f.test).length;
    return `<button class="chip" type="button" data-filter="${f.id}" aria-pressed="${f.id === state.lib.filter}">${f.label}<span class="n">${nf.format(n)}</span></button>`;
  }).join('');
  for (const chip of $('#libChips').children) {
    chip.onclick = () => {
      state.lib.filter = chip.dataset.filter;
      state.lib.limit = LIB_PAGE;
      renderLibrary();
    };
  }

  const test = FILTERS.find((f) => f.id === state.lib.filter).test;
  const list = games.filter((g) => test(g) && (!q || g.name.toLocaleLowerCase('fr').includes(q))).sort(SORTS[sort]);
  $('#libCount').textContent = ` ${nf.format(games.length)}`;

  $('#libGrid').innerHTML = list.length
    ? list.slice(0, limit).map(gameCard).join('')
    : `<div class="empty" style="grid-column:1/-1">Aucun jeu ne correspond.</div>`;

  const more = $('#libMore');
  if (list.length > limit) {
    more.innerHTML = `<button class="btn" type="button">Afficher plus (${nf.format(list.length - limit)} restants)</button>`;
    more.firstElementChild.onclick = () => {
      state.lib.limit += LIB_PAGE * 2;
      renderLibrary();
    };
  } else {
    more.innerHTML = '';
  }
}

function gameCard(g) {
  const st = g.status;
  let tag = '';
  let bar = '';
  if (st.kind === 'platinum') {
    tag = `<span class="tag plat">${icon('trophy')} Platiné</span>`;
    bar = `<div class="bar is-plat"><i style="width:100%"></i></div>`;
  } else if (st.kind === 'progress' || st.kind === 'notstarted') {
    tag = `<span class="tag pct">${st.a.unlocked}/${st.a.total} · ${fmtPct(st.a.percent)}</span>`;
    bar = `<div class="bar"><i style="width:${st.a.percent}%"></i></div>`;
  } else if (st.kind === 'pending') {
    tag = `<span class="tag pending">…</span>`;
  } else {
    tag = `<span class="tag">Sans succès</span>`;
  }

  const blocked = st.kind !== 'platinum' && state.dlcBlocked.has(g.appid);
  const tier = !blocked && (st.kind === 'progress' || st.kind === 'notstarted') ? difficultyTier(state.diff.get(g.appid)?.hardest) : null;
  const added = state.added.get(g.appid);
  const foot = [
    blocked ? `<span class="dlc-tag">${icon('lock')} DLC requis</span>` : '',
    st.kind !== 'platinum' && state.goals.has(g.appid) ? `<span class="goal-tag">${icon('star')} Objectif</span>` : '',
    tier ? `<span class="difficulty diff-${tier.id}">${tier.label}</span>` : '',
    added ? `<span class="added-tag">${addedLabel(added)}</span>` : '',
    isImpossible(g.appid)
      ? st.kind === 'platinum'
        ? '<span class="relic-seal" title="Platine que plus personne ne peut décrocher">Relique</span>'
        : `<span class="ach-impossible" title="Succès qui ne peuvent plus être débloqués">${state.hunters.get(g.appid).unobtainable} impossible${state.hunters.get(g.appid).unobtainable > 1 ? 's' : ''}</span>`
      : '',
  ].join('');

  const cls = [st.kind === 'platinum' && 'is-plat', g.playtime === 0 && !state.profile.playtimeHidden && 'is-never'].filter(Boolean).join(' ');
  return `
    <button class="game ${cls}" data-appid="${g.appid}" type="button">
      <div class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['header.jpg'], g.name)}</div>
      <div class="game-body">
        <div class="game-name" title="${esc(g.name)}">${esc(g.name)}</div>
        <div class="game-meta">
          <span class="hours">${icon('clock')} ${playLabel(g)}</span>
          ${tag}
        </div>
        ${bar}
        ${foot ? `<div class="game-foot">${foot}</div>` : ''}
      </div>
    </button>`;
}

// ---------------------------------------------------------------- fiche jeu

const modal = $('#gameModal');
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('.modal-close')) modal.close();
  // Copie du nom anglais d'un succès, pour le rechercher sur internet.
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const done = () => {
      copy.classList.add('is-copied');
      setTimeout(() => copy.classList.remove('is-copied'), 1200);
    };
    // Méthode de secours si l'API presse-papiers est refusée par le navigateur.
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = copy.dataset.copy;
      ta.style.cssText = 'position:fixed;opacity:0';
      modal.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return done();
      // Copie impossible ici : on sélectionne le nom pour un Ctrl+C manuel.
      const range = document.createRange();
      range.selectNodeContents(copy);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy).then(done, legacy);
    else legacy();
  }
  const toggle = e.target.closest('[data-mark]');
  if (toggle && canMark()) {
    const appid = Number(toggle.dataset.appid);
    const g = state.profile.games.find((x) => x.appid === appid);
    const kind = toggle.dataset.mark;
    if (kind === 'pin') {
      if (togglePin(appid)) toggle.outerHTML = pinButton(appid);
      return;
    }
    const on = !(kind === 'goal' ? state.goals : state.dlcBlocked).has(appid);
    ({ dlc: state.dlcBlocked, goal: state.goals, pin: state.pins } = toggleMark(state.steamid, kind, appid));
    $('#gameNotices').innerHTML = gameNotices(g, statusOf(g));
    update();
    loadNext(state.token);
    if (ownSynced()) {
      sendJSON('/api/marks', 'PUT', { appid, kind, on })
        .then(applyMarks)
        .catch(() => showBanner('Marquage gardé sur cet appareil : la synchronisation a échoué.'));
    }
  }
});

/** Certificat de platine affiché en tête de la fiche d'un jeu platiné. */
function certificate(g, a) {
  const p = compute().platinum.find((x) => x.g.appid === g.appid);
  if (!p) return '';
  return `
    <div class="cert">
      <span class="cert-medal" aria-hidden="true">${icon('trophy')}${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<i style="--a:${k * 45}deg"></i>`).join('')}</span>
      <span class="cert-text">
        <span class="cert-num">Platine n°${p.num}</span>
        <span class="cert-date">Obtenu le ${fmtDate(p.date)}</span>
      </span>
      ${rarityPill(g.appid, { long: true })}
    </div>
    <div class="cert-stats">
      <span><b>${fmtDuration(p.hunt)}</b>de chasse</span>
      ${g.playtime ? `<span><b>${fmtHours(g.playtime)}</b>de jeu</span>` : ''}
      <span><b>${a.total}</b>succès</span>
      <span><b>${fmtDate(a.times[0])}</b>premier succès</span>
      ${medianLabel(g.appid) ? `<span><b>${medianLabel(g.appid)}</b>médiane des chasseurs</span>` : ''}
    </div>
    ${canMark() ? `<div class="cert-actions">${pinButton(g.appid)}</div>` : ''}`;
}

async function openGame(appid) {
  const g = state.profile?.games.find((x) => x.appid === appid);
  if (!g) return;
  const st = statusOf(g);
  const a = st.a;

  // La fiche s'ouvre comme un boîtier de jeu : à gauche le manuel avec les infos,
  // à droite le disque, sérigraphié avec l'image du jeu.
  const cover = ['library_600x900.jpg', 'header.jpg'];
  modal.innerHTML = `
    <div class="case">
      <div class="case-left">
        <div class="case-flap">
          <div class="manual">
    <div class="modal-head">
      ${
        st.kind === 'platinum'
          ? certificate(g, a)
          : ''
      }
      <h2 id="modalTitle">${esc(g.name)}</h2>
      <div class="modal-stats">
        <span>${icon('clock')} <strong>${playLabel(g)}</strong></span>
        ${g.lastPlayed ? `<span>Dernière session : <strong>${fmtDate(g.lastPlayed)}</strong></span>` : ''}
        ${a?.total ? `<span>Succès : <strong>${a.unlocked} / ${a.total}</strong> (${fmtPct(a.percent)})</span>` : ''}
        <a href="https://store.steampowered.com/app/${g.appid}" target="_blank" rel="noopener">Page Steam ↗</a>
      </div>
      ${a?.total ? `<div class="bar ${st.kind === 'platinum' ? 'is-plat' : ''}"><i style="width:${a.percent}%"></i></div>` : ''}
      <div id="gameNotices">${gameNotices(g, st)}</div>
    </div>
    <div class="modal-body" id="modalBody">
      ${g.hasStats ? `<div class="loading" style="min-height:160px"><div class="spinner"></div></div>` : `<p class="empty">Ce jeu ne propose pas de succès Steam.</p>`}
    </div>
          </div>
          <div class="case-outside" aria-hidden="true">
            <span class="art">${artImg(g.appid, cover, '')}</span>
          </div>
        </div>
      </div>
      <div class="case-hinge" aria-hidden="true"></div>
      <div class="case-right">
        <button class="modal-close" type="button" aria-label="Fermer">${icon('close')}</button>
        <div class="disc-tray ${st.kind === 'platinum' ? rarityHighlights(compute()).get(g.appid) ?? '' : ''}" aria-hidden="true">
          <span class="tray-hub"></span>
          <span class="disc">
            <span class="disc-art">${artImg(g.appid, cover, '')}</span>
            <span class="disc-clear"></span>
            <span class="disc-shine"></span>
          </span>
        </div>
      </div>
    </div>`;
  modal.showModal();
  makeSpinnable(modal.querySelector('.disc'));

  if (!g.hasStats) return;
  try {
    const data = await getJSON(`/api/game/${state.steamid}/${appid}`);
    if (!modal.open) return;
    renderAchievements(data.achievements, st.kind === 'platinum');
  } catch (err) {
    $('#modalBody').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function rarityTag(r) {
  if (r == null) return '';
  const cls = r < 5 ? 'ultra' : r < 15 ? 'rare' : '';
  const label = r < 1 ? r.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : Math.round(r);
  return `<span class="rarity ${cls}" title="Pourcentage de joueurs l’ayant débloqué">${label} % des joueurs</span>`;
}

/** Encadrés de la fiche : difficulté de ce qu'il reste et succès ajoutés par une mise à jour. */
function addedLabel({ from, to }) {
  const n = to - from;
  return `+${n} succès ajouté${n > 1 ? 's' : ''}`;
}

function gameNotices(g, st) {
  const out = [];
  const added = state.added.get(g.appid);
  if (added) {
    out.push(`<div class="notice-added">${icon('sparkle')}<span><strong>${addedLabel(added)}</strong> par une mise à jour (repéré le ${fmtDate(added.at)})</span></div>`);
  }
  const d = state.diff.get(g.appid);
  const tier = st.kind !== 'platinum' ? difficultyTier(d?.hardest) : null;
  if (tier) {
    out.push(`<div class="notice-todo diff-box-${tier.id}">
      <span class="difficulty diff-${tier.id}">${tier.label}</span>
      <span>Il te reste <strong>${d.remaining} succès</strong> pour le platine · le plus dur est débloqué par ${fmtRarity(d.hardest)} des joueurs</span>
    </div>`);
  }
  const hunt = st.kind !== 'platinum' ? state.hunters.get(g.appid) : null;
  if (hunt?.median || hunt?.paidDlc) {
    const share = hunt.started ? Math.round((hunt.perfected / hunt.started) * 100) : null;
    const parts = [
      hunt.median ? `100 % en <strong>≈ ${fmtHours(hunt.median)}</strong> en médiane${g.playtime ? ` (tu en es à ${fmtHours(g.playtime)})` : ''}` : '',
      share != null && hunt.started >= 20 ? `${share} % des chasseurs qui l’ont commencé l’ont fini` : '',
      hunt.paidDlc ? 'ce jeu a des DLC payants' : '',
    ].filter(Boolean);
    out.push(`<div class="notice-hunt">${icon('clock')}<span>${parts.join(' · ')} <a href="https://steamhunters.com/apps/${g.appid}/achievements" target="_blank" rel="noopener">Steam Hunters ↗</a></span></div>`);
  }
  const relicHunt = st.kind === 'platinum' ? state.hunters.get(g.appid) : null;
  if (relicHunt?.unobtainable) {
    out.push(`<div class="notice-relic"><span class="relic-seal">Relique</span><span><strong>Platine de collection</strong> : ${relicHunt.unobtainable} succès ne peu${relicHunt.unobtainable > 1 ? 'vent' : 't'} plus être débloqué${relicHunt.unobtainable > 1 ? 's' : ''} aujourd’hui. Plus personne ne pourra décrocher ce platine.</span></div>`);
  }
  if (st.kind !== 'platinum' && hunt?.unobtainable) {
    out.push(`<div class="notice-dlc is-on">${icon('lock')}<span><strong>${hunt.unobtainable} succès impossible${hunt.unobtainable > 1 ? 's' : ''} à obtenir</strong> : le platine n’est plus faisable.</span></div>`);
  }
  if (canMark() && (st.kind === 'progress' || st.kind === 'notstarted')) {
    const goal = state.goals.has(g.appid);
    const dlc = state.dlcBlocked.has(g.appid);
    if (dlc) {
      out.push(`<div class="notice-dlc is-on">${icon('lock')}<span><strong>Platine bloqué par un DLC</strong> · rangé dans l’onglet « Bloqués (DLC) » de la bibliothèque</span></div>`);
    }
    out.push(`
      <div class="game-actions">
        <button class="btn btn-sm mark-goal" type="button" data-mark="goal" data-appid="${g.appid}" aria-pressed="${goal}">${icon('star')} ${goal ? 'Objectif platine' : 'Ajouter aux objectifs'}</button>
        <button class="btn btn-sm mark-dlc" type="button" data-mark="dlc" data-appid="${g.appid}" aria-pressed="${dlc}">${icon('lock')} ${dlc ? 'Bloqué par un DLC' : 'Bloqué par un DLC ?'}</button>
      </div>`);
  }
  return out.join('');
}

function renderAchievements(list, isPlatinum) {
  const body = $('#modalBody');
  if (!list.length) {
    body.innerHTML = `<p class="empty">Ce jeu ne propose pas de succès Steam.</p>`;
    return;
  }
  const unlocked = list.filter((x) => x.achieved).sort((a, b) => (b.unlocktime ?? 0) - (a.unlocktime ?? 0));
  // Les succès impossibles passent en dernier : inutile de les viser.
  const locked = list.filter((x) => !x.achieved).sort((a, b) => a.impossible - b.impossible || (b.rarity ?? -1) - (a.rarity ?? -1));
  const rarest = unlocked.filter((x) => x.rarity != null).sort((a, b) => a.rarity - b.rarity)[0];

  const row = (x) => {
    const secret = x.hidden && !x.achieved;
    return `
      <div class="ach ${x.achieved ? '' : 'locked todo'} ${x.impossible ? 'is-impossible' : ''}">
        ${x.icon ? `<img src="${esc(x.icon)}" alt="" loading="lazy">` : `<span class="ach-icon">${icon('lock')}</span>`}
        <div style="min-width:0">
          <div class="ach-name">${esc(x.name)}${
            x.nameEn
              ? `<button class="ach-en" type="button" data-copy="${esc(x.nameEn)}" title="Nom original en anglais · cliquer pour copier">${esc(x.nameEn)}</button>`
              : ''
          }</div>
          <div class="ach-desc">${secret ? '<em>Succès caché</em>' : esc(x.description)}</div>
        </div>
        <div class="ach-side">
          ${
            x.impossible
              ? x.achieved
                ? '<span class="relic-seal" title="Ce succès ne peut plus être débloqué aujourd’hui : tu fais partie des derniers à l’avoir">Relique</span>'
                : '<span class="ach-impossible" title="Ce succès ne peut plus être débloqué">Impossible</span>'
              : rarityTag(x.rarity)
          }
          ${x.points ? `<span class="ach-points" title="Points Steam Hunters">${nf.format(x.points)} pts</span>` : ''}
          <div>${x.achieved ? fmtDate(x.unlocktime) : 'Verrouillé'}</div>
        </div>
      </div>`;
  };

  // Ce qu'il reste à faire passe en premier : c'est ce qu'on cherche pour décrocher le platine.
  const todo = locked.length
    ? `<div class="ach-group ach-group-todo">Il te reste ${locked.length} succès · du plus accessible au plus rare</div>${locked.map(row).join('')}`
    : '';
  const done = unlocked.length ? `<div class="ach-group">Débloqués · ${unlocked.length}</div>${unlocked.map(row).join('')}` : '';
  const best = isPlatinum && rarest ? `<div class="ach-group">Ton succès le plus rare</div>${row(rarest)}` : '';
  body.innerHTML = best + todo + done;
}

// ---------------------------------------------------------------- infobulles

const tooltip = $('#tooltip');
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) {
    tooltip.hidden = true;
    return;
  }
  const [title, ...rest] = el.dataset.tip.split('\n');
  tooltip.innerHTML = `<strong>${esc(title)}</strong>${rest.length ? `\n${esc(rest.join('\n'))}` : ''}`;
  tooltip.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = tooltip;
  const x = Math.min(window.innerWidth - w - 8, e.clientX + 14);
  const y = e.clientY - h - 12 < 8 ? e.clientY + 18 : e.clientY - h - 12;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${y}px`;
});
document.addEventListener('pointerleave', () => (tooltip.hidden = true));

boot();
