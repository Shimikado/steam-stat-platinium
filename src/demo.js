import express from 'express';

// Mode démo : données fictives (mais vrais appids pour les visuels) pour voir l'interface sans clé API.

const DEMO_ID = '76561190000000000';

const CATALOG = [
  [1245620, 'ELDEN RING'], [292030, 'The Witcher 3: Wild Hunt'], [1091500, 'Cyberpunk 2077'],
  [367520, 'Hollow Knight'], [504230, 'Celeste'], [413150, 'Stardew Valley'], [620, 'Portal 2'],
  [400, 'Portal'], [1145360, 'Hades'], [814380, 'Sekiro: Shadows Die Twice'], [374320, 'DARK SOULS III'],
  [105600, 'Terraria'], [252950, 'Rocket League'], [271590, 'Grand Theft Auto V'],
  [1174180, 'Red Dead Redemption 2'], [489830, 'The Elder Scrolls V: Skyrim Special Edition'],
  [377160, 'Fallout 4'], [550, 'Left 4 Dead 2'], [646570, 'Slay the Spire'], [588650, 'Dead Cells'],
  [268910, 'Cuphead'], [391540, 'Undertale'], [1086940, "Baldur's Gate 3"], [1593500, 'God of War'],
  [2050650, 'Resident Evil 4'], [883710, 'Resident Evil 2'], [990080, 'Hogwarts Legacy'],
  [1794680, 'Vampire Survivors'], [632470, 'Disco Elysium'], [753640, 'Outer Wilds'], [427520, 'Factorio'],
  [294100, 'RimWorld'], [892970, 'Valheim'], [264710, 'Subnautica'], [220, 'Half-Life 2'],
  [546560, 'Half-Life: Alyx'], [435150, 'Divinity: Original Sin 2'], [289070, "Sid Meier's Civilization VI"],
  [322330, "Don't Starve Together"], [250900, 'The Binding of Isaac: Rebirth'], [1150690, 'OMORI'],
  [601150, 'Devil May Cry 5'], [582010, 'Monster Hunter: World'], [1158310, 'Crusader Kings III'],
  [1426210, 'It Takes Two'], [2379780, 'Balatro'], [1868140, 'DAVE THE DIVER'], [257850, 'Hyper Light Drifter'],
  [730, 'Counter-Strike 2'], [570, 'Dota 2'], [4000, "Garry's Mod"], [945360, 'Among Us'],
  [1966720, 'Lethal Company'], [2358720, 'Black Myth: Wukong'], [1817070, "Marvel's Spider-Man Remastered"],
  [8930, "Sid Meier's Civilization V"], [236850, 'Europa Universalis IV'], [1196590, 'Resident Evil Village'],
  [70, 'Half-Life'], [238960, 'Path of Exile'],
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = Math.floor(Date.now() / 1000);
const YEAR = 365 * 24 * 3600;

const games = CATALOG.map(([appid, name], i) => {
  const r = rng(appid);
  const never = r() < 0.15;
  const playtime = never ? 0 : Math.round(r() ** 2.2 * 12000 + r() * 300);
  const noStats = [730, 570, 4000, 945360].includes(appid) ? false : r() < 0.06;
  const total = noStats ? 0 : 12 + Math.floor(r() * 70);
  let ratio = never ? 0 : r();
  if (!never && r() < 0.3) ratio = 1;
  else if (!never && r() < 0.25) ratio = 0.75 + r() * 0.24;
  const unlocked = Math.min(total, Math.round(total * ratio));
  const first = now - Math.floor(r() * 6 * YEAR);
  const span = Math.max(3600, (now - first) * (0.1 + r() * 0.6));
  const times = Array.from({ length: unlocked }, () => Math.floor(first + r() * span)).sort((a, b) => a - b);
  const deck = r() < 0.3 ? Math.round(playtime * r() * 0.6) : 0;
  return {
    appid,
    name,
    icon: null,
    playtime,
    playtime2w: i < 4 && !never ? Math.round(r() * 900) : 0,
    playtimeDeck: deck,
    lastPlayed: never ? 0 : times.at(-1) ?? first,
    hasStats: total > 0,
    _ach: { total, unlocked, times },
  };
});

export function demoRouter() {
  const r = express.Router();

  r.get('/me', (req, res) => res.json({ steamid: DEMO_ID }));
  r.get('/resolve', (req, res) => res.json({ steamid: DEMO_ID }));

  r.get('/profile/:steamid', (req, res) => {
    res.json({
      player: {
        steamid: DEMO_ID,
        name: 'Joueur Démo',
        avatar: 'https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
        url: 'https://steamcommunity.com/',
        country: 'FR',
        createdAt: now - 11.4 * YEAR,
        isPublic: true,
      },
      level: 42,
      gamesHidden: false,
      recent: games.slice(0, 4).map((g) => g.appid),
      games: games.map(({ _ach, ...g }) => g),
    });
  });

  r.get('/achievements/:steamid', async (req, res) => {
    await new Promise((ok) => setTimeout(ok, 250)); // simule la latence de Steam
    const ids = String(req.query.appids ?? '').split(',').map(Number);
    res.json(
      ids.map((appid) => {
        const g = games.find((x) => x.appid === appid);
        const a = g?._ach ?? { total: 0, unlocked: 0, times: [] };
        return { appid, total: a.total, unlocked: a.unlocked, percent: a.total ? (a.unlocked / a.total) * 100 : null, times: a.times };
      }),
    );
  });

  r.get('/friends/:steamid', (req, res) => {
    const names = ['Kiwi', 'Shadowfax', 'Mélo', 'Brick', 'Nova', 'Pépite', 'Zed', 'Lune'];
    const playing = ['ELDEN RING', 'Balatro', null, null, 'Hades', null, null, null];
    res.json({
      private: false,
      friends: names.map((name, i) => ({
        steamid: `7656119000000001${i}`,
        name,
        avatar: 'https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg',
        online: i < 5,
        game: playing[i],
        isPublic: i !== 6,
        since: now - (i + 1) * YEAR,
      })),
    });
  });

  r.get('/rarity', (req, res) => {
    const ids = String(req.query.appids ?? '').split(',').map(Number);
    res.json(ids.map((appid) => ({ appid, platinumMax: Math.round(rng(appid * 3)() ** 2.5 * 400) / 10 + 0.2 })));
  });

  r.get('/game/:steamid/:appid', (req, res) => {
    const g = games.find((x) => x.appid === Number(req.params.appid));
    if (!g) return res.json({ appid: Number(req.params.appid), achievements: [] });
    const rand = rng(g.appid * 7);
    const order = Array.from({ length: g._ach.total }, (_, i) => i).sort(() => rand() - 0.5);
    const unlockedSet = new Set(order.slice(0, g._ach.unlocked));
    let t = 0;
    res.json({
      appid: g.appid,
      achievements: Array.from({ length: g._ach.total }, (_, i) => ({
        id: `ACH_${i}`,
        name: `Succès n°${i + 1}`,
        description: 'Description fictive du succès en mode démo.',
        icon: null,
        hidden: rand() < 0.1,
        achieved: unlockedSet.has(i),
        unlocktime: unlockedSet.has(i) ? g._ach.times[t++] : null,
        rarity: Math.round(rand() ** 2 * 1000) / 10,
      })),
    });
  });

  return r;
}
