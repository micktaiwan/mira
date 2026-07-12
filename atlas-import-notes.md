# Mira — import depuis ChatGPT Atlas (notes)

Détail du chantier « import favoris » et « import onglets ouverts » depuis
ChatGPT Atlas (navigateur Chromium d'OpenAI). Le `track.md` n'en garde qu'une
ligne d'état.

## Import favoris (reste à faire actif)

Objectif : une commande pilotable qui lit le fichier favoris d'Atlas, passe par
`importAtlasTree` (fonction pure déjà écrite + testée, mappe le format Atlas → notre
arbre) et fusionne dans l'arbre Mira.

Manque le câblage lecture-disque : le fichier Atlas `bookmarks/BookmarkBar` est du
**JSON** (pas de plist ici — le plist, c'est pour les pinned tabs), donc
`JSON.parse(readFileSync(...))` → `importAtlasTree` → fusion.

Décisions ouvertes :

- **Quel profil** (défaut = principal, ~874 favoris).
- **Remplacer** l'arbre OU importer dans un dossier **« Imported from Atlas »**
  (reco : dossier, non destructif).
- Dédup par url.

## Format des favoris Atlas (vérifié sur disque 2026-07-10)

`~/Library/Application Support/com.openai.atlas/<profil>/bookmarks/BookmarkBar` — un
**JSON** par profil (`bookmarks` est un dossier). Arbre récursif. Nœud :

- `id` (int), `uuid`, `title`
- `type` : objet à une clé — `{bookmarkBar:{}}` racine | `{folder:{}}` | `{url:{}}`
- `children[]`, `parentUUID`, `url` (si type url)
- **Aucun timestamp/favicon.**

Profil principal : ~874 urls / ~121 dossiers.

## Import onglets ouverts (idée — fait à la main une fois)

Fait **à la main** le 2026-07-10 (onglets d'un profil Atlas réimportés dans un
profil Mira via le socket : `new-tab` puis `pin-tab`). Contraintes **vérifiées**
pour un futur import pilotable :

1. **Source fiable** = fichiers **SNSS**
   `com.openai.atlas/browser-data/host/<profil>/Sessions/Session_*` — **arbre
   distinct** des favoris (`com.openai.atlas/<profil>/bookmarks/BookmarkBar`).
2. **Plusieurs profils** = comptes ChatGPT, dossiers `user-<acct>__<guid>`
   (+ variantes `__1/__2` par fenêtre) ; ignorer les `login-staging-*` éphémères.
3. **AppleScript** (`tell application "ChatGPT Atlas"`) fonctionne mais
   **sous-remonte** — n'énumère que les onglets chargés (a raté 22 des 26).
4. Chromium **alterne 2 fichiers** `Session_` : le plus récent n'est pas toujours
   la fenêtre vivante (les 26 vrais onglets étaient dans le fichier plus ancien).
5. Le flag **pinned n'est pas décodable** de façon fiable dans le SNSS d'Atlas /
   Chromium 149 → l'épinglage doit venir d'ailleurs (grille d'icônes visible, ou
   saisie manuelle).
