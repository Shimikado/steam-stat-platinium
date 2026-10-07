import { esc, icon, nf, artImg, boxHTML, fmtDate, fmtHours, fmtDuration, fmtRarity, rarityTier } from './utils.js';

// Salle des trophées : une page plein écran où chaque platine a sa plaque, regroupées par année.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SPARKS = [
  [-38, -30, 0], [44, -22, 0.6], [-46, 26, 1.3], [50, 34, 2], [0, -54, 2.6], [-8, 58, 3.3],
];

const medal = (cls = '') => `
  <span class="hall-medal ${cls}" aria-hidden="true">
    ${icon('trophy')}
    ${SPARKS.map(([x, y, d]) => `<i style="--x:${x}px;--y:${y}px;animation-delay:${d}s">${icon('sparkle')}</i>`).join('')}
  </span>`;

function plaque(p, i, { rarity, pill }) {
  const { g, a, date, num, hunt } = p;
  const tier = rarityTier(rarity.get(g.appid));
  return `
    <button class="plaque ${tier ? `tier-${tier.id}` : ''}" data-appid="${g.appid}" type="button" style="--i:${i}">
      <span class="plaque-bg art" data-name="">${artImg(g.appid, ['library_hero.jpg', 'header.jpg'], '')}</span>
      <span class="plaque-box">${boxHTML(g.appid, g.name)}</span>
      <span class="plaque-body">
        <span class="plaque-num">${icon('trophy')} Platine n°${num}</span>
        <span class="plaque-title">${esc(g.name)}</span>
        <span class="plaque-stats">
          <span><b>${fmtDate(date)}</b>obtenu le</span>
          <span><b>${fmtDuration(hunt)}</b>de chasse</span>
          ${g.playtime ? `<span><b>${fmtHours(g.playtime)}</b>de jeu</span>` : ''}
          <span><b>${a.total}</b>succès</span>
        </span>
        ${pill(g.appid, { long: true })}
      </span>
    </button>`;
}

export function hallHTML({ steamid, player, platinum, rarity, pill, scanning }) {
  const back = `<div class="hall-top"><a class="btn" href="#/u/${steamid}">← Retour au profil</a></div>`;

  if (scanning) {
    return `${back}
      <header class="hall-hero">
        ${medal('is-waiting')}
        <p class="hall-eyebrow">Salle des trophées</p>
        <h1 class="hall-title">${esc(player.name)}</h1>
        <p class="hall-sub">${scanning}</p>
      </header>`;
  }

  if (!platinum.length) {
    return `${back}
      <header class="hall-hero">
        ${medal('is-empty')}
        <p class="hall-eyebrow">Salle des trophées</p>
        <h1 class="hall-title">${esc(player.name)}</h1>
        <p class="hall-sub">La salle attend encore son premier platine… Jette un œil à « Ton prochain platine » sur le profil !</p>
      </header>`;
  }

  const n = platinum.length;
  const hours = platinum.reduce((t, p) => t + p.g.playtime, 0);
  const avgHunt = platinum.reduce((t, p) => t + p.hunt, 0) / n;
  const rarities = platinum.map((p) => rarity.get(p.g.appid)).filter((r) => r != null);
  const first = platinum.at(-1);

  const byYear = new Map();
  for (const p of platinum) {
    const y = new Date(p.date * 1000).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }

  let i = 0;
  return `${back}
    <header class="hall-hero">
      ${medal()}
      <p class="hall-eyebrow">Salle des trophées</p>
      <h1 class="hall-title">${esc(player.name)}</h1>
      <p class="hall-count"><span class="hall-num">${nf.format(n)}</span> platine${n > 1 ? 's' : ''}</p>
      <div class="hall-stats">
        ${hours ? `<span><b>${nf.format(Math.round(hours / 60))} h</b>investies dans ces platines</span>` : ''}
        <span><b>${fmtDuration(avgHunt)}</b>de chasse en moyenne</span>
        ${rarities.length ? `<span><b>≤ ${fmtRarity(Math.min(...rarities))}</b>pour le plus rare</span>` : ''}
        <span><b>${fmtDate(first.date)}</b>premier platine</span>
      </div>
    </header>
    ${[...byYear]
      .map(
        ([year, list]) => `
      <section class="hall-year">
        <h2><span>${year}</span><small>${list.length} platine${list.length > 1 ? 's' : ''}</small></h2>
        <div class="plaques">${list.map((p) => plaque(p, i++, { rarity, pill })).join('')}</div>
      </section>`,
      )
      .join('')}`;
}

/** Fait apparaître les plaques au fil du défilement, une seule fois chacune. */
export function revealPlaques(root) {
  const plaques = root.querySelectorAll('.plaque');
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    for (const p of plaques) p.classList.add('is-in');
    return;
  }
  let batch = 0;
  let batchTimer;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        e.target.classList.add('is-in');
        // Décalage en cascade pour les plaques qui entrent ensemble dans l'écran.
        e.target.animate(
          [
            { opacity: 0, transform: 'translateY(24px) scale(0.97)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 600, delay: Math.min(batch++, 5) * 70, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
        );
        clearTimeout(batchTimer);
        batchTimer = setTimeout(() => (batch = 0), 120);
      }
    },
    { root, threshold: 0.15 },
  );
  for (const p of plaques) io.observe(p);
}
