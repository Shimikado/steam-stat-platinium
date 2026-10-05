import { esc, getJSON, artImg, fmtRarity } from './utils.js';

// « Ton prochain platine » : parmi les jeux bien avancés, ceux dont les succès restants sont les plus accessibles.

const MAX_CANDIDATES = 8;

function difficulty(hardest) {
  if (hardest == null) return { id: 'unknown', label: 'Difficulté inconnue' };
  if (hardest >= 25) return { id: 'easy', label: 'Facile' };
  if (hardest >= 8) return { id: 'doable', label: 'Faisable' };
  if (hardest >= 2) return { id: 'tough', label: 'Coriace' };
  return { id: 'legendary', label: 'Légendaire' };
}

export async function findNextPlatinums(steamid, progress) {
  const candidates = progress
    .filter(({ a }) => a.percent >= 50 || a.total - a.unlocked <= 10)
    .sort((x, y) => x.a.total - x.a.unlocked - (y.a.total - y.a.unlocked))
    .slice(0, MAX_CANDIDATES);

  const results = await Promise.all(
    candidates.map(async ({ g, a }) => {
      try {
        const { achievements } = await getJSON(`/api/game/${steamid}/${g.appid}`);
        const remaining = achievements.filter((x) => !x.achieved).sort((x, y) => (y.rarity ?? -1) - (x.rarity ?? -1));
        if (!remaining.length) return null;
        const known = remaining.map((x) => x.rarity).filter((r) => r != null);
        const hardest = known.length === remaining.length ? Math.min(...known) : null;
        return { g, a, remaining, hardest, level: difficulty(hardest) };
      } catch {
        return null;
      }
    }),
  );

  // Le plus accessible d'abord : le succès le plus dur restant est encore courant, puis le moins de succès restants.
  return results
    .filter(Boolean)
    .sort((x, y) => (y.hardest ?? -1) - (x.hardest ?? -1) || x.remaining.length - y.remaining.length)
    .slice(0, 3);
}

export function renderNextPlatinums(list) {
  return `<div class="next-list">${list
    .map(({ g, a, remaining, level }, i) => {
      const left = remaining.length;
      return `
      <button class="next-card ${i === 0 ? 'is-top' : ''}" data-appid="${g.appid}" type="button">
        <span class="art" data-name="${esc(g.name)}">${artImg(g.appid, ['header.jpg'], g.name)}</span>
        <span class="next-body">
          ${i === 0 ? '<span class="next-pick">Le plus à portée</span>' : ''}
          <span class="next-title">${esc(g.name)}</span>
          <span class="next-meta">
            <span>Plus que <strong>${left}</strong> succès</span>
            <span class="difficulty diff-${level.id}">${level.label}</span>
          </span>
          <span class="bar"><i style="width:${a.percent}%"></i></span>
          <span class="next-ach">${remaining
            .slice(0, 3)
            .map(
              (x) => `
            <span class="next-ach-row">
              ${x.icon ? `<img src="${esc(x.icon)}" alt="" loading="lazy">` : '<span class="next-ach-icon"></span>'}
              <span class="next-ach-name">${x.hidden ? 'Succès caché' : esc(x.name)}</span>
              ${x.rarity != null ? `<span class="next-ach-pct">${fmtRarity(x.rarity)}</span>` : ''}
            </span>`,
            )
            .join('')}${left > 3 ? `<span class="next-ach-more">+ ${left - 3} autre${left > 4 ? 's' : ''}</span>` : ''}</span>
        </span>
      </button>`;
    })
    .join('')}</div>`;
}
