---
paths:
  - 'electron-builder.yml'
  - 'patches/**'
  - 'bin/**'
  - 'package.json'
---

# Packaging (build:mac) et build packagé

**Packaging (`build:mac`) : fonctionne, avec un patch figé.** electron-builder 26 charge `@noble/hashes@2` (pur ESM) via un `require()` CommonJS → `ERR_REQUIRE_ESM` qui plante tout le packaging au démarrage. Contourné en transformant ce `require` en `import()` dynamique dans `app-builder-lib/.../blockmap/blockmap.js`. Le correctif est **figé et versionné** dans `patches/app-builder-lib+26.15.3.patch` (via [patch-package](https://github.com/ds300/patch-package)) et **ré-appliqué automatiquement** par le `postinstall` (`patch-package`) après chaque `npm install`. Ne pas supprimer ce dossier `patches/`. Si electron-builder est mis à jour, régénérer le patch (`npx patch-package app-builder-lib`) ou le retirer s'il n'est plus utile.

- Ancien `postinstall` (`electron-builder install-app-deps`) supprimé : il plantait et ne servait à rien (pas de dépendance native, `npmRebuild: false`).

**Build packagé.** `./bin/build.sh` typecheck, quitte Mira **par le socket** (`bin/mira quit`) puis attend que le process ait vraiment disparu, fait `npm run build:mac`, puis **remplace `/Applications/Mira.app` par une vraie copie** (`ditto` depuis `dist/mac-arm64/Mira.app`) et rouvre l'app **en arrière-plan** (`open -g -a`) : un rebuild se demande pendant qu'on travaille ailleurs, Mira doit revenir là où il était, derrière. Ce fut un symlink, et ça cassait l'identité de bundle macOS : les sous-systèmes de confidentialité ne retrouvaient plus l'app (`bundle_id: (null)`), d'où un `ERR_ADDRESS_UNREACHABLE` sur tout hôte du LAN malgré l'autorisation Réseau local. Le pourquoi complet est en tête de `bin/build.sh`. Le mode de dev par défaut reste `npm run dev` (HMR). La règle perso « ne pas builder / lancer de long-running sans mon accord » vit dans `CLAUDE.local.md` (non versionné).

⚠️ **Ne jamais quitter Mira par `osascript -e 'quit app "Mira"'` dans un script.** Un Apple Event arrive sur la porte de confirmation (`src/main/quit.ts`) et lève une modale « Quit Mira? » que personne n'est là pour valider ; osascript rend la main tout de suite quand même, donc le script enchaîne son `rm -rf /Applications/Mira.app` sur un bundle encore en cours d'exécution. La commande socket `quit` appelle `suppressQuitPrompt()` exprès pour ça (`src/main/profiles.ts`, `quitApp`), comme les signaux SIGINT/SIGTERM. Et « la commande a répondu ok » ne veut pas dire « le process est mort » : le quit gracieux flush les sessions et re-verrouille les coffres, d'où la boucle d'attente sur `pgrep`.

**Provisioning profile : à renouveler tous les 7 jours.** `build/embedded.provisionprofile` porte l'entitlement AMFI `keychain-access-groups` sans lequel Touch ID / WebAuthn ne marche pas (voir `src/main/webauthn.ts`). Il est émis par le _personal team_ gratuit ZMKDR6H89Y et **expire au bout de 7 jours** ; passé ce délai il faut le refaire ET rebuilder, sinon l'entitlement cesse de valider au runtime.

Un profil ne s'obtient pas à la demande : Xcode ne l'émet **que** s'il signe une app qui réclame une capability l'exigeant. Un projet sans entitlements signe très bien et ne produit aucun profil (vérifié 2026-07-29). D'où la recette, avec `xcodegen` :

1. Projet jetable macOS, `PRODUCT_BUNDLE_IDENTIFIER: com.mickaelfm.mira`, `DEVELOPMENT_TEAM: ZMKDR6H89Y`, `CODE_SIGN_STYLE: Automatic`, `GENERATE_INFOPLIST_FILE: YES` (sinon la signature échoue), et surtout `CODE_SIGN_ENTITLEMENTS` pointant un fichier qui déclare `keychain-access-groups = $(AppIdentifierPrefix)com.mickaelfm.mira.webauthn`.
2. `xcodegen generate` puis `xcodebuild -project <p>.xcodeproj -scheme <s> -destination 'platform=macOS' -derivedDataPath <dd> -allowProvisioningUpdates build`.
3. **Vider le cache d'abord**, sinon l'étape 2 ne renouvelle rien : Xcode garde le profil dans `~/Library/Developer/Xcode/UserData/Provisioning Profiles/<uuid>.provisionprofile` et le **réutilise tel quel** tant qu'il est valide — le build réussit, le profil sort avec l'ancienne date d'expiration, et on croit avoir regagné 7 jours (vécu le 2026-08-10 : rebuild à J+2, expiration inchangée). Supprimer/déplacer ce fichier puis relancer l'étape 2 : Xcode en émet un neuf, nouvel UUID, J+7.
4. Le profil sort dans `<dd>/Build/Products/Debug/<App>.app/Contents/embedded.provisionprofile`. Le copier sur `build/embedded.provisionprofile`, puis `./bin/build.sh`.
5. Vérifier : `security cms -D -i build/embedded.provisionprofile | plutil -extract ExpirationDate raw -` doit donner J+7, et `security cms -D -i build/embedded.provisionprofile | plutil -extract Entitlements.keychain-access-groups json -o - -` doit donner `["ZMKDR6H89Y.*"]`. Après rebuild, contrôler que les helpers sont vivants (`ps -Ao comm | grep -c "[M]ira Helper"` — un SIGKILL AMFI les tuerait) et que `isUserVerifyingPlatformAuthenticatorAvailable()` renvoie `true` dans une page.

⚠️ **`plutil -extract` n'écrit sur stdout qu'en format `raw`** — pour tout autre format (`json`, `xml1`…) il écrit dans un **fichier**, dont le chemin par défaut est celui de l'entrée. Avec `-` en entrée (stdin), il crée donc un fichier nommé littéralement `-` dans le répertoire courant, rend un stdout vide et sort en 0 : on croit à une extraction vide et on laisse un déchet dans le repo (vécu le 2026-08-24, fichier `-` committé puis supprimé en `c020a66`). **Toujours `-o -`** quand le format n'est pas `raw`.

Piège de lecture : dans `Apple Development: faivrem@gmail.com (23L76N6978)`, `23L76N6978` est l'identifiant du **certificat**, pas l'équipe. L'équipe est `ZMKDR6H89Y` (`codesign -dvvv` → `TeamIdentifier`).
