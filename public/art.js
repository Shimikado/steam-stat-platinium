// Visuels des jeux, avec une chaîne de repli :
// 1. les vraies adresses fournies par le magasin Steam (via /api/art), dès qu'on les connaît ;
// 2. les adresses « classiques » sur les CDN Steam ;
// 3. si tout échoue, on redemande les vraies adresses au serveur et on réessaie ;
// 4. en dernier recours, l'icône du jeu et son nom.

export const ART_HOSTS = [
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
];

// Fichier « classique » → clé renvoyée par /api/art
const KIND = { 'library_600x900.jpg': 'capsule', 'library_hero.jpg': 'hero', 'header.jpg': 'header' };

const STORE_KEY = 'steam-stats:art:v1';
const known = new Map(); // appid -> { header, capsule, hero } | null
const icons = new Map(); // appid -> URL de l'icône du jeu
const waiting = new Map(); // appid -> Set<img> en attente de résolution
let queueTimer = null;

try {
  for (const [id, art] of Object.entries(JSON.parse(localStorage.getItem(STORE_KEY)) ?? {})) known.set(Number(id), art);
} catch {
  // pas de cache local
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(known)));
  } catch {
    // stockage plein : tant pis, on redemandera
  }
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Adresses à essayer, dans l'ordre, pour ces fichiers. */
export function artUrls(appid, files) {
  const art = known.get(appid);
  const resolved = art ? files.map((f) => art[KIND[f]]).filter(Boolean) : [];
  const classic = files.flatMap((f) => ART_HOSTS.map((h) => `${h}/${appid}/${f}`));
  return [...new Set([...resolved, ...classic])];
}

export function artImg(appid, files, alt) {
  const [first, ...rest] = artUrls(appid, files);
  return `<img src="${first}" data-fallback="${rest.join('|')}" data-appid-art="${appid}" data-kinds="${files.map((f) => KIND[f]).join(',')}" alt="${escAttr(alt)}" loading="lazy" decoding="async">`;
}

/** Icônes connues grâce à la liste des jeux du profil (dernier recours visuel). */
export function registerIcons(games) {
  for (const g of games) {
    if (g.icon) icons.set(g.appid, `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.icon}.jpg`);
  }
}

/** Charge en amont les vraies adresses d'une liste de jeux (évite des 404 à l'affichage). */
export async function preloadArt(appids) {
  const todo = appids.filter((id) => !known.has(id));
  for (let i = 0; i < todo.length; i += 250) {
    try {
      const res = await fetch(`/api/art?appids=${todo.slice(i, i + 250).join(',')}`);
      if (!res.ok) return;
      for (const [id, art] of Object.entries(await res.json())) known.set(Number(id), art);
    } catch {
      return;
    }
  }
  persist();
}

function lastResort(img) {
  const appid = Number(img.dataset.appidArt);
  const icon = icons.get(appid);
  if (icon && !img.classList.contains('is-icon')) {
    img.classList.add('is-icon');
    img.dataset.fallback = '';
    img.src = icon;
    return;
  }
  img.classList.remove('is-icon');
  img.classList.add('broken');
}

function retryWithResolved(img) {
  const appid = Number(img.dataset.appidArt);
  const art = known.get(appid);
  const tried = img.dataset.tried === '1';
  if (art && !tried) {
    const urls = img.dataset.kinds
      .split(',')
      .map((k) => art[k])
      .filter((u) => u && u !== img.src);
    if (urls.length) {
      img.dataset.tried = '1';
      img.dataset.fallback = urls.slice(1).join('|');
      img.src = urls[0];
      return;
    }
  }
  if (known.has(appid) || tried) return lastResort(img);

  // Adresses encore inconnues : on les demande au serveur, par petits lots.
  if (!waiting.has(appid)) waiting.set(appid, new Set());
  waiting.get(appid).add(img);
  queueTimer ??= setTimeout(flushQueue, 150);
}

async function flushQueue() {
  queueTimer = null;
  const batch = new Map(waiting);
  waiting.clear();
  await preloadArt([...batch.keys()]);
  for (const [appid, imgs] of batch) {
    if (!known.has(appid)) known.set(appid, null); // pas de réponse : on n'insistera pas
    for (const img of imgs) if (img.isConnected) retryWithResolved(img);
  }
}

export function installArtFallback() {
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.fallback === undefined) return;
      if (img.classList.contains('is-icon')) {
        img.classList.remove('is-icon');
        img.classList.add('broken');
        return;
      }
      const rest = img.dataset.fallback.split('|').filter(Boolean);
      if (rest.length) {
        img.dataset.fallback = rest.slice(1).join('|');
        img.src = rest[0];
      } else if (img.dataset.appidArt) {
        retryWithResolved(img);
      } else {
        img.classList.add('broken');
      }
    },
    true,
  );
}
