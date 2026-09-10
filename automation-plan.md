# Automation — rendre le pilotage de Mira rapide

Brief pour une session dédiée. Écrit le 08/09/2026 après une session qui a piloté
Notion à la main pendant vingt minutes et qui a mesuré d'où venait la lenteur.

## Ce que la mesure dit — et ce qu'elle ne dit pas

**Mira n'est pas lente.** Mesuré le 08/09/2026 avec `/usr/bin/time -p`, Mira
tournant avec ses deux profils ouverts et 136 onglets, sur une page Notion
chargée :

| Ce qui est mesuré | Durée |
| --- | --- |
| aller-retour socket brut (client python, `exec-js` trivial) | **< 1 ms** |
| `mira exec` de bout en bout (process node compris) | **40 ms** |
| `mira exec` d'un `innerText` sur la page Notion entière | 40 ms |
| `mira tabs`, `mira windows` | 40–50 ms |
| `mira press` | 60 ms |
| `mira shot` | 110 ms |
| **trois `exec-js` pipelinés sur UNE connexion** | **< 1 ms au total** |

⚠️ **Piège de mesure, à ne pas refaire.** Chronométrer en encadrant la commande
de deux `python3 -c 'time.time()'` donne 226 ms sur *tout*, `mira help` compris
— qui ne touche même pas le socket. C'est le démarrage de python sous pyenv
(200 ms), pas Mira. Utiliser `/usr/bin/time -p`, ou `time` du shell.

**Ce qui est lent, c'est la forme du pilotage : une commande = un process = un
tour d'agent.** La séquence qui a servi de cas d'étude (ouvrir les réglages
Notion et atteindre Settings → People) a coûté ~25 appels, dont **35 secondes de
`sleep` à l'aveugle** et **cinq appels rien que pour un clic**, dont deux ratés.
Aucun de ces coûts n'est dans Mira ; tous les trois viennent de capacités
absentes du CLI.

`mira commands` au 08/09/2026 rend ~120 commandes et **aucune** ne matche
`click`, `mouse`, `wait`, `batch`, `scroll` ni `type` — seul `press-key` existe.

## Les trois chantiers, dans cet ordre

### 1. `mira batch` — replier N tours en un

**Le gain le plus gros pour le moins de code, et le daemon est déjà prêt.**
Vérifié : trois requêtes JSON envoyées d'affilée sur une seule connexion
reçoivent leurs trois réponses, en moins d'une milliseconde. Le protocole est
déjà du JSON-par-ligne. **Il n'y a donc rien à faire côté main : c'est un
changement CLI seul.**

Aujourd'hui `bin/mira` ouvre une connexion, envoie **une** requête, lit **une**
réponse et sort (c'est écrit en tête du fichier). Chaque commande paie donc un
process node, et surtout un tour d'agent.

Ce qu'il faut :

```bash
mira batch @script.mira        # un fichier, une commande par ligne
mira batch -                   # ou depuis stdin
```

- Format d'une ligne : exactement ce qu'on taperait après `mira`
  (`exec document.title`, `press , --mod meta`, `wait --text Settings`), plus
  les commentaires `#` et les lignes vides ignorés.
- Une seule connexion, requêtes pipelinées, réponses lues dans l'ordre.
- **Arrêt au premier échec par défaut** (`--keep-going` pour continuer) : dans
  une séquence d'automation, tout ce qui suit un clic raté est du bruit.
- Sortie : une ligne par commande, préfixée de son index, plus un résumé
  `N ok, M failed`. `--json` rend le tableau brut des réponses.
- Exit code : 0 si tout passe, 1 sinon.
- La cible d'onglet (`--tab` / `$MIRA_TAB` / `--profile`) se pose **une fois**
  sur la commande `batch` et s'applique à toutes les lignes, chaque ligne
  pouvant la surcharger.

Où : la logique de parsing va dans `src/cli/mira-core.mjs` (pure, testée) ;
`bin/mira` ne fait que l'I/O. Ajouter les tests unitaires du parseur à côté.

### 2. Une attente conditionnelle — tuer les `sleep`

Sans elle, un agent écrit `sleep 3` : trop long quand la page est déjà prête
(c'est la lenteur ressentie), trop court quand elle ne l'est pas (c'est le faux
négatif, bien pire — on conclut « l'élément n'existe pas » alors qu'il arrive
200 ms plus tard).

Nouvelle commande de registre, **nouveau fichier de domaine**
`src/main/commands/wait.ts` (+ sa slice `WaitContext`, + `wait.test.ts`, + la
ligne d'import/spread dans `commands/index.ts` — c'est la seule ligne partagée à
toucher, cf. `.claude/rules/command-registry.md`).

```bash
mira wait --selector '[role=dialog]'      # attend qu'il apparaisse
mira wait --text 'Settings'               # attend un texte visible
mira wait --url '/settings'               # attend une navigation
mira wait --gone --selector '.spinner'    # attend une disparition
```

- Polling **dans la page** (via le même chemin que `exec-js`), pas côté node :
  un aller-retour socket par tentative serait absurde à 50 ms d'intervalle.
- `--timeout` en ms, défaut 5000. Au dépassement : `ok:false` avec un message
  qui dit **ce qui a été cherché et pendant combien de temps** — jamais un
  succès silencieux.
- Rend le temps réellement attendu, pour que l'appelant voie ce que ça coûte.
- ⚠️ `exec-js` coupe à 5 s (constaté sur un upload, cf. le skill `mira`) : le
  polling ne doit pas être un `await` long dans un seul `exec-js`, sinon il
  meurt à 5 s. Soit une boucle côté main qui réévalue, soit un timeout par
  tentative bien en dessous.

### 3. Une vraie souris — `mira click`

**C'est le manque qui coûte le plus cher par occurrence.** `press-key` passe par
CDP `Input.dispatchKeyEvent`, donc `isTrusted: true`. Il n'a **aucun équivalent
souris** : tout clic doit être reconstruit à la main en `exec-js`, en
dispatchant `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` avec
les bons `clientX`/`clientY`, sur le bon ancêtre — et beaucoup d'apps ignorent
ces événements synthétiques. Sur le cas Notion, il a fallu cinq appels et deux
échecs pour un seul clic sur « Settings ».

```bash
mira click --selector 'button[aria-label=Close]'
mira click --text 'Settings'          # premier élément visible portant ce texte
mira click --at 320,180               # coordonnées viewport
mira click --text 'Réglages' --nth 2  # désambiguïsation
```

Implémentation : **`Input.dispatchMouseEvent`** (`mousePressed` puis
`mouseReleased`, `button: 'left'`, `clickCount: 1`), exactement le même chemin
que `pressKeyInTab` dans `src/main/profiles.ts:5779` — reprendre sa mécanique
telle quelle :

- même résolution d'onglet et mêmes erreurs que `exec-js`
  (`webContentsForTab`) ;
- **même garde de visibilité** (`ensurePageVisibleForInput`) : Chromium ne
  délivre l'input qu'à un onglet visible, et un onglet caché avale le clic en
  répondant `ok` — le pire des échecs. Échouer bruyamment plutôt que mentir ;
- même discipline de debugger : n'attacher que si personne n'est attaché, ne
  détacher que ce qu'on a attaché soi-même (laisser celui du shim stealth).

Résolution de la cible : `--selector` / `--text` se résolvent **dans la page**
en un `getBoundingClientRect()`, puis on clique au centre. Refuser si l'élément
est hors viewport ou de taille nulle, en le disant (et offrir `--scroll` qui
`scrollIntoView` avant, plutôt que de cliquer dans le vide).

La commande va dans **`src/main/commands/input.ts`**, le domaine existe déjà et
c'est exactement son métier (le fichier dit « the keyboard counterpart to
exec-js » — la souris est le troisième pilier manquant). La traduction pure
nom→payload vit dans `src/main/input-keys.ts` pour le clavier ; faire pareil
pour la souris, dans le même fichier ou un `input-mouse.ts` frère, pour rester
testable sans Electron.

## Déjà fait, à ne pas refaire

**Le bug de ponctuation de `press-key` est corrigé** dans le working tree, avec
ses tests (17 passent, `npx vitest run src/main/input-keys.test.ts`) :
`src/main/input-keys.ts` a désormais une table `PUNCTUATION` (chaque caractère →
son vrai `code` US : `,` → `Comma`, `?` → `Slash`, `*` → `Digit8`) et une table
`PUNCTUATION_ALIASES` (les noms épelés que le shell passe sans quoter :
`Comma`, `Slash`, `Space`…).

Le symptôme, pour comprendre la classe de bug : `resolveKey` rendait `code: ''`
pour toute ponctuation. Taper un caractère n'a besoin que de `text`, mais un
**raccourci se matche sur `code`** — donc `Cmd+,` (les réglages de Notion,
Slack, VS Code) partait, répondait `ok`, et ne faisait rien. Un échec qui se
présente comme un succès.

⚠️ **Ce correctif n'est pas dans le build qui tourne.** Il faut un rebuild
(`./bin/build.sh`) pour le vérifier en vrai — et **un rebuild se demande à
Mickael**, il quitte Mira, donc les autres sessions qui s'en servent.

## Contraintes à respecter (elles viennent du repo, pas de moi)

- **Une commande = un nom + un schéma de params dans le registre**, atteignable
  à l'identique par IPC, socket et MCP. Rien de tout ça ne doit être une astuce
  du CLI qui bricole en `exec-js` — sauf `batch`, qui est bien du CLI pur.
- **Un fichier par domaine** dans `src/main/commands/`, et une seule ligne
  partagée à toucher (l'import + le spread dans `index.ts`). Mira est vibe codé
  sur plusieurs sessions en parallèle : deux sessions dans le même fichier =
  écrasement. Détail : `.claude/rules/command-registry.md`.
- **Une feature = un test** (Vitest, `npm test`). Si une commande est trop
  couplée à Electron, extraire sa logique pure et ne laisser que l'appel natif.
- **Ne jamais appeler `focus-app` ni `mira focus`** pour se débloquer. C'est le
  navigateur de tous les jours de Mickael, ouvert derrière son éditeur : chaque
  remontée lui coupe ce qu'il tape. Si une commande échoue parce que la fenêtre
  est cachée, le dire.
- **Tester sur un onglet en `--background`, dans un profil isolé**, pas sur ses
  onglets à lui. Voir `.claude/rules/piloting-and-testing.md`.
- **Ne lancer ni tuer aucun process sans le demander** (donc pas de
  `npm run dev`, pas de `build.sh`, pas de relance de Mira de sa propre
  initiative).

## Ce qui prouve que c'est fini

Rejouer la séquence qui a servi de cas d'étude — ouvrir les réglages Notion et
atteindre People — **en un seul `mira batch`**, sans un seul `sleep`, sans un
seul `exec-js` qui fabrique des `MouseEvent` à la main. Elle a coûté 25 appels
et vingt minutes ; elle doit tenir en un fichier de dix lignes.
