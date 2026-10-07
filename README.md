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
- **Amis** : sur ton propre profil, une fois connecté (jamais sur celui des autres), liste cliquable avec leur statut (en ligne, en jeu) pour ouvrir leur vitrine. Il faut que la liste d'amis soit publique.
- **Recherche** de n'importe quel profil public depuis la barre du haut
- Temps de jeu total, jeux possédés, jamais lancés, 2 dernières semaines, temps sur Steam Deck
- **Ambiance** : étagères en bois sombre, papier crème et laiton. Les platines sont rangés comme des boîtes de jeux en semi-3D (jaquette et tranche), dans la vitrine comme dans la salle des trophées.
- **Temps et difficulté du 100 %** via l'API publique de [Steam Hunters](https://steamhunters.com) : temps médian, part de chasseurs ayant tout débloqué, succès impossibles, DLC payants (cache 7 jours, hors quota Steam).
- **Vitrine des platines** : bannières « Dernier platine » et « Platine le plus rare », cartes holographiques et rareté de chaque platine. La rareté est une borne haute : on prend le succès le plus rare du jeu, d'après les statistiques mondiales de Steam.
- **Presque platinés** (≥ 75 %), avec le nombre de succès restants
- **Célébration des nouveautés** : sur ton propre profil, l'app compare avec ta visite précédente (mémorisée dans le navigateur). Les nouveaux platines et les changements de rang déclenchent des confettis et une étiquette « Nouveau » dans la vitrine.
- **Difficulté des platines à faire** : chaque jeu commencé est classé (Facile, Faisable, Coriace, Légendaire) selon le succès restant le plus rare. On obtient une tier list, un tri « Platine le plus accessible » dans la bibliothèque et les 3 « prochains platines » les plus à portée.
- **Succès ajoutés par une mise à jour** : Steam ne donne pas la date d'ajout des succès, donc l'app mémorise le nombre total de succès de chaque jeu dans le navigateur et repère les hausses d'une visite à l'autre. Les platines « perdus » sont signalés « à reconquérir ».
- **Objectifs de platine** : marquage ⭐ depuis la fiche d'un jeu. Les objectifs sont mis en avant en haut du profil, ont leur onglet dans la bibliothèque et déclenchent « Objectif atteint ! » une fois platinés.
- **Platines bloqués par un DLC** : marquage manuel depuis la fiche d'un jeu (Steam ne dit pas quels DLC tu possèdes). Ces jeux sortent de la tier list, du prochain platine et des presque platinés, et sont rangés dans l'onglet « Bloqués (DLC) » de la bibliothèque.
- **Fiche jeu** : les succès manquants passent en premier, du plus accessible au plus rare.
- **Salle des trophées** (`#/u/<steamid>/trophees`) : une page plein écran avec une plaque par platine, regroupées par année (numéro, date, durée de la chasse, rareté)
- **Numéro de platine** chronologique et **certificat de platine** dans la fiche des jeux platinés
- **Platines épinglés** (3 au maximum) : depuis la fenêtre de la carte de chasseur ou le certificat d'un jeu platiné. Ils passent en tête de la vitrine et sur la carte, complétés par les plus rares, et teintent la lumière du fond animé.
- **Fond animé** : « poussière dans la lampe ». Un cône de lumière chaude, teinté par ton premier platine épinglé, où flottent de fines particules de poussière, dont certaines aux couleurs de tes platines.
- **Carte de chasseur** : une image PNG de 1200×630 consacrée aux platines (nombre, heures pour les platiner, succès décrochés, ultra-rares, 3 platines mis en avant) à copier dans Discord ou à télécharger
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

## Base de données (facultative)

Avec `DATABASE_URL` (Postgres, par exemple l'offre gratuite de [Neon](https://neon.com)) :
- le cache des succès, des pourcentages mondiaux et des schémas survit aux redémarrages de Render, donc les chargements sont quasi instantanés après une mise en veille ;
- les succès ajoutés par une mise à jour sont détectés côté serveur, partagés entre tous les visiteurs ;
- objectifs, marquages DLC et historique des platines sont liés au compte Steam connecté et synchronisés entre appareils ;
- chaque profil ouvert dans l'app enregistre un résumé (platines, plus rare), calculé par le serveur depuis son cache. Le bloc Amis affiche le nombre de platines des amis déjà analysés et un **classement** entre eux.

Les tables sont créées au démarrage. Sans base, l'app garde son fonctionnement local (navigateur et disque).

## Économie d'appels Steam (limite : 100 000 par jour)

- Les succès d'un jeu ne sont redemandés que si le jeu a été rejoué depuis : son temps de jeu ou sa date de dernière session ont changé. Sinon le cache reste valable jusqu'à 30 jours. Si le joueur masque son temps de jeu, ce repère n'existe pas et le cache dure 6 h.
- Pourcentages mondiaux : 7 jours de cache. Liste des succès d'un jeu : 30 jours. Liste d'amis : 6 h (les statuts en ligne restent rafraîchis toutes les 5 min).
- La difficulté n'est évaluée que pour les jeux commencés.
- Compteur journalier consultable sur `/api/usage`. Au-delà de `STEAM_DAILY_BUDGET` (95 000 par défaut), les nouveaux appels sont refusés pour ne pas faire bloquer la clé.

## Déploiement sur Render (gratuit)

1. Sur https://dashboard.render.com : **New +** → **Blueprint**, puis choisis ce dépôt GitHub. Render lit `render.yaml`.
2. Renseigne `STEAM_API_KEY` (et `DATABASE_URL` si tu as une base) quand Render les demande. `SESSION_SECRET` est générée automatiquement.
3. Une fois le service en ligne, l'URL publique (`https://<nom>.onrender.com`) est détectée automatiquement via `RENDER_EXTERNAL_URL`. Pour un domaine personnalisé, définis `BASE_URL`.

Sur l'offre gratuite, le service se met en veille après 15 min sans visite et met environ 1 min à se réveiller. Le cache disque est vidé à chaque redémarrage.
