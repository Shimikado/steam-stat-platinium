import { esc, icon, artImg } from './utils.js';

// Célébration des nouveautés depuis la dernière visite : confettis + carte récapitulative.
// C'est un moment rare (un nouveau platine), c'est là que l'animation a toute sa place.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const COLORS = ['#f4f8ff', '#dfe9f7', '#b9cbe4', '#7d97bd', '#ff8ccf', '#ffd36e', '#7effc8', '#6ec8ff', '#c58bff'];

export function confetti({ count = 180, duration = 3800 } = {}) {
  if (reduceMotion.matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  // En popover, le canvas rejoint la « top layer » et passe au-dessus de la modale ouverte.
  canvas.popover = 'manual';
  document.body.append(canvas);
  canvas.showPopover?.();
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  // Trois canons : bas-gauche, bas-droite et un éclat central.
  const sources = [
    { x: 0, y: H * 0.85, angle: -60, spread: 30 },
    { x: W, y: H * 0.85, angle: -120, spread: 30 },
    { x: W / 2, y: H * 0.45, angle: -90, spread: 180 },
  ];
  const parts = Array.from({ length: count }, (_, i) => {
    const src = sources[i % 3];
    const a = ((src.angle + (Math.random() - 0.5) * src.spread * 2) * Math.PI) / 180;
    const speed = (src === sources[2] ? 6 : 13) + Math.random() * 9;
    return {
      x: src.x,
      y: src.y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      size: 5 + Math.random() * 7,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      flutter: Math.random() * Math.PI * 2,
      round: Math.random() < 0.3,
    };
  });

  const start = performance.now();
  let last = start;
  const frame = (now) => {
    const t = now - start;
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    ctx.clearRect(0, 0, W, H);
    const fade = t > duration - 800 ? Math.max(0, (duration - t) / 800) : 1;
    for (const p of parts) {
      p.vy += 0.32 * dt; // gravité
      p.vx *= 0.985 ** dt; // résistance de l'air
      p.vy *= 0.985 ** dt;
      p.flutter += 0.12 * dt;
      p.x += (p.vx + Math.sin(p.flutter) * 0.8) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > H + 20) continue;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Le cosinus écrase le rectangle : effet de papier qui tourne sur lui-même.
        ctx.fillRect(-p.size / 2, (-p.size / 3) * Math.abs(Math.cos(p.flutter)), p.size, (p.size / 1.5) * Math.abs(Math.cos(p.flutter)) + 1);
      }
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/**
 * plats : [{appid, name}] · rank : {name, tone} | null
 */
export function celebrate({ plats = [], rank = null }) {
  if (!plats.length && !rank) return;

  const title = plats.length
    ? plats.length > 1
      ? `${plats.length} nouveaux platines !`
      : 'Nouveau platine !'
    : `Rang ${rank.name} atteint !`;

  const dialog = document.createElement('dialog');
  dialog.className = 'celebration';
  dialog.innerHTML = `
    <div class="celebration-glow" aria-hidden="true"></div>
    <div class="celebration-trophy">${icon('trophy')}</div>
    <p class="celebration-eyebrow">Depuis ta dernière visite</p>
    <h2 class="celebration-title">${esc(title)}</h2>
    ${
      plats.length
        ? `<div class="celebration-plats">${plats
            .slice(0, 4)
            .map(
              (g) => `
            <div class="celebration-plat">
              <span class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['library_600x900.jpg', 'header.jpg'], g.name)}</span>
              <span class="celebration-plat-name">${esc(g.name)}</span>
            </div>`,
            )
            .join('')}</div>${plats.length > 4 ? `<p class="celebration-more">et ${plats.length - 4} autre${plats.length > 5 ? 's' : ''}…</p>` : ''}`
        : ''
    }
    ${rank && plats.length ? `<p class="celebration-rank tone-${rank.tone}">${icon('trophy')} Rang ${esc(rank.name)} atteint</p>` : ''}
    <button class="btn btn-primary btn-lg celebration-close" type="button">Trop bien !</button>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('.celebration-close')) dialog.close();
  });
  dialog.showModal();
  confetti();
}
