# Mira

Un navigateur web perso, à moi, **basé sur Chromium** et **vibe codé**. Frère de Kova (le terminal) : court, personnel, taillé pour mon usage.

Nom : `mira` = "regarde" (latin _mirari_, s'émerveiller) + une étoile. Le job d'un navigateur : afficher le web.

## Rules par domaine (`.claude/rules/`)

Le savoir spécifique à une zone de code vit dans des **rules path-scopées** qui ne chargent que quand tu touches les fichiers concernés (allège ce CLAUDE.md, toujours chargé). Panorama des rules :

- `main-native-gotchas.md` (`src/main/**`) : pièges natifs Electron — WebContentsView, `<webview>`, overlay natif, `globalShortcut` AZERTY, Spaces macOS.
- `command-registry.md` (`src/main/commands/**`) : découpage anti-collision du registre de commandes (un fichier par domaine).
- `piloting-and-testing.md` (`src/main/**`, `docs/socket.md`, `scratchpad/**`, `*.test.ts`) : piloter Mira par le socket (client brut vs piège `nc`, `exec-js`/`tabId`, onglet de test en `background`, profil isolé, `--profile`/`MIRA_PROFILE`).
- `packaging.md` (`electron-builder.yml`, `patches/**`, `bin/**`, `package.json`) : `build:mac`, patch app-builder-lib figé, `./bin/build.sh`.

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
   - **Socket unix** (externe, façon Kova) : `MIRA_SOCKET` (défaut `/tmp/mira.sock`), une requête JSON par ligne, pour piloter Mira depuis un shell / un agent. **Référence API : `docs/socket.md`** ; en live, la commande `list-commands` liste les noms connus du build qui tourne. **En pratique, piloter via le CLI `mira` (`bin/mira`, sur le PATH), pas au `nc` : `mira tabs` / `mira use --url <s>` (pin via `$MIRA_TAB`) / `mira exec` / `mira call <cmd> --params '<json>'`. Logique pure + tests dans `src/cli/mira-core.mjs`.** Détail (client brut, `exec-js`, onglets de test, profil isolé) : rule `.claude/rules/piloting-and-testing.md`.
   - **MCP** : un serveur mince qui wrappe la socket. Il n'ajoute pas de logique, il expose les commandes existantes.
4. **Une commande = un nom + un schéma de params.** Ainsi elle est appelable à l'identique depuis IPC, socket ou MCP, sans réécriture.

Règle de conception au quotidien : avant d'implémenter une action dans un composant React, se demander « est-ce une commande du registre ? ». Si oui (presque toujours), elle vit dans le main et le composant l'appelle. Si une feature n'est atteignable qu'en cliquant, elle viole le principe fondateur.

## Principe fondateur : tout testable (une feature = un test)

**Chaque feature arrive avec son test.** Pas de code de feature mergé sans un test qui le couvre. C'est le corollaire direct du principe « tout pilotable » : comme la logique vit dans le registre de commandes (des fonctions nommées et typées, pas des click handlers), elle se teste sans lancer Electron ni Chromium.

- **Runner : Vitest** (naturel, on est déjà sur Vite via electron-vite). Commande `npm test`.
- **Ce qu'on teste vraiment = la logique des commandes.** Chaque commande du registre a son test unitaire : entrées → effet attendu / valeur retournée. C'est là que vit 90 % de la valeur.
- **Ce qu'on ne teste PAS en unitaire = les bouts natifs Electron** (positionnement du `WebContentsView`, cycle de vie des `webContents`, IPC réel). On le fait au coup par coup, pas systématiquement.
- **Conséquence de conception :** si une commande est trop couplée à Electron pour être testable simplement, extraire sa logique pure dans une fonction à part (testable), et ne laisser dans la commande que l'appel natif (fin, non testé).

## Découpage anti-collision (sessions parallèles)

Mira est vibe codé sur **plusieurs sessions en parallèle**. Un même fichier édité par deux sessions = conflit de merge ou écrasement. Le découpage vise donc **un fichier par feature**, pour que deux sessions qui bossent sur deux sujets différents touchent des fichiers différents.

**Le détail (layout de `src/main/commands/`, règles pour ajouter une commande / une slice de contexte / un domaine) vit dans la rule `.claude/rules/command-registry.md`.** Test avant d'écrire : « ma feature touche-t-elle un fichier qu'une autre session touche probablement aussi ? » — si oui, nouveau fichier de domaine plutôt qu'un append. Même principe pour les autres surfaces quand elles grossiront (CSS par surface, composants React par feature sous `renderer/src/features/<x>/`, `App.tsx` ne fait qu'assembler).

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

Les **pièges natifs** de ce pont (repositionnement manuel de la vue, overlay impossible sans fenêtre native, etc.) sont dans la rule `.claude/rules/main-native-gotchas.md`, chargée en éditant `src/main/**`.

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
npm run dev        # dev + HMR (process long-running)
npm run build      # typecheck + build
npm run typecheck  # tsc, sans build
npm test           # Vitest
npm run lint / format
./bin/build.sh     # build packagé + réinstalle l'app (quit Mira → build:mac → open)
```

Détails packaging / build packagé : rule `.claude/rules/packaging.md`.

## Notes

- **Langue** : tout le code, les commentaires, les identifiants et les textes d'UI en **anglais**. Le français reste pour le dialogue.
- **Rien d'intime ici** : repo de code perso classique, pas le repo `self`. Pas de chiffrement git-crypt, commits descriptifs normaux.
- **Notes locales non versionnées** : le workflow perso et l'identité du profil de test vivent dans `CLAUDE.local.md`, chargé automatiquement par Claude Code à côté de ce fichier quand il est présent. Il est git-excluded : **absent d'un clone public, c'est normal — ne pas signaler son absence ni la traiter comme une erreur.**
