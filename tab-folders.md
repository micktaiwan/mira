# Dossiers d'onglets (tab folders)

Design + état de **ranger les onglets ouverts dans des dossiers** dans la sidebar
de gauche. **V1 implémentée** (à valider en app) — voir §Archi (implémentée V1).
Indexé dans `track.md`.

Origine : une première tentative a confondu la demande avec des **favoris** (arbre
de bookmarks affiché dans un panneau de sidebar). C'était un malentendu, entièrement
revert. La vraie demande porte sur les **onglets ouverts**, pas les bookmarks.

## Le repère qui cadre tout : Cmd+K est central, pas un panneau de favoris

**Les favoris ne sont pas un panneau de sidebar. Ils vivent dans Cmd+K.** La command
palette (`Cmd+K`, déjà implémentée) liste déjà les favoris aplatis parmi ses entrées
(`buildPaletteEntries`, voir `track.md` §Design de la palette). L'accès rapide à un
site favori se fait donc en tapant `Cmd+K` + quelques lettres, pas en cliquant une
liste toujours visible.

Conséquence de direction produit : **Cmd+K doit devenir le réflexe central** de
navigation (ouvrir un favori, sauter à un onglet, lancer une commande). C'est
pourquoi un panneau « Favorites » dans la sidebar n'a pas lieu d'être — il
dupliquerait ce que la palette fait déjà mieux. La sidebar reste dédiée aux
**onglets ouverts** (et à leur regroupement en dossiers, ci-dessous).

## Modèle — ce qui est DÉCIDÉ

- **Regroupement purement visuel.** Un dossier groupe des onglets ouverts dans la
  sidebar. Les onglets restent des onglets normaux : un `WebContentsView`, sélection,
  navigation — rien ne change à leur cycle de vie. Le dossier est une étiquette, pas
  un conteneur qui change la nature de l'onglet.
- **Un onglet appartient à 0 ou 1 dossier.** Les onglets non rangés restent dans une
  **zone « en vrac »** (loose), comme aujourd'hui. On ne force pas tout onglet dans un
  dossier.
- **Repli = visuel seulement, les onglets restent VIVANTS.** Replier un dossier cache
  ses onglets dans la sidebar mais ne les met **pas** en veille (pas de décharge RAM).
- **Persistant.** La structure (dossiers : nom, repli, ordre ; appartenance de chaque
  onglet) survit au redémarrage. Elle va dans `session-store` (le fichier qui sauve
  déjà les onglets par fenêtre).
- **Clic droit sur un onglet → ranger.** Un menu contextuel sur une ligne d'onglet
  propose : **ranger dans un dossier existant**, ou **créer un nouveau dossier** (et y
  ranger l'onglet). C'est le point d'entrée principal du rangement.
- **Profondeur : 1 seul niveau.** Un dossier contient des onglets, pas de sous-dossiers.
- **Ordre : sections figées.** Haut → bas : grille pinned, puis **dossiers**, puis onglets
  **en vrac**. Les dossiers sont entre les pinned et le vrac (pas de liste libre façon Arc).
- **Navigation `Cmd+↑`/`Cmd+↓` : ordre visuel.** On parcourt pinned → onglets des dossiers
  **ouverts** → vrac, en **sautant** les onglets des dossiers **repliés**. Si l'onglet actif
  est caché dans un dossier replié, on rentre par le premier/dernier onglet visible.
- **Menu clic droit : natif** (Electron `Menu.popup`), pas HTML — toujours au-dessus du
  `WebContentsView`, jamais clippé. **Premier menu natif déjà codé** (New Tab / Duplicate /
  Pin-Unpin / Close), c'est la « couture » où les items « Move to folder / New folder »
  se brancheront. Voir `tab-menu.ts` (liste pure testée) + `commands/tab-menu.ts`
  (`show-tab-menu {tabId}`) + `showTabMenuIn` dans `profiles.ts`.
- **Différé (plus tard, pas dans la V1) :** options par dossier pour **afficher la
  conso RAM** du dossier et un bouton **clear rapide** (décharger/mettre en veille les
  onglets du dossier). Le repli reste sans effet RAM en V1 ; le clear sera une action
  explicite séparée.

## Archi (implémentée V1)

Modèle : **l'appartenance vit sur l'onglet** (`TabMeta.folderId`, comme `pinned`) — c'est
ce qui la fait **survivre au restore** (les ids d'onglets sont régénérés, une carte
id→dossier séparée ne survivrait pas). Les **métadonnées** de dossier (titre, repli,
ordre) sont une liste à part.

- **Pur / testé** : `src/main/tab-folder-store.ts` — modèle `TabFolder {id,title,collapsed}`,
  ops (add/rename/remove/collapse/setTabFolder/clear/prune) + `navigableTabIds` /
  `nextNavigableTabId` (l'ordre Cmd↑/↓). Tests : `tab-folder-store.test.ts`.
- **Persistance** : `session-store.ts` — `folderId` par onglet + `folders[]` par fenêtre
  (écrits seulement si présents → compat des vieux fichiers). Restore recrée les onglets
  avec leur `folderId` puis prune le dangling.
- **Commandes** (`commands/tab-folders.ts`, pilotables socket/MCP, testées) :
  `create-tab-folder {title, tabId?}`, `rename-tab-folder`, `remove-tab-folder` (dissout,
  n'efface pas les onglets), `toggle-tab-folder`, `move-tab-to-folder {tabId, folderId|null}`,
  `list-tab-folders`.
- **ProfileManager** (`profiles.ts`) : champ `pw.folders`, push des `folders` sur
  `mira:tabs-changed`, `folderId` dans `tabInfos`, nav via `nextNavigableTabId`, pin qui
  sort du dossier, prune à la fermeture, `showTabMenuIn` alimente le menu natif.
- **Menu clic droit** (`tab-menu.ts`) : sous-menu **Move to Folder** (dossiers existants +
  **New Folder…**) et **Remove from Folder** — masqués sur un onglet pinned.
- **UI** : `Sidebar.tsx` rend pinned → **section dossiers** (`FolderHeader` : caret/repli,
  rename au double-clic, × pour dissoudre) → vrac. Onglets d'un dossier = mêmes `TabRow`
  (drag partagé). Styles : `assets/tab-folders.css`.

**Règle de gestes** : **drag dans la même section** = réordonner (`move-tab`) ; **drag
vers une autre section** (une ligne d'un autre groupe, ou **sur l'en-tête d'un dossier**)
= changer d'appartenance (`move-tab-to-folder`) ; le **clic droit** fait aussi Move/Remove.
**Nommage à la création** : « New Folder » crée un dossier nommé « New folder » et la
sidebar ouvre aussitôt son champ nom (sélectionné) — un menu natif ne peut pas demander
de texte. Le repli est visuel (aucun effet RAM ; le clear/RAM par dossier reste différé).

**Reste à valider en app** : piloté par le dev (`npm run dev`) — vérifier le clic droit →
Move/New/Remove, le repli, la nav Cmd↑/↓ qui saute les repliés, et la survie au redémarrage.

## Distinctions à garder en tête

- **Dossiers d'onglets ≠ onglets épinglés (pinned).** Les pinned restent la grille
  compacte en tête de strip. Un dossier groupe des onglets normaux, pas des pinned.
- **Dossiers d'onglets ≠ favoris (bookmarks).** Les favoris sont des URLs sauvées
  (arbre `bookmark-store.ts`, menu natif, étoile, Cmd+K). Les dossiers d'onglets
  regroupent des **onglets ouverts vivants**. Deux features distinctes.
