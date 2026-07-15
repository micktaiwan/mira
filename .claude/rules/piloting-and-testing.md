---
paths:
  - "src/main/**"
  - "docs/socket.md"
  - "scratchpad/**"
  - "**/*.test.ts"
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
- **Pour ouvrir un onglet de test, TOUJOURS `new-tab` avec `background:true`.** Un `new-tab` normal met l'onglet actif ET ramène Mira au premier plan, ce qui vole le focus de l'utilisateur pendant que tu testes. Le mode background charge la page cachée sans voler le focus ni faire passer la fenêtre devant ; tu récupères le `tabId` dans la réponse et tu la pilotes via `exec-js`.
- **Profil de test isolé.** Un profil dédié (session/cookies à part) existe pour ne pas polluer les profils réels. Son id concret et son usage vivent dans `CLAUDE.local.md` (non versionné).

## Lancer Mira à froid sur un seul profil (`--profile` / `MIRA_PROFILE`)

Au démarrage, Mira rouvre par défaut les profils qui étaient ouverts au dernier quit. Pour **démarrer à froid sur un seul profil** (typiquement le profil de test), sans rouvrir les autres :

- Flag CLI : `--profile <id>` ou `--profile=<id>`.
- Ou variable d'env : `MIRA_PROFILE=<id>` (le flag l'emporte si les deux sont posés).

Un id inconnu n'est pas fatal : Mira loggue un warning et retombe sur la restauration normale (dernier set ouvert). Parsing pur et testé dans `parseProfileArg` (`src/main/profile-store.ts`), branché au boot dans `src/main/index.ts` via `openSavedProfiles(explicitProfileId)`.

Le mécanisme est implémenté et couvert par des tests unitaires ; **pas encore vérifié en vrai** l'invocation shell exacte pour injecter le flag/env dans l'app packagée (`open -a Mira --args --profile <id>` devrait passer par `--args`, l'héritage de `MIRA_PROFILE` via `open` reste à confirmer). À valider au premier usage.
