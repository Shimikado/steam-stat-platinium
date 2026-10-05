import { esc, nf } from './utils.js';

const DAY = 24 * 3600;
const YEAR = 365.25 * DAY;

/** Statistiques dérivées des dates de déblocage, utilisées par plusieurs badges. */
function timeStats(times) {
  const perDay = new Map();
  const months = new Set();
  let night = 0;
  for (const [t] of times) {
    const d = new Date(t * 1000);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    months.add(d.getFullYear() * 12 + d.getMonth());
    if (d.getHours() < 5) night++;
  }

  // Plus longue série de mois consécutifs avec au moins un succès.
  const sorted = [...months].sort((a, b) => a - b);
  let streak = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i && sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }

  return {
    bestDay: Math.max(0, ...perDay.values()),
    night,
    streak,
    oldestYears: times.length ? (Date.now() / 1000 - times[0][0]) / YEAR : 0,
  };
}

/**
 * Liste des badges avec leur avancement.
 * ctx : { s (résultat de compute), rarity (Map appid -> %), playtimeHidden }
 */
export function computeBadges({ s, rarity, playtimeHidden }) {
  const ts = timeStats(s.times);
  const plats = s.platinum.length;
  const rarities = s.platinum.map((p) => rarity.get(p.g.appid)).filter((r) => r != null);
  const rarest = rarities.length ? Math.min(...rarities) : null;
  const fastest = s.platinum.filter((p) => p.g.playtime > 0).reduce((m, p) => Math.min(m, p.g.playtime), Infinity);
  const maxPlay = s.maxPlaytime;
  const started = s.platinum.length + s.progress.length;

  const count = (value, target, unit = '') => ({
    progress: Math.min(1, value / target),
    label: `${nf.format(Math.min(value, target))} / ${nf.format(target)}${unit}`,
  });
  const once = (ok, hint) => ({ progress: ok ? 1 : 0, label: ok ? '' : hint });

  return [
    { id: 'first', emoji: '🏆', name: 'Premier platine', desc: 'Platiner un jeu', ...count(plats, 1) },
    { id: 'collector', emoji: '🗄️', name: 'Collectionneur', desc: '10 jeux platinés', ...count(plats, 10) },
    { id: 'curator', emoji: '🏛️', name: 'Conservateur', desc: '25 jeux platinés', ...count(plats, 25) },
    { id: 'hall', emoji: '👑', name: 'Mur des légendes', desc: '50 jeux platinés', ...count(plats, 50) },
    {
      id: 'ultra',
      emoji: '💎',
      name: 'Ultra rare',
      desc: 'Un platine obtenu par 5 % des joueurs ou moins',
      ...once(rarest != null && rarest <= 5, rarest != null ? `Ton plus rare : ${rarest.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : ''),
    },
    {
      id: 'shadow',
      emoji: '🌑',
      name: 'Chasseur d’ombres',
      desc: 'Un platine obtenu par 1 % des joueurs ou moins',
      ...once(rarest != null && rarest <= 1, rarest != null ? `Ton plus rare : ${rarest.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : ''),
    },
    playtimeHidden
      ? null
      : {
          id: 'speed',
          emoji: '⚡',
          name: 'Speedrunner',
          desc: 'Un platine en moins de 5 h de jeu',
          ...once(fastest <= 300, Number.isFinite(fastest) ? `Ton plus rapide : ${Math.round(fastest / 60)} h` : ''),
        },
    playtimeHidden ? null : { id: 'marathon', emoji: '🏃', name: 'Marathonien', desc: '500 h sur un seul jeu', ...count(Math.floor(maxPlay / 60), 500, ' h') },
    { id: 'allnighter', emoji: '🔥', name: 'Journée de folie', desc: '50 succès en une seule journée', ...count(ts.bestDay, 50) },
    { id: 'owl', emoji: '🦉', name: 'Oiseau de nuit', desc: '100 succès débloqués entre minuit et 5 h', ...count(ts.night, 100) },
    { id: 'thousand', emoji: '🎯', name: 'Millier', desc: '1 000 succès débloqués', ...count(s.unlocked, 1000) },
    { id: 'tenk', emoji: '🚀', name: 'Dix mille', desc: '10 000 succès débloqués', ...count(s.unlocked, 10000) },
    { id: 'streak', emoji: '📅', name: 'Régulier', desc: 'Des succès 12 mois d’affilée', ...count(ts.streak, 12, ' mois') },
    { id: 'explorer', emoji: '🧭', name: 'Explorateur', desc: 'Au moins un succès dans 100 jeux', ...count(started, 100) },
    {
      id: 'perfectionist',
      emoji: '✨',
      name: 'Perfectionniste',
      desc: 'Complétion moyenne de 50 % ou plus (10 jeux commencés minimum)',
      ...(started >= 10 ? count(Math.round(s.avgCompletion ?? 0), 50, ' %') : { progress: 0, label: `${started} / 10 jeux commencés` }),
    },
    { id: 'archaeo', emoji: '🦴', name: 'Archéologue', desc: 'Un succès débloqué il y a plus de 10 ans', ...count(Math.floor(ts.oldestYears), 10, ' ans') },
  ]
    .filter(Boolean)
    .map((b) => ({ ...b, done: b.progress >= 1 }));
}

export function renderBadges(list) {
  const sorted = [...list].sort((a, b) => Number(b.done) - Number(a.done) || b.progress - a.progress);
  return `<div class="badges">${sorted
    .map(
      (b) => `
      <div class="badge ${b.done ? 'is-done' : ''}" title="${esc(b.desc)}">
        <span class="badge-medal" aria-hidden="true">${b.emoji}</span>
        <span class="badge-text">
          <strong>${esc(b.name)}</strong>
          <small>${esc(b.desc)}</small>
          ${
            b.done
              ? `<span class="badge-done">Débloqué</span>`
              : `<span class="badge-progress"><span class="bar"><i style="width:${b.progress * 100}%"></i></span>${b.label ? `<span>${esc(b.label)}</span>` : ''}</span>`
          }
        </span>
      </div>`,
    )
    .join('')}</div>`;
}
