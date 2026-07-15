---
paths:
  - "electron-builder.yml"
  - "patches/**"
  - "bin/**"
  - "package.json"
---

# Packaging (build:mac) et build packagé

**Packaging (`build:mac`) : fonctionne, avec un patch figé.** electron-builder 26 charge `@noble/hashes@2` (pur ESM) via un `require()` CommonJS → `ERR_REQUIRE_ESM` qui plante tout le packaging au démarrage. Contourné en transformant ce `require` en `import()` dynamique dans `app-builder-lib/.../blockmap/blockmap.js`. Le correctif est **figé et versionné** dans `patches/app-builder-lib+26.15.3.patch` (via [patch-package](https://github.com/ds300/patch-package)) et **ré-appliqué automatiquement** par le `postinstall` (`patch-package`) après chaque `npm install`. Ne pas supprimer ce dossier `patches/`. Si electron-builder est mis à jour, régénérer le patch (`npx patch-package app-builder-lib`) ou le retirer s'il n'est plus utile.

- Ancien `postinstall` (`electron-builder install-app-deps`) supprimé : il plantait et ne servait à rien (pas de dépendance native, `npmRebuild: false`).

**Build packagé.** `./bin/build.sh` quitte Mira, fait `npm run build:mac`, et rouvre l'app (`/Applications/Mira.app` est un **symlink** vers `dist/mac-arm64/Mira.app`, donc `build:mac` rafraîchit l'app installée en place — aucune copie ; setup one-time du symlink documenté en tête de `bin/build.sh`). Le mode de dev par défaut reste `npm run dev` (HMR). La règle perso « ne pas builder / lancer de long-running sans mon accord » vit dans `CLAUDE.local.md` (non versionné).
