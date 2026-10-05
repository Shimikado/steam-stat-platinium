# Steam Stats

Une vitrine pour ta bibliothèque Steam : jeux platinés à l'honneur, complétion des succès, temps de jeu total et quelques stats sympas.

## Démarrage

```bash
npm install
cp .env.example .env   # puis renseigne STEAM_API_KEY
npm start              # http://localhost:3000
```

- **Clé API** : https://steamcommunity.com/dev/apikey (nom de domaine : `localhost` suffit).
- **Sans clé** : `npm run demo` affiche l'interface avec des données fictives.
- **Confidentialité** : les « détails des jeux » du profil doivent être **publics** dans Steam, sinon l'API ne renvoie ni jeux ni succès.

## Ce que ça affiche

- **Rang de chasseur** selon le nombre de platines : Recrue, Bronze (1), Argent (5), Or (15), Platine (30), Diamant (60), Légende (100)
- **Amis** : liste cliquable avec leur statut (en ligne, en jeu) pour ouvrir leur vitrine. Il faut que la liste d'amis soit publique.
- **Recherche** de n'importe quel profil public depuis la barre du haut
- Temps de jeu total, jeux possédés, jamais lancés, 2 dernières semaines, temps sur Steam Deck
- **Vitrine des platines** : bannières « Dernier platine » et « Platine le plus rare », cartes holographiques et rareté de chaque platine. La rareté est une borne haute : on prend le succès le plus rare du jeu, d'après les statistiques mondiales de Steam.
- **Presque platinés** (≥ 75 %), avec le nombre de succès restants
- **Célébration des nouveautés** : sur ton propre profil, l'app compare avec ta visite précédente (mémorisée dans le navigateur). Les nouveaux platines et les changements de rang déclenchent des confettis et une étiquette « Nouveau » dans la vitrine.
- **Difficulté des platines à faire** : chaque jeu commencé est classé (Facile, Faisable, Coriace, Légendaire) selon le succès restant le plus rare. On obtient une tier list, un tri « Platine le plus accessible » dans la bibliothèque et les 3 « prochains platines » les plus à portée.
- **Succès ajoutés par une mise à jour** : Steam ne donne pas la date d'ajout des succès, donc l'app mémorise le nombre total de succès de chaque jeu dans le navigateur et repère les hausses d'une visite à l'autre. Les platines « perdus » sont signalés « à reconquérir ».
- **Platines bloqués par un DLC** : marquage manuel depuis la fiche d'un jeu (Steam ne dit pas quels DLC tu possèdes). Les jeux marqués sortent de la tier list et du prochain platine, et vont dans leur propre section.
- **Fiche jeu** : les succès manquants passent en premier, du plus accessible au plus rare.
- **Salle des trophées** (`#/u/<steamid>/trophees`) : une page plein écran avec une plaque par platine, regroupées par année (numéro, date, durée de la chasse, rareté)
- **Numéro de platine** chronologique et **certificat de platine** dans la fiche des jeux platinés
- **Carte de chasseur** : une image PNG de 1200×630 (rang, platines, plus rares) à copier dans Discord ou à télécharger
- Succès débloqués par mois, top 10 du temps de jeu, répartition de la complétion
- Anecdotes : premier succès, journée record, platine le plus rapide ou le plus long, vieil amour délaissé…
- Bibliothèque filtrable et triable ; un clic sur un jeu ouvre la liste de ses succès, avec leur rareté mondiale

## Fonctionnement

- `server.js` : Express, connexion **Steam OpenID** (vérifiée côté serveur auprès de Steam) et proxy vers la Web API. La clé ne quitte jamais le serveur.
- `src/steam.js` : appels à la Web API Steam, 6 requêtes en parallèle au maximum, avec mise en cache. Les succès sont gardés 6 h et les schémas 7 jours dans `.cache/` pour ne pas tout re-scanner à chaque redémarrage. Le bouton « Rafraîchir » ignore le cache.
- `public/` : front en HTML/CSS/JS sans étape de build. Les succès sont chargés par lots de 25 jeux et l'affichage se remplit au fur et à mesure.
- On peut aussi consulter le profil public de quelqu'un d'autre sans se connecter (URL, SteamID64 ou pseudo personnalisé).

- Les sessions sont stockées dans un cookie signé (`cookie-session`) : rien n'est gardé côté serveur, donc elles survivent aux redémarrages.
- L'API est limitée à 400 requêtes par tranche de 5 min et par IP, pour protéger le quota de la clé Steam.

## Déploiement sur Render (gratuit)

1. Sur https://dashboard.render.com : **New +** → **Blueprint**, puis choisis ce dépôt GitHub. Render lit `render.yaml`.
2. Renseigne `STEAM_API_KEY` quand Render la demande. `SESSION_SECRET` est générée automatiquement.
3. Une fois le service en ligne, l'URL publique (`https://<nom>.onrender.com`) est détectée automatiquement via `RENDER_EXTERNAL_URL`. Pour un domaine personnalisé, définis `BASE_URL`.

Sur l'offre gratuite, le service se met en veille après 15 min sans visite et met environ 1 min à se réveiller. Le cache disque est vidé à chaque redémarrage.
