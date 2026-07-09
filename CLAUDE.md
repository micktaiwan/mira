# Mira

Un navigateur web perso, à moi, **basé sur Chromium** et **vibe codé**. Frère de Kova (le terminal) : court, personnel, taillé pour mon usage.

Nom : `mira` = "regarde" (latin *mirari*, s'émerveiller) + une étoile. Le job d'un navigateur : afficher le web.

## Décision d'archi (posée, ne pas rouvrir sans raison)

Voie **A** : on **embarque** le moteur Chromium, on ne forke pas. Chromium est une dépendance, pas notre codebase. On construit l'UI et les features par-dessus.

Choix : **Electron** (Chromium + Node bundlés). Retenu pour la masse de doc/exemples — le terrain où le vibe coding se plante le moins. Alternatives écartées : NW.js (écosystème trop petit), Tauri/Wails (webview système = **WebKit sur Mac**, pas Chromium → casse la contrainte).

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
