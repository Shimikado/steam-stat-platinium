// Fond « poussière dans la lampe » : un cône de lumière chaude (CSS, flou doux) dans lequel flottent
// de fines particules de poussière (canvas pleine résolution). La lumière et quelques particules
// prennent une légère teinte des couleurs du profil (platines épinglés…).

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const FRAME_MS = 1000 / 30;
const MOTES = 70;
const WARM = [255, 206, 150]; // lumière de lampe à incandescence

let canvas;
let ctx;
let raf = 0;
let last = 0;
let W = 0;
let H = 0;
let dpr = 1;
const start = performance.now();
let motes = [];

// Teintes des particules (la première est toujours la lumière chaude), avec glissement vers la cible.
let tints = [WARM];
let target = null;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---------------------------------------------------------------- géométrie du cône

const cx = () => W * 0.5;
/** Demi-largeur du cône de lumière à la hauteur y (étroit en haut, large en bas). */
const halfWidth = (y) => W * (0.06 + 0.34 * Math.min(1, Math.max(0, y / H)));
/** 1 au centre du faisceau, 0 en dehors, avec une transition douce sur les bords. */
function inCone(x, y) {
  const d = Math.abs(x - cx()) / halfWidth(y);
  return d < 0.7 ? 1 : d > 1.25 ? 0 : 1 - (d - 0.7) / 0.55;
}

// ---------------------------------------------------------------- particules

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // ≈ normale, bornée
}

function spawn(m = {}) {
  m.y = Math.random() * H;
  // Plus dense dans le faisceau, quelques grains égarés ailleurs.
  m.x = Math.random() < 0.8 ? cx() + gauss() * halfWidth(m.y) : Math.random() * W;
  m.vx = (Math.random() - 0.5) * 0.15;
  m.vy = (Math.random() - 0.5) * 0.12;
  m.r = 0.5 + Math.random() ** 2 * 1.8; // surtout de très fins grains
  m.a = 0.25 + Math.random() * 0.55;
  m.f = 0.3 + Math.random() * 0.9; // fréquence de scintillement
  m.p = Math.random() * Math.PI * 2;
  m.tint = Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 3); // 30 % teintées
  return m;
}

function resize() {
  dpr = Math.min(1.5, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  motes = Array.from({ length: MOTES }, () => spawn());
  draw(performance.now(), false);
}

function step(dt) {
  for (const m of motes) {
    // Brassage de l'air : petite marche aléatoire amortie, légère tendance à monter (air chaud).
    m.vx = (m.vx + (Math.random() - 0.5) * 0.02) * 0.985;
    m.vy = (m.vy + (Math.random() - 0.5) * 0.02 - 0.0015) * 0.985;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.x < -10 || m.x > W + 10 || m.y < -10 || m.y > H + 10) spawn(m);
  }
}

function draw(now, move = true) {
  if (!ctx) return;
  const t = (now - start) / 1000;
  const dt = Math.min(3, (now - last) / 33.3 || 1);
  if (move) step(dt);

  if (target) {
    tints = target.map((c, i) => mix(tints[i] ?? c, c, 0.05));
    if (target.every((c, i) => c.every((v, k) => Math.abs(v - tints[i][k]) < 0.5))) target = null;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const light = 0.12 + 0.88 * inCone(m.x, m.y);
    const twinkle = 0.65 + 0.35 * Math.sin(t * m.f + m.p);
    const alpha = m.a * light * twinkle;
    if (alpha < 0.02) continue;
    const [r, g, b] = (tints[m.tint] ?? tints[0]).map(Math.round);
    // Petit halo pour les plus gros grains, puis le grain lui-même, net.
    if (m.r > 1.3) {
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.18})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  if (now - last < FRAME_MS) return;
  draw(now);
  last = now;
}

function play() {
  cancelAnimationFrame(raf);
  if (reduceMotion.matches || document.hidden) {
    draw(performance.now(), false); // image fixe
    return;
  }
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- lampe (CSS)

function buildLamp() {
  const lamp = document.createElement('div');
  lamp.className = 'lamp';
  lamp.setAttribute('aria-hidden', 'true');
  // Le flou est sur le conteneur, la découpe en cône sur l'enfant : bords du faisceau adoucis.
  lamp.innerHTML = '<div class="lamp-cone"><div class="lamp-beam"></div></div><div class="lamp-bulb"></div>';
  document.body.prepend(lamp);
}

function setLampColor(colors) {
  const [r, g, b] = mix(WARM, colors[0] ?? WARM, 0.3).map(Math.round);
  const root = document.documentElement.style;
  root.setProperty('--lamp-r', r);
  root.setProperty('--lamp-g', g);
  root.setProperty('--lamp-b', b);
}

/** Teintes des particules : lumière chaude, puis les couleurs du profil éclaircies. */
const tintsFrom = (colors) => [WARM, ...colors.slice(0, 3).map((c) => mix(c, [255, 240, 220], 0.45))];

export function startBackdrop(colors) {
  if (canvas) return;
  buildLamp();
  canvas = document.createElement('canvas');
  canvas.className = 'backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  document.querySelector('.lamp').after(canvas); // la poussière passe devant le faisceau
  ctx = canvas.getContext('2d');
  tints = tintsFrom(colors);
  setLampColor(colors);
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', play);
  reduceMotion.addEventListener('change', play);
  play();
}

/** Change les couleurs du profil (1 à 3) : la lampe glisse vers la nouvelle teinte, la poussière aussi. */
export function setBackdropColors(colors) {
  if (!colors?.length) return;
  if (!canvas) return startBackdrop(colors);
  setLampColor(colors);
  target = tintsFrom(colors);
  if (reduceMotion.matches || document.hidden) {
    tints = target;
    target = null;
    draw(performance.now(), false);
  }
}
