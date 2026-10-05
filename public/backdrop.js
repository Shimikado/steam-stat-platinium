// Fond procédural : de grandes taches de lumière qui dérivent lentement, teintées par la couleur
// d'ambiance du profil. Dessiné en basse résolution (puis agrandi par le navigateur, ce qui floute
// naturellement) et limité à ~24 images/s pour rester discret et léger.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SCALE = 1 / 8; // résolution du canvas par rapport à l'écran
const FRAME_MS = 1000 / 24;

let canvas;
let ctx;
let raf = 0;
let last = 0;
const start = performance.now();

// Couleurs actuelles et cibles des taches, en [r, g, b] ; on glisse de l'une à l'autre.
let current = null;
let target = null;

// Chaque tache suit une courbe de Lissajous lente : position, rayon et phase propres.
const BLOBS = [
  { x: 0.82, y: 0.08, ax: 0.1, ay: 0.08, fx: 0.031, fy: 0.023, r: 0.62, alpha: 0.26 },
  { x: 0.12, y: 0.22, ax: 0.09, ay: 0.12, fx: 0.019, fy: 0.027, r: 0.55, alpha: 0.18 },
  { x: 0.55, y: 0.78, ax: 0.16, ay: 0.07, fx: 0.023, fy: 0.017, r: 0.7, alpha: 0.13 },
  { x: 0.95, y: 0.6, ax: 0.07, ay: 0.14, fx: 0.029, fy: 0.021, r: 0.45, alpha: 0.12 },
];

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function toHsl([r, g, b]) {
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

/** Palette de 4 teintes à partir d'une couleur : elle-même, deux voisines et une version sombre. */
function paletteFrom(rgb) {
  const [h, s] = toHsl(rgb);
  const wrap = (x) => (x + 1) % 1;
  return [
    hsl(h, Math.min(0.85, s), 0.55),
    hsl(wrap(h - 0.07), Math.min(0.8, s * 0.9), 0.5),
    hsl(wrap(h + 0.09), Math.min(0.75, s * 0.85), 0.45),
    hsl(wrap(h + 0.5), 0.35, 0.4), // touche complémentaire, très discrète
  ];
}

function resize() {
  canvas.width = Math.max(32, Math.round(window.innerWidth * SCALE));
  canvas.height = Math.max(32, Math.round(window.innerHeight * SCALE));
  draw(performance.now());
}

function draw(now) {
  if (!current) return;
  const t = (now - start) / 1000;
  const W = canvas.width;
  const H = canvas.height;
  const size = Math.max(W, H);

  // Glissement progressif vers la palette cible (~1,5 s).
  if (target) {
    let done = true;
    current = current.map((c, i) =>
      c.map((v, k) => {
        const d = target[i][k] - v;
        if (Math.abs(d) > 0.5) done = false;
        return v + d * 0.06;
      }),
    );
    if (done) target = null;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  BLOBS.forEach((b, i) => {
    const x = (b.x + Math.sin(t * b.fx * 2 * Math.PI + i) * b.ax) * W;
    const y = (b.y + Math.cos(t * b.fy * 2 * Math.PI + i * 1.7) * b.ay) * H;
    const r = b.r * size * (1 + Math.sin(t * 0.05 + i) * 0.08);
    const [cr, cg, cb] = current[i].map(Math.round);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${b.alpha})`);
    g.addColorStop(0.55, `rgba(${cr},${cg},${cb},${b.alpha * 0.35})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });
  ctx.globalCompositeOperation = 'source-over';
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  if (now - last < FRAME_MS) return;
  last = now;
  draw(now);
}

function play() {
  cancelAnimationFrame(raf);
  if (reduceMotion.matches || document.hidden) {
    draw(performance.now()); // une image fixe suffit
    return;
  }
  raf = requestAnimationFrame(loop);
}

export function startBackdrop(rgb) {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  ctx = canvas.getContext('2d');
  current = paletteFrom(rgb);
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', play);
  reduceMotion.addEventListener('change', play);
  play();
}

export function setBackdropColor(rgb) {
  if (!canvas) return startBackdrop(rgb);
  target = paletteFrom(rgb);
  // Avec les animations réduites, pas de boucle : on applique directement.
  if (reduceMotion.matches || document.hidden) {
    current = target;
    target = null;
    draw(performance.now());
  }
}
