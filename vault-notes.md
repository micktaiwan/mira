# Mira — cloisonnement par profil & profils chiffrés (notes)

Historique et détail technique du chantier « cloisonnement complet par profil »
et « profil chiffré (vault) ». Le `track.md` n'en garde qu'une ligne d'état ;
tout le récit vit ici.

## Décision (2026-07-11)

Chaque profil est une **unité de stockage isolée** : l'historique, les
permissions et les favoris d'un profil ne doivent PAS fuiter vers un autre.

- Isolés dès le départ : la **partition Electron** (cookies/localStorage/IndexedDB,
  `Partitions/mira-<id>/`), les **onglets** (`sessions.json`, clé par id) et les
  **extensions**.
- Fuyaient encore : `history.json` et `permissions.json` (tableaux globaux à plat).
  → rendus **par profil**.
- **Favoris aussi par profil** (renverse le choix « global minimaliste » d'avant).
- **Réglages restent globaux** (home URL, clé LLM, largeurs — pas de la donnée de
  navigation).
- **Pas de migration** : OK de jeter l'historique actuel (confirmé).

## Stockage par profil (FAIT 2026-07-11)

1. Refactor de `ProfileManager` en collaborateurs : `llm-runner.ts`,
   `tooltip-controller.ts`, `bookmarks-controller.ts`, `profile-data.ts`.
2. Historique + permissions + favoris vivent dans
   `userData/profiles/<id>/{history,permissions,bookmarks}.json`, un
   `ProfileData` / `BookmarksController` par id (`dataFor` / `bookmarksFor`,
   création lazy).
3. `recordVisit` / `recordGrant` / favoris routés vers le profil ciblé ;
   broadcast permissions/favoris scopé à la fenêtre du profil ; menu natif
   Bookmarks = arbre du profil focus (rebuild au changement de focus).
4. Les commandes history/permissions/bookmarks agissent sur le profil focus.

Tests OK. À valider en app après build (rebuild requis).

## Profil chiffré — vault (cœur pilotable FAIT 2026-07-11)

Modèle : **déchiffrer vers l'emplacement normal, re-chiffrer au repos** (pas de
symlink, décidé).

- Vault `.sparsebundle` **AES-256 par profil** dans `userData/vaults/<id>.sparsebundle`,
  chiffre les DEUX dossiers du profil (`profiles/<id>` trails + `Partitions/mira-<id>`
  cookies).
- `vault.ts` (pur, testé : `vaultPlan` / `assertEncryptable` / `needsUnlock` — le
  default n'est pas chiffrable, pas de dossier auto-contenu).
- `vault-service.ts` (natif `hdiutil` + cp/rm, **verify-before-wipe** sur
  encrypt+lock).
- Domaine `commands/vault.ts` : `encrypt-profile` / `unlock-profile` /
  `lock-profile` / `list-vaults` (pilotables + testés) ; flag `Profile.encrypted`
  persisté.
- `ProfileManager` : `unlockedVaults` (id→password en mémoire), gate `openProfile`
  sur profil verrouillé, skip au démarrage.
- **encrypt/lock exigent la fenêtre fermée** (course sur les handles Electron évitée).

### Natif validé en réel (2026-07-11)

Via `vault-service.integration.test.ts` (gardé par `MIRA_VAULT_IT=1`, vrai
`hdiutil` sur un dossier temp jetable, 5/5 : encrypt+wipe, unlock intact, edit
persiste après lock, mauvais mot de passe rejeté, discard). S'auto-nettoie (aucun
volume résiduel).

## Cycle de vie (tranché + câblé 2026-07-11)

1. **Auto-lock à la fermeture de fenêtre** — handler `closed`, hors quit (async,
   fire-and-forget).
2. **Perte de session sur arrêt sale = OK** (« incognito qui garde les cookies »)
   → pas de réconciliation : au démarrage `reconcileVaults()` **efface** le
   plaintext qui traîne d'un profil chiffré (le vault fait foi), `discardPlaintext`
   dans vault-service.
3. Password en clair en RAM tant que déverrouillé = accepté.

## UI dialog mot de passe (FAIT + flux in-app validé 2026-07-12)

Dialog natif dans Settings → Profiles (`VaultPasswordDialog`, boutons
Encrypt/Unlock/Lock, badge locked) ; cycle encrypt→unlock→use→lock exercé en vrai.

## Saga « perte des cookies » (reloggué à chaque cycle)

### Première cause trouvée + fix (2026-07-12)

Electron met en cache l'objet `Session` d'une partition pour toute la vie de l'app
et ne la relit JAMAIS quand le vault échange les fichiers dessous → un 2ᵉ unlock
dans le même run sert une session vide = déloggué (prouvé : disque = 37 cookies,
fichier même pas retouché, mais session vide).

**Fix = partition à nonce par unlock** (`noncePartitionDir` → dossier live
`mira-<id>-<nonce>` jamais vu d'Electron → session fraîche qui lit les cookies
restaurés) ; toute résolution de partition passe par `effectivePartition` (map
`unlockedPartition`) ; `flushStore()` / `flushStorageData()` au lock avant la
copie ; éviction + `ProfileData.dispose()` des caches `dataById` / `bookmarksById`
au lock/unlock (annule les timers de debounce → règle aussi la fuite `history.json`
recréé APRÈS l'effacement) ; `reconcile` efface les dossiers à nonce orphelins par
nom (`discardProfilePlaintext` + `isProfilePartitionDir`, glob).

Validé en dev : unlock → use → lock → re-unlock garde les cookies.

### Bug revenu, VRAIE cause (2026-07-12)

Le nonce n'était PAS la cause récurrente. Prouvé (banc Electron isolé) que copier
la partition **sans flush** perd même les cookies **persistants** (Chromium les
bufferise en RAM) ; et Mira ne re-chiffrait le vault qu'à la **fermeture de
fenêtre** (auto-lock), **jamais au quit de l'app** → quitter avec le profil ouvert
(`open:true` dans sessions.json) figeait le vault au dernier lock, `reconcileVaults`
effaçant le plaintext au boot → chaque session re-jetée.

Chiffrement **hors de cause** (cookies stockés en clair, pas de clé « Mira Safe
Storage » au Keychain → fallback, non chiffré).

**Fix (code fait) = lock-au-quit** : `before-quit` diffère le quit, ferme les
fenêtres, re-chiffre tous les vaults ouverts, puis quitte (`lockAllVaults` /
`performVaultLock` extrait, garde `lockingAll` pour ne pas doubler l'auto-lock) ;
+ flush ajouté à `encrypt-profile` ; + commande pilotable `lock-all-vaults`
(panic-lock). Tests unitaires + doc socket à jour.

### Résidus non corrigés (mineurs)

- Cookies de session perdus par cycle (normal).
- `flushStorageData` non `await` (masqué par le délai hdiutil).

## Reste à faire

**PAS ENCORE VALIDÉ EN VRAI** (natif Electron, hors tests unit) → à exercer :
unlock → login → Cmd+Q → re-unlock → toujours loggé. Pour activer le fix : fermer
la fenêtre du profil chiffré (sauve via l'ancien auto-lock) PUIS redémarrer Mira
pour charger le nouveau code.
