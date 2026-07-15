---
paths:
  - "src/main/commands/**"
---

# Registre de commandes — découpage anti-collision

Mira est vibe codé sur **plusieurs sessions en parallèle**. Un même fichier édité
par deux sessions = conflit de merge ou écrasement. Le découpage vise donc **un
fichier par feature**. Comme tout est une commande, une organisation naïve
concentrerait toutes les features dans un seul fichier — exactement le point de
collision à éviter.

**Registre de commandes = un fichier par domaine.** Le registre ne vit PAS dans un fichier unique. Il est éclaté dans `src/main/commands/` :

```
src/main/commands/
  registry.ts     types cœur + buildRegistry générique (change rarement)
  context.ts      CommandContext = intersection des slices de chaque domaine
  index.ts        racine de composition + barrel : fusionne les maps, ré-exporte l'API publique
  navigation.ts   commandes navigate/back/forward  + slice NavContext
  profiles.ts     commandes open/create/rename/list + slice ProfileContext
  settings.ts     commande open-settings           + slice SettingsContext
  <domaine>.ts    … un fichier par domaine
  *.test.ts       un test par domaine ; faux contexte partagé dans fake-context.ts
```

Règles de découpage à respecter par toute session :

1. **Ajouter une commande à un domaine existant** → éditer **uniquement** son fichier de domaine (ex. `navigation.ts`). Ne pas rapatrier de logique dans `index.ts`.
2. **Ajouter une capacité de contexte** (une méthode dont la commande a besoin) → l'ajouter à la **slice du domaine** (`NavContext`, `ProfileContext`, …), pas à une interface géante partagée. Le `makeContext` de `src/main/profiles.ts` (ProfileManager) l'implémente ensuite.
3. **Ajouter un domaine entier** → créer `commands/<domaine>.ts` (+ sa slice + son `.test.ts`), puis **une seule** ligne partagée à toucher : l'`import` + le spread dans `commands/index.ts`.
4. **Ne jamais réimporter par chemin interne.** Les consommateurs importent depuis `./commands` (résout vers `commands/index.ts`), jamais `./commands/navigation` directement.
5. **Le même principe s'applique aux autres surfaces** quand elles grossiront : CSS par surface (`assets/toolbar.css`, `sidebar.css`, `palette.css`), composants React par feature sous `renderer/src/features/<x>/`, `App.tsx` ne fait que les assembler. Éviter d'empiler dans `main.css` ou `App.tsx`.

Test avant d'écrire : « ma feature touche-t-elle un fichier qu'une autre session
touche probablement aussi ? ». Si oui, c'est un signal qu'il faut un nouveau
fichier de domaine plutôt qu'un append dans un fichier partagé.

**Une feature = un test.** Chaque commande du registre a son test unitaire
(entrées → effet/valeur retournée), lancé via `npm test` (Vitest). Si une
commande est trop couplée à Electron pour être testée simplement, extraire sa
logique pure dans une fonction à part (testable) et ne laisser dans la commande
que l'appel natif (fin, non testé).
