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
