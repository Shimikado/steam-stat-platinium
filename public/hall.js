import { esc, icon, nf, boxHTML, fmtDate, fmtHours, fmtDuration, fmtPoints, rarityHalo } from './utils.js';

// Salle des trophées : une page plein écran sous la lampe, avec une vitrine éclairée par année
// où chaque platine est exposé en grand, avec son cartel comme dans un musée.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SPARKS = [
  [-38, -30, 0], [44, -22, 0.6], [-46, 26, 1.3], [50, 34, 2], [0, -54, 2.6], [-8, 58, 3.3],
];

const medal = (cls = '') => `
  <span class="hall-medal ${cls}" aria-hidden="true">
    ${icon('trophy')}
    ${SPARKS.map(([x, y, d]) => `<i style="--x:${x}px;--y:${y}px;animation-delay:${d}s">${icon('sparkle')}</i>`).join('')}
  </span>`;

function exhibit(p, i, { points, pill, isRelic }) {
  const { g, a, date, num, hunt } = p;
  const meta = [g.playtime ? `${fmtHours(g.playtime)} de jeu` : '', `${fmtDuration(hunt)} de chasse`, `${a.total} succès`]
    .filter(Boolean)
    .join(' · ');
  return `
    <button class="exhibit ${rarityHalo(points(g.appid))}" data-appid="${g.appid}" type="button" style="--i:${i}" aria-label="${esc(g.name)}">
      <span class="exhibit-stage">
        <span class="exhibit-light" aria-hidden="true"></span>
        ${boxHTML(g.appid, g.name)}
      </span>
      <span class="exhibit-label">
        ${isRelic(g.appid) ? '<span class="relic-seal" title="Platine devenu impossible : certains succès ne peuvent plus être débloqués">Relique</span>' : ''}
        <span class="exhibit-num">Platine n°${num}</span>
        <span class="exhibit-title">${esc(g.name)}</span>
        <span class="exhibit-date">${fmtDate(date)}</span>
        <span class="exhibit-meta">${meta}</span>
      </span>
      ${pill(g.appid)}
    </button>`;
}

const LAMP =
  '<div class="lamp hall-lamp" aria-hidden="true"><div class="lamp-cone"><div class="lamp-beam"></div></div><div class="lamp-bulb"></div></div>';

export function hallHTML({ steamid, player, platinum, points, isRelic, pill, scanning }) {
  const back = `<div class="hall-top"><a class="btn" href="#/u/${steamid}">← Retour au profil</a></div>`;

  if (scanning) {
    return `${LAMP}${back}
      <header class="hall-hero">
        ${medal('is-waiting')}
        <p class="hall-eyebrow">Salle des trophées</p>
        <h1 class="hall-title">${esc(player.name)}</h1>
        <p class="hall-sub">${scanning}</p>
      </header>`;
  }

  if (!platinum.length) {
    return `${LAMP}${back}
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
  const best = platinum.filter((p) => points(p.g.appid) != null).sort((x, y) => points(y.g.appid) - points(x.g.appid))[0];
  const first = platinum.at(-1);

  const byYear = new Map();
  for (const p of platinum) {
    const y = new Date(p.date * 1000).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }

  let i = 0;
  return `${LAMP}${back}
    <header class="hall-hero">
      ${medal()}
      <p class="hall-eyebrow">Salle des trophées</p>
      <h1 class="hall-title">${esc(player.name)}</h1>
      <p class="hall-count"><span class="hall-num">${nf.format(n)}</span> platine${n > 1 ? 's' : ''}</p>
      <div class="hall-stats">
        ${hours ? `<span><b>${nf.format(Math.round(hours / 60))} h</b>investies dans ces platines</span>` : ''}
        <span><b>${fmtDuration(avgHunt)}</b>de chasse en moyenne</span>
        ${best ? `<span><b>${fmtPoints(points(best.g.appid))}</b>pour le plus rare</span>` : ''}
        <span><b>${fmtDate(first.date)}</b>premier platine</span>
      </div>
    </header>
    ${[...byYear]
      .map(
        ([year, list]) => `
      <section class="vitrine">
        <h2 class="vitrine-title"><span>${year}</span><small>${list.length} platine${list.length > 1 ? 's' : ''}</small></h2>
        <div class="exhibits">${list.map((p) => exhibit(p, i++, { points, pill, isRelic })).join('')}</div>
      </section>`,
      )
      .join('')}`;
}

/** Fait apparaître les jeux exposés au fil du défilement, une seule fois chacun. */
export function revealPlaques(root) {
  const plaques = root.querySelectorAll('.exhibit');
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
