# Settings par profil — discussion (RIEN N'EST ACTÉ)

**Statut : ouvert. Aucune décision prise. Aucun code écrit sur ce sujet.**
Ce fichier ne fait que **tracer** une discussion pour ne pas la reperdre. Il ne
décrit pas un chantier lancé ni une orientation retenue. Tant que cette ligne
est là, on ne fait rien.

## La question posée

Aujourd'hui les settings de Mira sont-ils par profil ? Et si on les passait par
profil, quels seraient les impacts ?

## État actuel (VÉRIFIÉ dans le code, 2026-07-10)

Les settings sont **100 % globaux**, partagés par tous les profils :

- Un seul fichier `userData/settings.json`, chargé/écrit dans `index.ts:123-137`.
- Une seule copie `this.appSettings` dans le `ProfileManager` (`profiles.ts:181`),
  utilisée par toutes les fenêtres.
- `getSettings` / `setHomeUrl` **ignorent** le `target` (la fenêtre profil) et
  lisent/écrivent le singleton (`profiles.ts:1056-1061`).
- Il n'existe qu'**un seul setting** aujourd'hui : `homeUrl` (URL d'ouverture d'un
  nouvel onglet / d'une fenêtre fraîche). Depuis 2026-07-10, une valeur vide =
  onglet blanc (`about:blank`, barre d'adresse vide).

## Ce qui rendrait le passage par profil peu coûteux

1. **Le contexte de commande connaît déjà le profil.** `makeContext(target)`
   reçoit la fenêtre ciblée ; `getSettings`/`setHomeUrl` pourraient adresser le
   bon profil sans nouvelle plomberie de routage. La surface Settings étant un
   onglet *dans* une fenêtre profil, « quel profil édite-t-on ? » a une réponse
   naturelle : celui de la fenêtre.
2. **Le pattern de persistance par profil existe déjà.** `sessions.json` est un
   `Record<profileId, …>` (`session-store.ts`). On copierait ce modèle — pas de
   convention nouvelle à inventer.

## Impacts concrets si on le faisait

- `settings-store.ts` : ajouter un normalizer de **map** `Record<profileId,
  AppSettings>` (comme `normalizeSessions`) ; définir le défaut d'un profil sans
  entrée.
- Stockage (`index.ts`) : `settings.json` devient une map par id. **Migration**
  du fichier plat actuel `{homeUrl}` (l'appliquer au `default` ? à tous ?) sinon
  on perd le réglage existant.
- `ProfileManager` : `this.appSettings` (une valeur) devient une
  `Map<profileId, AppSettings>`. Le dep constructeur `homeUrl` devient une seed
  par profil ou un défaut de repli.
- Les 3 lectures de home (`profiles.ts` ~335, ~773, ~1071) :
  `this.appSettings.homeUrl` → `homeFor(pw.id)`. C'est le cœur fonctionnel : un
  nouvel onglet ouvre le home **de son profil**.
- `getSettings`/`setHomeUrl` : adressent `target.id`.
- Fenêtre fraîche / restore : home du profil concerné.
- Tests + `fake-context` : `state.homeUrl` (string) → `state.homeUrl[profileId]`.

Blast radius réel mais **borné** : un seul setting fonctionnel à ne pas casser.

## Le vrai piège de conception (à trancher avant de coder)

La question n'est pas « par profil : oui/non », c'est **« tous les settings
sont-ils per-profile ? »**. `homeUrl` est per-profile pertinent (profil boulot →
home boulot). Mais un futur réglage (thème UI, moteur de recherche par défaut)
serait plutôt **app-wide**. Tout passer en per-profile = risque de dupliquer un
réglage global dans chaque profil (deux sources de vérité qui divergent) ou de
re-splitter plus tard. Le modèle propre serait **deux buckets** : `AppSettings`
(global) + `ProfileSettings` (par id).

## Question ouverte non tranchée (UI)

Quand on ouvre Settings dans la fenêtre du profil A : éditer **A uniquement**
(implicite, simple) ou voir/éditer **tous les profils** depuis un seul écran ?
Ça change l'UI de la section General, pas le back-end.

## Décision

**Aucune.** Mickael n'a pas tranché. On ne code rien pour l'instant. Ce fichier
et sa ligne de track existent seulement pour retrouver l'analyse le jour où la
décision sera prise.
