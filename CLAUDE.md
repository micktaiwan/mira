# Mira

Un navigateur web perso, à moi, **basé sur Chromium** et **vibe codé**. Frère de Kova (le terminal) : court, personnel, taillé pour mon usage.

Nom : `mira` = "regarde" (latin *mirari*, s'émerveiller) + une étoile. Le job d'un navigateur : afficher le web.

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
   - **Socket unix** (externe, façon Kova) : `MIRA_SOCKET`, une requête JSON par ligne, pour piloter Mira depuis un shell / un agent.
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

| Couche | Choix |
|---|---|
| Shell | Electron (Chromium + Node) |
| Build / HMR | electron-vite |
| UI ("chrome") | React + TypeScript |
| Style | Tailwind *(à ajouter — pas encore câblé)* |
| Contenu web | `WebContentsView` (un par onglet) |

## Le modèle mental : deux mondes séparés

1. **La "chrome"** = l'UI *autour* du web (onglets, barre d'URL, sidebar, palette). C'est notre fenêtre React, notre HTML à nous. Vit dans `src/renderer/`.
2. **Le contenu web** = les sites visités. Vit dans des conteneurs isolés, un process par vue.

Le pont : **`WebContentsView`** (API Electron moderne). Un onglet = un `WebContentsView`, créé côté **main** (`src/main/`), positionné sous la barre d'adresse, écouté (`did-navigate`, `page-title-updated`, `page-favicon-updated`) et piloté (`loadURL`, `goBack`, `reload`). La chrome (renderer) et le main communiquent par **IPC**.

## Les deux pièges à connaître d'avance

1. **`WebContentsView` n'est PAS un élément DOM.** C'est une couche native posée par-dessus la fenêtre à des coordonnées x/y/w/h explicites. Quand la chrome bouge (resize, sidebar qui s'ouvre), il faut **recalculer et repositionner la vue à la main**. C'est le bug classique du browser Electron.
2. **Ne pas utiliser `<webview>` ni `BrowserView`** — dépréciés. Toujours `WebContentsView`. (L'IA propose souvent l'ancien `<webview>` : à corriger.)

## Chemin d'incréments

1. Fenêtre Electron + **un** `WebContentsView` qui charge une URL en dur.
2. Barre d'adresse qui navigue (URL + entrée → `loadURL`).
3. Back / forward / reload + affichage titre & favicon.
4. **Multi-onglets** (tableau de `WebContentsView`, un visible à la fois) — premier vrai palier de complexité (cycle de vie, focus, layout au resize).
5. Ce qui rend Mira *à moi* : sidebar façon Arc, raccourcis clavier, command palette `Cmd+K`.

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
```

## Notes

- **Packaging (`build:mac`) : fonctionne, avec un patch figé.** electron-builder 26 charge `@noble/hashes@2` (pur ESM) via un `require()` CommonJS → `ERR_REQUIRE_ESM` qui plante tout le packaging au démarrage. Contourné en transformant ce `require` en `import()` dynamique dans `app-builder-lib/.../blockmap/blockmap.js`. Le correctif est **figé et versionné** dans `patches/app-builder-lib+26.15.3.patch` (via [patch-package](https://github.com/ds300/patch-package)) et **ré-appliqué automatiquement** par le `postinstall` (`patch-package`) après chaque `npm install`. Ne pas supprimer ce dossier `patches/`. Si electron-builder est mis à jour, régénérer le patch (`npx patch-package app-builder-lib`) ou le retirer s'il n'est plus utile.
  - Ancien `postinstall` (`electron-builder install-app-deps`) supprimé : il plantait et ne servait à rien (pas de dépendance native, `npmRebuild: false`).
- **Langue** : tout le code, les commentaires, les identifiants et les textes d'UI en **anglais**. Le français reste pour le dialogue.
- **Rien d'intime ici** : repo de code perso classique, pas le repo `self`. Pas de chiffrement git-crypt, commits descriptifs normaux.
