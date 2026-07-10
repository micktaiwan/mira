# Plan — Skills contextuels par site (`skills`)

Posé le 2026-07-10 (ex `actions-plan.md`, renommé « skills » le 2026-07-10). Spec de
démarrage : le concept est arrêté, l'implémentation reste à faire. L'archi générale
et les deux principes fondateurs vivent dans `CLAUDE.md` ; l'état d'avancement vivra
dans `track.md`. Ce doc porte le plan + les **questions ouvertes** (marquées ❓) à
trancher au fur et à mesure. Approche assumée : on **crée le premier skill** et on
affine le modèle en avançant — plusieurs points ci-dessous ne se trancheront qu'au
contact du code.

> **Désambiguïsation.** Ici, un « skill » = une **capacité de Mira sur un site donné**
> (résumer cette conversation, répondre, capitaliser…). C'est distinct des **skills
> de Claude** (les `/skills` du harness). Comme Mira est pilotable par Claude via MCP,
> le risque de collision de vocabulaire existe : quand un skill Mira apparaît au socket
> / MCP, le nommer sans ambiguïté (préfixe `skill:` / commandes `list-skills`,
> `run-skill`).

## 1. Le concept

Un **skill** est une **capacité contextuelle pilotée par une conf par site**.

Sur la page courante, Mira lit le contenu, regarde de quel site il s'agit, et propose
le **jeu de skills défini pour ce site**. Chaque skill a son propre **prompt système**
et son propre comportement.

Exemple canonique — je suis sur LinkedIn dans une conversation. Les skills du site :

- **Résumer la conversation** → texte affiché (dans un pane à droite, voir §2).
- **Répondre automatiquement** → génère une réponse (V2 : la réinjecte dans la zone
  de compo ; V1 : affichée, je copie-colle).
- **Capitaliser dans le SC** → envoie le contenu vers mon second cerveau (fichier /
  Panorama / skill Claude `/capitalise`).

**Où ça se surface — dans la palette Cmd+K.** [DÉCIDÉ 2026-07-10] Les skills applicables
au site actif apparaissent comme des **entrées dynamiques de la palette**, sous un groupe
**« Skills sur cette page »** — exactement le mécanisme `buildPaletteEntries` déjà en
place (voir `src/main/palette.ts`). Pas de surface d'entrée séparée : la palette est
déjà le hub d'actions, les skills en sont une source de plus. `list-skills` (voir §3)
alimente ces entrées ; choisir une entrée lance `run-skill`.

L'intérêt d'un feature natif (vs une extension Chrome) : il s'inscrit dans les **deux
principes fondateurs** de Mira. Un skill = une commande du registre, donc **pilotable**
(socket + MCP → un agent peut lancer un skill sur ma page depuis une conversation) et
**testable** (la logique de résolution site→skills est un test Vitest, sans lancer
Chromium). Décision prise le 2026-07-10 : on fait d'abord le natif dans Mira, pas une
extension. La portabilité vers d'autres navigateurs n'est pas un objectif.

## 2. L'abstraction centrale : un skill

La conf d'un site = une **liste de skills**. Un skill est décrit par :

| Champ | Rôle |
|---|---|
| `name` | Libellé affiché dans la palette (« Skills sur cette page ») |
| `match` | Quand le skill s'applique (domaine, pattern d'URL, éventuellement un sélecteur — voir ❓ extraction) |
| `prompt` | Le prompt système propre au skill |
| `source` | Ce qu'on extrait de la page et qu'on donne à l'IA (voir §4) |
| `sink` | Où va le résultat (voir ci-dessous) |

### La destination (`sink`) — dépend du skill

Le résultat ne va **pas toujours au même endroit** : c'est le skill qui décide. Trois
familles, de difficulté croissante — c'est le cœur du découpage V1/V2 :

1. **Pane à droite** — ex. résumer la conversation → un texte AI s'affiche dans un
   **panneau latéral droit** de Mira. **Nouvelle surface chrome.** Point clé (piège #3
   du `CLAUDE.md`) : ce pane **rétrécit la vue web** (on réduit la largeur du
   `WebContentsView`, comme la sidebar le décale à gauche), il ne **déborde donc pas**
   par-dessus la page → pas de couche native au-dessus, pas le problème de l'overlay.
   **Périmètre V1** (c'est la surface d'affichage par défaut). *(surface à construire)*
2. **Sur la page elle-même** — ex. répondre auto qui écrit dans la zone de compo, ou
   annoter/surligner. C'est un **write DOM** dans la `WebContentsView`. **Fragile**
   (dépend du HTML du site, casse quand le site change). **Différé V2** (voir §6).
3. **Sortie externe** — ex. capitaliser dans le SC → écrit un fichier / appelle
   Panorama / déclenche un skill Claude. Le skill tape dans un outil **hors Mira**
   (socket, MCP, script). ❓ dans le périmètre V1 ? (voir Questions ouvertes)

### L'asynchrone — un hourglass dans la surface concernée

`run-skill` appelle une IA : c'est **lent** (réseau + modèle), contrairement à toutes
les commandes actuelles quasi-instantanées. Le retour visuel « ça travaille » vit **dans
la surface du sink**, et dépend donc du skill : un **hourglass / spinner** dans le pane
à droite pour un résumé, ou un indicateur dans l'UI pour un skill qui écrit sur la page.
Modèle exact (streaming token par token ? annulation ? état d'erreur ?) : **à creuser
au premier skill.** ❓

## 3. Surface registre (le « tout pilotable »)

Deux commandes dans le registre (domaine `commands/skills.ts`, sur le modèle de
`commands/tabs.ts` / `commands/palette.ts`) :

- **`list-skills`** — pour la page/le site courant, retourne les skills applicables
  (`{ name, ... }`). Alimente les entrées « Skills sur cette page » de la palette *et*
  est interrogeable au socket/MCP.
- **`run-skill`** — exécute un skill nommé : extrait la source, appelle l'IA avec le
  prompt, applique le `sink`. Asynchrone (voir §2).

Conséquence directe : depuis une conversation Claude (via MCP, wrapper du socket), je
peux lister et lancer un skill sur la page ouverte dans Mira.

La logique **pure et testable** à isoler (un test Vitest, pas de Chromium) : la
**résolution** `(url, conf) → liste de skills applicables`. L'appel IA et le DOM sont
les bords non-testés unitairement (comme les bits natifs Electron ailleurs).

## 4. Extraction du contenu

Par défaut, extraire le **texte propre** de la page, pas `document.body.innerText`
(pollué par menus/pubs/footers). État de l'art : **Readability.js** (la lib du mode
lecture de Firefox) injectée dans la `WebContentsView`, résultat remonté par IPC.

Mais l'exemple LinkedIn montre le besoin de cibler un **bout précis** (juste le fil de
la conversation, pas toute la page). D'où la question ouverte sur la granularité de la
source par skill (❓ §Questions ouvertes).

## 5. Le moteur IA

❓ **API distante vs local — non tranché.** Deux voies :

- **API** (Claude / OpenAI) : qualité max, clé stockée côté main process (Node, pas les
  contraintes MV3), appels sans CORS. Coûte, et le contenu part chez un tiers.
- **Local** (Ollama sur `localhost`) : gratuit, privé, mais qualité moindre et dépend du
  Mac allumé.

Piste par défaut à confirmer : commencer en **API, clé en conf locale**, ajouter le
local ensuite si l'usage suit. À trancher au moment d'implémenter.

## 6. Différé V2 — réinjection HTML dans la page

Le cas « répondre auto qui écrit directement dans la zone de compo LinkedIn ». Hors
périmètre V1 (affichage dans le pane droit seul). C'est le morceau fragile : écrire dans
le DOM d'un site tiers dépend de son HTML (sélecteurs qui cassent, champs
contenteditable/React qui n'acceptent pas un simple `.value =`, events synthétiques à
dispatcher pour que le site enregistre la saisie). À spécifier proprement quand on
l'attaque — ne pas l'improviser en V1.

## 7. Questions ouvertes (à trancher, souvent au premier skill)

- ❓ **Granularité de l'extraction.** Tous les skills lisent-ils la même chose (l'article
  Readability entier), ou un skill peut-il cibler un **bout précis** de la page via un
  sélecteur (le fil de conv LinkedIn) ? Détermine si `source` porte un sélecteur.

- ❓ **Modèle async précis.** Streaming token par token dans le pane, ou affichage en
  une fois à la fin ? Annulation ? État d'erreur ? À creuser au premier skill.

- ❓ **Édition de la conf par site — « UI intelligente ».** Une UI pour définir/éditer
  les skills d'un site, pas juste un JSON à la main. Forme à concevoir plus tard.
  Sous-questions : où vit la conf (fichier type `~/.mira/skills.json` ? par profil ?),
  comment on l'édite (Settings ? capture du sélecteur en pointant l'élément ?), skills
  globaux par défaut + overrides par site.

- ❓ **Sortie externe en V1 ?** Le skill « capitaliser dans le SC » (sink externe)
  entre-t-il dans le premier jet, ou V1 = pane droit + le externe vient juste après ?

- ❓ **Moteur IA** : API vs local en premier (voir §5).

## 8. Périmètre V1 (proposé)

- Skills du site courant listés comme entrées **« Skills sur cette page »** dans la
  palette Cmd+K (`list-skills`).
- `run-skill` avec **sink = pane à droite** (nouvelle surface chrome qui rétrécit la vue
  web), hourglass pendant l'appel.
- Extraction Readability par défaut.
- Une conf par site minimale (forme à décider — l'UI intelligente est différée).
- Moteur IA branché sur une API avec clé locale (à confirmer).
- **On code un premier skill concret (ex. résumer une conv) de bout en bout**, et on
  laisse le modèle se stabiliser à partir de ce cas réel.

Réinjection HTML (§6), UI d'édition intelligente (§7) et sortie externe explicitement
hors V1 (sauf décision contraire).
