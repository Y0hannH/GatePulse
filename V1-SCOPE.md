# GatePulse — Cadrage V1

Décidé le 2026-09-24 : le PoC est validé, on sort du statut démo. Ce document fixe le périmètre
de la V1 tel que tranché avec Yohann ; il sert de référence tant qu'il n'est pas remplacé par des
issues/tickets de suivi.

## Contexte

Le PoC (v0.1.0) a démontré la faisabilité technique : exécuter du SQL ad hoc sur une base on-prem /
IP-filtrée via un pipeline Fabric générique (Lookup/Script + connexion gateway), piloté uniquement
par l'API REST Fabric. Les 4 points de risque du brief sont mesurés et pour l'essentiel confirmés
(voir `README.md` §6 et §5) : plafond Lookup à 5000 lignes (troncature silencieuse), limite de
sortie à 4 194 304 octets, format des paramètres, point d'API de résultat.

GatePulse avait été choisi comme pilote de `pulse-shared` (auth) précisément parce que
« démo, enjeu nul » (`HARMONISATION.md` L372). Ce n'est plus vrai à partir de maintenant : le code
partagé qu'il consomme devient un chemin critique pour un outil d'usage quotidien, pas un terrain
d'essai sans conséquence. En tenir compte pour les prochaines évolutions de `pulse-shared`.

## Objectif V1

**Outil interne pour data engineers** : exécuter du SQL ad hoc directement depuis VS Code via
n'importe quelle connexion Fabric autorisée, sans repasser par le contournement actuel (accès
manuel via l'UI Fabric, SSMS via VPN, ou équivalent — à documenter précisément côté utilisateurs).
L'extension VS Code est la seule surface produit retenue pour la V1.

**Élargi le 2026-09-25 (initialement restreint aux connexions gateway) :** le pipeline ne fait que
recevoir un GUID de connexion en paramètre (`externalReferences.connection`, cf.
`provisioning/pipeline-template.json`) — il n'a jamais eu de dépendance technique au type de
connexion, gateway ou cloud (confirmé empiriquement par le point P4 du PoC : swap de connexion via
API). Deux scénarios distincts justifient GatePulse, tous deux couverts par le même mécanisme :
1. **Gateway** : contourner un accès réseau restreint (base on-prem / IP-filtrée) — le scénario
   d'origine du brief.
2. **Cloud** : exécuter une requête via une connexion Fabric à laquelle l'utilisateur est autorisé,
   sans avoir lui-même d'accès direct (login, réseau) à la base derrière — le pipeline s'exécute
   avec les identifiants configurés sur la connexion, pas ceux de l'utilisateur.

`isSupportedSqlConnection` (`fabricClient.ts`, ex-`isGatewaySqlConnection`) ne filtre donc plus que
sur la famille SQL de `connectionDetails.type`, sans condition sur `connectivityType`. Voir aussi
la correction du filtrage au point 3 ci-dessous.

## Statut du repo et distribution

- Repo git à initialiser en local, aligné structurellement sur FabricPulse / VaultPulse / dbtforge
  (tsconfig, eslint flat config, scripts npm communs — déjà fait depuis la bascule `dist/` +
  `pulse-core`). **Pas de remote GitHub pour l'instant**, pas de Marketplace : distribution interne
  via `.vsix` comme aujourd'hui.
- `publisher: "gatepulse"`, `private: true`, `UNLICENSED` restent en l'état tant que le repo reste
  local. Réaligner sur `evolve-data` seulement si/quand une distribution externe est décidée.
- Le nom de package `gatepulse-fabric-sql-demo` doit perdre le suffixe `-demo` (V1, plus une démo) —
  à faire au moment du chantier de renommage, pas isolément.

## Sort du périmètre produit V1

Le CLI de validation (`src/cli/main.ts`, scénarios P1 à P4 : rowcap, size, latency, concurrency,
swap) sort du produit livré — il a rempli son rôle de preuve de faisabilité pour le PoC.

- **Décidé le 2026-09-24 : archivé, gelé.** On n'y touche plus — ni corrections, ni suivi des
  évolutions de `src/core` côté V1 (le CLI peut donc se retrouver désynchronisé au fil du temps,
  assumé). Le code reste en place tel quel dans `src/cli/` ; pas de suppression, pas de déplacement
  tant que le repo n'a pas de git (rien à tagger). Une fois `git init` fait, marquer l'état courant
  d'un tag avant de considérer un déplacement vers un dossier `archive/`.
- **Correction du 2026-09-24 (en concevant le point 4, UX du panel) : le gel ne couvre PAS tout
  `scenarios.ts`.** `runSingle` — l'exécution d'une requête simple, utilisée par le panel VS Code,
  donc par le produit V1 — vit dans ce même fichier, à côté des scénarios P1-P4
  (`runLatencyTest`/`runRowCapTest`/`runSizeTest`/`runConcurrencyTest`/`runSwapTest`, ceux-là bien
  gelés). Idem pour le wrapper générique `scenario()` et les types `ScenarioReport`/
  `ScenarioContext` que `runSingle` utilise. **À l'implémentation** : extraire `runSingle` +
  `scenario()` + ces types vers un nouveau module non gelé (ex. `src/core/runQuery.ts`) avant de
  commencer le point 4, pour que le panel ne dépende plus du fichier archivé. Seules les fonctions
  `run<X>Test` (et leurs helpers `perSizeRuns`, `maxConcurrent`, `describe`, `formatVerdicts`,
  `aggregateVerdicts` si non réutilisés ailleurs) restent gelées dans `scenarios.ts`. Le
  `CLAUDE.md` du repo, qui disait « `src/cli/main.ts` et les scénarios P1-P4
  (`src/core/scenarios.ts`, `compare.ts`) sont gelés », est corrigé en conséquence.
- `test/mock-selftest.ts` (`npm test`) couvre aujourd'hui surtout les scénarios de validation : à
  revoir une fois le travail V1 démarré, pour re-cibler ce qui reste utile côté `src/core`
  (`pipelineRunner`, `fabricClient`, `provision`, et le nouveau module `runQuery`) — sans dépendre
  du CLI figé.
- Le CLI garde son utilité de fait comme historique de mesure (résultats déjà obtenus, cf.
  `README.md` §6) même s'il sort du produit livré.

## Nouvelles exigences V1

### 1. Provisioning automatique du pipeline — conception (2026-09-24)

**Principe** : l'utilisateur fournit le **workspace** Fabric pour chaque tenant (pas de création
de workspace par l'extension — hors périmètre, cf. plus bas), renseigné en settings. Au premier
usage sur un tenant/workspace donné, l'extension détecte si le pipeline générique existe déjà dans
ce workspace et le crée automatiquement sinon. **Contrainte clé** : un pipeline par
**workspace/tenant**, pas par (tenant × utilisateur de l'extension) — un workspace déjà configuré
par un collègue doit être réutilisé tel quel.

**Identification déterministe.** Un nom d'affichage fixe et versionné identifie le pipeline
générique dans un workspace, indépendamment de qui l'a créé : constante
`GATEPULSE_PIPELINE_NAME = "GatePulse — Generic SQL Lookup Pipeline"` (à définir dans
`provision.ts`, à côté de `QUERY_ACTIVITY_TYPES`). Pas de suffixe de version dans le nom pour l'v1
— la question de faire évoluer un pipeline déjà provisionné par une v1 antérieure est un problème
distinct, non résolu ici (cf. risques plus bas).

**Nouvelle capacité côté `fabricClient.ts`.** Aucun listing d'items de workspace n'existe
aujourd'hui (seul `getItem(itemId)` unitaire). À ajouter, sur le même modèle que
`FabricPulse/src/services/fabricApi.ts` (`getDbtJobs`, `GET /workspaces/{wsId}/items?type=X` +
pagination par `continuationUri`) — cohérent avec le futur client REST partagé de
`HARMONISATION.md` (« Client REST Fabric partagé (FabricPulse + GatePulse) ») :

```
async listItems(type?: string): Promise<{ id: string; displayName: string; type: string }[]>
// GET /v1/workspaces/{workspaceId}/items[?type=DataPipeline], suit continuationUri
```

**Flux `ensurePipeline(session)`** (nouvelle fonction dans `provision.ts`, appelée paresseusement —
une fois par session, en mémoire seulement, pas persisté entre redémarrages de VS Code — au premier
run de requête plutôt qu'à l'activation, sur le modèle du `getSession()` déjà paresseux de
`extension.ts`) :

1. `listItems('DataPipeline')` sur le workspace configuré, filtrer par `displayName ===
   GATEPULSE_PIPELINE_NAME`.
2. **Exactement un match** → réutiliser cet id. Ne pas lui faire confiance aveuglément : passer par
   `inspectPipeline` (déjà existant) pour vérifier qu'il déclare bien les 3 paramètres et la
   connexion dynamique. Si l'inspection échoue, **erreur explicite** (nouveau `ErrorKind:
   'provisioning'`, cf. plus bas) plutôt qu'un re-provisioning silencieux à côté — un pipeline du
   bon nom mais mal formé doit être corrigé ou renommé à la main, pas dédoublé.
3. **Zéro match** → relister une dernière fois juste avant la création (réduit la fenêtre de race
   sans l'éliminer, cf. risques) puis `provisionPipeline(..., displayName: GATEPULSE_PIPELINE_NAME,
   templatePath: provisioning/pipeline-template.json)`. Informer l'utilisateur qu'un pipeline vient
   d'être créé (message VS Code + log), création d'un item Fabric = effet de bord réel, jamais
   silencieux.
4. **Plusieurs matches** (deux collègues ont perdu la course malgré l'étape 3) → ne rien supprimer
   automatiquement (suppression = destructif, hors périmètre d'un outil qui doit rester sûr par
   défaut) ; choisir le plus petit `id` comme gagnant déterministe (mêmes utilisateurs → même choix
   partout) et loguer un **WARN** explicite listant tous les doublons, pour nettoyage manuel.

**Réglages impactés.** `gatepulse.pipelineId` devient optionnel : vide (nouveau défaut) = résolution
automatique ; renseigné = override explicite, saute complètement la découverte (échappatoire pour
debug ou pipeline provisionné à la main). `checkConfig` (`config.ts`) ne doit plus exiger
`pipelineId` non vide — seuls `tenantId` et `workspaceId` restent obligatoires en amont.

**Taxonomie d'erreurs.** Ajouter `'provisioning'` à `ErrorKind` (`errors.ts`) pour les échecs propres
à `ensurePipeline` (pipeline candidat mal formé, doublons détectés, échec de création) — distinct de
`'config'` (réglages manquants/invalides statiquement), cohérent avec la convention déjà posée dans
`CLAUDE.md` (« un cas dans la taxonomie plutôt qu'un message ad hoc »).

**Risques non résolus, à vérifier empiriquement (même esprit que README §6)** :
| Sujet | Hypothèse | À vérifier |
|---|---|---|
| Unicité du `displayName` | Fabric n'impose probablement pas l'unicité des noms d'items dans un workspace | Si deux créations quasi simultanées passent toutes les deux l'étape 3, le cas "plusieurs matches" (étape 4) doit se déclencher en pratique — à tester avec deux sessions concurrentes |
| Évolution du pipeline générique entre versions de l'extension | Un pipeline déjà provisionné par une v1 antérieure reste utilisé tel quel, jamais migré automatiquement | Pas traité dans cette conception ; si le template change, `inspectPipeline` (étape 2) doit au moins détecter l'incompatibilité plutôt que de faire tourner silencieusement une requête sur un pipeline obsolète |
| Droits de création d'item | Le compte doit avoir le droit de créer un `DataPipeline` dans un workspace où il n'est peut-être que lecteur des connexions | À confirmer : quel rôle workspace minimum pour `POST .../items` |

**Dépendance vers le point 2 (multi-tenant).** Résolu par la conception ci-dessous : une bascule de
tenant reconstruit la session (mécanisme déjà existant, cf. `onDidChangeConfiguration` dans
`extension.ts`), donc le cache en mémoire d'`ensurePipeline` — attaché à la session — est
automatiquement réinitialisé à chaque bascule sans code supplémentaire.

### 2. Multi-tenant — conception (2026-09-24)

**Modèle retenu : réglage `gatepulse.tenants`, en User Settings par défaut — pas resource-scope,
pas `globalState`.** Correction du 2026-09-24 : la première version de cette conception calquait le
`scope: "resource"` de VaultPulse (vaults déclarés par projet, dans `.vscode/settings.json`), en
présumant que la réutilisation d'un pipeline déjà provisionné (point 1) exigeait que la
*déclaration* tenant/workspace soit, elle aussi, partagée via un repo d'équipe. **C'est faux, et
Yohann l'a corrigé** : GatePulse s'utilise comme l'extension mssql — des requêtes ad hoc lancées
sans dépendre d'un projet ouvert, souvent hors de tout repo. La réutilisation du pipeline ne dépend
pas du partage des *réglages* : elle est garantie côté API Fabric par la détection par nom
(`listItems` + `displayName` fixe, point 1), indépendamment de qui a configuré son instance VS
Code. Chaque utilisateur renseigne son propre `tenantId`/`workspaceId` (obtenus par un canal
externe à VS Code — doc interne, Slack…), pas via un fichier partagé.

Le réglage reste un **tableau, éditable directement en JSON** (cohérent avec le modèle de settings
déjà en place dans GatePulse, et avec la commande `Add Tenant`-style ci-dessous) — mais **sans
`scope: "resource"`** : par défaut dans `window` (le scope VS Code standard, non restreint), donc
vit dans les **User Settings**, aucun dossier à ouvrir. Rien n'empêche une surcharge par workspace
si quelqu'un le veut vraiment (VS Code le permet nativement pour ce scope), mais ce n'est ni requis
ni le cas d'usage visé — contrairement à `addVaultToWorkspace()` de VaultPulse qui écrit en dur
dans `ConfigurationTarget.Workspace`, la future commande d'ajout de GatePulse écrira dans
`ConfigurationTarget.Global`.

**Nouveau réglage `gatepulse.tenants`**, remplace les réglages top-level `tenantId`, `workspaceId`,
`connectionGuid`, `databaseName`, `pipelineId` (ce dernier objet du point 1) :

```jsonc
"gatepulse.tenants": {
  "type": "array",
  "default": [],
  "items": {
    "type": "object",
    "required": ["alias", "tenantId", "workspaceId"],
    "properties": {
      "alias":          { "type": "string", "description": "Nom affiché, ex. \"Client A - Prod\"" },
      "tenantId":       { "type": "string", "description": "GUID du tenant Entra ID" },
      "workspaceId":    { "type": "string", "description": "GUID du workspace Fabric (où vit / sera provisionné le pipeline générique)" },
      "clientId":       { "type": "string", "description": "Optionnel : app registration spécifique à ce tenant (sinon gatepulse.clientId global)" },
      "pipelineId":     { "type": "string", "description": "Optionnel : override manuel, saute l'auto-provisioning (point 1)" },
      "connectionGuid": { "type": "string", "description": "Optionnel : connexion gateway pré-remplie dans le panel" },
      "databaseName":   { "type": "string", "description": "Optionnel : base pré-remplie dans le panel" }
    }
  }
}
```

**Réglages qui restent globaux** (comportementaux, indépendants du tenant actif) : `authFlow`,
`clientId` (défaut si l'entrée n'en fournit pas), `scopes`, `pollIntervalMs`, `timeoutMs`,
`activityNames`, `parameterPayloadFormat`, `parameterNames`, `resultFetchRetries`/`Delay`,
`logDirectory`, tout `validation.*`.

**`src/core` ne change pas.** `GatePulseConfig` (`config.ts`) garde sa forme plate actuelle — un
seul tenant à la fois — donc `FabricClient`, `PipelineRunner`, `session.ts` restent inchangés. Le
multi-tenant est traité **uniquement côté extension** : `readConfig()` se scinde en
`readGlobalConfig()` (réglages globaux ci-dessus) et `readTenants()` (`gatepulse.tenants`), et une
nouvelle fonction `buildConfigForTenant(global, tenant): GatePulseConfig` fait la fusion pour
produire l'objet plat que `createSession()` attend déjà. Rayon d'impact minimal, cohérent avec le
principe de ne pas refactorer au-delà du besoin.

**Tenant actif et bascule.** Un seul tenant actif à la fois pour le panel (pas plusieurs panels
concurrents en V1 — question qui recoupe le point 4, non tranchée ici). Nouvelle commande
`GatePulse: Switch Tenant` (QuickPick sur les `alias`), plus un sélecteur dans le panel lui-même.
Le choix est mémorisé dans `context.globalState` (pas `workspaceState` : même raisonnement que
ci-dessus — sans dossier ouvert, l'état de fenêtre est moins fiable d'une session à l'autre que le
`globalState`, qui suit l'utilisateur partout). Une bascule invalide la session courante et la
reconstruit — exactement le mécanisme déjà en place dans `extension.ts` (`session = undefined` sur
`onDidChangeConfiguration`), réutilisé tel quel.

**Commande d'ajout.** `GatePulse: Add Tenant` (inputs successifs ou petit webview — détail UX
repoussé au point 4) écrit dans `gatepulse.tenants` via
`config.update(KEY, [...current, entry], vscode.ConfigurationTarget.Global)` — **`Global`, pas
`Workspace`** contrairement à `addVaultToWorkspace()` de VaultPulse (`src/config.ts:21`), pour la
même raison que le choix de scope ci-dessus. L'édition manuelle du tableau JSON reste toujours
possible en complément, comme pour `vaultpulse.vaults`.

**Auth : rien à changer.** `AzureAuthService` (`pulse-core`) met déjà les tokens en cache par
`tenantId:scope` et `getToken(tenantId, scope)` prend le tenant en paramètre à chaque appel (cf.
`session.ts`) — la bascule entre tenants n'exige pas de sign-out, le cache existant absorbe déjà
plusieurs tenants dans le même process. Confirmé par la conception de `pulse-shared`, **pas encore
vérifié en usage réel avec ≥ 2 tenants côté GatePulse** (mono-tenant jusqu'ici) — à ajouter aux
risques ci-dessous.

**Validation.** Nouvelle fonction `checkTenants(tenants: TenantEntry[]): string[]`, même style que
`checkConfig` : réglage vide (aucun tenant déclaré), alias dupliqués (ambigu dans le QuickPick),
GUID invalides sur `tenantId`/`workspaceId`/`clientId`/`pipelineId`. Appelée avant `checkConfig`.

**Interactions.**
- Point 1 (provisioning) : `ensurePipeline` tourne sur le workspace du tenant actif ; la
  réinitialisation de son cache à la bascule est déjà acquise (cf. dépendance résolue ci-dessus).
- Point 3 (liste dynamique des connexions/pipelines, pas encore conçu) : lira/écrira les mêmes
  champs optionnels `connectionGuid`/`pipelineId` de l'entrée active, en pré-remplissage.
- CLI : **aucun impact**, il reste figé sur son `gatepulse.config.json` mono-tenant (décision
  d'archivage déjà actée).

**Risques à vérifier empiriquement** :
| Sujet | Hypothèse | À vérifier |
|---|---|---|
| Cache d'auth multi-tenant en usage réel | La clé `tenantId:scope` isole correctement N tenants dans le même process | Pas testé côté GatePulse au-delà d'un seul tenant — à valider en configurant 2 tenants réels et en basculant plusieurs fois |
| Reconstruction de session à la bascule | Un run en cours au moment de la bascule doit être annulé proprement (pattern déjà utilisé pour `onDidChangeConfiguration`, mais jamais déclenché en cours d'exécution active) | À tester : lancer une requête, basculer de tenant avant la fin |

### 3. Liste dynamique des connexions/pipelines — conception (2026-09-24)

**Le volet « pipeline » est déjà couvert par le point 1** : `ensurePipeline` résout/crée le
pipeline générique automatiquement, la plupart des utilisateurs n'ont jamais besoin d'en choisir
un. Le seul reliquat, c'est l'override manuel `gatepulse.tenants[].pipelineId` (point 2,
échappatoire) : plutôt que de faire saisir un GUID à la main, un picker `GatePulse: Pick Pipeline
(override)` réutilise `listItems('DataPipeline')` (déjà construit pour le point 1) sur le workspace
du tenant actif. Pas de nouvelle capacité API à ajouter pour ça — uniquement une commande +
QuickPick côté extension.

**Le volet « connexions » est le vrai travail neuf de ce point.** Aujourd'hui `connectionGuid` est
un GUID saisi à la main (`gatepulse.tenants[].connectionGuid`, pré-remplissage). Objectif : lister
les connexions gateway disponibles plutôt que de faire chercher le GUID dans le portail Fabric.

**Nouvelle capacité côté `fabricClient.ts` : `listConnections()`.** Contrairement à `listItems`
(point 1), une connexion n'est **pas un item de workspace** — elle appartient au tenant/gateway,
référencée par GUID depuis un pipeline mais listée indépendamment de tout workspace :

```
async listConnections(): Promise<FabricConnection[]>
// GET /v1/connections (pas de segment workspaceId), pagination par continuationUri
// comme listItems (point 1) et le listAll de FabricPulse/src/services/fabricApi.ts
```

```ts
interface FabricConnection {
  id: string;
  displayName: string;
  connectivityType: string; // attendu : 'OnPremisesGateway' | 'VirtualNetworkGateway' | 'ShareableCloud' | 'PersonalCloud' — à confirmer
  gatewayId?: string;
  connectionDetails?: { type?: string; path?: string }; // connectionDetails.type attendu proche de "Sql" — à confirmer
}
```

**Filtrage — élargi le 2026-09-25.** Restreint au départ à `connectivityType ===
'OnPremisesGateway'` (+ `connectionDetails.type` de la famille SQL), sous l'hypothèse que GatePulse
n'avait de sens que pour les connexions gateway. Corrigé : le pipeline ne dépend techniquement que
du GUID de connexion (cf. Objectif V1 ci-dessus, cas d'usage cloud), donc `isSupportedSqlConnection`
ne teste plus que la famille SQL de `connectionDetails.type` — gateway (`OnPremisesGateway`,
`VirtualNetworkGateway`, ...) et cloud (`ShareableCloud`, `PersonalCloud`, ...) sont désormais tous
deux éligibles. Le picker (QuickPick) affiche `gateway {gatewayId}` en detail quand la connexion en
a un, sinon `connectivityType` — pour rester lisible sur une liste mixte gateway/cloud.

**`databaseName` reste en saisie libre pour la V1.** Fabric ne connaît pas les bases qui existent
« derrière » une connexion SQL générique — les énumérer demanderait de faire tourner une requête
(`SELECT name FROM sys.databases`) via le pipeline déjà provisionné, donc un run réel juste pour
peupler un picker. Amélioration envisageable plus tard (une fois connexion **et** pipeline résolus,
proposer un picker de bases), explicitement **reportée**, pas conçue ici — ne pas la construire
maintenant.

**Repli si la liste échoue.** `listConnections()` peut échouer (403 si l'utilisateur n'a pas le
droit de lister les connexions du tenant, liste vide si aucune connexion gateway n'y est
enregistrée). Ce n'est jamais bloquant : le picker doit se dégrader en échec silencieux côté
UX — un WARN dans les logs, et le champ `connectionGuid` reste modifiable à la main, comme
aujourd'hui. Pas de nouvel `ErrorKind` : ce n'est pas une erreur de run (taxonomie existante
suffit), juste un WARN de log — cohérent avec le principe « jamais d'échec silencieux, mais pas
tout ce qui échoue n'est une erreur bloquante non plus ».

**Cache.** Même logique qu'`ensurePipeline` (point 1) : résolu une fois par session, en mémoire
uniquement, invalidé par une bascule de tenant (point 2) puisque le token utilisé pour l'appel est
celui du tenant actif. Commande `GatePulse: Refresh Connections` pour forcer un rafraîchissement
sans redémarrer VS Code.

**Où le GUID choisi est sauvegardé.** « Utiliser pour cette session » (ne touche pas aux réglages)
vs « Enregistrer par défaut pour ce tenant » (écrit `gatepulse.tenants[i].connectionGuid` via
`ConfigurationTarget.Global` — jamais `.Workspace`, même correction qu'au point 2). Choix laissé à
l'utilisateur dans le picker, pas de sauvegarde automatique.

**Interactions.**
- Point 1 : partage la logique `listItems`/pagination pour le picker de pipeline override.
- Point 2 : écrit dans les mêmes champs optionnels de `gatepulse.tenants[]`, avec la même règle de
  scope `Global`. Se réinitialise à chaque bascule de tenant.
- CLI : **aucun impact**, figé (décision d'archivage déjà actée).

**Risques à vérifier empiriquement** :
| Sujet | Hypothèse | À vérifier |
|---|---|---|
| Endpoint et forme exacte | `GET /v1/connections` existe et retourne `connectivityType`/`connectionDetails.type` sous cette forme | Non testé contre un vrai tenant Fabric — à confronter à l'implémentation dès le premier appel réel, comme les hypothèses du README §6 |
| Portée du listing | La liste retournée par `/v1/connections` est bien scoping tenant/utilisateur et pas trop large (toutes les connexions de l'organisation, pas seulement celles utiles à GatePulse) | Si trop large en pratique, envisager `/v1/gateways` puis connexions par gateway — non conçu ici, à réévaluer si le filtrage `connectivityType`/`type` ne suffit pas |
| Droit de lister vs droit d'utiliser | Un utilisateur peut voir une connexion dans la liste sans avoir le droit de l'utiliser dans un pipeline | Le run lui-même reste la seule vérité (comme aujourd'hui, cf. `connection` dans `ErrorKind`) — le picker n'est qu'un confort, jamais une garantie |

### 4. UX du panel — conception (2026-09-24)

État des lieux : `panel.ts`/`panel.js`/`panel.css` sont entièrement façonnés par le PoC — 5 boutons
de scénario P1-P4, chips de verdicts, décomposition de latence (file Fabric/run Fabric/polls),
sous-titre « démo ». Rien de tout ça ne s'adresse à un data engineer qui veut juste exécuter une
requête au quotidien. Prérequis : l'extraction de `runSingle` hors de `scenarios.ts` (cf.
correction ci-dessus, section CLI).

**A. Ce qui sort du panel.** Les 5 boutons de scénario (`panel.ts:194-198`, `panel.js:60-62`) et
tout leur rendu associé : la branche « scenario » de `renderReport` (`panel.js:166-178`, un
`<details>` par run avec chips PASS/FAIL par point) et les chips de verdicts P1-P4
(`panel.js:153-156`) — ce code appelle des fonctions maintenant gelées. Le sous-titre « SQL via
Fabric Gateway — démo » (`panel.ts:177`) perd « démo ».

**B. Ce qui reste — et se reformule.** `pipelineRunner.ts` (pas gelé) peuple `ExecutionReport.checks`
sur **chaque** run, y compris un simple `run` — pas seulement dans les scénarios. Certains de ces
checks sont un vrai signal opérationnel au quotidien, pas un artefact PoC :
- `SILENT_FAILURE` / `ROW_CAP` en WARN : troncature silencieuse à 5000 lignes sans erreur Fabric —
  un piège réel pour qui écrit `SELECT *` sans `TOP`, à afficher en évidence, pas dans un coin.
- `PARAM_BINDING` en FAIL : la requête envoyée via l'API n'est pas celle exécutée (le pipeline a
  tourné sur une valeur par défaut) — silencieux aujourd'hui dans le flot normal, doit remonter.
- À l'inverse, `API_TRIGGER`/`API_RESULT` en PASS sont de la plomberie utile en debug, pas au
  quotidien.

Règle retenue : plus de vocabulaire « P1/P2 » mis en avant dans l'UI (c'était un langage pour
public de démo) — un **bandeau d'alerte** au-dessus des résultats quand un check FAIL/WARN existe
(reformulé en langage utilisateur, pas en `ROW_CAP WARN`), et une section **« Diagnostics »**
repliée par défaut qui garde tous les checks (y compris PASS/INFO) pour qui creuse un problème.
Rien n'est supprimé du modèle de données (`ExecutionReport.checks` ne change pas), seule la
priorité d'affichage change.

**C. Nouvelles zones issues des points 1-3.**
- *Tenant* : sélecteur en haut du panel (les `alias` de `gatepulse.tenants`), plus une commande
  `GatePulse: Switch Tenant` (point 2). État vide guidé si `gatepulse.tenants` est vide — un vrai
  parcours d'accueil, pas juste le bandeau d'erreur générique `configProblems` actuel.
  `refreshDefaults()` (`panel.ts:79`) devra inclure la liste des tenants et l'actif, pas seulement
  `connectionGuid`/`databaseName`.
- *Connexion* : le champ texte `connectionGuid` reste (repli toujours possible, point 3) mais gagne
  un bouton « Parcourir… » ouvrant le picker de connexions gateway. Pas de composant équivalent
  pour un pipeline autre que l'auto-provisionné — l'override pipeline (rare) reste une commande
  dédiée, hors du flux principal, pour ne pas charger l'écran de tous les jours.
- *Provisioning* (point 1) : première utilisation sur un tenant → message explicite avant le
  premier run (« Pipeline GatePulse provisionné automatiquement dans le workspace X ») plutôt
  qu'un simple log — sans ça, le premier run paraît juste plus lent sans explication.

**D. Confort quotidien — le contenu vraiment neuf de ce point.**
1. **Historique de requêtes.** Dernières requêtes exécutées, par tenant, ré-exécutables en un
   clic. Stocké en `context.globalState` (même règle qu'au point 2 : pas `workspaceState`, l'outil
   s'utilise sans dossier ouvert), clé dédiée, **cap strict à N entrées** (ex. 50, FIFO) pour rester
   dans les limites pratiques de `globalState`. Chaque entrée : texte de la requête, horodatage,
   alias du tenant/connexion utilisés, statut, durée — **jamais le contenu du résultat** (pas de
   duplication de données potentiellement volumineuses ou sensibles dans le state de l'extension).
2. **Export CSV du résultat affiché.** Bouton sur chaque table de résultat, écrit via
   `vscode.window.showSaveDialog` (action explicite de l'utilisateur, jamais d'écriture silencieuse
   sur disque). Exporte les lignes **actuellement visibles** (après tri/filtre, point 4 ci-dessous),
   pas le jeu de données brut.
3. **Persistance de saisie** (déjà là via `vscode.getState()`/`setState()` sur
   `connectionGuid`/`databaseName`/`query`) : étendre au tenant actif sélectionné, toujours côté
   état de webview, pas réglages.
4. **Implémenté le 2026-09-25** (le tri/filtre de colonnes, noté ci-dessus comme "pas requis pour
   la V1", s'est confirmé à l'usage — demande explicite de Yohann) :
   - **Résultats triables et filtrables par colonne.** Client-side uniquement, `media/panel.js` —
     en-tête cliquable (cycle aucun → asc → desc → aucun, une seule colonne à la fois) plus une
     ligne de filtres texte sous l'en-tête (un champ par colonne, substring insensible à la casse,
     debounce 120 ms). Aucun aller-retour vers l'extension : les lignes sont déjà dans la webview
     (`<= 5000 par activité`, cf. `compactRun`). Tri numérique-aware (`compareValues`), `NULL` en
     dernier quel que soit le sens.
   - **Éditeur SQL modernisé.** Le `<textarea>` est remplacé par CodeMirror 5 (vendoré, voir
     GatePulse/CLAUDE.md) — coloration syntaxique T-SQL (`text/x-mssql`), numéros de ligne,
     correspondance de parenthèses, fermeture auto des parenthèses/guillemets, thème
     `cm-s-gatepulse` calé sur les variables CSS VS Code (donc cohérent clair/sombre
     automatiquement, pas un thème CodeMirror figé).
   - **Liste des bases par connexion.** Nouveau champ base de données avec `<datalist>` : rempli
     automatiquement (une requête `SELECT name FROM sys.databases WHERE state = 0` via le pipeline,
     cf. `runQuery.ts::listDatabases`), mis en cache en mémoire par `connectionGuid`
     (`SqlPanel.databaseCache`, jamais persisté), bouton de rafraîchissement manuel, et la saisie
     libre reste toujours possible (repli si la liste échoue ou si l'utilisateur préfère taper).
5. **Implémenté le 2026-09-25 : arbre de schéma dans la sidebar** (`tenantTree.ts`), demande
   explicite de Yohann — « découvrir la liste de toutes les tables/schéma/vues », en arborescence,
   « comme les bases » (mis en cache, rafraîchissable). Chaque tenant se déplie en
   Bases → Schémas → Tables/Vues → Colonnes, chaque niveau chargé (et caché) seulement quand son
   parent est déplié — jamais tout chargé d'un coup.
   - **Requêtes de découverte** (`runQuery.ts`) : `listSchemaObjects` (`INFORMATION_SCHEMA.TABLES`,
     un aller-retour donne tables *et* vues via `TABLE_TYPE`) et `listColumns`
     (`INFORMATION_SCHEMA.COLUMNS`, un aller-retour par table, jamais toutes les tables d'un coup).
     ANSI SQL standard, pas du T-SQL spécifique comme `sys.databases` — mais **non vérifié contre un
     vrai Fabric-gateway SQL Server**, même réserve que les autres requêtes de découverte de ce
     document.
   - **Connexion utilisée pour parcourir un tenant : son `connectionGuid` par défaut**
     (`gatepulse.tenants[].connectionGuid`, point 2). Pas de sélecteur de connexion dans l'arbre —
     si le tenant n'en a pas, la racine du tenant se déplie sur un message cliquable qui lance
     directement `GatePulse: Pick Connection`. Un tenant avec plusieurs connexions à parcourir n'a
     qu'une seule vue possible à la fois (celle enregistrée par défaut) : limitation assumée, pas
     conçue pour le multi-connexion par tenant dans l'arbre.
   - **Déplier le nœud d'un tenant rend ce tenant actif** s'il ne l'était pas déjà
     (`ensureActiveTenantForTree`, réutilise `switchToTenant`) — cohérent avec le modèle « un seul
     tenant actif à la fois » déjà en place (point 2) plutôt que d'introduire une notion de session
     multi-tenant juste pour l'arbre.
   - **Cliquer une table/vue ouvre le panel, requête prête** : `SELECT TOP 100 * FROM
     [schema].[table]` pré-rempli avec la bonne connexion/base (`SqlPanel.prefillQuery`,
     commande interne `gatepulse.openTableQuery`). Pas demandé explicitement mais découle
     naturellement de « parcourir puis requêter » — extension jugée à faible risque, cohérente avec
     le clic sur une ligne de tenant qui fait déjà bascule + ouverture.
   - **Cache et rafraîchissement séparés de celui du panel** (`SqlPanel.databaseCache`) : l'arbre
     existe même panel fermé. Trois `Map` dans `extension.ts` (bases par connexion, objets par
     `connexion:base`, colonnes par `connexion:base:schéma:table`), vidées par le nouveau bouton
     `GatePulse: Refresh Schema Tree` dans la barre de titre de la vue (remplace
     `refreshConnections`, mal placé là — cette dernière commande reste utilisable via la palette,
     juste retirée de la barre de titre de l'arbre où elle ne concernait pas ce que l'arbre affiche)
     et par tout changement de config (`invalidateSession`, même règle que les autres caches).
   - **`ensurePipelineResolved` déplacé** de `panel.ts` (méthode privée) vers `extension.ts`
     (fonction de module, injectée dans `SqlPanel` et utilisée directement par les callbacks de
     l'arbre) — trois consommateurs maintenant (run, liste des bases, arbre de schéma), plus
     raisonnable en fonction partagée qu'en méthode privée dupliquée.
6. **Historique : voir sans exécuter (2026-09-25), demande explicite de Yohann.** Cliquer une entrée
   d'historique ne lance plus la requête — elle est seulement chargée dans l'éditeur pour relecture/
   modification. Un bouton ▶ inline par entrée garde le comportement « charger et exécuter en un
   clic » pour qui le veut toujours.
7. **Caches partagés + persistance disque (2026-09-25), demande explicite de Yohann** (premier
   retour à l'usage du point 5 : « pourquoi ne pas alimenter la liste des bases du panel avec ce qui
   est déjà en mémoire », « je redéplie l'arbre après un reload et ça re-fetch »).
   - **Un seul cache par type, partagé panel + arbre.** `SqlPanel` avait son propre
     `databaseCache` en plus de celui de l'arbre — les deux faisaient la même requête pour la même
     connexion. Unifié : `extension.ts` possède maintenant les trois `Map` (bases, objets, colonnes)
     et les injecte aux deux surfaces via une interface `PanelServices` (remplace les 5 paramètres
     positionnels de `SqlPanel.show`/son constructeur). Le panel ne connaît plus de cache à lui.
   - **Persisté dans `context.globalState`** (clé `gatepulse.schemaMetadataCache`), chargé au
     démarrage de l'extension — un reload de VS Code ne perd plus ce qui a déjà été découvert.
     Nouveau réglage **`gatepulse.cacheSchemaMetadata`** (bool, défaut `true`) : off = cache mémoire
     seulement pour la session courante (rien écrit sur disque, tout perdu au reload, comme avant) ;
     désactiver le réglage efface aussi la copie déjà sur disque. « GatePulse: Refresh Schema Tree »
     force toujours un re-fetch complet, réglage ou pas.
   - **Correction d'un bug introduit au point 5** : `invalidateSession()` (déclenchée à chaque
     bascule de tenant) vidait ces trois caches — alors qu'ils sont indexés par `connectionGuid`, pas
     par tenant, donc valides quel que soit le tenant actif. Ça forçait un re-fetch à chaque
     va-et-vient entre deux tenants même sur la même connexion. Retiré de `invalidateSession()` ;
     seuls le bouton refresh et la désactivation du réglage les vident maintenant.
8. **Autocomplétion SQL (2026-09-25), demande explicite de Yohann** — retire la ligne « chantier
   disproportionné, non demandé » de la section E ci-dessous, ex-point non retenu à la conception
   initiale du point 4. Ctrl+Space (et auto-déclenchement après un `.`) dans l'éditeur : noms de
   table/vue en saisie libre, colonnes après `table.`. CodeMirror 5 addon `show-hint` vendoré (voir
   `VENDORED.md`) avec une fonction de hint entièrement custom côté `panel.js` (pas `sql-hint.js`,
   trop générique — pas conscient du schéma) ; async, `postMessage`/réponse vers les mêmes
   `getSchemaObjects`/`getColumns` du point 7. Cache côté webview à un seul niveau (« schéma
   courant ») : suffisant, le vrai cache anti-refetch est déjà côté extension (point 7).
9. **Colonnes non transférables (2026-09-25), incident réel de Yohann** : `ThumbNailPhoto`
   (`varbinary(max)`) a fait échouer un `SELECT *` avec `ErrorCode=DataTypeNotSupported` — le moteur
   de transfert du Lookup/Script ne sait pas déplacer certains types (binaire, XML, geography,
   sql_variant...). Deux réponses :
   - Nouveau `ErrorKind: 'unsupportedType'` (`errors.ts`), détecté par un motif regex distinct de
     `SqlException` (c'est une `HybridDeliveryException`, pas une erreur SQL) — message et piste
     d'action dédiés dans le panel au lieu de tomber dans `pipelineFailed` générique.
   - `gatepulse.openTableQuery` (clic sur une table/vue dans l'arbre) génère maintenant une liste de
     colonnes explicite plutôt que `*` **si et seulement si** au moins une colonne du type exclu
     (`UNSELECTABLE_COLUMN_TYPES`, `extension.ts`) est présente — sinon `SELECT TOP 100 *` reste tel
     quel, pas de verbosité inutile. Ne couvre que les requêtes générées depuis l'arbre ; une requête
     tapée à la main avec `SELECT *` peut toujours heurter ce mur, message d'erreur clair à défaut.
10. **Diagnostics masqué en cas d'échec (2026-09-25), demande explicite de Yohann.** La section
    Diagnostics (tous les checks, y compris PASS/INFO) ne s'affiche plus quand le run a échoué — le
    bandeau d'erreur rouge dit déjà l'essentiel, Diagnostics n'ajoutait que du bruit à côté. Reste
    affiché comme avant sur un run réussi (c'est là qu'il sert : confirmer que tout est net).

**E. Explicitement hors périmètre de ce point** (pour ne pas dériver) :
- Multi-requêtes / multi-onglets simultanés — un seul éditeur de requête, comme aujourd'hui.
- Requêtes nommées/favoris au-delà du simple historique — piste V2 si le besoin se confirme à l'usage.

**Interactions.**
- Point 1 : le bandeau de provisioning s'affiche avant le premier run sur un tenant donné.
- Points 2 et 3 : fournissent les données (tenants, connexions) que le panel affiche ; le panel ne
  redéfinit aucune règle de stockage, il consomme ce qui est déjà décidé (`Global`, jamais
  `Workspace`/`resource`).
- CLI : aucun impact, figé.

**Risque à vérifier** : la taille de l'historique dans `globalState` reste dans les limites
pratiques de VS Code avec le cap proposé (50 entrées de texte court) — à confirmer à
l'implémentation, pas un doute de conception.

## Explicitement hors périmètre V1

- Gros volumes / Copy vers Lakehouse (inchangé depuis le PoC).
- Création de workspace Fabric par l'extension (l'utilisateur le fournit toujours).
- Marketplace public / distribution externe.

## Prochaines étapes proposées

1. ~~Trancher le devenir du CLI de validation~~ — fait, cf. ci-dessus (archivé, gelé).
2. ~~Concevoir le flux d'auto-provisioning~~ — fait, cf. section 1 ci-dessus. Reste à implémenter :
   `listItems` (`fabricClient.ts`), `ensurePipeline` (`provision.ts`), `ErrorKind: 'provisioning'`
   (`errors.ts`), relâchement de `checkConfig` sur `pipelineId`.
3. ~~Définir le modèle de settings multi-tenant~~ — fait, cf. section 2 ci-dessus.
4. ~~Concevoir la découverte dynamique des connexions/pipelines~~ — fait, cf. section 3 ci-dessus.
   **Implémenté (2026-09-24, filtrage élargi le 2026-09-25)** : `listConnections`/
   `isSupportedSqlConnection` (`fabricClient.ts`),
   commandes `GatePulse: Pick Connection` / `Pick Pipeline (Override)` / `Refresh Connections`
   (`extension.ts`), toutes en command palette pour l'instant — pas encore de bouton « Parcourir… »
   ni de sélecteur dans le panel lui-même (délibérément laissé au point 4, cf. division déjà posée :
   point 3 = mécanisme/commandes, point 4 = widget dans le panel). Dégradation en saisie libre
   testée (liste vide → message informatif, pas de blocage). Couverture offline ajoutée dans
   `test/provision-selftest.ts` (mock `/v1/connections`).
5. ~~Spécifier l'UX v1 du panel~~ — fait, cf. section 4 ci-dessus. **Implémenté (2026-09-25)** :
   `runSingle` extrait vers `src/core/runQuery.ts` (le panel ne dépend plus de `scenarios.ts`,
   gelé) ; retrait des boutons/rendus P1-P4 du webview (`media/panel.js` réécrit) ; bandeau
   d'alerte reformulé (SILENT_FAILURE/ROW_CAP/PARAM_BINDING/CONNECTION_RESOLUTION/DATABASE_BINDING
   en WARN/FAIL) + section Diagnostics repliée par défaut avec tous les checks ; sélecteur de
   tenant dans le panel (`<select>` + bouton « + Tenant », câblés sur les commandes
   `gatepulse.switchTenant`/`addTenant` déjà existantes) ; bouton « Parcourir… » sur le champ
   connexion, qui appelle `gatepulse.pickConnection` et remplit directement le champ du panel
   (`SqlPanel.setConnectionGuid`, jusque-là jamais câblé) ; historique de requêtes dans
   `globalState` (cap 50, ré-exécutable en un clic, jamais le contenu du résultat) ; export CSV par
   activité via `showSaveDialog`. Le bandeau de provisioning (point 1) reste une notification VS
   Code explicite au premier run sur un tenant, pas un composant dédié dans le panel — suffisant vu
   sa fréquence (une fois par tenant).
6. ~~`git init` local (sans remote)~~ — fait, `git log` : 3 commits (repo initial, point 1, point 2).
7. **Implémenté (2026-09-24/25) : points 1 à 4** — typecheck/lint/compile/test verts à chaque
   étape, committés séparément, avec une suite de tests offline dédiée
   (`test/provision-selftest.ts`, mock Fabric Items + Connections API, 26 assertions). **Trou de
   couverture assumé, pas comblé le 2026-09-25** : `runQuery.ts::listDatabases` (parsing/dédup/tri
   des noms de bases) n'a pas de test offline dédié — le mock HTTP existant
   (`test/mock-selftest.ts`) simule des jobs pipeline shape-fixe (colonnes `server_name`/
   `database_name`), pas un jeu de lignes `sys.databases` arbitraire ; l'étendre pour ça a semblé
   disproportionné vu que le chemin d'exécution sous-jacent (`ctx.runner.execute`) est déjà
   largement couvert par les autres tests. Un bug ici se verrait immédiatement à l'usage (liste de
   bases vide/fausse dans le panel), contrairement aux subtilités P4 qui, elles, justifiaient des
   tests dédiés. **Non encore vérifié à la main** : le panel VS Code (webview, sign-in réel, run
   contre un vrai tenant Fabric) — aucun outil ne permet de le simuler depuis ce poste de travail ;
   seule la logique métier est couverte par les tests offline. Les quatre points du cadrage V1 sont
   maintenant implémentés (le point 4 continue d'évoluer, cf. §4.D.4 : tri/filtre des résultats,
   éditeur CodeMirror, liste des bases par connexion, ajoutés le 2026-09-25) ; la vérification
   manuelle contre un vrai tenant Fabric reste le prochain jalon avant de considérer la V1
   utilisable en pratique.
