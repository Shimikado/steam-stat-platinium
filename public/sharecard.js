import { artUrls } from './art.js';
import { esc, icon, nf, fmtRarity, rarityTier, artImg } from './utils.js';

// Carte de chasseur partageable (PNG 1200×630, le format des aperçus Discord/Twitter).

const W = 1200;
const H = 630;

const TONES = {
  rookie: ['#8b97ad', '#5e6a80', '#8b97ad'],
  bronze: ['#f3c39a', '#b26d3c', '#e9a87a'],
  silver: ['#f4f6fa', '#a9b3c3', '#e3e8f0'],
  gold: ['#fff1b0', '#e0a82e', '#ffe08a'],
  plat: ['#f4f8ff', '#b9cbe4', '#7d97bd'],
  diamond: ['#e6fbff', '#7fd6ff', '#c9b8ff'],
  legend: ['#ff8ccf', '#ffd36e', '#7effc8', '#6ec8ff', '#c58bff'],
};

// La police du canvas n'a pas toujours l'espace fine insécable du français : on la remplace par une espace normale.
const plain = (text) => String(text).replace(/[  ]/g, ' ');

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

async function drawCard({ player, rank, plats, stats, featured }) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const [avatar, ...covers] = await Promise.all([
    loadImage([player.avatar]),
    ...featured.map((f) => loadImage(capsuleUrls(f.appid))),
  ]);

  // Fond
  ctx.fillStyle = '#140f15';
  ctx.fillRect(0, 0, W, H);
  for (const [x, y, r, c] of [
    [1050, -60, 620, 'rgba(255,128,92,0.18)'],
    [80, 640, 560, 'rgba(185,203,228,0.10)'],
    [760, 420, 420, 'rgba(197,139,255,0.08)'],
  ]) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.strokeStyle = 'rgba(185,203,228,0.25)';
  ctx.lineWidth = 2;
  roundRect(ctx, 16, 16, W - 32, H - 32, 28);
  ctx.stroke();

  const tone = TONES[rank.tone] ?? TONES.plat;

  // Avatar avec anneau du rang
  const ax = 64;
  const ay = 70;
  const as = 132;
  ctx.fillStyle = gradient(ctx, ax, ay, ax + as, ay + as, tone);
  roundRect(ctx, ax - 6, ay - 6, as + 12, as + 12, 30);
  ctx.fill();
  ctx.fillStyle = '#140f15';
  roundRect(ctx, ax - 2, ay - 2, as + 4, as + 4, 26);
  ctx.fill();
  if (avatar) drawCover(ctx, avatar, ax, ay, as, as, 24);

  // Nom + rang
  const tx = ax + as + 34;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 50px Sora, Inter, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(fitText(ctx, player.name, 470), tx, ay + 58);

  ctx.font = '700 22px Inter, sans-serif';
  const rankLabel = `Rang ${rank.name}`;
  const rw = ctx.measureText(rankLabel).width + 40;
  ctx.fillStyle = gradient(ctx, tx, 0, tx + rw, 0, tone);
  roundRect(ctx, tx, ay + 82, rw, 42, 21);
  ctx.fill();
  ctx.fillStyle = '#1c2436';
  ctx.fillText(rankLabel, tx + 20, ay + 111);

  // Gros chiffre : platines
  const plat = gradient(ctx, 64, 300, 420, 420, ['#f4f8ff', '#b9cbe4', '#7d97bd', '#f4f8ff']);
  ctx.fillStyle = plat;
  ctx.font = '800 150px Sora, Inter, sans-serif';
  const platText = plain(nf.format(plats));
  ctx.fillText(platText, 58, 400);
  const pw = ctx.measureText(platText).width;
  ctx.font = '700 30px Sora, Inter, sans-serif';
  ctx.fillText(plats > 1 ? 'jeux' : 'jeu', 58 + pw + 18, 352);
  ctx.fillText(plats > 1 ? 'platinés' : 'platiné', 58 + pw + 18, 390);

  // Stats secondaires
  ctx.font = '500 21px Inter, sans-serif';
  let sx = 64;
  for (const [raw, label] of stats) {
    const value = plain(raw);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 32px Sora, Inter, sans-serif';
    ctx.fillText(value, sx, 488);
    const vw = ctx.measureText(value).width;
    ctx.fillStyle = '#bdb0b4';
    ctx.font = '500 18px Inter, sans-serif';
    ctx.fillText(label, sx, 516);
    sx += Math.max(vw, ctx.measureText(label).width) + 46;
  }

  // Jaquettes en éventail
  if (featured.length) {
    ctx.fillStyle = '#bdb0b4';
    ctx.font = '700 15px Inter, sans-serif';
    ctx.letterSpacing = '2px';
    ctx.fillText(featured.some((f) => f.pinned)
        ? 'MES PLATINES À L’HONNEUR'
        : featured.some((f) => f.rarity != null)
          ? 'MES PLATINES LES PLUS RARES'
          : 'MES DERNIERS PLATINES', 690, 92);
    ctx.letterSpacing = '0px';

    const cw = 150;
    const ch = 225;
    const slots = [
      { x: 700, y: 150, rot: -7 },
      { x: 855, y: 128, rot: 0 },
      { x: 1010, y: 150, rot: 7 },
    ];
    featured.forEach((f, i) => {
      const { x, y, rot } = slots[i];
      ctx.save();
      ctx.translate(x + cw / 2, y + ch / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.translate(-cw / 2, -ch / 2);
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 12;
      ctx.fillStyle = '#342a37';
      roundRect(ctx, 0, 0, cw, ch, 14);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      if (covers[i]) drawCover(ctx, covers[i], 0, 0, cw, ch, 14);
      const tier = rarityTier(f.rarity);
      ctx.strokeStyle = tier?.id === 'ultra' ? gradient(ctx, 0, 0, cw, ch, TONES.legend) : 'rgba(220,232,250,0.7)';
      ctx.lineWidth = 3;
      roundRect(ctx, 0, 0, cw, ch, 14);
      ctx.stroke();

      if (f.rarity != null) {
        const label = `≤ ${fmtRarity(f.rarity)}`;
        ctx.font = '700 16px Inter, sans-serif';
        const lw = ctx.measureText(label).width + 20;
        ctx.fillStyle = tier?.id === 'ultra' ? gradient(ctx, 10, 0, 10 + lw, 0, TONES.legend) : 'rgba(9,13,20,0.85)';
        roundRect(ctx, 10, ch - 40, lw, 30, 15);
        ctx.fill();
        ctx.fillStyle = tier?.id === 'ultra' ? '#1d1630' : '#f5eeea';
        ctx.fillText(label, 20, ch - 19);
      }
      ctx.restore();

      ctx.fillStyle = '#f5eeea';
      ctx.font = '600 16px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, f.name, cw + 8), x + cw / 2, y + ch + 44);
      ctx.textAlign = 'left';
    });
  }

  // Pied de carte
  ctx.fillStyle = '#8a7d83';
  ctx.font = '600 17px Inter, sans-serif';
  ctx.fillText('Steam Stats', 64, H - 52);
  ctx.textAlign = 'right';
  ctx.fillText(new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()), W - 64, H - 52);
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
