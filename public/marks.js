// Marquages manuels par profil, mémorisés dans ce navigateur (et synchronisés avec le compte si possible) :
// - dlc  : platine bloqué par un DLC que le joueur n'a pas (Steam ne l'indique pas) ;
// - goal : objectif de platine, mis en avant sur le profil ;
// - pin  : platine épinglé, mis en avant dans la vitrine et sur la carte de chasseur (MAX_PINS au plus).

const KEY = 'steam-stats:marks:v1'; // { steamid: { dlc: [appid…], goal: [appid…], pin: [appid…] } }
const LEGACY_DLC_KEY = 'steam-stats:dlc-blocked:v1';
export const MAX_PINS = 3;

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

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // stockage indisponible : le marquage ne vaudra que pour cette visite
  }
}

export function loadMarks(steamid) {
  const m = readAll()[steamid] ?? {};
  return { dlc: new Set(m.dlc ?? []), goal: new Set(m.goal ?? []), pin: new Set(m.pin ?? []) };
}

/**
 * Bascule un marquage et renvoie les marquages à jour (ou null si la limite d'épingles est atteinte).
 * Un jeu bloqué par un DLC ne peut pas être un objectif (et inversement) ; l'épingle est indépendante.
 */
export function toggleMark(steamid, kind, appid) {
  const all = readAll();
  const marks = loadMarks(steamid);
  if (marks[kind].has(appid)) {
    marks[kind].delete(appid);
  } else {
    if (kind === 'pin' && marks.pin.size >= MAX_PINS) return null;
    marks[kind].add(appid);
    if (kind !== 'pin') marks[kind === 'dlc' ? 'goal' : 'dlc'].delete(appid);
  }
  all[steamid] = { dlc: [...marks.dlc], goal: [...marks.goal], pin: [...marks.pin] };
  writeAll(all);
  return marks;
}

/** Remplace les marquages locaux d'un profil (copie de ceux synchronisés avec le serveur). */
export function saveMarks(steamid, { dlc, goal, pin = [] }) {
  const all = readAll();
  all[steamid] = { dlc: [...dlc], goal: [...goal], pin: [...pin] };
  writeAll(all);
}
