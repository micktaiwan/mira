---
paths:
  - 'src/main/**'
  - 'docs/socket.md'
  - 'scratchpad/**'
  - '**/*.test.ts'
---

# Piloter Mira par socket + tester dans un profil isolé

Ces notes servent quand tu pilotes une Mira qui tourne (tests, debug) via le
socket de contrôle `MIRA_SOCKET` (défaut `/tmp/mira.sock`). Protocole complet et
liste des commandes : `docs/socket.md` ; en live, la commande `list-commands`
liste les noms connus du build qui tourne.

**✅ Premier réflexe : le CLI `mira` (`bin/mira`).** C'est un client mince au-dessus du socket, écrit pour tuer exactement les frictions ci-dessous (piège `nc`, `tabId` à résoudre à la main, JSON fabriqué à la main). Il tourne sans build (`.mjs`, ESM natif), contre la Mira live. Invoquer par chemin : `/Users/mickaelfm/projects/perso/mira/bin/mira <verbe>`. Logique pure et testée dans `src/cli/mira-core.mjs` (+ `.test.ts`).

```bash
MIRA=/Users/mickaelfm/projects/perso/mira/bin/mira
$MIRA tabs                              # liste les onglets (id / titre / url), * = actif
eval "$($MIRA use --url localhost:8000)" # pin un onglet → export MIRA_TAB=<uuid> (session courante)
$MIRA exec "document.title"             # exec-js sur l'onglet pinné (ou actif si rien de pinné)
$MIRA reload                            # reload l'onglet pinné (via exec-js) ou actif
$MIRA shot /tmp/page.png [--full]       # capture PNG de l'onglet pinné/actif (--full = document entier)
$MIRA nav example.com                   # navigate l'onglet actif
$MIRA commands                          # list-commands du build qui tourne
$MIRA call select-tab --params '{"id":"<uuid>"}'  # passthrough générique vers N'IMPORTE quelle commande
```

Statefulness **par l'environnement, jamais un fichier partagé** : `MIRA_TAB` pin « l'onglet à travailler » pour MA session shell uniquement → deux sessions Claude ne s'écrasent jamais la cible. Précédence calquée sur `--profile`/`MIRA_PROFILE` : `--tab <id>` > `$MIRA_TAB` > onglet actif de la fenêtre focus. Garde-fou : un `MIRA_TAB` périmé fait **échouer bruyamment** (`unknown tab: <id>`, exit 1), il ne retombe jamais en douce sur l'actif. Code exec-js verbeux : `$MIRA exec @fichier.js` ou `… | $MIRA exec -` (stdin), pour esquiver le quoting shell. Sortie brute JSON : `--json`. Exit code 0/1 sur `ok`, 2 sur erreur de transport — donc branchable en Bash.

Sous le CLI il y a toujours le socket brut. **Ne PAS le piloter avec `printf … | nc -U`.** Le `nc` de macOS ferme la connexion dès que stdin fait EOF (juste après le `printf`), donc il **rate toute réponse asynchrone** : `get-status` (réponse instantanée) passe parfois, mais `exec-js` et toute commande qui `await` (CDP, navigation…) renvoient **0 octet** — un « vide » trompeur qui ressemble à un hang ou à un bug de la commande (vérifié le 2026-07-11, m'a fait perdre des heures à croire exec-js cassé). Fix fiable : un **client socket brut** qui lit jusqu'au `\n`. Helper posé pour les sessions de debug : `scratchpad/mira.py` (`call({...})` / `execjs(tabId, code)`), à recréer si absent :

```python
import socket, json
def call(obj, timeout=30):
    s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout); s.connect('/tmp/mira.sock')
    s.sendall((json.dumps(obj)+'\n').encode()); buf=b''
    while b'\n' not in buf:
        c=s.recv(65536)
        if not c: break
        buf+=c
    return json.loads(buf.decode())
```

Dépannage rapide en shell si vraiment besoin de `nc` : garder stdin ouvert le temps de la réponse — `{ printf '%s\n' '{…}'; sleep 1; } | nc -U /tmp/mira.sock`. Mais préférer le client Python.

## Forme des requêtes socket (pièges vécus)

- **Champ `"command"`, pas `"cmd"`.** Le socket Kova utilise `{"cmd":…}` ; Mira attend `{"command":…}`. Un `"cmd"` renvoie `missing "command" field`.
- **Les params sont nichés sous `"params"`, jamais à plat.** `{"command":"install-extension","id":"…"}` échoue avec `"id" must be a non-empty string`. Forme correcte : `{"command":"install-extension","params":{"id":"…"}}`. Exemple complet : `{"command":"navigate","params":{"url":"example.com"}}`.

## exec-js et onglets de test

- **`exec-js` prend un `tabId`** (UUID via `list-tabs`) : toujours le passer pour viser un onglet précis. Un onglet endormi renvoie `{"ok":false,"error":"tab is asleep"}` (le réveiller via `select-tab`). Pour du code async, `exec-js` peut ne pas attendre la promesse dans certains builds — contourner par « lance l'async, stocke dans `window.__x`, relis en sync » sur un 2ᵉ appel.
- **Aucune commande socket ne remonte Mira au premier plan.** Depuis le fix « foreground policy » (`src/main/foreground-policy.ts`), une commande qui arrive par le socket/MCP fait son travail sans jamais activer l'app : `new-tab`, `navigate`, `open-url`, `open-profile`, `activate-tab`, `press-key`, `detach-tab`. Seul `focus-app` remonte Mira, et c'est sa seule raison d'être. La même commande venue de l'UI (clic, Cmd+T) garde l'ancien comportement.
- **`background:true` reste utile, mais pour autre chose** : il empêche la fenêtre de _basculer_ sur le nouvel onglet, donc rien ne bouge à l'écran. `new-tab {background:true}`, `navigate {newTab:true,background:true}`, ou `mira open <url> -b`. Tu récupères le `tabId` dans la réponse et tu pilotes via `exec-js`.
- **Profil de test isolé.** Un profil dédié (session/cookies à part) existe pour ne pas polluer les profils réels. Son id concret et son usage vivent dans `CLAUDE.local.md` (non versionné).

## Piloter au clavier (vraie frappe) et onglets cachés

Pour les web apps **clavier-first** (Kondo, Superhuman : archiver avec `e`, `j`/`k`, `Escape`), utiliser `press-key`, pas un `KeyboardEvent` synthétique via `exec-js`.

- **Les events synthétiques sont ignorés.** Un `document.dispatchEvent(new KeyboardEvent(...))` a `isTrusted:false` ; ces apps le rejettent (vérifié le 2026-07-15 : synthétique `l` n'ouvre PAS le menu Label de Kondo). `press-key` passe par CDP `Input.dispatchKeyEvent` → `isTrusted:true`, indistinguable d'une frappe physique.
- **CLI** : `mira press <key> [--mod alt,ctrl,meta,shift]`. `key` = nom façon `KeyboardEvent.key` (`e`, `Enter`, `ArrowDown`, ` `). Socket : `press-key {key, tabId?, modifiers?}`.
- **Une vraie frappe n'atteint qu'un onglet VISIBLE.** Chromium droppe silencieusement l'input d'un onglet caché (arrière-plan / `document.visibilityState !== "visible"`). Le **focus OS de la fenêtre n'est PAS requis** — un onglet visible dans une fenêtre non-focus reçoit quand même la frappe (vérifié le 2026-07-15). `press-key` **rend l'onglet cible visible d'abord** — il le passe actif dans SA fenêtre, et si la page est toujours cachée (fenêtre minimisée ou entièrement recouverte, l'occlusion macOS marque la page `hidden`) il la remet à l'écran par `restore` + `showInactive` + `moveTop`, **sans jamais activer l'app**. Si ça ne suffit pas, il échoue (`tab could not be made visible for input`) au lieu de faire un faux succès — dans ce cas, `focus-app` d'abord.

**Fenêtres multiples & activation cross-fenêtre.** Un profil peut avoir plusieurs fenêtres ; `list-tabs`/`mira tabs` ne montrent que les onglets de la fenêtre cible, `mira windows` liste les fenêtres (`*` = focus). Piège : `select-tab` n'active un onglet que dans la **fenêtre focus** (`unknown tab` sinon), alors que `exec-js`/`press-key` résolvent le `tabId` cross-fenêtre. Pour rendre visible un onglet de N'IMPORTE quelle fenêtre : **`activate-tab {id}`** (le fait passer actif dans sa fenêtre ; il ne remonte plus la fenêtre depuis le socket). `mira tabs` marque `*` l'onglet actif/visible et `z` les onglets endormis (page-bound échoue dessus tant qu'ils ne sont pas réveillés).

## Lancer Mira à froid sur un seul profil (`--profile` / `MIRA_PROFILE`)

Au démarrage, Mira rouvre par défaut les profils qui étaient ouverts au dernier quit. Pour **démarrer à froid sur un seul profil** (typiquement le profil de test), sans rouvrir les autres :

- Flag CLI : `--profile <id>` ou `--profile=<id>`.
- Ou variable d'env : `MIRA_PROFILE=<id>` (le flag l'emporte si les deux sont posés).

Un id inconnu n'est pas fatal : Mira loggue un warning et retombe sur la restauration normale (dernier set ouvert). Parsing pur et testé dans `parseProfileArg` (`src/main/profile-store.ts`), branché au boot dans `src/main/index.ts` via `openSavedProfiles(explicitProfileId)`.

Le mécanisme est implémenté et couvert par des tests unitaires ; **pas encore vérifié en vrai** l'invocation shell exacte pour injecter le flag/env dans l'app packagée (`open -a Mira --args --profile <id>` devrait passer par `--args`, l'héritage de `MIRA_PROFILE` via `open` reste à confirmer). À valider au premier usage.

### Dev « scratch » : booter le seul profil de test, ses onglets restaurés

`npm run dev:scratch` (script dans `package.json`) démarre `electron-vite dev` avec `MIRA_PROFILE` posé sur l'id du profil de test — c'est-à-dire boot de CE profil seul (les autres profils réels ne sont pas rouverts, ni réécrits au quit), en **restaurant ses onglets sauvegardés** (`content: 'restore'`, pas de wipe) pour reprendre les tests là où on s'est arrêté. Ça partage le userData réel (pas d'isolation) : voulu, pour garder cookies/logins/onglets du profil de test. L'id vit dans `.dev-scratch-profile` (git-excluded, absent d'un clone public — le script retombe alors sur la restauration normale, c'est OK). Ne remplace pas `npm run dev` (qui rouvre tout).
