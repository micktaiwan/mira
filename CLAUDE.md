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

- **`postinstall` échoue** (`electron-builder install-app-deps`, bug ESM electron-builder 26 + Node 22). Sans impact sur le dev — ne concerne que le packaging (`build:mac` etc.). À régler seulement quand on voudra packager.
- **Langue** : tout le code, les commentaires, les identifiants et les textes d'UI en **anglais**. Le français reste pour le dialogue.
- **Rien d'intime ici** : repo de code perso classique, pas le repo `self`. Pas de chiffrement git-crypt, commits descriptifs normaux.
