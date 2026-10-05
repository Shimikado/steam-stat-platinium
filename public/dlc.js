// Platines bloqués par un DLC : marquage manuel, par profil, mémorisé dans ce navigateur.
// Steam n'indique ni les DLC possédés ni les succès qui en dépendent, d'où le choix d'un marquage à la main.

const KEY = 'steam-stats:dlc-blocked:v1'; // { steamid: [appid, …] }

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

export function loadDlcBlocked(steamid) {
  return new Set(readAll()[steamid] ?? []);
}

/** Bascule le marquage d'un jeu et renvoie le nouvel ensemble. */
export function toggleDlcBlocked(steamid, appid) {
  const all = readAll();
  const set = new Set(all[steamid] ?? []);
  if (set.has(appid)) set.delete(appid);
  else set.add(appid);
  all[steamid] = [...set];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // stockage indisponible : le marquage ne vaudra que pour cette visite
  }
  return set;
}
