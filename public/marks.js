// Marquages manuels par profil, mémorisés dans ce navigateur :
// - dlc  : platine bloqué par un DLC que le joueur n'a pas (Steam ne l'indique pas) ;
// - goal : objectif de platine, mis en avant sur le profil.

const KEY = 'steam-stats:marks:v1'; // { steamid: { dlc: [appid…], goal: [appid…] } }
const LEGACY_DLC_KEY = 'steam-stats:dlc-blocked:v1';

function readAll() {
  try {
    const all = JSON.parse(localStorage.getItem(KEY)) ?? {};
    // Reprise des marquages DLC faits avant l'ajout des objectifs.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_DLC_KEY));
    if (legacy) {
      for (const [id, list] of Object.entries(legacy)) all[id] = { goal: [], ...all[id], dlc: [...new Set([...(all[id]?.dlc ?? []), ...list])] };
      localStorage.setItem(KEY, JSON.stringify(all));
      localStorage.removeItem(LEGACY_DLC_KEY);
    }
    return all;
  } catch {
    return {};
  }
}

export function loadMarks(steamid) {
  const m = readAll()[steamid] ?? {};
  return { dlc: new Set(m.dlc ?? []), goal: new Set(m.goal ?? []) };
}

/**
 * Bascule un marquage et renvoie les marquages à jour.
 * Un jeu bloqué par un DLC ne peut pas être un objectif (et inversement).
 */
export function toggleMark(steamid, kind, appid) {
  const all = readAll();
  const marks = loadMarks(steamid);
  const other = kind === 'dlc' ? 'goal' : 'dlc';
  if (marks[kind].has(appid)) {
    marks[kind].delete(appid);
  } else {
    marks[kind].add(appid);
    marks[other].delete(appid);
  }
  all[steamid] = { dlc: [...marks.dlc], goal: [...marks.goal] };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // stockage indisponible : le marquage ne vaudra que pour cette visite
  }
  return marks;
}

/** Remplace les marquages locaux d'un profil (copie de ceux synchronisés avec le serveur). */
export function saveMarks(steamid, { dlc, goal }) {
  const all = readAll();
  all[steamid] = { dlc: [...dlc], goal: [...goal] };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // facultatif
  }
}
