// Fonctions partagées entre les modules du front.

export const $ = (sel, root = document) => root.querySelector(sel);
export const nf = new Intl.NumberFormat('fr-FR');
export const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
export const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric' });
export const monthShort = new Intl.DateTimeFormat('fr-FR', { month: 'short' });

export const ART_HOSTS = [
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function fmtHours(min) {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return h < 10 ? `${h.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h` : `${nf.format(Math.round(h))} h`;
}

export const fmtDate = (ts) => (ts ? dateFmt.format(new Date(ts * 1000)) : '—');
export const fmtPct = (p) => `${p >= 99.5 && p < 100 ? '99' : Math.round(p)} %`;

export async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur HTTP ${res.status}`), { status: res.status });
  return data;
}

/** <img> avec une chaîne d'URLs de repli (les assets Steam récents n'existent pas toujours sur l'ancien CDN). */
export function artImg(appid, files, alt) {
  const urls = files.flatMap((f) => ART_HOSTS.map((h) => `${h}/${appid}/${f}`));
  const [first, ...rest] = urls;
  return `<img src="${first}" data-fallback="${rest.join('|')}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
}

export const gameIconUrl = (g) =>
  g.icon ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.icon}.jpg` : '';


/** Tranches de rareté d'un platine, d'après le % maximum de joueurs l'ayant obtenu. */
export function rarityTier(p) {
  if (p == null) return null;
  if (p <= 5) return { id: 'ultra', label: 'Ultra rare' };
  if (p <= 15) return { id: 'rare', label: 'Rare' };
  if (p <= 35) return { id: 'uncommon', label: 'Peu commun' };
  return { id: 'common', label: 'Commun' };
}

/**
 * Rang de difficulté d'un platine à faire, d'après le succès restant le plus rare
 * (le % de joueurs l'ayant débloqué) : c'est lui qui décide si le platine est atteignable.
 */
export const DIFFICULTY_TIERS = [
  { id: 'easy', label: 'Facile', min: 25, hint: 'Tous les succès restants sont débloqués par 25 % des joueurs ou plus' },
  { id: 'doable', label: 'Faisable', min: 8, hint: 'Le succès restant le plus dur est débloqué par 8 à 25 % des joueurs' },
  { id: 'tough', label: 'Coriace', min: 2, hint: 'Le succès restant le plus dur est débloqué par 2 à 8 % des joueurs' },
  { id: 'legendary', label: 'Légendaire', min: 0, hint: 'Au moins un succès restant est débloqué par moins de 2 % des joueurs' },
];

export function difficultyTier(hardest) {
  if (hardest == null) return null;
  return DIFFICULTY_TIERS.find((t) => hardest >= t.min);
}

export const fmtRarity = (p) => `${p < 10 ? p.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : Math.round(p)} %`;
