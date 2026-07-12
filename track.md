# Mira — track

Suivi des chantiers de Mira (navigateur perso Chromium/Electron). Le « pourquoi »
et l'archi vivent dans `CLAUDE.md` ; ici c'est l'état vivant + la prochaine action.
Historique lourd d'un chantier → doc annexe dédié (voir §Docs), jamais dans le tableau.

## Statut des chantiers

| Statut | Sujet | Prochaine action |
| --- | --- | --- |
| 🔧 En test | **Repo rendu public + scrub des données perso** | Repo passé **public** le 2026-07-12. Données perso sorties du versionné (git-excluded via `.git/info/exclude` : `track.md`, `scratchpad/`, `CLAUDE.local.md`, `linkedin-triage.md`) et scrubées dans le tracké (domaines perso → `example.com`, home → Google, appId `com.mira.app`). Historique réécrit (git-filter-repo + force-push, 0 occurrence perso sur 23 commits). **Prochaine action** : vérifier sur GitHub qu'aucun ancien SHA n'est servi (cache/API) et qu'aucun fork n'existe. |
| 🔧 En test | **Position des fenêtres sur les bureaux virtuels (Spaces)** | Chaque fenêtre-profil retient SON bureau (`spaceIndex` dans `sessions.json`, index ordre Mission Control) et y retourne au relaunch via l'addon natif `native/mira-spaces/` (API privée SkyLight, cf. piège #5 du `CLAUDE.md`). Commandes `list-spaces` / `move-window-to-space`. Codé + testé. **Valider en app** : 2 bureaux → quit → relaunch → chacune revient sur son bureau. |
| ✅ Terminé | **WhatsApp Web bloqué** (`stealth.ts`) | Résolu, WhatsApp Web fonctionne (confirmé 2026-07-10). Cause exacte jamais isolée (Heisenbug d'instrumentation, irreproductible en Electron 41.7.0 propre). Probe SW gardé (fonctions pures `interpretSwProbe` / `swProbeLogLine` testées). |
| ✅ Terminé | **Favoris → menu natif + arbre de dossiers** | Validé en app 2026-07-10. Arbre `bookmark-store.ts` (pur, testé), commandes add/remove/rename/move/list/open (pilotables), rendu dans le menu natif « Bookmarks », **Cmd+D**, étoile ★. Détail : §Design des favoris. Distinct des pinned tabs. |
| 🔄 En cours | **Favoris — reste à faire** | 1) **Import Atlas** : câblage lecture-disque (`importAtlasTree` déjà écrit + testé), décisions ouvertes (dossier « Imported from Atlas » recommandé, dédup par url). 2) **Gestion depuis le menu** (remove/rename/move en items — commandes déjà pilotables, manque les items). Détail : `atlas-import-notes.md`. |
| 💡 Idée | **Import onglets ouverts d'Atlas** | Fait **à la main** une fois (2026-07-10, via socket `new-tab` + `pin-tab`). Contraintes vérifiées pour un import pilotable futur : `atlas-import-notes.md`. |
| 🔧 En test | **Extensions Chrome (compat large)** | Chargement MV3 (Dark Reader, `extensions.ts`, sideloads persistés), toolbar (`ExtensionActions.tsx`), Web Store (Otto installé d'un clic), Settings → Extensions, par profil. **E7/Kondo résolu** (shim SW↔`chrome.runtime` + `nodeIntegrationInSubFrames:true`). Logging rotatif de crash (`log.ts`, testé). **Reste** : E2 valider clipper + password manager (le vrai test compat large) ; E4 clic-droit ; E6 preloads en packaging ; déplacer Cmd+S (= Discard Tab) avant les tests E2. Détail : `extensions-plan.md` §8. |
| ⏸️ En attente | **Vidéos DRM (Prime Video, Netflix…) — erreur 7131** | Cause : Electron stock 41.7.0 **sans Widevine CDM** → aucun contenu DRM déchiffrable (YouTube / non-DRM OK). Voie connue si besoin réel : fork castLabs `@castlabs/electron-releases` + signature VMP (couple Mira au rythme du fork). ⚠️ La même erreur 7131 apparaît **aussi dans Chrome** → 2ᵉ problème machine/réseau, à résoudre côté Chrome d'abord. |
| 🔄 En cours | **Cloisonnement complet par profil + profil chiffré (vault)** | Chaque profil = unité de stockage isolée : history/permissions/favoris **par profil** (réglages restent globaux). Profil chiffré : vault `.sparsebundle` AES-256 par profil, cœur pilotable (`encrypt`/`unlock`/`lock`/`list-vaults`) + UI dialog dans Settings, flux in-app validé (2026-07-12). Bug perte cookies : **fix lock-au-quit + flush (code fait)**. **Prochaine action** : valider en vrai `unlock → login → Cmd+Q → re-unlock → toujours loggé`. Détail : `vault-notes.md`. |
| 💡 Idée | **Settings par profil ?** (aujourd'hui globaux) | **Rien n'est acté.** Discussion : `settings-per-profile.md`. |
| 🔧 En test | **Skills contextuels par site** | Cœur pur `skills.ts` (skill `summarize-page`, testé), commandes `list-skills` / `run-skill` (pilotables). Surfacing palette + **pane droit** (`SkillPane.tsx`, rétrécit la vue web → pas de piège #3, markdown sans innerHTML), **moteur LLM** 3 providers (`claude-cli` défaut / `anthropic-api` / `extractive`) dans Settings → AI, pane = **chat avec historique**. Panneaux redimensionnables (largeurs persistées). Codé + testé, **à valider en app après rebuild**. **Reste** : rebuild ; caveat `claude` sur PATH en packagé ; skill Gmail. Détail : `skills-plan.md`. « skill » = capacité Mira par site, distinct des skills Claude. |
| 🔧 En test | **Agent hors de Mira — Claude Code pilote le navigateur (option A)** | Décidé 2026-07-11 : l'ambition agentique vit dans un **skill Claude Code** (terminal), pas dans un moteur interne à Mira. Mira reste **pilotable** (socket / `exec-js` / registre), l'agent l'entraîne du dehors. **Option A prouvée de bout en bout** (2026-07-11) : premier skill de pilotage (triage LinkedIn, gardé local). Vérifié : un onglet en arrière-plan garde son `WebContentsView` masqué → `exec-js` lit ET clique un onglet caché, donc l'utilisateur peut changer d'onglet pendant un run. **Prochaine action** : porter le pattern à d'autres sites sans API. Voir §Décisions posées « API-first ». |
| ✅ Terminé | **Command palette `Cmd+K`** | Validé en app 2026-07-10. Fuzzy-search parmi commandes statiques + onglets + favoris + profils ; un choix lance la commande du registre. Logique pure/testée `buildPaletteEntries` (`palette.ts`). Détail : §Design de la palette. |
| ✅ Terminé | **`exec-js` — introspection de page** | Commande `exec-js {code, tabId}` : exécute du JS dans l'onglet (monde de la page), renvoie le résultat sérialisable. Fondation double : debug d'un site + moteur de skills. Validée en vrai 2026-07-10, testée en unitaire. |
| ✅ Terminé | **Login OAuth (Google/GSI) — UA + popups** | Validé en app 2026-07-10. (1) UA : `app.userAgentFallback` retire `Mira/` et `Electron/` (Google refusait `disallowed_useragent`). (2) Popup OAuth : `decideWindowOpen` (`window-open.ts`, testé) → un popup devient une vraie fenêtre enfant (même partition), le reste reste un onglet. Bénéficie à tous les logins OAuth/SSO. |
| ✅ Terminé | **Settings** — fenêtre dédiée, manager de profils | Validé en app 2026-07-09 (`Settings.tsx`, cmd `open-settings`, Cmd+,). |
| ✅ Terminé | **Tabs verticaux à gauche** (façon Arc) + panneau repliable | Validé en app 2026-07-09 : new/close/select, repli, layout au resize, dimming des endormis, persistance + lazy-load. `tab-store.ts` + `session-store.ts` (purs, testés), `commands/tabs.ts`, `Sidebar.tsx`. |
| ✅ Terminé | **Status bar** (façon Kova) | Validé en app 2026-07-09. `commands/status.ts` (`get-status`, testé, pilotable), `StatusBar.tsx` : compteur d'onglets `loaded/total`, RSS sommé sur tous les process, horloge, détail au survol inline. |
| ✅ Terminé | Incréments 1→3 : WebContentsView, barre d'URL, registre de commandes | — |
| ✅ Terminé | Socket de contrôle externe `MIRA_SOCKET` (+ IPC) — « tout pilotable » | — |
| ✅ Terminé | Profils dans le **menu natif** de l'app | — |
| ✅ Terminé | **Profils : modèle id/label + persistance + create/rename** — `profiles.json`, commandes pilotables | — |

## Docs

- [`extensions-plan.md`](extensions-plan.md) — plan complet du chantier Extensions Chrome (recherche + revue adversariale, décisions D1-D5, étapes E0→…, résolution Kondo §8).
- [`skills-plan.md`](skills-plan.md) — spec des skills contextuels par site : concept, abstraction, surfacing dans la palette, périmètre V1 (pane droit).
- [`settings-per-profile.md`](settings-per-profile.md) — discussion « settings par profil ? ». **Rien n'est acté.**
- [`vault-notes.md`](vault-notes.md) — historique complet du cloisonnement par profil + profil chiffré (vault `.sparsebundle`, saga perte de cookies, fix lock-au-quit).
- [`atlas-import-notes.md`](atlas-import-notes.md) — import favoris + onglets depuis ChatGPT Atlas : format sur disque, contraintes vérifiées.

## Décisions posées (ne pas rouvrir sans raison)

- **Deux principes fondateurs** (dans `CLAUDE.md`) : _tout pilotable_ (IPC + socket + MCP via un registre de commandes unique) et _tout testable_ (une feature = un test Vitest sur la logique du registre).
- **Où Mira gagne sa place : API-first, Mira pour la longue traîne sans API [cadrage 2026-07-11].** Quand un site expose une API/MCP propre (Gmail, Calendar, Notion, Drive), **piloter l'API** — structuré, sûr, batchable, headless ; Mira n'apporte rien de mieux là. Mira **complète** les API : sa valeur propre est la **longue traîne des sites sans API** (LinkedIn, outils internes derrière SSO), où piloter le DOM de la session loggée est **le seul** moyen d'agir en tant que « l'humain connecté » — zéro setup d'auth, au prix de la fragilité (sélecteurs CSS, séquentiel, clics simulés non atomiques). Corollaire pour un skill Mira : isoler les sélecteurs en tête, préférer ARIA/attributs stables, et **vérifier l'effet** plutôt que supposer le clic réussi.
- **Profils = fenêtres** (modèle Chrome), pas containers Firefox. Ouvrir un profil déjà ouvert → **focus** sa fenêtre (pas de doublon). Additif.
- **Rename profil = label seul.** Le vrai identifiant est un **ID stable** (où vivent les cookies : `persist:mira-<id>`). Renommer change le libellé, jamais l'ID → cookies préservés. **[FAIT]** : modèle `{id, label}` dans `src/main/profile-store.ts` (pur, testé), persisté dans `profiles.json`. L'ID est un `randomUUID` ; le `default` garde la session Electron par défaut.
- **Settings = fenêtre dédiée** pour l'instant ; deviendra un **onglet** (façon `chrome://settings`) une fois utile. **[FAIT]** : `open-settings` (commande + Cmd+, + item menu) ouvre une 2e fenêtre (même bundle renderer, `?view=settings`, singleton).
- **État jamais perdu = persistance à chaque mutation.** Les onglets d'une fenêtre sont sauvés dans `sessions.json` (clé = id de profil) à **chaque** changement et à la fermeture, pas seulement au quit. L'onglet actif est stocké en **index**. Fichier corrompu/absent → dégradation propre. Modèle pur/testé dans `src/main/session-store.ts`.
- **Status bar : mémoire app-wide + horloge chrome-side. [FAIT]** La barre lit `get-status` (mêmes chiffres au socket/MCP). Mémoire = RSS **sommé sur tous les process Electron** (`getAppMetrics`). Compteur = `loaded/total`. Horloge HH:MM côté chrome (pur UI).
- **Détail du status au survol = révélé INLINE, jamais en tooltip flottant.** Un tooltip flottant se peindrait sous le `WebContentsView` natif (piège #1 du `CLAUDE.md`). La barre est du DOM que la vue ne recouvre jamais → on révèle le détail **dans** la barre.
- **Onglet endormi = dimmé. [FAIT]** Le flag `loaded` est calculé côté main (`pw.views.has(id)`) et poussé par onglet. La Sidebar dimme titre+favicon des onglets `!loaded`. L'onglet actif est toujours matérialisé.
- **Onglets lazy-loadés (façon Arc/Chrome).** À la restauration, tous les onglets apparaissent (métadonnées persistées) mais **seul l'onglet actif crée son `WebContentsView`**. Les autres sont dormants jusqu'au premier clic (`selectTabIn` les matérialise). `pw.state.tabs` = tous ; `pw.views` = matérialisés.
- **Socket** : chemin `/tmp/mira.sock` (override `MIRA_SOCKET`). Protocole : une requête JSON par ligne `{"command":"...","params":{...}}` → `{"ok":true,...}` / `{"ok":false,"error":...}`.
- Ciblage des commandes : IPC → fenêtre appelante (`event.sender`) ; socket → fenêtre au premier plan.

## Design des tabs (posé, implémenté)

- **Vertical, à gauche**, façon Arc / OpenAI Atlas (pas d'onglets horizontaux).
- **Tabs par fenêtre** : chaque fenêtre-profil a **ses propres** onglets.
- **Panneau repliable — repli complet** : un icône **cache entièrement** le panneau (pas un rail d'icônes), et sert à le rouvrir. Façon Arc.
- Un onglet = un `WebContentsView` ; un seul visible à la fois par fenêtre ; layout à recalculer (le panneau replié change la largeur/offset x de la vue).
- Reste piloté par le registre : `new-tab`, `close-tab`, `close-active-tab`, `select-tab`, `move-tab`, `list-tabs`, `toggle-tabs-panel`.
- **Réordonner par drag-and-drop. [FAIT]** Logique pure `moveTab(state, id, toIndex)` (testée). La Sidebar fait le DnD HTML5 et appelle la commande — elle ne réordonne jamais elle-même. L'ordre est persisté dans `sessions.json`.
- **Barre d'URL = miroir de l'onglet actif. [FAIT]** La barre affiche toujours l'URL du site actif, **sauf** quand l'input a le focus. `onBlur` → resnap sur l'URL réelle. Helper `activeUrlOf(tabs, activeId)`.
- **Nouvel onglet → URL affichée + sélectionnée.** Ouvrir un onglet charge l'URL par défaut (`HOME_URL`, `example.com` pour l'instant ; deviendra un réglage Settings), l'affiche et la sélectionne (`el.select()`).
- **Nouvel onglet → focus barre d'URL. [FAIT]** Ouvrir un onglet redonne le focus clavier à la chrome (`mira:focus-address-bar`). Course connue (la nouvelle vue reprenait le focus au commit) corrigée par un one-shot `view.webContents.once('focus', …)` qui renvoie le focus à la chrome.
- **Cmd+W = fermer l'onglet courant.** Jamais l'app, jamais la fenêtre. **[FAIT]** : `close-active-tab` (pilotable) ; menu File custom — New Tab **Cmd+T**, Close Tab **Cmd+W**, Close Window **Cmd+Shift+W**. Sur le **dernier onglet** : la fenêtre reste ouverte et vide (panneau forcé ouvert pour que « + New tab » reste atteignable). Taper une URL en état vide ouvre un onglet (la commande `navigate` détecte `activeId === null`).

## Design des favoris (refonte 2026-07-10 : arbre + menu — validé en app)

- **Favoris = arbre de dossiers, dans le menu natif.** Modèle en arbre dans `bookmark-store.ts` (pur, testé) : union discriminée `{kind:'url',…}` | `{kind:'folder',…,children[]}`, racine = liste ordonnée de nœuds. Ops pures : insert / remove / rename / move / find / findUrl / flatten / normalize. Persisté en `bookmarks.json`. **Par profil** (décision 2026-07-11, voir ligne « Cloisonnement complet par profil » — l'ancien choix « global minimaliste » est abandonné). Ids = `randomUUID`.
- **Rendu dans le menu natif « Bookmarks »** : dossier → sous-menu, url → item cliquable (`open-bookmark`). « Add to Favorites » **Cmd+D**. Le menu se reconstruit à chaque mutation.
- **Piloté par le registre** : `add-bookmark {url?, title?, parentId?}` (sans url = onglet actif), `add-folder`, `remove-bookmark`, `rename-bookmark`, `move-bookmark`, `list-bookmarks`, `open-bookmark`. Testés.
- **Gestion des dossiers = minimale côté UI** : le modèle + les commandes supportent tout (pilotables), mais **pas d'UI de gestion** pour l'instant — la hiérarchie arrive surtout par l'import Atlas. UI = menu + l'étoile.
- **Étoile ★/☆ conservée** (`App.tsx`) : reflète si l'url de l'onglet actif est en favori, clic = toggle (ajoute à la racine sinon retire). La section sidebar « Favorites » est retirée.
- **`add-bookmark` idempotent par url** : re-bookmarker une page renvoie l'entrée existante, pas de doublon.
- **Import Atlas** : fonction pure `importAtlasTree(atlasJson)` déjà écrite + testée. Format Atlas + câblage + décisions ouvertes : `atlas-import-notes.md`.

## Design de la palette (posé, implémenté — à valider en app)

- **Cmd+K ouvre une palette de recherche** qui liste des **entrées** (`{title, subtitle?, group, command, params?}`), pas des commandes brutes. Choisir = un appel sur le même bus que la barre d'URL / socket / MCP. La chrome filtre + appelle, aucune logique métier.
- **Entrées** : commandes statiques + dynamiques (onglets, favoris aplatis, profils). Construites par `buildPaletteEntries(state)` : pure et testée. La chrome fait le fuzzy-match localement.
- **Le main possède l'état ouvert/fermé.** Piège #3 du `CLAUDE.md` : choix = **masquer la vue active** tant que la palette est ouverte (pas de fenêtre native). `toggle-palette` bascule le flag, re-layout, donne le focus à la chrome, pousse `mira:toggle-palette`.
- **Fermeture** (Échap / clic hors / après un choix) : la chrome appelle `toggle-palette {open:false}` (re-montre la vue) **puis** la commande de l'entrée, pour qu'un `select-tab`/`navigate` atterrisse sur une vue visible.

## Repo

- Repo **public** GitHub `micktaiwan/mira` (passé public le 2026-07-12).

## Commandes utiles

```bash
npm run dev        # dev + HMR (⚠️ long-running — modifs du MAIN nécessitent un redémarrage complet)
npm test           # Vitest (logique du registre)
npm run typecheck && npm run lint
# Piloter depuis un shell (les commandes profil ciblent par ID stable, pas le label) :
printf '%s\n' '{"command":"navigate","params":{"url":"example.com"}}' | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"list-profiles"}' | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"create-profile","params":{"label":"Perso"}}' | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"rename-profile","params":{"id":"<uuid>","label":"Work"}}' | nc -U /tmp/mira.sock
printf '%s\n' '{"command":"open-profile","params":{"id":"<uuid>"}}' | nc -U /tmp/mira.sock
```
