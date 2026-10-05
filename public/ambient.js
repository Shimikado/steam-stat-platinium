import { ART_HOSTS } from './utils.js';
import { setBackdropColor } from './backdrop.js';

// Ambiance du profil : la couleur dominante d'un visuel de jeu teinte le fond procédural de la page.

const CACHE_KEY = 'steam-stats:ambient:v1'; // appid -> [r, g, b]
const DEFAULT = [255, 128, 92];

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function loadImage(urls) {
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= urls.length) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => next(i + 1);
      // Le proxy rend l'image « même origine », sinon le canvas refuse de lire ses pixels.
      img.src = `/api/img?url=${encodeURIComponent(urls[i])}`;
    };
    next(0);
  });
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Couleur dominante « vive » d'un visuel : moyenne des pixels pondérée par leur saturation,
 * puis ramenée à une saturation et une luminosité qui rendent bien en lueur sur fond sombre.
 */
function dominantColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 0.12 || l > 0.92) continue; // on ignore les noirs et blancs
    const weight = s * s + 0.02;
    r += data[i] * weight;
    g += data[i + 1] * weight;
    b += data[i + 2] * weight;
    w += weight;
  }
  if (!w) return DEFAULT;
  const [h, s] = rgbToHsl(r / w, g / w, b / w);
  return hslToRgb(h, Math.max(0.55, Math.min(0.85, s * 1.3)), 0.6);
}

export async function ambientColor(appid) {
  const cache = readCache();
  if (cache[appid]) return cache[appid];
  const urls = ['header.jpg', 'library_hero.jpg'].flatMap((f) => ART_HOSTS.map((h) => `${h}/${appid}/${f}`));
  const img = await loadImage(urls);
  if (!img) return null;
  let color;
  try {
    color = dominantColor(img);
  } catch {
    return null;
  }
  cache[appid] = color;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // cache facultatif
  }
  return color;
}

export function applyAmbient(color) {
  const [r, g, b] = color ?? DEFAULT;
  document.documentElement.style.setProperty('--ambient-rgb', `${r} ${g} ${b}`);
  setBackdropColor([r, g, b]);
}

// Dernière ambiance de chaque profil, pour l'appliquer dès l'ouverture sans changement visible ensuite.
const PROFILE_KEY = 'steam-stats:ambient-profile:v1'; // steamid -> { appid, color }

export function restoreAmbient(steamid) {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY))?.[steamid];
    if (saved) applyAmbient(saved.color);
    return saved ?? null;
  } catch {
    return null;
  }
}

export async function updateAmbient(steamid, appid) {
  const color = await ambientColor(appid);
  if (!color) return null;
  applyAmbient(color);
  try {
    const all = JSON.parse(localStorage.getItem(PROFILE_KEY)) ?? {};
    all[steamid] = { appid, color };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
  } catch {
    // facultatif
  }
  return color;
}
