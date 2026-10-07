import { esc, getJSON, artImg, fmtRarity, difficultyTier } from './utils.js';

// « Ton prochain platine » : les jeux commencés dont les succès restants sont les plus accessibles.

/** Classement : succès restant le plus dur le plus courant d'abord, puis le moins de succès restants. */
export const byAccessibility = (diff) => (x, y) => {
  const dx = diff.get(x.g.appid);
  const dy = diff.get(y.g.appid);
  return (dy?.hardest ?? -1) - (dx?.hardest ?? -1) || (dx?.remaining ?? 1e9) - (dy?.remaining ?? 1e9);
};

export async function findNextPlatinums(steamid, progress, diff) {
  const top = progress.filter(({ g }) => diff.get(g.appid)?.hardest != null).sort(byAccessibility(diff)).slice(0, 3);

  const results = await Promise.all(
    top.map(async ({ g, a }) => {
      try {
        const { achievements } = await getJSON(`/api/game/${steamid}/${g.appid}`);
        const remaining = achievements.filter((x) => !x.achieved).sort((x, y) => (y.rarity ?? -1) - (x.rarity ?? -1));
        return remaining.length ? { g, a, remaining, level: difficultyTier(diff.get(g.appid).hardest) } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

export function renderNextPlatinums(list, medianLabel = () => null) {
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
            <span>Plus que <strong>${left}</strong> succès${medianLabel(g.appid) ? ` · 100 % en ${medianLabel(g.appid)}` : ''}</span>
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
