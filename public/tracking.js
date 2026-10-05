// Détection des succès ajoutés par une mise à jour d'un jeu.
// Steam ne donne pas la date d'ajout d'un succès : on mémorise le nombre total de succès de chaque jeu
// (identique pour tous les joueurs) et on repère les hausses d'une visite à l'autre, dans ce navigateur.

const TOTALS_KEY = 'steam-stats:totals:v1'; // appid -> nombre total de succès
const ADDED_KEY = 'steam-stats:added:v1'; // appid -> { from, to, at }
const KEEP_SECONDS = 60 * 24 * 3600; // une nouveauté reste signalée 60 jours

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // stockage plein ou indisponible : la détection sera simplement moins complète
  }
}

/**
 * entries : [[appid, total], …] pour les jeux analysés.
 * Renvoie une Map appid -> { from, to, at } des jeux qui ont gagné des succès récemment.
 */
export function trackNewAchievements(entries) {
  const totals = read(TOTALS_KEY);
  const added = read(ADDED_KEY);
  const now = Math.floor(Date.now() / 1000);

  for (const [appid, total] of entries) {
    const prev = totals[appid];
    if (prev != null && total > prev) {
      // Plusieurs ajouts rapprochés : on garde le total d'origine pour afficher le cumul.
      const recent = added[appid] && now - added[appid].at < KEEP_SECONDS;
      added[appid] = { from: recent ? added[appid].from : prev, to: total, at: now };
    }
    totals[appid] = total;
  }

  for (const [appid, info] of Object.entries(added)) {
    if (now - info.at > KEEP_SECONDS || totals[appid] < info.to) delete added[appid];
  }

  write(TOTALS_KEY, totals);
  write(ADDED_KEY, added);
  return new Map(Object.entries(added).map(([id, info]) => [Number(id), info]));
}
