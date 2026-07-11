# Plan — Extensions Chrome dans Mira (compat large)

Posé le 2026-07-09, passé au crible (revue adversariale multi-agents) le 2026-07-10.
Objectif confirmé par Mickael : viser la **compatibilité large** avec les extensions Chrome
(pas juste 2-3 extensions perso). Ce doc est le plan d'implémentation ; l'état d'avancement
vit dans `track.md`, l'archi générale dans `CLAUDE.md`.

Tous les faits externes cités ici ont été vérifiés les 2026-07-09/10 (lecture directe des
READMEs, sources et issues — URLs à chaque section). Les faits internes sont ancrés par
**nom de fonction + fichier** (pas de numéros de ligne : le repo est édité par plusieurs
sessions en parallèle, les lignes périment en heures).

## 1. Verdict de faisabilité (honnête)

« Compat large » est atteignable **pour une grande partie des extensions**, avec un plafond
qui vient d'Electron lui-même, pas de Mira :

| Catégorie | Verdict | Pourquoi |
|---|---|---|
| Extensions UI/contenu (Dark Reader, clippers, userscripts…) | ✅ réaliste | APIs couvertes par Electron + `electron-chrome-extensions` |
| Ad blocking | ❌ **renoncé** (D3) | La seule voie par extension était uBlock MV2 (`chrome.webRequest`, couvert par Electron en MV2 seulement) ; les bloqueurs MV3 exigent `declarativeNetRequest`, absent d'Electron. Option future SANS extension : bloqueur intégré côté Mira (ex. `@ghostery/adblocker-electron` sur `session.webRequest`), possible précisément parce qu'on renonce au webRequest des extensions (§3.1) |
| Bloqueurs MV3 (uBO Lite…) | ❌ aujourd'hui | pas de DNR, et `chrome.webRequest` est indisponible dans les service workers MV3 (electron#52265, ouvert) |
| Extensions exigeant `chrome.identity` (OAuth), `sidePanel`, `tabGroups`, `commands` | ❌ | non implémentées par Electron ni par la lib |
| Password managers (1Password…) | 🔶 à tester | MV3 SW tournent sur Electron 41 ; le remplissage dépend d'APIs à valider en vrai — et les popups OAuth `window.open` dépendent de D5 (§7) |

Sources : doc officielle [electronjs.org/docs/latest/api/extensions](https://www.electronjs.org/docs/latest/api/extensions)
(liste exacte des APIs supportées, DNR absent) ;
[electron#52265](https://github.com/electron/electron/issues/52265) (ouvert : `chrome.webRequest.onBeforeRequest`
undefined dans les SW MV3) ; [electron#49984](https://github.com/electron/electron/issues/49984)
(mainteneur : « V3 Chrome extensions are supported. We just don't support all specific APIs
that Chrome provides. ») ; [electron-browser-shell#172](https://github.com/samuelmaddock/electron-browser-shell/issues/172)
(SW MV3 cassés sur Electron 40, refonctionnent en 41 — bisection utilisateur, pas confirmée par un changelog Electron).

## 2. Briques retenues

Monorepo [samuelmaddock/electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell)
(la référence de facto, uBlock Origin et Dark Reader en vitrine du README) :

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `electron-chrome-extensions` | 4.9.0 | **GPL-3.0 ou Patron (payante)** — champ `license` **obligatoire** au constructeur, vérifié à l'exécution (`checkLicense()` throw) | Implémente `chrome.tabs/windows/action/cookies/contextMenus/notifications/webNavigation/runtime/storage` par-dessus NOS onglets, via callbacks |
| `electron-chrome-web-store` | 0.13.0 | MIT | Install direct depuis chromewebstore.google.com : télécharge/déballe les `.crx` (CRX2/3), auto-update toutes les 5 h, allowlist/denylist, `beforeInstall` |
| `electron-chrome-context-menu` | 1.1.0 | MIT | Menu clic-droit parité Chrome ; accepte les items d'extensions via `extensionMenuItems` |

Le chargement lui-même reste du Electron natif : `session.extensions.loadExtension`
(la forme `ses.loadExtension` est **dépréciée**), sessions **persistantes** uniquement,
après `app.ready`, à refaire à **chaque boot**, dossiers unpacked seulement (le `.crx` est
l'affaire du paquet web-store).

Contraintes d'intégration vérifiées (README + source de la lib) :

- **Une instance `ElectronChromeExtensions` par session** (throw si doublon). La lib enregistre
  elle-même son preload sur la session (`registerPreloadScript`, frame + service-worker) —
  rien à ajouter aux `webPreferences` des onglets.
- Le preload de la lib **doit être embarqué au packaging** (`electron-chrome-extensions/preload`) —
  à valider dans `build:mac` (electron-vite externalise les deps, electron-builder les embarque ;
  sinon plugin de copie, cf. README).
- Les SW MV3 exigent le **sandbox activé** sur les webContents des onglets — c'est le défaut,
  et les vues d'onglets de Mira ne le désactivent pas (`materializeTab` dans `profiles.ts` :
  `webPreferences` = partition seule ; le `sandbox: false` existant ne concerne que les fenêtres
  chrome et Settings, pas les vues). Ne jamais ajouter `sandbox: false` aux vues d'onglets.
- « All background scripts are persistent » (limitation lib) : chaque extension chargée coûte
  sa RAM en continu, multipliée par le nombre de sessions où elle est chargée (visible dans
  notre status bar RSS).

## 3. Les pièges spécifiques à notre archi

1. **`session.webRequest` est exclusif avec le `chrome.webRequest` des extensions.** Un seul
   listener `session.webRequest.*` posé par notre code **désactive silencieusement** le
   `chrome.webRequest` des extensions sur cette session (règle d'exclusivité Electron, README
   lib : « Usage of Electron's webRequest API will prevent chrome.webRequest listeners from
   being called »). D3 ayant sorti uBlock MV2 du périmètre, ce n'est plus un garde-fou
   critique — c'est même l'inverse : la voie est libre pour un futur bloqueur intégré côté
   Mira. À savoir, pas à tester.
2. **Sessions par profil.** Chaque profil a sa partition (`persist:mira-<id>`, défaut = session
   par défaut — `partitionForId` dans `profile-store.ts`). Les extensions étant par session,
   les sets sont naturellement **par profil** (D2 tranchée) : installer une extension =
   l'installer dans le profil courant, et lui seul. La session par
   défaut est partagée avec les fenêtres chrome et Settings (leurs `webPreferences` n'ont pas de
   partition) — en dev, la chrome est du `http://localhost` : un content script `<all_urls>`
   s'y injecterait. Accepté pour l'instant (en prod la chrome est du `file://`, non matché par
   défaut), à revisiter si gênant (D4).
3. **`window.open` est refusé partout.** `materializeTab` pose un `setWindowOpenHandler` qui
   deny tout et route vers `shell.openExternal`. Conséquences pour les extensions : les liens
   `target=_blank` d'un dashboard d'extension partent dans le navigateur système, un
   `window.open('chrome-extension://…')` échoue en silence (aucun handler macOS pour ce scheme),
   et un popup OAuth ouvert par une page ne rentre jamais dans la session Mira. → Décision D5.

## 4. Architecture dans Mira

Fidèle aux deux principes fondateurs : tout passe par le registre, la logique pure est testée.

### 4.1 `ExtensionsService` (main, nouveau fichier `src/main/extensions.ts`)

Possède les instances lib et le câblage. **Clé de la map = l'objet `Session` lui-même**,
résolu au point de câblage via `view.webContents.session` — jamais reconstruit depuis le nom
de partition (piège : `partitionForId('default')` renvoie `undefined`, et
`session.fromPartition(String(undefined))` créerait une partition in-memory où `loadExtension`
throw). Profil défaut → `session.defaultSession`, explicitement. Ce keying rend aussi le
doublon d'instance (throw de la lib) impossible par construction.

```ts
new ElectronChromeExtensions({
  license: 'GPL-3.0',            // décision D1, voir §7
  session,
  createTab:    async (details) => { /* newTabIn du bon ProfileWindow → [webContents, window] */ },
  selectTab:    (wc, win)  => { /* selectTabIn */ },
  removeTab:    (wc, win)  => { /* closeTabIn */ },
  createWindow: async (details) => { /* refusé au début : une fenêtre = un profil (décision posée) */ },
})
```

(`assignTabDetails` volontairement omis : la lib ne voit que les onglets ayant un webContents,
donc `discarded` y serait constant — logique morte.)

Câblage aux points de passage existants de `profiles.ts` (tous des choke points uniques) :

| Événement Mira | Où (fonction) | Appel lib |
|---|---|---|
| webContents d'onglet créé | `materializeTab` (SEUL point de création de `WebContentsView` dans tout `src/`) | `extensions.addTab(wc, win)` |
| onglet activé | **partout où `state.activeId` change** : `newTabIn` (un nouvel onglet devient actif via `addTab` du tab-store — c'est le chemin le plus fréquent, Cmd+T / open-bookmark / navigate-sur-vide), `selectTabIn`, voisin activé dans `closeTabIn`, `restoreSession`, `discardActiveTabIn` | `extensions.selectTab(wc)` |
| onglet fermé | `closeTabIn` | `extensions.removeTab(wc)` |
| onglet endormi (discard) | `discardView` | `extensions.removeTab(wc)` |

Plutôt que 5 call-sites, viser **un hook unique « activation changée »** appelé partout où
`activeId` bouge (y compris les futurs cas type onglet Settings sans webContents — ne rien
signaler à la lib quand l'onglet actif n'a pas de vue).

Cycle de vie à la fermeture d'une **fenêtre** de profil : une `Session` Electron n'est jamais
détruite, donc l'instance lib et les background scripts persistants **restent en RAM** fenêtre
fermée (visible dans la status bar). Assumé en V1 (« sessions chaudes ») et documenté ; si ça
pèse, E6 ajoutera le déchargement (`removeExtension` par extension à la fermeture, rechargement
à la réouverture).

Quirk assumé : les onglets **endormis** (lazy-load) n'ont pas de webContents → invisibles pour
`chrome.tabs.query`. Cohérent avec `discarded`, sans gravité.

### 4.2 Domaine de commandes `src/main/commands/extensions.ts`

Pattern standard (modèle : `status.ts`) : slice `ExtensionsContext`, helpers purs exportés,
`extensionsCommands: CommandMap<CommandContext>`, `extensions.test.ts`, fakes dans
`fake-context.ts`, stubs dans le contexte inline de `socket.test.ts`. Une ligne à toucher dans
`commands/index.ts` + l'intersection dans `commands/context.ts`.

Commandes : `list-extensions`, `install-extension {id}` (Web Store), `load-extension {path}`
(unpacked/sideload), `uninstall-extension {id}`, `update-extensions`. Toutes pilotables
socket/MCP — installer uBlock depuis un shell devient une ligne de `nc`.

Deux points spécifiés d'avance (trouvés en revue) :

- **Install/uninstall ciblent le profil de la fenêtre appelante** (D2 : sets par profil).
  L'API du paquet web-store (`installExtension`/`uninstallExtension`) prend une session —
  c'est exactement notre granularité. Le piège à tester est l'isolation : deux profils = deux
  installs indépendantes (disque compris) ; désinstaller dans A ne doit RIEN changer dans B.
  Test : fake context à 2 profils, uninstall dans A, B intact.
- **`normalizeInput` (`url.ts`) doit accepter `chrome-extension://`.** Aujourd'hui son regex ne
  connaît que `https?|file|about:` → `navigate` vers une page d'extension (socket/MCP ou Enter
  dans la barre qui miroite un onglet extension) partirait en recherche Google. Une ligne +
  son test dans `url.test.ts` (E1).

### 4.3 Prérequis structurel : registre async (E0)

Le registre est **synchrone** (`CommandHandler` retourne `CommandResult`, `registry.ts`) or
`installExtension` & co sont async. E0 élargit le type en `CommandResult | Promise<CommandResult>`.
Périmètre réel (vérifié call-site par call-site) :

- `ipcMain.handle` (IPC) : rien à faire, il await déjà les promises.
- Chemin socket : `handleRequestLine` (`socket.ts`) devient async, et son try/catch doit
  attraper les **rejections** (pas seulement les throws synchrones) → `fail()`.
- `socket.test.ts` : ses assertions synchrones sur `handleRequestLine` passent à `await` —
  les tests existants **doivent être édités**, ils ne restent pas verts tels quels.
- Accélérateurs menu (`index.ts`/`menu.ts`) : fire-and-forget ; ajouter un `.catch` pour
  qu'une commande async en erreur ne devienne pas une unhandled rejection.

Petit mais pas cosmétique. À faire en premier et seul (fichiers partagés `registry.ts` /
`socket.ts` — collision minimale avec les autres sessions si l'incrément est court).

### 4.4 UI (chrome React)

- **Boutons d'action toolbar** : la lib fournit le Web Component `<browser-action-list>`
  (badges, clicks, popups). Prérequis : appeler `injectBrowserAction()` dans **notre preload
  chrome**, et `ElectronChromeExtensions.handleCRXProtocol(session)` pour servir les icônes en
  `crx://`. **Attribut `partition` obligatoire** : la chrome de TOUTE fenêtre de profil tourne
  sur la session par défaut, et l'élément se binde par défaut à la session où il vit — sans
  `partition="persist:mira-<id>"`, la fenêtre « Work » afficherait/piloterait les extensions du
  profil défaut (silencieux, pas d'erreur). Omettre l'attribut uniquement pour le profil défaut.
  À valider en E3 : que `handleCRXProtocol` sur la session de la chrome sert bien les icônes
  d'extensions chargées dans une autre session (non documenté par la lib).
- Composant sous `renderer/src/features/extensions/` (règle CLAUDE.md), monté dans la toolbar
  de `App.tsx` après le `<form>` adresse, CSS dédié (pas dans `main.css`).
- **CSP à ouvrir** : la CSP de la chrome vit dans la balise `<meta http-equiv>` de
  `src/renderer/index.html` (`img-src 'self' data:` — c'est pour ça que les favicons sont des
  badges-lettres) → y ajouter `crx:` à `img-src`.
- **Popups d'extension** : la lib crée sa **propre fenêtre enfant frameless** (`PopupView`,
  auto-dimensionnée, fermée au blur), ancrée sur le rect du bouton envoyé par la chrome. C'est
  exactement la parade du piège n°3 de `CLAUDE.md` (fenêtre native au-dessus du contenu web),
  déjà éprouvée par notre tooltip → rien à inventer.
- **État** : la chrome ne stocke rien (principe existant). Si on fait notre propre UI plus tard,
  push `mira:extensions-changed` + seed par `list-extensions`, comme les tabs.

### 4.5 Web Store, stockage & ordre de boot

`installChromeWebStore({ session, extensionsPath, minimumManifestVersion, beforeInstall, autoUpdate })`
par session de profil. Extensions stockées **par profil**
(`extensionsPath: userData/Extensions/<profileId>/` — D2 ; disque dupliqué si deux profils
installent la même extension, assumé), chargées dans la session du profil à l'ouverture de sa
fenêtre (`loadAllExtensions`). `minimumManifestVersion` reste au défaut du paquet (3) — D3 a
renoncé à uBlock/MV2, pas besoin d'abaisser le plancher (le sideload unpacked d'une MV2 via
`load-extension` reste techniquement possible si un jour utile).
`beforeInstall` → dialog natif de confirmation.

**Ordre de boot obligatoire** : `await loadAllExtensions(session)` **avant** `restoreSession`
de la fenêtre. Sinon un onglet persisté sur une page `chrome-extension://` (dashboard uBlock…)
se restaure avant l'enregistrement de l'extension → ERR_FAILED au relaunch. Cas de validation
explicite en E5 : quit avec un onglet extension actif, relaunch.

## 5. Incréments (une feature = un test, chacun livrable seul)

- **E0 — Registre async.** Périmètre exact au §4.3 (type élargi, socket async + catch des
  rejections, édition de `socket.test.ts`, `.catch` des accélérateurs menu). Tests : commande
  async happy path + rejection → `{ok:false}` via le registre et via `handleRequestLine`.
- **E1 — Chargement + domaine `extensions`.** Deps npm, `ExtensionsService` (map keyée par
  `Session`, §4.1), câblage des choke points **dont le hook d'activation unique**,
  `load-extension`/`list-extensions`/`uninstall-extension` (multi-session, §4.2),
  `chrome-extension://` dans `normalizeInput` + test, chargement au boot ordonné (§4.5).
  Tests : domaine via registre + faux contexte (liste, params invalides, isolation
  install/uninstall entre profils, uninstall inconnu → `{ok:false}`) ; helpers purs
  (normalisation `ExtensionInfo`).
  Validation en app : Dark Reader unpacked assombrit une page.
- **E2 — Validation d'extensions réelles (MV3).** Installer et valider en vrai un petit set
  représentatif : Dark Reader (content scripts + action), un clipper (Obsidian Web Clipper),
  un password manager (1Password — le cas 🔶 du §1 : SW MV3, remplissage, popup OAuth via D5).
  Consigner ici ce qui marche/casse — c'est le vrai test de la promesse « compat large »
  depuis que D3 a sorti uBlock du périmètre.
- **E3 — Actions toolbar + popups.** `injectBrowserAction` (preload), `<browser-action-list
  partition=…>` (feature component, §4.4), `handleCRXProtocol`, CSP `crx:` dans `index.html`.
  Validation : popup uBlock/Dark Reader ancré au bouton, **dans une fenêtre de profil non-défaut**
  (le bug de binding de session est silencieux — c'est LE cas à tester).
- **E4 — Menu contextuel.** `webContents.on('context-menu')` sur les vues d'onglets →
  `buildChromeContextMenu` + `extensions.getContextMenuItems(wc, params)`. Bonus : Mira gagne
  un vrai clic-droit parité Chrome (il n'y en a aucun aujourd'hui). Wiring dans
  `materializeTab`, à côté de `wireView`.
- **E5 — Web Store.** `installChromeWebStore` par session, `install-extension {id}` +
  `update-extensions` au registre, `beforeInstall` confirm. Validation : naviguer
  chromewebstore.google.com dans Mira, installer d'un clic, puis quit/relaunch avec un onglet
  `chrome-extension://` actif (§4.5).
- **E6 — Gestion + packaging.** Surface Settings (liste + uninstall, par profil — D2),
  events `mira:extensions-changed`, déchargement à la fermeture de fenêtre
  si la RAM des sessions chaudes pèse (§4.1), vérif du preload lib dans le build packagé
  (`build:mac`). Tests : logique d'état per-profil pure.

Ordre : E0 → E1 → E2 valident le cœur de la promesse (des extensions réelles tournent) avant
tout investissement UI. Si E2 casse, on le sait au plus tôt.

## 6. Risques connus (sourcés)

- **`chrome.commands` stubbed** (raccourcis clavier d'extensions inertes) ; `chrome.tabs.move/duplicate/captureVisibleTab` ❌ — table du README lib.
- **Cmd+S = Discard Tab chez nous** (`menu.ts`) : dans toute page où Cmd+S veut dire
  « sauvegarder » (Google Docs, éditeurs d'options d'extensions…), l'accélérateur menu gagne :
  onglet discardé, éditions perdues. Préexistant, mais les pages d'extension le rendent plus
  saillant. À déplacer (Cmd+Shift+S ?) avant E2.
- **Shim `storage.managed`/`sync` → `local`** (la lib redirige tout vers `local`) : une
  extension qui écrit beaucoup via ces APIs peut faire gonfler `Local Extension Settings`
  (cas extrême rapporté : [electron-browser-shell#158](https://github.com/samuelmaddock/electron-browser-shell/issues/158)). À surveiller (taille du userData).
- **Electron 41 non testé par la lib** (dev sur 37, minimum 35, pas de borne haute). La lib suit
  Electron de près mais peut casser à une montée de version (précédent : #172 sur Electron 40).
- **Licence GPL-3.0 vérifiée à l'exécution** avec blocklist sha256 de projets non conformes
  (`src/browser/license.ts` de la lib). Pas un risque si D1 assumée, mais à savoir.
- **Packaging du preload lib** — à valider en E6 (précédent : on a déjà un patch figé
  electron-builder, cf. CLAUDE.md Notes).

## 7. Décisions (toutes tranchées avec Mickael, 2026-07-10)

- **D1 — Licence.** `license: 'GPL-3.0'` : gratuit, impose de fournir les sources **si on
  distribue** Mira (repo privé interne = pas un problème aujourd'hui). Alternative :
  sponsor GitHub → licence Patron. **Reco : GPL-3.0. [TRANCHÉ 2026-07-10 : GPL-3.0 — pas de
  distribution prévue.]**
- **D2 — Extensions globales ou par profil ?** **[TRANCHÉ 2026-07-10 : PAR PROFIL** — « on
  sépare toujours les profils ». Supersede la reco « set global » ; répercuté en §3.2, §4.2,
  §4.5, E1, E6.]
- **D3 — Autoriser MV2 (`minimumManifestVersion: 2`) ?** C'était la condition du ad-blocking
  par extension (uBlock full). **[TRANCHÉ 2026-07-10 : NON** — « je m'en fous d'uBlock ».
  Conséquence assumée : **pas de blocage de pub par extension** dans Mira (aucun bloqueur MV3
  ne peut bloquer sous Electron). Porte laissée ouverte : bloqueur intégré côté Mira via
  `session.webRequest`, devenu possible grâce à ce renoncement (§3.1).]
- **D4 — Chrome UI sur la session par défaut** (risque content-scripts en dev, §3.2).
  **Reco : accepter**, revisiter si un content script pollue la chrome en dev.
  **[TRANCHÉ 2026-07-10 : accepter.]**
- **D5 — `window.open` : router vers un onglet.** Aujourd'hui deny-all → navigateur externe
  (§3.3). Pour un navigateur, le comportement attendu est : `_blank`/`window.open` http(s) et
  `chrome-extension://` de la même session → **nouvel onglet Mira** (`newTabIn`). Ça change un
  comportement existant (liens qui partaient dans le navigateur système) et conditionne les
  popups OAuth des password managers. **Reco : router vers un onglet, dès E1.
  [TRANCHÉ 2026-07-10 : router vers un onglet.]**

## 8. E7 — Kondo ne tourne pas + combler les API `chrome.*` manquantes (2026-07-11)

**✅ RÉSOLU le 2026-07-11 soir — voir §8.12 (la résolution complète, section autonome).**
§8.11 = le récapitulatif de l'investigation (cause racine, théories réfutées, options envisagées) ;
§8.1–8.10 = le journal chronologique conservé comme trace, avec des états intermédiaires ensuite
corrigés (ex. §8.8 « ça converge » = FAUX, cf. §8.11-D) — s'y fier UNIQUEMENT via §8.11/§8.12.

### 8.1 Le symptôme

Kondo (`kojhnafkiednagnljfgakalcbfbklbdk`, v1.12.1) charge dans Mira mais affiche en boucle
un dialog « Browser extension stopped / Toggle it off and back on » → reload → re-boucle.
Kondo = **deux morceaux couplés** : une **extension** (injecte dans LinkedIn) + une **web app**
`app.trykondo.com`. Le dialog vient de la web app qui n'arrive plus à parler à l'extension.

### 8.2 Faits VÉRIFIÉS (avec preuve)

1. **Le content script s'injecte bien.** Marqueur `<div id="kondo-ext" version=1.12.1 key=<id>>`
   présent dans `app.trykondo.com` (sondé via `exec-js` avec `tabId`). Écarte « onglet neuf requis »
   et « injection absente ».
2. **Le mécanisme de la boucle** (lu dans `assets/content-DQEAdWiS.js`, désobfusqué) : le content
   script crée un `<div id=kondo-ext>` (shadow root fermé) contenant un **iframe caché** →
   `chrome-extension://<id>/ext.html?session=X` ; puis ouvre un **Port longue-durée**
   `chrome.runtime.connect({name:'kondo-content'})` vers le SW ; son `.onDisconnect` fait
   `location.reload()`. La web app relaie via l'iframe/postMessage et, faute de réponse du SW,
   loggue `Error: Extension bridge timeout | PopupConnectError` (répété ~toutes les 30 s).
3. **La permission `declarativeNetRequestWithHostAccess` provoque un échec de binding natif FATAL.**
   Le log Chromium sort `ERROR native_extension_bindings_system.cc:767] Failed to create API on
   Chrome object` dans un **process dédié qui ne loggue QUE ça** (contexte mort à la création des
   bindings, avant tout JS). **PREUVE** : après avoir retiré `declarativeNetRequestWithHostAccess`
   + le bloc `declarative_net_request` du `manifest.json` et redémarré, cette erreur **DISPARAÎT**
   du log, et `list-extensions` renvoie `gaps: []` (l'edit a bien chargé). Electron ne compile pas
   `declarativeNetRequest` → déclarer la permission suffit à faire planter la création du namespace.
   C'est **la même erreur** qui a précédé le SIGSEGV de l'onboarding Otto (track.md).
4. **MAIS retirer DNR ne suffit PAS : la boucle persiste.** Sans la permission DNR, le SW Kondo ne
   produit **aucune ligne de log** et `Extension bridge timeout` continue. Le blocage restant =
   le **pont content-script ↔ service worker** (`chrome.runtime.connect`) qui ne s'établit pas.
5. **Les consoles de SW d'extension SONT capturées** dans le log de Mira (Dark Reader loggue
   « Welcome to Dark Reader! » depuis `chrome-extension://…/background/index.js`). Donc l'**absence**
   totale de log du SW Kondo est significative : son SW **n'exécute aucun JS** (pas démarré, ou meurt
   avant la console). Dark Reader (pas de DNR) tourne, Kondo non.
6. **Le service-worker preload de Mira ne s'exécute PAS.** Le diagnostic `[mira-sw]` injecté dans
   `ALARMS_POLYFILL_SOURCE` n'apparaît **nulle part** dans le log — même pas dans le SW de Dark
   Reader qui, lui, tourne. Donc `ses.registerPreloadScript({type:'service-worker'})` n'injecte pas
   dans les SW d'extension chez nous → **Tier A est inopérant tel quel** (voir §8.5 pour la piste).
   Réf : la lib injecte SON preload via le même mécanisme et le garde
   (`node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js:594`,
   `process.type === "service-worker" || location.href.startsWith("chrome-extension://")`).

### 8.3 Théories RÉFUTÉES (ne pas les reprendre)

- **« `chrome.alarms` manquant → le SW throw » : FAUX.** Le SW de Kondo appelle bien `chrome.alarms`
  5× (grep dans `background-vYAqPXIO.js`) et alarms n'est fourni ni par la lib ni par Electron.
  MAIS le process qui meurt ne loggue **aucun** throw JS (il meurt à la création des bindings
  natifs, pas au runtime JS) ; et un throw sur `chrome.alarms` apparaîtrait dans le log comme les
  throws de Dark Reader. Le déclencheur du `Failed to create API` est **DNR** (prouvé §8.2.3), pas
  alarms. Un shim JS ne peut rien contre un échec de binding natif.
- **« onglet neuf requis » / « injection absente » : FAUX** (§8.2.1).
- **« retirer DNR répare Kondo » : FAUX** (§8.2.4 — supprime le crash de binding mais pas la boucle).

### 8.4 État du code (ce qui existe, ce qui marche)

Fichiers touchés/créés (branche master, non commités) :

- **`src/main/extension-capabilities.ts`** (NOUVEAU, pur, **21 tests verts** dans
  `extension-capabilities.test.ts`) :
  - `translateDnrRules` / `dnrUrlFilterToRegExp` / `dnrMatches` — DNR → plan `webRequest`.
  - `detectCapabilityGaps` / `PROVIDED_APIS` / `KNOWN_LIMITATIONS` — Tier C.
  - `ALARMS_POLYFILL_SOURCE` / `alarmDelayMs` / `alarmPeriodMs` — Tier A (inopérant, §8.2.6).
  - **⚠️ contient un DIAGNOSTIC TEMPORAIRE `[mira-sw]`** (console.log + error listeners) dans
    `ALARMS_POLYFILL_SOURCE` — **à retirer**.
- **`src/main/extensions.ts`** (native, édité) : `registerAlarmsShim` (SW preload — inopérant),
  `applyDnr` → `session.webRequest` (Tier B, appelé à chaque load/enable/update/uninstall),
  `readManifest`/`readDnrRules`/`gapsFor`/`withGaps`. Helpers module `isDnrBlocked`/`pickDnrRedirect`/
  `applyRequestHeaderMods`/`applyResponseHeaderMods`. (NB : ce fichier est aussi édité par d'autres
  sessions — vérifier `git diff` avant de rééditer.)
- **`src/main/commands/extensions.ts`** : champ `gaps?: CapabilityGap[]` ajouté à `ExtensionInfo`.

Statut par tier :

- **Tier C (gaps) — MARCHE EN VRAI.** `list-extensions` renvoie les `gaps` de Kondo
  (`declarativeNetRequest*` degraded). C'est l'outil qui aurait dû guider dès le début.
- **Tier B (DNR→webRequest) — CODÉ, NON VALIDÉ EN VRAI.** Logique pure testée ; le câblage
  `session.webRequest` n'a pas pu être exercé (Kondo ne charge pas). Sain sur le papier.
- **Tier A (shim alarms) — INOPÉRANT** (le SW preload ne s'exécute pas) **ET probablement inutile**
  (alarms n'était pas la cause). Décision en attente : réparer l'injection ou retirer.

### 8.5 Prochaines étapes OUVERTES (pour la session fraîche)

1. **Tier 0 en priorité (peu coûteux, peut tout débloquer)** : tester une version plus récente
   d'`electron-chrome-extensions` (actuel **4.9.0**). Le blocage restant est le pont
   `chrome.runtime.connect` content-script ↔ SW MV3 (réveil + Port longue-durée). Chercher dans les
   issues upstream (samuelmaddock/electron-browser-shell) « service worker », « runtime.connect »,
   « port », « MV3 ». Réf existante §1 : electron#52265 (chrome.webRequest indispo dans SW MV3, ouvert).
2. **Nommer l'API fautive à coup sûr** (au lieu d'inférer) : relancer avec le logging Chromium
   verbeux — `app.commandLine.appendSwitch('vmodule','native_extension_bindings_system=2')` (avant
   `app.ready`, dans `index.ts`) → le log nommera l'API que `CreateAPIBinding` n'arrive pas à créer.
   Attendu : ça confirme `declarativeNetRequest`.
3. **Fix propre du crash DNR (vrai bug général, pas fait)** : au **load**, retirer la permission
   `declarativeNetRequest*` du manifest (le SW ne meurt plus) MAIS garder le bloc
   `declarative_net_request` (ou lire le ruleset avant) pour que **Tier B** applique les règles via
   `webRequest`. Ça rendrait viable TOUTE extension DNR — Kondo garde en plus le blocage pont (#1).
   Implique de patcher le manifest sur disque au load (écrasé aux updates → réappliquer), ou charger
   une copie patchée.
4. **Trancher Tier A** : soit comprendre pourquoi `registerPreloadScript({type:'service-worker'})`
   n'injecte pas (ordre ? la lib écrase ? SW d'extension exclus ?), soit **retirer Tier A** (+ le
   diagnostic `[mira-sw]`) comme code mort.
5. **Retirer le diagnostic temporaire `[mira-sw]`** de `ALARMS_POLYFILL_SOURCE` dans tous les cas.

### 8.6 Boîte à outils de debug (comment reprendre — LIRE EN PREMIER)

- **Mira tourne en `npm run dev`** (process long-running — NE PAS lancer/tuer sans accord de Mickael ;
  une modif du main relance le main automatiquement). Socket de contrôle : `/tmp/mira.sock`,
  une requête JSON par ligne : `printf '%s\n' '{"command":"...","params":{...}}' | nc -U /tmp/mira.sock`.
- **`exec-js` PREND UN `tabId`** (`src/main/commands/devtools.ts`) — **TOUJOURS le passer** pour viser
  un onglet précis par UUID (récupéré via `list-tabs`). Sans `tabId`, il tape l'onglet actif de la
  fenêtre au premier plan → fragile, source de tout mon thrash. `list-commands` liste les 76 commandes.
- **Ouvrir une page `chrome-extension://…` comme onglet ÉCHOUE** (la `WebContentsView` ne se
  matérialise pas : « reading 'session' ») — bug à part, ne pas compter dessus pour sonder le contexte
  extension.
- **Logs** : `~/Library/Application Support/Mira/logs/chromium-<ts>.log` (rotatif, 10 gardés ;
  `main-<ts>.log` pour le main). **Les consoles de SW/content d'extension y remontent** (source
  `chrome-extension://…`). Grep utiles : `bridge timeout`, `Failed to create API`, `[mira-sw]`,
  `kojhnaf`, `getExtensionStatus`.
- **Internals de Kondo sur disque** : `~/Library/Application Support/Mira/Extensions/default/kojhnafkiednagnljfgakalcbfbklbdk/1.12.1_0/` —
  `manifest.json` (permissions + `declarative_net_request` → `ruleset.json`) ;
  `assets/content-loader.js` → `content-DQEAdWiS.js` (LE PONT : iframe `ext.html` + `runtime.connect`) ;
  `service-worker-loader.js` → `background-vYAqPXIO.js` (le SW ; usage : `alarms` 5×, `cookies` 12×,
  `notifications` 10×, `storage` 15×, `contextMenus` 4×, **`declarativeNetRequest` 0×**) ;
  `ruleset.json` (un `modifyHeaders` qui retire `Origin` sur `https://www.linkedin.com/*` XHR — le
  contournement CORS de Kondo pour lire LinkedIn).
- **Expérience manifest (réversible)** : back up `manifest.json` → retirer
  `declarativeNetRequestWithHostAccess` + le bloc `declarative_net_request` → restart dev → l'erreur
  `Failed to create API` disparaît (mais la boucle persiste). Restaurer depuis le backup après.
- **Vérité terrain manquante** : la cause exacte de la non-réponse du SW. Faute d'avoir pu exécuter du
  JS dans le SW (mon preload n'injecte pas) ni ouvrir une page d'extension, il reste à obtenir soit le
  DevTools du SW, soit le log verbeux (§8.5.2).

### 8.7 Session 2026-07-11 après-midi — CAUSE RACINE TROUVÉE, fixes codés, à valider

**⚠️ Cette section SUPERSEDE §8.2.4/8.2.5/8.2.6, §8.3 (partiellement) et §8.5.** Trois causes
empilées, toutes prouvées, trois fixes codés (tests verts, typecheck OK) — **pas encore validés
en vrai** (il faut un restart de `npm run dev`).

#### Les trois causes (chaîne complète du « Browser extension stopped »)

1. **Permission DNR → crash des bindings natifs** (déjà prouvé §8.2.3, inchangé). Déclarer
   `declarativeNetRequestWithHostAccess` suffit à tuer le SW avant tout JS.
2. **`chrome.alarms` n'existe pas → throw top-level à la FIN du module SW.** La doc officielle
   Electron 41 (`docs/api/extensions.md`, branche 41-x-y) liste les API supportées : alarms n'y est
   PAS (runtime.connect/onConnect y sont). Le tail du bundle SW de Kondo est
   `…onConnect.addListener(f), onInstalled.addListener(fe), onStartup.addListener(_), _(), …(W), W(), …(X), X()`
   et `X()` fait `chrome.alarms.onAlarm.removeListener(Z)` → TypeError. onConnect est enregistré
   AVANT le throw, mais une éval de module SW en échec marque le worker cassé côté Chromium.
   **Correction de §8.3** : « alarms est la cause » avait été réfuté à tort — l'argument « le throw
   apparaîtrait dans le log » ne tient pas (la console d'un SW dont l'éval échoue n'est pas capturée),
   et « le SW ne produit aucun log » (§8.2.5) était un artefact : le SW de Kondo n'a qu'UN console.*
   dans tout son code. **Preuve qu'il tourne** : à l'enable (12:47:59), les logs debug du preload de
   la lib (`contextMenus.create` ×2, lignes :49/:67 du preload) sont apparus — le SW exécute du JS
   sans DNR. §8.2.4 (« SW muet sans DNR ») est donc FAUX.
3. **Electron 41 ne (re)démarre jamais le SW d'une extension au-delà du premier lancement, et
   `chrome.runtime.connect` ne réveille PAS un worker arrêté.** C'est **electron#41613**, fixé sur
   main (mergé 2026-04-02, PR #50611) et backporté en **42.x** (#50640) ; le backport 41-x-y
   (#50641) a été **abandonné** (« workaround exists »). Mécanisme du fix : Electron remet
   `kPrefHasStartedServiceWorker=false` à chaque load pour re-déclencher la logique fresh-install de
   Chromium. **Preuves locales** : (a) reload de l'onglet Kondo à 12:55:59 → bannière web app à
   12:56:00 → `Extension bridge timeout` à 12:56:02, alors que le SW était mort ; (b) `ps` : AUCUN
   process Mira avec `--extension-process` (le SW n'a pas été réveillé par le connect) ; (c) la
   registration SW de Kondo existe bien dans la LevelDB `Service Worker/Database` (l'enregistrement
   n'est pas le problème, le démarrage l'est). **Workaround officiel** (issue #41613, commentaire
   2644018998) : `session.serviceWorkers.startWorkerForScope(extension.url)` après le load.

#### Corrections d'observations antérieures

- **§8.2.6 (« le SW preload ne s'exécute pas ») : FAUX, mal lu.** Dans le shim de l'époque, le guard
  `if (!g.chrome || !g.chrome.runtime) return;` était placé AVANT le diagnostic `[mira-sw]`. Or un
  preload SW tourne dans le **monde isolé** (context isolation) où `globalThis.chrome` n'existe pas →
  le guard sortait avant de logger. Le preload de la lib, lui, marche parce qu'il passe par
  `contextBridge.executeInMainWorld` (cf. `chrome-extension-api.preload.js`) — et il termine par
  **`Object.freeze(chrome)`** dans le monde principal : tout shim qui s'exécute APRÈS lui ne peut
  plus rien ajouter à `chrome` (assignation silencieusement ignorée).
- **Tier 0 (lib plus récente) : voie morte.** 4.9.0 = dernière version npm ET dernier commit du repo
  upstream (2025-07-02, HEAD = release 4.9.0). Rien à récupérer.
- Le diagnostic `[mira-sw]` a été retiré de `ALARMS_POLYFILL_SOURCE` (§8.5.5 fait).

#### Les trois fixes codés (non commités, non validés en vrai)

1. **Strip DNR au load** (`extensions.ts`) : `sanitizeExtensionDir` (backup du manifest original en
   `manifest.mira-original.json` + réécriture sans `declarativeNetRequest*` ni bloc
   `declarative_net_request`), appelé sur TOUS les chemins de chargement (`sanitizeStoreDir` avant
   `installChromeWebStore`, sideloads, `load`, `enable`, post-`installFromStore` avec reload,
   post-`update` avec reload). `readManifest` préfère le backup → Tier B (webRequest) et Tier C
   (gaps) lisent toujours le manifest ORIGINAL. Logique pure : `stripUnsupportedPermissions`
   (`extension-capabilities.ts`, testée).
2. **Shim alarms v2** (`extension-capabilities.ts`) : découpé en `ALARMS_POLYFILL_MAIN_WORLD`
   (fonction autonome, testée) + wrapper `ALARMS_POLYFILL_SOURCE` qui gate sur
   `process.type === 'service-worker'` et injecte via `contextBridge.executeInMainWorld`. Enregistré
   **AVANT** la construction d'`ElectronChromeExtensions` (ordre d'exécution des preloads =
   ordre d'enregistrement) pour précéder le `Object.freeze(chrome)` de la lib.
3. **Launch + keepalive des SW d'extension** (`extensions.ts`) : `launchWorkers` (le workaround
   officiel — `startWorkerForScope` pour toute extension MV3 à SW, sur tous les chemins de load) +
   `hookWorkerKeepalive` (map versionId→scope sur `running-status-changed` ; sur `stopped`, restart
   si l'extension est toujours chargée, throttlé par `recordWorkerRestart` — pure, testée : max 5
   restarts/60 s pour ne pas boucler sur un SW qui crash à l'éval). Effet : les SW d'extension
   restent résidents (coût RAM accepté, navigateur perso).

État des tests : `npm run typecheck` OK, 557 tests verts (46 fichiers). Manifest de Kondo sur disque
**restauré à l'original** (le pipeline de strip le reprendra proprement au boot). Instrumentation
temporaire encore en place pour la validation : `sw-debug.ts` (+ appel dans `ensureFor`) et le switch
`vmodule` dans `index.ts` — **à retirer après validation**.

#### Validation (bloquée sur un restart de `npm run dev` — accord Mickael requis)

`electron-vite dev` sans `-w` ne watche PAS le main (vérifié dans le CLI installé : l'option watch
existe mais n'est pas passée) — la note §8.6 « une modif du main relance le main » était fausse.
Après restart, vérifier dans `main-<ts>.log` : (1) `[mira] stripped unsupported permissions from …`
(strip au boot) ; (2) `[sw-debug] … probe OK kojhnaf…` (le SW démarre) ; (3) `[sw-debug] … status …
running` puis cycles stop/restart ; (4) plus AUCUN `Failed to create API` dans `chromium-<ts>.log` ;
(5) onglet app.trykondo.com : plus de `Extension bridge timeout` après la bannière de boot, plus de
dialog « Browser extension stopped ». Puis retirer sw-debug + vmodule.

#### Bugs annexes

- **`exec-js` pend sur TOUS les onglets — CAUSE TROUVÉE + FIX CODÉ (à valider au prochain restart).**
  `webContents.executeJavaScript` ne se résout JAMAIS quand un debugger CDP est attaché au même
  target — et `stealth.ts` en attache un sur CHAQUE content view (`wc.debugger.attach('1.3')` pour
  `Page.addScriptToEvaluateOnNewDocument`). Les deux partagent le transport DevTools. **Pas une
  régression E7** : le call `view.webContents.executeJavaScript(code, true)` est identique dans le
  build committé (`git show HEAD:…profiles.ts`), donc exec-js n'a jamais rendu de valeur dans cet
  environnement (la note §8.6 « exec-js marche » était sur-affirmée : jamais vérifiée sur une vraie
  valeur de retour). Preuve du hang : réponse socket vide (len=0 ⇒ aucun write ⇒ promesse jamais
  settled) ; stealth ne le voyait pas car il fait `.catch(()=>{})` sur ses `executeJavaScript` de
  réassert (le vrai boulot passe par CDP `addScriptToEvaluateOnNewDocument`). **Fix** : nouveau
  `src/main/cdp-eval.ts` — `evalInWebContents(wc, code)` route par `wc.debugger.sendCommand(
  'Runtime.evaluate', {returnByValue, awaitPromise, userGesture, replMode})` quand un debugger est
  attaché, sinon fallback `executeJavaScript` ; logique pure `interpretRuntimeEvaluate` (7 tests).
  `execJsInTab` (profiles.ts, 2 call-sites) l'appelle. Sûr même si l'hypothèse est partielle :
  Runtime.evaluate marche aussi quand executeJavaScript marche. **À VALIDER** au restart : `exec-js`
  doit renvoyer une valeur (`document.title`, etc.). Même cause latente non corrigée : l'extraction
  de skill (`profiles.ts` ~2365, `executeJavaScript(extractionScript…)`) — à migrer sur
  `evalInWebContents` si run-skill pend.
- **`Electron sandboxed_renderer.bundle.js script failed to run` + `TypeError: object null is not
  iterable`** : **PAS notre bug, upstream, bénin.** Apparaît uniquement une fois des extensions
  chargées (0 occurrence dans le run 23:56 avant install Kondo), sur des pages QUI ONT LEUR PROPRE
  service worker (trykondo/sw.js, DocuSign, Framer, Google Messages, Amazon). Cause : dès qu'une
  extension est active, `electron-chrome-extensions` enregistre un preload `type:'service-worker'`
  (`crx-mv3-preload`) qui s'applique à TOUS les SW de la session, y compris ceux des pages web ; sous
  `--enable-sandbox`, le bootstrap `sandbox_bundle` d'un tel contexte itère une liste de preload
  null-ish et throw. Indépendant de notre shim alarms (l'erreur préexistait à sa v2). Les pages
  restent fonctionnelles (le log Chromium le dit lui-même : « recoverable / site still functional »).
  Pas de correctif côté Mira sans patcher Electron/la lib (l'API `registerPreloadScript` n'a pas de
  filtre par scope). Ticket historique du symptôme : electron#32133. À laisser tel quel.
- Détail utile : `list-extensions` (socket) vise le profil de la FENÊTRE FOCUS — une liste vide peut
  juste vouloir dire « mauvaise fenêtre » (passer par `open-profile` d'abord).

### 8.8 Session 2026-07-11 fin d'aprem — Kondo semble CONVERGER, exec-js reste le blocage

**Journal en cours, à compléter.** Deux builds redémarrés par Mickael cet aprem (14:57, puis 15:26
avec le fix exec-js CDP). Faits nouveaux VÉRIFIÉS (logs lus) :

- **Kondo ne boucle plus — il converge.** Build 15:26 (`chromium-2026-07-11T15-26-22.log`) : la web
  app a rechargé **exactement 3 fois** au boot (bannières `build.260710` à 15:26:23 / 15:26:36 /
  15:26:47, chacune suivie ~3 s après d'un `Extension bridge timeout` à 15:26:26 / 15:26:39 /
  15:26:50) **puis PLUS RIEN pendant 6+ min**. Le SW Kondo (versionId=26) atteint `running` à
  15:26:22 et `probe OK` à 15:26:30, sans aucune transition stop/start ensuite. **Lecture** : les 3
  reloads = la course au démarrage (le content script tente `connect` avant que le SW soit chaud) ;
  une fois le SW stable (maintenu par le keepalive), le pont s'établit et Kondo cesse de recharger.
  **À confirmer visuellement** (le dialog « stopped » a-t-il disparu de l'écran ?) — bloqué par
  exec-js.
- **exec-js reste cassé même via CDP.** Le fix `cdp-eval.ts` (route par `Runtime.evaluate` du
  debugger attaché, sinon `executeJavaScript`) est **bien dans le build tournant** (vérifié :
  `out/main/index.js` contient `evalInWebContents`/`Runtime.evaluate`, mtime 15:26:22), et pourtant
  `exec-js` renvoie toujours une réponse socket VIDE (0 octet ⇒ jamais de write ⇒ promesse jamais
  settled), sur tous les onglets, y compris l'onglet actif et example.com. `get-status` répond ⇒
  socket sain. Donc **les DEUX chemins (executeJavaScript ET Runtime.evaluate) ne se résolvent
  jamais** — c'est plus profond que « le debugger bloque executeJavaScript ».
- **Nouvelle hypothèse exec-js (renderer gelé)** : les onglets inactifs sont `view.setVisible(false)`
  (dans `layout()` de `profiles.ts`) et `backgroundThrottling` n'est configuré NULLE PART (`grep`
  vide) ⇒ défaut `true`. Un `WebContentsView` caché + fenêtre Mira non-foreground (le terminal a le
  focus quand je pilote par socket) ⇒ Chromium peut occlure/geler le renderer, et un renderer gelé
  fait pendre aussi bien `executeJavaScript` que `Runtime.evaluate`. À tester : exec-js sur l'onglet
  ACTIF avec la fenêtre Mira AU PREMIER PLAN, et/ou poser `backgroundThrottling:false` sur les
  content views (`materializeTab()` de `profiles.ts`). NB : `exec-js` n'est **pas** une régression
  E7 — le call
  `view.webContents.executeJavaScript(code, true)` est identique dans le build committé
  (`git show HEAD:…profiles.ts`), donc il n'a jamais rendu de valeur dans cet environnement.
- **Instrumentation prête (non chargée)** : `cdp-eval.ts` a été enrichi d'un `withTimeout` (5 s, plus
  aucun hang possible) + logs `[cdp-eval]` par chemin (attached? cdp OK/FAILED, execJS OK/FAILED).
  Le prochain restart dira EXACTEMENT quel chemin échoue et pourquoi.
- **Investigation multi-agents lancée** (workflow `kondo-execjs-rootcause`) : 5 investigateurs
  parallèles sur (1) exec-js, (2) le pont Kondo iframe `ext.html`/Port, (3) le routage de Port de la
  lib, (4) le keepalive SW, (5) la timeline des logs ; puis vérification adversariale + synthèse.
  Résultats à reporter ici.
- **Piste pont sous-explorée** : le pont Kondo n'est PAS que `runtime.connect`. Le content script
  crée une **iframe cachée** `chrome-extension://<id>/ext.html?session=X` (dans un shadow root fermé)
  et relaie via `postMessage`/`MessagePort`. Un build antérieur (14:57) montrait
  `ext.html … ERR_BLOCKED_BY_CLIENT` (le framing d'une page d'extension par une page web exige
  `web_accessible_resources` + qu'Electron l'honore pour les SOUS-FRAMES). Le build 15:26 n'a PLUS ce
  blocage (0 occurrence) — à corréler avec la convergence. Vérifier si l'iframe charge bien.

### 8.9 Session 2026-07-11 soir — DEUX fausses croyances démolies, bug Kondo isolé au pont iframe imbriquée

**Percée majeure via investigation multi-agents (workflow `kondo-execjs-rootcause`) + tests live.**
Deux corrections d'honnêteté d'abord :

1. **exec-js n'a JAMAIS été cassé — c'était le client `nc`.** `nc -U` de macOS ne lit pas la réponse
   du socket unix (il ferme après le `printf`/EOF). Un client **socket Python brut** obtient les
   réponses parfaitement : `exec-js {code:'1+1'}` → `{"ok":true,"result":2}` en 0,00 s ; lectures DOM
   OK. **Tout le récit « exec-js pend, il faut CDP »** de §8.7/§8.8 reposait sur un outil de test
   défaillant. La note historique « exec-js marche, passe un tabId » était JUSTE ; j'avais tort d'en
   douter. Le fix `cdp-eval.ts` (route par Runtime.evaluate) n'était donc pas nécessaire pour un bug,
   mais il est en place et marche (à garder ou simplifier ; c'est du durcissement, pas un fix). Outil
   de pilotage désormais : helper Python `scratchpad/mira.py` (`call`/`execjs`), PAS `nc`.
   Nuance vérifiée : exec-js n'attend PAS les promesses dans le build tournant (`Promise.resolve(42)`
   → `{}`) — contourner par le pattern « lance l'async, stocke dans `window.__x`, relis en sync ».

2. **Kondo est TOUJOURS cassé — mon « ça converge après 3 reloads » de §8.8 était FAUX.** Sonde DOM
   directe de `app.trykondo.com` : `stoppedDialog: true`, texte « Browser extension stopped / Toggle
   it off and back on ». Le SW-start-race était réfuté par le workflow (le SW extension était debout
   tout du long) ; les 3 reloads puis silence = la web app a épuisé son budget de retries, PAS une
   connexion réussie.

**Le pont Kondo (mécanisme exact, lu dans le code) :** relais à **4 sauts** avec transfert de
MessagePort — web app → (window.postMessage) content script → (iframe.contentWindow.postMessage)
**iframe cachée `ext.html`** (chrome-extension://, dans un shadow root fermé) → (navigator.
serviceWorker) **SW extension**. Le SW (`de` dans `background-vYAqPXIO.js`) répond
`{source:'kondo-worker', status:'connected'}` sur le port ; `ext.html` (`settings.js`) fait
`(await navigator.serviceWorker.ready).active.postMessage({source:'kondo-iframe'}, [...ports])`.

**Ce qui MARCHE (prouvé en live, chaque brique en isolation) :**
- Content script injecté (marqueur `#kondo-ext` v1.12.1 présent).
- `ext.html` charge maintenant en onglet ET en iframe (plus de `ERR_BLOCKED_BY_CLIENT`).
- Dans un **onglet top-level** `chrome-extension://…/ext.html` : `navigator.serviceWorker.controller`
  = le SW extension, `getRegistrations()` = 1 (scope extension, state **activated**),
  `navigator.serviceWorker.ready` **résout**. → réfute l'hypothèse « navigator.serviceWorker
  indispo dans une page d'extension ».
- Le handshake complet `ext.html(top-level) → active.postMessage(port) → SW de() → reply` :
  **`gotReply:true`, reply `{status:'connected'}`**. Donc SW sain, `de` marche, alarms shim marche
  (le SW ne throw pas au top-level → `chrome.alarms` existe bien = **fix alarms validé**).
- `chrome.runtime.connect({name:'kondo-content'})` depuis une page extension : port **reste
  connecté** (pas de disconnect) → messaging natif runtime OK.

**Ce qui CASSE (reproduit en live, robuste sur 8 retries) :** rejouer le rôle de la web app DEPUIS
`app.trykondo.com` — créer une **iframe `ext.html` imbriquée** (chrome-extension:// dans la page
https), poster `session` + MessagePort → **AUCUNE réponse du SW** (`gotReply` absent). Même
handshake, seule différence = **l'iframe est imbriquée dans une page https** au lieu d'un onglet
top-level. **Donc le blocage est la frontière `chrome-extension://` imbriquée dans une page web** :
soit le MessagePort ne traverse pas `iframe.contentWindow.postMessage` vers l'iframe extension, soit
`navigator.serviceWorker` ne pointe pas vers le SW extension dans une iframe imbriquée (peut-être
scopé à tort sur l'origine top-level trykondo, ou SW désactivé en contexte « third-party »).

**Étape décisive en cours** : logger `[mira-sw-msg]` ajouté dans le SW via le preload alarms
(`ALARMS_POLYFILL_MAIN_WORLD`, `extension-capabilities.ts`) pour voir si le message
`source:'kondo-iframe'` **atteint le SW** dans le cas imbriqué. Verdict attendu :
- message N'ATTEINT PAS le SW ⇒ le port/message ne traverse pas la frontière iframe imbriquée
  (transfert de MessagePort, ou navigator.serviceWorker cassé dans l'iframe) — probable limite
  Electron 41 ; piste de fix = upgrade **Electron 42** (qui a déjà corrigé #41613) ou shim Mira.
- message ATTEINT le SW mais pas de reply ⇒ le port de retour ne revient pas — même classe.
Nécessite un restart de `npm run dev` (electron-vite ne watche pas le main). **Hypothèses réfutées à
ne pas reprendre** : « exec-js cassé » (c'était nc) ; « navigator.serviceWorker indispo en page
d'extension » (marche en top-level) ; « SW mort / alarms throw » (le SW répond) ; « ça converge tout
seul » (dialog stopped affiché).

### 8.10 CAUSE RACINE DÉFINITIVE — SW d'extension injoignable depuis une iframe imbriquée

**Prouvé sans ambiguïté** (build 16:03, logger `[mira-sw-msg]` dans le SW + mini-extension de test
que je contrôle, `scratchpad/sw-probe-ext`, chargée via `load-extension`) :

Une page `chrome-extension://` **en onglet top-level** voit parfaitement son service worker :
`navigator.serviceWorker.controller` = le SW, `getRegistrations()` = 1 (state activated), `ready`
résout ; le handshake `active.postMessage({source:'kondo-iframe'}, [port])` → SW `de()` → reply
`{status:'connected'}` **fonctionne** (validé aussi par le logger SW qui voit le message).

La **même page en iframe imbriquée dans une page web** (le cas réel de Kondo :
`chrome-extension://…/ext.html` dans `https://app.trykondo.com`) est coupée de son SW :
- `navigator.serviceWorker.controller` = **null**
- `getRegistrations()` = **[]**, `getRegistration()` = **null**
- `navigator.serviceWorker.ready` = **ne résout jamais** (hang)
- MAIS le `window.postMessage` + le **MessagePort arrivent bien** dans l'iframe (`received, ports:1`)
  → le relais web app → content script → iframe marche ; seul le dernier saut iframe→SW est mort.

**Conséquence** : le message `kondo-iframe` **n'atteint jamais le SW** dans le flux réel (logger SW =
0, alors qu'il capte parfaitement le cas top-level → logger validé). Le SW répond « connected »
uniquement si on le joint, ce qu'une iframe imbriquée ne peut pas faire. D'où le dialog « Browser
extension stopped » permanent.

**Ce n'est pas un bug Kondo ni un bug Mira** : Kondo marche dans Chrome (où une iframe de
`web_accessible_resources` est un contexte d'extension contrôlé par le SW). C'est un **trou
d'Electron/electron-chrome-extensions** : le SW d'extension n'est pas rattaché aux sous-frames
d'extension imbriqués dans une page web (probablement un souci de process/site-isolation). Confirmé
upstream : **electron-browser-shell#172 (ouverte)** — « MV3 service workers broken », 1Password et
Obsidian Web Clipper donnent des « popups with infinite loading states » (même symptôme). Classe
d'extensions affectée = toutes celles qui utilisent le pont iframe-WAR → SW via
`navigator.serviceWorker` (pattern courant des password managers / clippers).

**Ce qui est validé et marche (à ne pas rouvrir)** : DNR strip (SW ne plante plus), shim
`chrome.alarms` (le SW tourne et répond → alarms présent), keepalive SW (SW extension stable, 0
cycle), exec-js (jamais cassé — c'était `nc`, cf. CLAUDE.md), `chrome.runtime.connect`
page-extension→SW.

**Pistes de fix (décision à prendre) :**
1. **Upgrade Electron 41 → 42+** : 42 a corrigé le cycle de vie des SW d'extension (#41613) ; à
   vérifier s'il rattache aussi le SW aux sous-frames. Risque : packaging (patch app-builder figé),
   régressions. Le plus « propre » si ça corrige nativement.
2. **Shim Mira « navigator.serviceWorker ↔ chrome.runtime » dans les pages d'extension** : hop (a)
   marche (port dans l'iframe) et `chrome.runtime` joint le SW → on peut ponter. Il faut patcher
   DEUX côtés : (page) remplacer `navigator.serviceWorker.ready.active.postMessage(msg,[port])` par
   un pont qui ouvre `chrome.runtime.connect` vers le SW et relaie ; (SW, via le preload alarms
   existant) recevoir ce `onConnect`, fabriquer un `MessageChannel` et **dispatcher un
   `MessageEvent('message')` synthétique avec un vrai MessagePort** sur `self` pour que le `de()` de
   Kondo le reçoive. Auto-contenu et générique (pas Kondo-spécifique), mais non trivial ; **une
   pièce non prouvée** = le dispatch synthétique de port côté SW. `chrome.runtime` ne transfère PAS
   les MessagePorts, d'où le double pont.
3. **Accepter** que cette classe d'extensions (bridge iframe→SW) ne marche pas en Electron 41.

Artefacts de debug en place : logger `[mira-sw-msg]` dans `ALARMS_POLYFILL_MAIN_WORLD`
(`extension-capabilities.ts`, temporaire), `sw-debug.ts` + switch `vmodule` (`index.ts`),
mini-extension `scratchpad/sw-probe-ext` (désinstallée). Helper de pilotage : `scratchpad/mira.py`.

### 8.11 RÉCAPITULATIF COMPLET — tout ce qui a été fait, tenté, et ce qui reste

*Section autonome : elle se lit seule. §8.1–8.10 = le journal détaillé (avec mes erreurs et leurs
corrections) ; ici = la synthèse de référence. Tous les faits ci-dessous ont été VÉRIFIÉS en live le
2026-07-11 (client socket Python `scratchpad/mira.py`, logger `[mira-sw-msg]` dans le SW, et une
mini-extension de test `scratchpad/sw-probe-ext` que je contrôle entièrement).*

#### A. Le problème en une phrase

Kondo (extension + web app `app.trykondo.com`) affiche en permanence « Browser extension stopped »
parce que le dernier saut de son pont — la page `ext.html` (une page `chrome-extension://` chargée en
**iframe imbriquée** dans la page web) doit joindre son propre service worker via
`navigator.serviceWorker` — est **mort dans Electron** : une iframe d'extension imbriquée dans une
page web n'est pas rattachée au SW de son extension.

#### B. Méthodologie de debug (comment reproduire / reprendre)

- **Piloter le socket UNIQUEMENT via `scratchpad/mira.py`** (client socket brut), JAMAIS `nc -U`
  (voir CLAUDE.md : `nc` rate les réponses asynchrones → faux « vide »). `call({...})`,
  `execjs(tabId, code)`.
- **`exec-js` n'attend pas les promesses** dans le build : pattern « lance l'async, stocke dans
  `window.__x`, relis en sync » sur un 2ᵉ appel.
- **Observer le SW** : impossible via exec-js (onglets seulement). Solution = **logger dans le SW**
  via le preload alarms (`ALARMS_POLYFILL_MAIN_WORLD` → `console.log('[mira-sw-msg]'…)`) ; les
  consoles de SW remontent dans `userData/logs/main-<ts>.log`.
- **Séparer les sauts** = charger une **mini-extension de test** (`load-extension`) qui reproduit le
  pattern de Kondo mais **rapporte chaque étape au parent** via `parent.postMessage` (contourne le
  fait qu'on ne peut pas scripter dans une page d'extension cross-origin). Modèle dans
  `scratchpad/sw-probe-ext/` (manifest MV3 + `sw.js` + `probe.html`/`probe.js`).

#### C. Ce qui a été TESTÉ, et le résultat (le vrai « ce que j'ai tenté »)

| # | Test (live) | Résultat |
|---|---|---|
| 1 | `exec-js` via `nc -U` vs client Python | nc → **0 octet** (faux hang) ; Python → **marche**. Le bug était l'outil, pas exec-js. |
| 2 | Sonde DOM de `app.trykondo.com` | `stoppedDialog: true` — Kondo bien cassé (réfute « ça converge »). |
| 3 | Onglet **top-level** `ext.html` : `navigator.serviceWorker` | `controller` = le SW, `getRegistrations()` = 1 (**activated**), `ready` **résout**. |
| 4 | Onglet top-level : handshake `active.postMessage({source:'kondo-iframe'},[port])` → SW | **`gotReply:true`**, reply `{source:'kondo-worker',status:'connected'}`. |
| 5 | Logger SW pendant le test #4 | `[mira-sw-msg] source=kondo-iframe ports=1` → **logger validé** (il voit bien un vrai message). |
| 6 | `chrome.runtime.connect({name:'kondo-content'})` depuis `ext.html` → SW | port **reste connecté** (pas de disconnect) → messaging natif runtime OK. |
| 7 | Recharger le **vrai Kondo** + logger SW | **0** `kondo-iframe` reçu par le SW (alors que le logger marche, #5) → le message n'arrive jamais au SW. |
| 8 | Depuis `app.trykondo.com`, créer une **iframe `ext.html` imbriquée** + poster session+port (6–8 essais) | **aucune réponse** ; logger SW delta = **0**. Reproduit le bug hors du code Kondo. |
| 9 | **Mini-extension de test**, iframe imbriquée, rapport par étape | `received: ports:1` (le port ARRIVE dans l'iframe) MAIS `controller:null`, `getRegistrations():[]`, `getRegistration():null`, `ready`: **timeout**. |
| 10 | Mini-extension, SW : dispatch d'un **`MessageEvent` synthétique avec un vrai MessagePort** sur `self` | `SELF-MESSAGE … portOk=true` puis `SYNTHETIC-OK reply=…` → **le SW-half du shim marche**. |

#### D. Théories RÉFUTÉES (ne JAMAIS rouvrir)

- « `chrome.alarms` manquant fait throw le SW » — **cause réelle au départ** mais **corrigée** (shim
  alarms) ; le SW tourne et répond (#4).
- « La permission DNR fait planter le SW » — **vraie**, mais **corrigée** (strip au load) ; plus de
  `Failed to create API`.
- « Electron 41 ne redémarre pas le SW (#41613) » — **vraie**, **corrigée** (keepalive
  `startWorkerForScope` + restart-on-stop) ; le SW extension est stable, 0 cycle (#7).
- « exec-js est cassé / il faut CDP » — **FAUX**, c'était `nc` (#1). Le fix `cdp-eval.ts` est du
  durcissement, pas un correctif de bug.
- « `navigator.serviceWorker` indispo dans une **page** d'extension » — **FAUX**, marche en
  top-level (#3).
- « Ça converge tout seul après 3 reloads » — **FAUX** (#2, #7) : la web app épuise ses retries.
- « Le SW-start-race explique les reloads » — **réfuté** (le SW était debout avant les reloads).
- « Le keepalive cause du Port churn » — **réfuté** (SW extension stable).
- « `ext.html` bloqué `ERR_BLOCKED_BY_CLIENT` » — **était vrai** dans un build antérieur,
  **plus le cas** (l'iframe charge).

#### E. Ce qui est PROUVÉ et ACQUIS (marche — ne pas re-tester)

DNR strip · shim `chrome.alarms` · keepalive SW · `chrome.runtime.connect` page→SW · exec-js (via
client Python) · relais web app → content script → iframe (le port arrive dans l'iframe, #9).

#### F. LA CAUSE RACINE (définitive, #9)

Une iframe `chrome-extension://` **imbriquée dans une page web** est **coupée du service worker de
son extension** : `controller` null, `getRegistrations()` vide, `ready` ne résout jamais. En onglet
top-level, tout marche (#3). Le message + le MessagePort arrivent bien dans l'iframe (#9), donc seul
le saut iframe→SW est mort. Kondo marche dans Chrome (l'iframe WAR y est contrôlée par le SW) ⇒ c'est
un **trou d'Electron/electron-chrome-extensions** (rattachement SW↔sous-frames d'extension),
probablement lié au modèle de process / site-isolation. **Classe entière touchée** (pont iframe→SW
via `navigator.serviceWorker`) : password managers, clippers. Confirmé upstream :
**electron-browser-shell#172 (ouverte)** — 1Password / Obsidian Web Clipper, « popups with infinite
loading states » (même symptôme).

#### G. SOLUTIONS RESTANTES (détaillées)

**Option 1 — Shim Mira `navigator.serviceWorker ↔ chrome.runtime` (recommandé ; toutes les briques
prouvées #6, #9, #10).** But : rendre le saut iframe→SW fonctionnel dans les pages d'extension, de
façon **générique** (débloque toute la classe, pas que Kondo). Deux moitiés :

- *Page (frame preload sur les pages `chrome-extension://`, à enregistrer via
  `ses.registerPreloadScript({type:'frame', …})`, gate `location.href.startsWith('chrome-extension://')`,
  et seulement quand `navigator.serviceWorker.controller===null` = contexte imbriqué cassé)* :
  patcher `navigator.serviceWorker.ready` pour résoudre vers un objet dont
  `.active.postMessage(msg, [port])` : ouvre `chrome.runtime.connect({name:'__mira_swbridge'})`,
  envoie `msg` (JSON), et **relaie les données** `port ↔ runtimePort` (JSON dans les deux sens —
  Kondo n'échange que du JSON : `{source:'kondo-worker',status:'connected'}`, etc.).
- *SW (ajout à mon preload alarms existant)* : sur `chrome.runtime.onConnect` name `__mira_swbridge`,
  créer un `MessageChannel(a,b)`, **dispatcher `self.dispatchEvent(new MessageEvent('message',
  {data: msg, ports:[b]}))`** (prouvé #10 → le `de()` de Kondo reçoit un vrai port), et relayer
  `a ↔ runtimePort`.
- **Le MessagePort ne transite JAMAIS par `chrome.runtime`** (qui ne sait pas le transférer) : chaque
  côté fabrique sa propre paire locale, on ne relaie que les données. C'est la clé qui rend le shim
  possible.
- Points de vigilance : ne patcher que les pages d'extension au `controller` null (ne pas casser le
  vrai `navigator.serviceWorker` là où il marche) ; gérer plusieurs ponts concurrents (une paire par
  `postMessage`) ; gérer disconnect/close des deux côtés ; le `?session=` de Kondo reste géré par son
  propre code (on intercepte plus bas, à `active.postMessage`). Non trivial mais borné et testable
  (mini-extension + logger SW en place).

**Option 2 — Upgrade Electron 41 → 42+.** Electron 42 a corrigé le cycle de vie des SW d'extension
(#41613, non backporté en 41). À VÉRIFIER : corrige-t-il aussi le rattachement SW↔sous-frames (la
cause §F) ? Si oui, shim inutile, c'est le plus propre. Comment tester : bump `electron` en `^42`
dans `package.json`, `npm i`, vérifier que le patch figé `app-builder-lib` s'applique toujours
(`patches/`, cf. Notes du CLAUDE.md), relancer, puis re-jouer le test #9 (mini-extension imbriquée :
`controller` doit devenir non-null). Risques : régressions Chromium 138→140, packaging.

**Option 3 — Forker/patcher `electron-chrome-extensions`** pour rattacher le SW aux sous-frames
(via `patch-package`, comme le patch app-builder existant). Plus profond que le shim, dépend des
internals de la lib ; à réserver si options 1 et 2 échouent.

**Option 4 — Accepter** que cette classe (bridge iframe→SW) ne marche pas en Electron 41 et le
documenter comme limite connue (cohérent avec le §1 : « plafond qui vient d'Electron »).

#### H. Outillage de debug EN PLACE (à retirer une fois la voie tranchée)

- Logger `[mira-sw-msg]` dans `ALARMS_POLYFILL_MAIN_WORLD` (`extension-capabilities.ts`).
- `sw-debug.ts` (+ appel dans `ExtensionsService.ensureFor`) et le switch `vmodule` dans `index.ts`.
- `cdp-eval.ts` (+ test) : garder (durcissement exec-js sous debugger CDP) ou simplifier — pas un
  correctif de bug.
- Helper de pilotage `scratchpad/mira.py` et modèle de mini-extension `scratchpad/sw-probe-ext/`
  (hors repo, session-scoped — recréer si besoin ; snippets dans CLAUDE.md et ci-dessus).

*(Nettoyage fait à la résolution, cf. §8.12 : `sw-debug.ts` supprimé, switch `vmodule` retiré,
`[mira-sw-msg]` déjà retiré pendant le codage du shim ; `cdp-eval.ts` GARDÉ en durcissement.)*

### 8.12 ✅ RÉSOLUTION (2026-07-11 soir) — le shim était juste, son preload ne s'exécutait jamais

**Kondo fonctionne** (confirmé par Mickael après restart : plus de dialog « Browser extension
stopped »). L'Option 1 de §8.11-G (shim `navigator.serviceWorker ↔ chrome.runtime`) est la voie
retenue et VALIDÉE. Récit de la résolution, pour mémoire :

#### Ce qui a été fait

1. **Le shim a été codé (session Codex)**, fidèle au design §8.11-G, en deux moitiés dans
   `src/main/extension-capabilities.ts` :
   - *Moitié SW* (`SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD`) : `chrome.runtime.onConnect` sur le port
     privé `__mira_extension_service_worker_bridge_v1__` → recrée un `MessageChannel` local →
     dispatche un `MessageEvent('message')` synthétique avec un vrai port sur `self` → relaie les
     données (JSON) entre port local et runtime port. Installée via le preload alarms existant
     (donc AVANT le `Object.freeze(chrome)` de la lib).
   - *Moitié frame* (`SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD`) : dans une page `chrome-extension://`
     imbriquée dont le `controller` est null, patche le getter `navigator.serviceWorker.ready` pour
     résoudre vers un pseudo-registration dont `.active.postMessage(msg, [ports])` ouvre un
     `chrome.runtime.connect` et relaie. Un runtime port par appel `postMessage` ; les MessagePorts
     ne traversent JAMAIS `chrome.runtime` (chaque côté fabrique sa paire locale, on ne relaie que
     les données — la clé du design).
   - Câblage natif : `registerRuntimeShims` (`extensions.ts`) écrit les deux sources dans
     `userData/sw-shims/` et les enregistre par session (`registerPreloadScript`, types
     `service-worker` et `frame`) avant la construction d'`ElectronChromeExtensions`.

2. **Relecture après « ça marche toujours pas » (cette session)** — verdict : **la logique du shim
   était CORRECTE, son seul défaut était la livraison.** Preuve de bout en bout SANS restart, en
   inlinant la moitié frame verbatim dans le script d'une mini-extension sonde chargée en iframe
   imbriquée dans app.trykondo.com (= simuler « le preload a tourné ») : `ready` résout →
   `postMessage` avec port transféré → **réponse du SW reçue à travers le pont complet**
   (`swReply: {status:'connected-from-sw'}`), logs SW à l'appui (`onConnect name=__mira_…` puis
   `message event, source=mira-probe ports=1`). Les deux moitiés, le transport et le relais retour
   marchent.

#### LE bug (une ligne de webPreferences)

**Electron n'exécute les preloads que dans le frame principal**, sauf si les webPreferences posent
`nodeIntegrationInSubFrames: true`. Vérifié jusque dans le source d'Electron 41
(`ShouldLoadPreload`, `shell/renderer/renderer_client_base.cc`, branche 41-x-y) :
`is_main_frame || is_devtools || allow_node_in_sub_frames`. Or :

- les vues d'onglets (`materializeTab`, `profiles.ts`) ne posaient que `{ partition }` — le flag
  n'existait nulle part dans le repo ni dans la lib ;
- la moitié frame du shim **se désactive volontairement en top-level** (`if (top === self) return`) :
  elle ne visait QUE les iframes imbriquées… le seul endroit où son preload ne tournait pas.
  → Code mort à 100 %, silencieusement (aucune erreur nulle part).

Preuve directe (sonde sans inline, build 19:44) : dans l'iframe imbriquée `bridgeInstalled: false`
et `ready` en timeout, alors que tous les guards de la moitié frame seraient passés.

#### Le fix (validé)

`nodeIntegrationInSubFrames: true` dans les webPreferences des vues d'onglets (`materializeTab`,
`profiles.ts`) et des popups OAuth (`overrideBrowserWindowOptions` du `setWindowOpenHandler`, même
fichier — les password managers injectent aussi des iframes dans les popups). Coût accepté : les
preloads de session (lib + nôtre) s'exécutent désormais dans chaque iframe de chaque page, mais les
deux gatent immédiatement hors `chrome-extension://` — overhead négligeable. Flag étiqueté
« experimental » par Electron ; c'est le mécanisme prévu pour ce besoin.

#### Faits établis au passage (utiles pour E2)

- `chrome.runtime.connect` **fonctionne depuis une iframe d'extension imbriquée** (ping/pong complet
  vers le SW, prouvé en live) — le dernier maillon jusque-là non prouvé du design.
- La surface Kondo est minimale : tout le script d'`ext.html` (`assets/settings.js`) tient en 4
  lignes et ne touche QUE `navigator.serviceWorker.ready` → `.active?.postMessage(...)`, **dans son
  handler de message** (déclenché par les retries de la web app) — donc pas de course entre
  l'installation du patch et la lecture de `ready`.
- Le handler du SW Kondo (`de` dans `background-vYAqPXIO.js`) ne vérifie que
  `e.data?.source === 'kondo-iframe'` et `e.ports[0]` — ni `origin` ni `source` (que le dispatch
  synthétique ne peut pas fournir).
- Kondo maintient son SW vivant tout seul : `setInterval(chrome.runtime.getPlatformInfo, 20 s)`
  (c'est pourquoi son SW ne cycle pas alors que les SW oisifs meurent à ~30 s et sont relancés par
  notre keepalive).

**Portée** : le shim + le flag débloquent toute la classe « pont iframe-WAR → SW via
`navigator.serviceWorker` » (password managers, clippers — les cas d'electron-browser-shell#172),
pas seulement Kondo. À vérifier en E2 (1Password, Obsidian Web Clipper).

**Nettoyage fait** : `sw-debug.ts` supprimé (+ son appel dans `ensureFor`), switch `vmodule` retiré
d'`index.ts`. **Gardé en durcissement** : `cdp-eval.ts` (+ tests) — route `exec-js` par
`Runtime.evaluate` quand un debugger CDP est attaché, avec timeout.
