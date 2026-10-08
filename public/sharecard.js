import { artUrls } from './art.js';
import { esc, icon, nf, fmtRarity, artImg } from './utils.js';

// Carte de chasseur partageable (PNG 1200×630, le format des aperçus Discord/Twitter).

const W = 1200;
const H = 630;

// Ambiance « étagère en bois sombre » : bois, laiton, papier crème et lumière de lampe (comme l'app).
const WOOD = { light: '#8a5d39', mid: '#6b4528', dark: '#4a2e18', deep: '#2c1a0d' };
const PAPER = '#efe2c6';
const INK = '#3b2a1a';
const CREAM = '#f3e6cb';
const MUTED = '#b59b7a';
const BRASS = ['#f8e2a8', '#d9a75a', '#9c6a30'];
const DISPLAY = 'Fraunces, Georgia, serif';

// Même échelle que le halo de rareté de l'étagère (rustic.css) : cuivre → ambre → or → or blanc.
function halo(rarity) {
  if (rarity == null) return null;
  if (rarity <= 1) return { rgb: '255,232,178', a: 0.95 };
  if (rarity <= 5) return { rgb: '255,196,96', a: 0.7 };
  if (rarity <= 20) return { rgb: '232,160,80', a: 0.5 };
  return { rgb: '196,128,84', a: 0.32 };
}

// La police du canvas n'a pas toujours l'espace fine insécable du français : on la remplace par une espace normale.
const plain = (text) => String(text).replace(/[  ]/g, ' ');

const proxied = (url) => `/api/img?url=${encodeURIComponent(url)}`;

function loadImage(urls) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= urls.length) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => tryNext(i + 1);
      img.src = proxied(urls[i]);
    };
    tryNext(0);
  });
}

const capsuleUrls = (appid) => artUrls(appid, ['library_600x900.jpg', 'header.jpg']);

function gradient(ctx, x0, y0, x1, y1, colors) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
  return g;
}

function glow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Dessine une image en mode « cover » dans un rectangle arrondi. */
function drawCover(ctx, img, x, y, w, h, r) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const scale = Math.max(w / img.width, h / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  ctx.restore();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Fond du meuble : bois sombre veiné. */
function woodPanel(ctx, x, y, w, h, top = '#24170d', bottom = '#170f08') {
  ctx.fillStyle = gradient(ctx, 0, y, 0, y + h, [top, bottom]);
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,220,170,0.022)';
  for (let gx = x; gx < x + w; gx += 13) ctx.fillRect(gx, y, 3, h);
}

/** Petite étiquette papier punaisée, légèrement de travers. draw(ctx, w, h) dessine autour du centre. */
function paperTag(ctx, cx, y, w, h, rot, draw, pin = false) {
  ctx.save();
  ctx.translate(cx, y + h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = gradient(ctx, 0, -h / 2, 0, h / 2, [PAPER, '#e3d2b0']);
  roundRect(ctx, -w / 2, -h / 2, w, h, 3);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  if (pin) {
    ctx.fillStyle = gradient(ctx, -4, -h / 2 + 3, 4, -h / 2 + 11, ['#fff0c8', '#8c5e28']);
    ctx.beginPath();
    ctx.arc(0, -h / 2 + 7, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  draw(ctx, w, h);
  ctx.textAlign = 'left';
  ctx.restore();
}

/** Plaque de laiton gravée, avec ses deux vis. */
function brassPlate(ctx, x, y, text) {
  ctx.font = `600 21px ${DISPLAY}`;
  const w = ctx.measureText(text).width + 64;
  const h = 40;
  const cy = y + h / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = gradient(ctx, x, y, x, y + h, BRASS);
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,245,215,0.45)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 3.5, y + 3.5, w - 7, h - 7, 2);
  ctx.stroke();
  for (const sx of [x + 15, x + w - 15]) {
    ctx.fillStyle = gradient(ctx, sx - 4, cy - 4, sx + 4, cy + 4, ['#fff0c8', '#7d5424']);
    ctx.beginPath();
    ctx.arc(sx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,35,12,0.7)';
    ctx.beginPath();
    ctx.moveTo(sx - 3, cy + 1);
    ctx.lineTo(sx + 3, cy - 1);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,240,205,0.5)'; // gravure : liseré clair sous les lettres
  ctx.fillText(text, x + 32, y + 28);
  ctx.fillStyle = INK;
  ctx.fillText(text, x + 32, y + 27);
}

/**
 * Boîte de jeu comme sur l'étagère du profil : jaquette légèrement tournée (rotateY 20°),
 * fine tranche sombre à gauche, charnière claire et reflet en biais.
 */
function gameBox(ctx, img, x, y, w, h) {
  const spine = 7;
  const fw = w - spine;
  const fx = x + spine;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = '#2a1d14';
  ctx.fillRect(fx, y, fw, h);
  ctx.restore();

  // Tranche, vue de biais
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y + 3);
  ctx.lineTo(fx, y);
  ctx.lineTo(fx, y + h);
  ctx.lineTo(x, y + h - 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = '#1e140c';
  ctx.fillRect(x, y, spine, h);
  if (img) ctx.drawImage(img, 0, 0, img.width * 0.08, img.height, x, y, spine, h);
  ctx.fillStyle = 'rgba(10,6,3,0.55)';
  ctx.fillRect(x, y, spine, h);
  ctx.restore();

  // Face : jaquette, charnière, reflet
  if (img) drawCover(ctx, img, fx, y, fw, h, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(fx, y, 5, h);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(fx + 5, y, 1, h);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(fx + fw - 1, y, 1, h);
  const gloss = ctx.createLinearGradient(fx, y, fx + fw * 0.9, y + h * 0.42);
  gloss.addColorStop(0, 'rgba(255,255,255,0.2)');
  gloss.addColorStop(0.32, 'rgba(255,255,255,0)');
  gloss.addColorStop(0.72, 'rgba(255,255,255,0)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.07)');
  ctx.fillStyle = gloss;
  ctx.fillRect(fx, y, fw, h);
}

async function drawCard({ player, rank, plats, stats, featured }) {
  await document.fonts.ready;
  await Promise.all(
    [`800 150px ${DISPLAY}`, `600 46px ${DISPLAY}`, `700 28px ${DISPLAY}`, '600 15px Inter'].map((f) =>
      document.fonts.load(f).catch(() => {}),
    ),
  );
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const [avatar, ...covers] = await Promise.all([
    loadImage([player.avatar]),
    ...featured.map((f) => loadImage(capsuleUrls(f.appid))),
  ]);

  // Cadre en bois, puis le fond du meuble
  const F = 14;
  ctx.fillStyle = gradient(ctx, 0, 0, W, H, [WOOD.mid, WOOD.dark, WOOD.deep, WOOD.dark]);
  ctx.fillRect(0, 0, W, H);
  woodPanel(ctx, F, F, W - F * 2, H - F * 2, '#211509', '#130c06');
  ctx.strokeStyle = 'rgba(217,167,90,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(F + 0.5, F + 0.5, W - F * 2 - 1, H - F * 2 - 1);
  glow(ctx, 260, 260, 420, 'rgba(255,190,120,0.07)');

  // ---------------------------------------------------------------- à gauche : le chasseur

  // Avatar dans un cadre en laiton
  const ax = 70;
  const ay = 72;
  const as = 120;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = gradient(ctx, ax - 9, ay - 9, ax + as + 9, ay + as + 9, BRASS);
  roundRect(ctx, ax - 9, ay - 9, as + 18, as + 18, 6);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1a110a';
  ctx.fillRect(ax - 2, ay - 2, as + 4, as + 4);
  if (avatar) drawCover(ctx, avatar, ax, ay, as, as, 2);

  const tx = ax + as + 36;
  ctx.fillStyle = CREAM;
  ctx.font = `600 46px ${DISPLAY}`;
  ctx.fillText(fitText(ctx, player.name, 380), tx, ay + 50);
  brassPlate(ctx, tx, ay + 72, `Rang ${rank.name}`);

  // Gros chiffre en laiton, gravé dans le bois
  const platText = plain(nf.format(plats));
  ctx.font = `800 150px ${DISPLAY}`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(platText, 62, 394);
  ctx.fillStyle = gradient(ctx, 0, 285, 0, 392, BRASS);
  ctx.fillText(platText, 60, 390);
  const pw = ctx.measureText(platText).width;
  ctx.fillStyle = CREAM;
  ctx.font = `600 32px ${DISPLAY}`;
  ctx.fillText(plats > 1 ? 'jeux' : 'jeu', 60 + pw + 20, 340);
  ctx.fillText(plats > 1 ? 'platinés' : 'platiné', 60 + pw + 20, 378);

  // Stats sur des étiquettes papier punaisées
  let sx = 64;
  const rots = [-1.6, 1.1, -0.8];
  stats.forEach(([raw, label], i) => {
    const value = plain(raw);
    ctx.font = `700 28px ${DISPLAY}`;
    const vw = ctx.measureText(value).width;
    ctx.font = '600 14px Inter, sans-serif';
    const w = Math.max(vw, ctx.measureText(label).width) + 36;
    paperTag(ctx, sx + w / 2, 436, w, 78, rots[i % rots.length], (c) => {
      c.fillStyle = INK;
      c.font = `700 28px ${DISPLAY}`;
      c.fillText(value, 0, 10);
      c.fillStyle = 'rgba(59,42,26,0.72)';
      c.font = '600 14px Inter, sans-serif';
      c.fillText(label, 0, 30);
    }, true);
    sx += w + 24;
  });

  // ---------------------------------------------------------------- à droite : l'étagère éclairée

  const nx = 650;
  const ny = 104;
  const nw = W - F - 40 - nx;
  const plankY = 452;
  const plankH = 30;
  const nh = plankY + plankH - ny;

  if (featured.length) {
    ctx.fillStyle = MUTED;
    ctx.font = '700 14px Inter, sans-serif';
    ctx.letterSpacing = '3px';
    ctx.fillText(
      featured.some((f) => f.pinned)
        ? 'MES PLATINES À L’HONNEUR'
        : featured.some((f) => f.rarity != null)
          ? 'MES PLATINES LES PLUS RARES'
          : 'MES DERNIERS PLATINES',
      nx - 4,
      ny - 26,
    );
    ctx.letterSpacing = '0px';
  }

  // Niche du meuble, encadrée de bois
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = WOOD.dark;
  roundRect(ctx, nx - 7, ny - 7, nw + 14, nh + 14, 10);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = WOOD.mid;
  ctx.lineWidth = 1.5;
  roundRect(ctx, nx - 7, ny - 7, nw + 14, nh + 14, 10);
  ctx.stroke();

  ctx.save();
  roundRect(ctx, nx, ny, nw, nh, 6);
  ctx.clip();
  woodPanel(ctx, nx, ny, nw, nh);
  ctx.fillStyle = gradient(ctx, 0, ny, 0, ny + 80, ['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']);
  ctx.fillRect(nx, ny, nw, 80);

  // Cône de la lampe
  const lx = nx + nw / 2;
  const cone = ctx.createLinearGradient(0, ny, 0, plankY);
  cone.addColorStop(0, 'rgba(255,206,150,0.22)');
  cone.addColorStop(1, 'rgba(255,206,150,0.05)');
  ctx.fillStyle = cone;
  ctx.filter = 'blur(14px)';
  ctx.beginPath();
  ctx.moveTo(lx - 30, ny + 18);
  ctx.lineTo(lx + 30, ny + 18);
  ctx.lineTo(nx + nw + 20, plankY);
  ctx.lineTo(nx - 20, plankY);
  ctx.closePath();
  ctx.fill();
  ctx.filter = 'none';
  glow(ctx, lx, plankY, nw * 0.55, 'rgba(255,200,140,0.10)');

  // Abat-jour en laiton, accroché au plafond de la niche
  glow(ctx, lx, ny + 18, 70, 'rgba(255,214,160,0.35)');
  ctx.fillStyle = gradient(ctx, lx - 34, 0, lx + 34, 0, ['#5a3a1a', '#c9944c', '#7a5226']);
  ctx.beginPath();
  ctx.moveTo(lx - 14, ny);
  ctx.lineTo(lx + 14, ny);
  ctx.lineTo(lx + 34, ny + 18);
  ctx.lineTo(lx - 34, ny + 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,240,210,0.95)';
  ctx.beginPath();
  ctx.ellipse(lx, ny + 18, 26, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Poussière dans la lumière (tirage fixe : la carte reste identique d'une génération à l'autre)
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    const t = rand();
    const px = lx + (rand() * 2 - 1) * (40 + t * (nw / 2 - 20));
    const py = ny + 10 + t * (plankY - ny - 20);
    ctx.fillStyle = `rgba(255,226,180,${(0.08 + rand() * 0.3).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(px, py, 0.6 + rand() * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Les boîtes, avec leur halo de rareté
  const bw = 124;
  const bh = 186;
  const gap = (nw - featured.length * bw) / (featured.length + 1);
  const boxX = (i) => nx + gap * (i + 1) + bw * i + 8;
  featured.forEach((f, i) => {
    const x = boxX(i);
    const y = plankY - bh - 2;
    const h = halo(f.rarity);
    if (h) {
      ctx.save();
      ctx.filter = 'blur(20px)';
      ctx.fillStyle = `rgba(${h.rgb},${(h.a * 0.45).toFixed(2)})`;
      roundRect(ctx, x - 12, y - 16, bw + 24, bh + 16, 20);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 10, plankY - 6, bw + 16, 8);
    ctx.restore();
    gameBox(ctx, covers[i], x, y, bw, bh);
    if (h) {
      ctx.strokeStyle = `rgba(${h.rgb},${(h.a * 0.4).toFixed(2)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 7.5, y + 0.5, bw - 8, bh - 1);
    }
  });

  // Planche : dessus éclairé, chant, ombre
  ctx.fillStyle = gradient(ctx, 0, plankY, 0, plankY + plankH, [WOOD.light, '#74492a', '#4f3119', '#3b2412', '#1f1309']);
  ctx.fillRect(nx, plankY, nw, plankH);
  ctx.restore();

  // Étiquettes de rareté sur le chant de la planche, noms en dessous
  featured.forEach((f, i) => {
    const cx = boxX(i) + bw / 2;
    if (f.rarity != null) {
      const label = plain(f.rarityLabel ?? `≤ ${fmtRarity(f.rarity)}`);
      ctx.font = `700 15px ${DISPLAY}`;
      paperTag(ctx, cx, plankY + 6, ctx.measureText(label).width + 18, 21, i % 2 ? 1.5 : -1.5, (c) => {
        c.fillStyle = INK;
        c.font = `700 15px ${DISPLAY}`;
        c.fillText(label, 0, 5);
      });
    }
    ctx.fillStyle = CREAM;
    ctx.font = '600 15px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, f.name, bw + 30), cx, plankY + plankH + 40);
    ctx.textAlign = 'left';
  });

  // Pied de carte
  ctx.fillStyle = 'rgba(217,167,90,0.75)';
  ctx.font = `600 19px ${DISPLAY}`;
  ctx.fillText('Steam Stats', 64, H - 46);
  ctx.fillStyle = MUTED;
  ctx.font = '500 15px Inter, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()), W - 64, H - 46);
  ctx.textAlign = 'left';

  return canvas;
}

/**
 * Ouvre la carte de chasseur.
 * data : contenu de la carte ; pick (facultatif) : sélection des platines épinglés
 *   { choices: [{ appid, name }], isPinned(appid), onToggle(appid) → nouvelles data, maxPins }
 */
export async function openShareCard(data, pick = null) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal share-modal';
  dialog.innerHTML = `
    <div class="share-head">
      <h2>Ta carte de chasseur</h2>
      <button class="modal-close" type="button" aria-label="Fermer">${icon('close')}</button>
    </div>
    <div class="share-scroll">
      <div class="share-preview"><div class="loading" style="min-height:240px"><div class="spinner"></div></div></div>
      ${
        pick?.choices.length
          ? `<div class="share-pick">
              <p class="share-pick-title">${icon('pin')} Épingle jusqu’à ${pick.maxPins} platines à mettre en avant</p>
              <input class="input share-pick-filter" type="search" placeholder="Filtrer…" aria-label="Filtrer les platines">
              <div class="pick-grid"></div>
            </div>`
          : ''
      }
    </div>
    <div class="share-actions">
      <button class="btn btn-primary" type="button" data-action="copy" disabled>Copier l’image</button>
      <button class="btn" type="button" data-action="download" disabled>Télécharger le PNG</button>
      <span class="share-status" role="status"></span>
    </div>`;
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('.modal-close')) dialog.close();
  });
  dialog.showModal();

  const status = dialog.querySelector('.share-status');
  const preview = dialog.querySelector('.share-preview');
  let blob = null;
  let url = null;
  let drawId = 0;
  dialog.addEventListener('close', () => {
    if (url) URL.revokeObjectURL(url);
    dialog.remove();
  });

  async function redraw() {
    const id = ++drawId;
    try {
      const canvas = await drawCard(data);
      const next = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
      if (id !== drawId) return; // un dessin plus récent a été demandé entre-temps
      if (url) URL.revokeObjectURL(url);
      blob = next;
      url = URL.createObjectURL(blob);
      preview.innerHTML = `<img src="${url}" alt="Carte de chasseur de ${esc(data.player.name)}">`;
      for (const b of dialog.querySelectorAll('[data-action]')) b.disabled = false;
    } catch (err) {
      preview.innerHTML = `<p class="empty">Impossible de générer la carte (${esc(err.message)}).</p>`;
    }
  }

  // Sélecteur : épinglés d'abord, puis le reste (dans l'ordre fourni).
  const grid = dialog.querySelector('.pick-grid');
  const filter = dialog.querySelector('.share-pick-filter');
  function renderPick() {
    if (!grid) return;
    const q = filter.value.trim().toLocaleLowerCase('fr');
    const list = pick.choices
      .filter((c) => !q || c.name.toLocaleLowerCase('fr').includes(q))
      .sort((x, y) => Number(pick.isPinned(y.appid)) - Number(pick.isPinned(x.appid)));
    grid.innerHTML = list
      .map(
        (c) => `
        <button class="pick-item" type="button" data-pick="${c.appid}" aria-pressed="${pick.isPinned(c.appid)}" title="${esc(c.name)}">
          <span class="art" data-name="${esc(c.name)}">${artImg(c.appid, ['header.jpg'], c.name)}</span>
          <span class="pick-name">${esc(c.name)}</span>
          <span class="pick-check" aria-hidden="true">${icon('pin')}</span>
        </button>`,
      )
      .join('');
  }
  if (grid) {
    renderPick();
    filter.addEventListener('input', renderPick);
    grid.addEventListener('click', (e) => {
      const item = e.target.closest('[data-pick]');
      if (!item) return;
      const next = pick.onToggle(Number(item.dataset.pick));
      if (!next) return; // limite atteinte : l'app affiche déjà un message
      data = next;
      renderPick();
      redraw();
    });
  }

  await redraw();

  dialog.querySelector('[data-action="download"]').onclick = () => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `carte-chasseur-${data.player.name.replace(/[^\w-]+/g, '_')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  dialog.querySelector('[data-action="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.textContent = 'Copiée ! Colle-la dans Discord avec Ctrl+V.';
    } catch {
      status.textContent = 'Copie impossible ici, utilise « Télécharger ».';
    }
  };
}
