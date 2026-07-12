# Mira

Un navigateur web perso, à moi, **basé sur Chromium** et **vibe codé**. Frère de Kova (le terminal) : court, personnel, taillé pour mon usage.

Nom : `mira` = "regarde" (latin _mirari_, s'émerveiller) + une étoile. Le job d'un navigateur : afficher le web.

## Décision d'archi (posée, ne pas rouvrir sans raison)

Voie **A** : on **embarque** le moteur Chromium, on ne forke pas. Chromium est une dépendance, pas notre codebase. On construit l'UI et les features par-dessus.

Choix : **Electron** (Chromium + Node bundlés). Retenu pour la masse de doc/exemples — le terrain où le vibe coding se plante le moins. Alternatives écartées : NW.js (écosystème trop petit), Tauri/Wails (webview système = **WebKit sur Mac**, pas Chromium → casse la contrainte).

## Principe fondateur : tout pilotable (IPC + MCP)

**Toute action de Mira doit être pilotable par programme, pas seulement à la souris.** C'est une contrainte d'archi, pas un vœu : elle décide de la structure du code dès le départ.

Conséquences concrètes :

1. **Couche de commandes unique.** Chaque action (naviguer, ouvrir/fermer/switcher un onglet, back/forward/reload, ajouter un favori, commande de palette…) est une **commande nommée et typée** dans un registre central côté **main**. C'est la seule source de vérité des actions.
2. **L'UI n'est qu'un appelant.** La chrome React ne mute JAMAIS l'état du browser directement : elle **envoie une commande** (via IPC) que le main exécute. Un click handler = un `invoke('command-name', params)`, pas de la logique métier dans le renderer.
3. **Trois transports, un seul bus.** Le même registre de commandes est atteignable par :
   - **IPC** (interne) : la chrome React ↔ main.
   - **Socket unix** (externe, façon Kova) : `MIRA_SOCKET` (défaut `/tmp/mira.sock`), une requête JSON par ligne, pour piloter Mira depuis un shell / un agent. **Référence API : `docs/socket.md`** (protocole + toutes les commandes et leurs params) ; en live, la commande `list-commands` liste les noms connus du build qui tourne.
     - **⚠️ NE PAS piloter le socket avec `printf … | nc -U`.** Le `nc` de macOS ferme la connexion dès que stdin fait EOF (juste après le `printf`), donc il **rate toute réponse asynchrone** : `get-status` (réponse instantanée) passe parfois, mais `exec-js` et toute commande qui `await` (CDP, navigation…) renvoient **0 octet** — un « vide » trompeur qui ressemble à un hang ou à un bug de la commande (vérifié le 2026-07-11, m'a fait perdre des heures à croire exec-js cassé). Fix fiable : un **client socket brut** qui lit jusqu'au `\n`. Helper posé pour les sessions de debug : `scratchpad/mira.py` (`call({...})` / `execjs(tabId, code)`), à recréer si absent :
       ```python
       import socket, json
       def call(obj, timeout=30):
           s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout); s.connect('/tmp/mira.sock')
           s.sendall((json.dumps(obj)+'\n').encode()); buf=b''
           while b'\n' not in buf:
               c=s.recv(65536)
               if not c: break
               buf+=c
           return json.loads(buf.decode())
       ```
       Dépannage rapide en shell si vraiment besoin de `nc` : garder stdin ouvert le temps de la réponse — `{ printf '%s\n' '{…}'; sleep 1; } | nc -U /tmp/mira.sock`. Mais préférer le client Python.
     - **`exec-js` prend un `tabId`** (UUID via `list-tabs`) : toujours le passer pour viser un onglet précis. Un onglet endormi renvoie `{"ok":false,"error":"tab is asleep"}` (le réveiller via `select-tab`). Pour du code async, `exec-js` peut ne pas attendre la promesse dans certains builds — contourner par « lance l'async, stocke dans `window.__x`, relis en sync » sur un 2ᵉ appel.
     - **Pour ouvrir un onglet de test, TOUJOURS `new-tab` avec `background:true`.** Un `new-tab` normal met l'onglet actif ET ramène Mira au premier plan — or quand tu testes, Mickael est probablement en train de faire autre chose et voir Mira surgir devant le dérange. Le mode background charge la page cachée sans voler le focus ni faire passer la fenêtre devant ; tu récupères le `tabId` dans la réponse et tu la pilotes via `exec-js`.
     - **Profil de test dédié à Claude.** Un profil isolé (session/cookies à part) existe pour les tests : label **`Claude Test`**, id **`00000000-0000-0000-0000-000000000000`**. L'ouvrir/focus sur une Mira qui tourne : `open-profile {"id":"00000000-0000-0000-0000-000000000000"}`. Tester dedans plutôt que dans les profils réels de Mickael (Pro/Perso), pour ne pas polluer son historique/onglets.

## Lancer Mira sur un profil précis à froid (`--profile` / `MIRA_PROFILE`)

Au démarrage, Mira rouvre par défaut les profils qui étaient ouverts au dernier quit. Pour **démarrer à froid sur un seul profil** (typiquement le profil de test), sans rouvrir les autres :

- Flag CLI : `--profile <id>` ou `--profile=<id>`.
- Ou variable d'env : `MIRA_PROFILE=<id>` (le flag l'emporte si les deux sont posés).

Un id inconnu n'est pas fatal : Mira loggue un warning et retombe sur la restauration normale (dernier set ouvert). Parsing pur et testé dans `parseProfileArg` (`src/main/profile-store.ts`), branché au boot dans `src/main/index.ts` via `openSavedProfiles(explicitProfileId)`.

Le mécanisme est implémenté et couvert par des tests unitaires ; **je n'ai pas encore vérifié en vrai** l'invocation shell exacte pour injecter le flag/env dans l'app packagée (`open -a Mira --args --profile <id>` devrait passer par `--args`, l'héritage de `MIRA_PROFILE` via `open` reste à confirmer). À valider au premier usage.

- **MCP** : un serveur mince qui wrappe la socket. Il n'ajoute pas de logique, il expose les commandes existantes.

4. **Une commande = un nom + un schéma de params.** Ainsi elle est appelable à l'identique depuis IPC, socket ou MCP, sans réécriture.

Règle de conception au quotidien : avant d'implémenter une action dans un composant React, se demander « est-ce une commande du registre ? ». Si oui (presque toujours), elle vit dans le main et le composant l'appelle. Si une feature n'est atteignable qu'en cliquant, elle viole le principe fondateur.

## Principe fondateur : tout testable (une feature = un test)

**Chaque feature arrive avec son test.** Pas de code de feature mergé sans un test qui le couvre. C'est le corollaire direct du principe « tout pilotable » : comme la logique vit dans le registre de commandes (des fonctions nommées et typées, pas des click handlers), elle se teste sans lancer Electron ni Chromium.

- **Runner : Vitest** (naturel, on est déjà sur Vite via electron-vite).
- **Ce qu'on teste vraiment = la logique des commandes.** Chaque commande du registre a son test unitaire : entrées → effet attendu / valeur retournée. C'est là que vit 90 % de la valeur.
- **Ce qu'on ne teste PAS en unitaire = les bouts natifs Electron** (positionnement du `WebContentsView`, cycle de vie des `webContents`, IPC réel). Ça demande de mocker Electron ou de faire de l'intégration ; on le fait au coup par coup, pas systématiquement. « Une feature = un test » signifie **la logique de la feature est couverte**, pas « on simule tout Chromium ».
- **Conséquence de conception :** si une commande est trop couplée à Electron pour être testable simplement, c'est un signal qu'il faut extraire sa logique pure dans une fonction à part (testable), et ne laisser dans la commande que l'appel natif (fin, non testé).
- Commande `npm test` (Vitest) à câbler dès la première vraie commande (incrément 2).

## Découpage anti-collision (sessions parallèles)

Mira est vibe codé sur **plusieurs sessions en parallèle**. Un même fichier édité par deux sessions = conflit de merge ou écrasement. Le découpage vise donc **un fichier par feature**, pour que deux sessions qui bossent sur deux sujets différents touchent des fichiers différents. C'est une conséquence directe des deux principes ci-dessus : comme tout est une commande, une organisation naïve concentrerait toutes les features dans un seul fichier — exactement le point de collision à éviter.

**Registre de commandes = un fichier par domaine.** Le registre ne vit PAS dans un fichier unique. Il est éclaté dans `src/main/commands/` :

```
src/main/commands/
  registry.ts     types cœur + buildRegistry générique (change rarement)
  context.ts      CommandContext = intersection des slices de chaque domaine
  index.ts        racine de composition + barrel : fusionne les maps, ré-exporte l'API publique
  navigation.ts   commandes navigate/back/forward  + slice NavContext
  profiles.ts     commandes open/create/rename/list + slice ProfileContext
  settings.ts     commande open-settings           + slice SettingsContext
  <domaine>.ts    … un fichier par domaine
  *.test.ts       un test par domaine ; faux contexte partagé dans fake-context.ts
```

Règles de découpage à respecter par toute session :

1. **Ajouter une commande à un domaine existant** → éditer **uniquement** son fichier de domaine (ex. `navigation.ts`). Ne pas rapatrier de logique dans `index.ts`.
2. **Ajouter une capacité de contexte** (une méthode dont la commande a besoin) → l'ajouter à la **slice du domaine** (`NavContext`, `ProfileContext`, …), pas à une interface géante partagée. Le `makeContext` de `src/main/profiles.ts` (ProfileManager) l'implémente ensuite.
3. **Ajouter un domaine entier** → créer `commands/<domaine>.ts` (+ sa slice + son `.test.ts`), puis **une seule** ligne partagée à toucher : l'`import` + le spread dans `commands/index.ts`.
4. **Ne jamais réimporter par chemin interne.** Les consommateurs importent depuis `./commands` (résout vers `commands/index.ts`), jamais `./commands/navigation` directement.
5. **Le même principe s'applique aux autres surfaces** quand elles grossiront : CSS par surface (`assets/toolbar.css`, `sidebar.css`, `palette.css`), composants React par feature sous `renderer/src/features/<x>/`, `App.tsx` ne fait que les assembler. Éviter d'empiler dans `main.css` ou `App.tsx`.

Test avant d'écrire : « ma feature touche-t-elle un fichier qu'une autre session touche probablement aussi ? ». Si oui, c'est un signal qu'il faut un nouveau fichier de domaine plutôt qu'un append dans un fichier partagé.

## Stack

| Couche        | Choix                                     |
| ------------- | ----------------------------------------- |
| Shell         | Electron (Chromium + Node)                |
| Build / HMR   | electron-vite                             |
| UI ("chrome") | React + TypeScript                        |
| Style         | Tailwind _(à ajouter — pas encore câblé)_ |
| Contenu web   | `WebContentsView` (un par onglet)         |

## Le modèle mental : deux mondes séparés

1. **La "chrome"** = l'UI _autour_ du web (onglets, barre d'URL, sidebar, palette). C'est notre fenêtre React, notre HTML à nous. Vit dans `src/renderer/`.
2. **Le contenu web** = les sites visités. Vit dans des conteneurs isolés, un process par vue.

Le pont : **`WebContentsView`** (API Electron moderne). Un onglet = un `WebContentsView`, créé côté **main** (`src/main/`), positionné sous la barre d'adresse, écouté (`did-navigate`, `page-title-updated`, `page-favicon-updated`) et piloté (`loadURL`, `goBack`, `reload`). La chrome (renderer) et le main communiquent par **IPC**.

## Les pièges à connaître d'avance

1. **`WebContentsView` n'est PAS un élément DOM.** C'est une couche native posée par-dessus la fenêtre à des coordonnées x/y/w/h explicites. Quand la chrome bouge (resize, sidebar qui s'ouvre), il faut **recalculer et repositionner la vue à la main**. C'est le bug classique du browser Electron.
2. **Ne pas utiliser `<webview>` ni `BrowserView`** — dépréciés. Toujours `WebContentsView`. (L'IA propose souvent l'ancien `<webview>` : à corriger.)
3. **Un overlay HTML par-dessus le contenu web est impossible ; il faut une fenêtre native.** Corollaire du #1 : le `WebContentsView` étant composité **au-dessus de tout le DOM de la chrome**, une bulle CSS/absolue (tooltip, popover, menu contextuel) qui déborde sur la zone d'un onglet est **cachée derrière la page**. Le tooltip natif `title=""` n'est PAS une option de secours : il est **cassé sur Electron 41.x macOS arm64** ([#49843](https://github.com/electron/electron/issues/49843), ok en 37.x), en plus d'être non-stylable et temporisé. La seule voie pour dessiner au-dessus du contenu web est une **fenêtre native** que l'OS composite plus haut : une `BrowserWindow` enfant transparente + `focusable:false` + `setIgnoreMouseEvents(true)`, montrée avec `showInactive()` (une couche `WebContentsView` sœur ré-empilée marche aussi, mais son alpha au-dessus d'une vue sœur est réputé peu fiable). Implémenté pour le tooltip de la status bar : commandes `show-tooltip`/`hide-tooltip` (registre), géométrie pure et testée dans `src/main/tooltip.ts`, overlay natif dans `src/main/profiles.ts`.
4. **`globalShortcut` enregistre par position de touche QWERTY, pas par caractère.** Sur le clavier French AZERTY de Mickael, l'accélérateur `'M'` se pose sur le keycode 46 (position du M QWERTY = touche « , » en AZERTY) : la touche M physique (keycode 41, position « ; » QWERTY) ne déclenche rien. Vérifié en vrai le 2026-07-10 (frappe simulée par keycode vs frappe réelle). Parade : enregistrer les deux accélérateurs (`'M'` et `';'`) sur le même handler — voir le raccourci focus-app dans `src/main/index.ts`. Concerne toute lettre qui change de place entre QWERTY et AZERTY : A, Z, Q, W, M.
5. **Les bureaux virtuels macOS (Spaces) sont invisibles pour Electron.** Tous les Spaces partagent le même plan de coordonnées (même x/y sur le bureau 1 et le bureau 3), et une app relancée ouvre TOUJOURS ses fenêtres sur le bureau courant : sauver/restaurer les bounds ne restaure jamais le bureau. Aucune API publique (ni Electron ni AppKit) ne place une fenêtre sur un Space donné — la seule voie est l'API privée SkyLight, et `SLSMoveWindowsToManagedSpace` **ne marche que pour les fenêtres du process appelant** (verrouillé pour les fenêtres d'autres apps depuis macOS 14.5 — vérifié en vrai le 2026-07-11 sur Darwin 25 : move refusé sur une fenêtre Calculator, accepté sur une fenêtre à soi). D'où l'addon `native/mira-spaces/` (wrappers minces), la logique pure dans `src/main/spaces.ts` (indexation par ordre Mission Control — les ids de Space changent au reboot, l'index non), le champ `spaceIndex` de `session-store.ts`, et les commandes `list-spaces` / `move-window-to-space`. Autre piège dedans : déplacer une fenêtre vers un autre bureau via Mission Control n'émet AUCUN événement Electron (mêmes coordonnées) — la capture se fait sur `focus` et à la fermeture.

## Chemin d'incréments

1. Fenêtre Electron + **un** `WebContentsView` qui charge une URL en dur.
2. Barre d'adresse qui navigue (URL + entrée → `loadURL`).
3. Back / forward / reload + affichage titre & favicon.
4. **Multi-onglets** (tableau de `WebContentsView`, un visible à la fois) — premier vrai palier de complexité (cycle de vie, focus, layout au resize).
5. Ce qui rend Mira _à moi_ : sidebar façon Arc, raccourcis clavier, command palette `Cmd+K`.

## Structure (scaffold electron-vite)

```
src/main/       process principal (fenêtre, WebContentsView, IPC handlers)
src/preload/    pont sécurisé main ↔ renderer (contextBridge)
src/renderer/   l'UI React (la "chrome")
```

## Commandes

```bash
npm run dev        # dev + HMR (process long-running — ne pas lancer sans accord de Mickael)
npm run build      # typecheck + build
npm run typecheck  # tsc, sans build
npm run lint / format
./bin/build.sh     # build packagé + réinstalle l'app (quit Mira → build:mac → open)
```

**Ne pas proposer de « builder ».** Mickael développe Mira en continu via `npm run dev` (HMR) — c'est toujours ce chemin-là qui tourne. Ne jamais suggérer de rebuild/réinstaller l'app, et ne pas lancer `./bin/build.sh` de soi-même. Le build packagé n'existe que si Mickael le demande explicitement par ces mots : dans ce cas, `./bin/build.sh` quitte Mira, fait `npm run build:mac`, et rouvre l'app (`/Applications/Mira.app` est un **symlink** vers `dist/mac-arm64/Mira.app`, donc `build:mac` rafraîchit l'app installée en place — aucune copie ; setup one-time du symlink documenté en tête de `bin/build.sh`).

## Notes

- **Packaging (`build:mac`) : fonctionne, avec un patch figé.** electron-builder 26 charge `@noble/hashes@2` (pur ESM) via un `require()` CommonJS → `ERR_REQUIRE_ESM` qui plante tout le packaging au démarrage. Contourné en transformant ce `require` en `import()` dynamique dans `app-builder-lib/.../blockmap/blockmap.js`. Le correctif est **figé et versionné** dans `patches/app-builder-lib+26.15.3.patch` (via [patch-package](https://github.com/ds300/patch-package)) et **ré-appliqué automatiquement** par le `postinstall` (`patch-package`) après chaque `npm install`. Ne pas supprimer ce dossier `patches/`. Si electron-builder est mis à jour, régénérer le patch (`npx patch-package app-builder-lib`) ou le retirer s'il n'est plus utile.
  - Ancien `postinstall` (`electron-builder install-app-deps`) supprimé : il plantait et ne servait à rien (pas de dépendance native, `npmRebuild: false`).
- **Langue** : tout le code, les commentaires, les identifiants et les textes d'UI en **anglais**. Le français reste pour le dialogue.
- **Rien d'intime ici** : repo de code perso classique, pas le repo `self`. Pas de chiffrement git-crypt, commits descriptifs normaux.
