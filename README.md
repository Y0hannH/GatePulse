# GatePulse — démo « SQL via pipeline Fabric »

Exécuter du SQL ad hoc via un pipeline Fabric (activité Lookup et/ou Script), piloté **uniquement par l'API REST Fabric**, sur n'importe quelle connexion Fabric autorisée — gateway (base on-prem / filtrée par IP) ou cloud. Le pipeline ne fait que recevoir un GUID de connexion en paramètre : il l'exécute avec les identifiants configurés sur *cette connexion*, pas les tiens — deux scénarios distincts en profitent : contourner un accès réseau restreint (gateway), ou exécuter une requête via une connexion à laquelle tu es autorisé sans avoir toi-même d'accès direct à la base (cloud). Le projet mesure aussi les 4 points de risque du brief.

Le runner lit **toutes les activités de requête** du run (types `Lookup` et `Script`, ou la liste `activityNames`). Chaque check est émis par activité, et `all` termine par une comparaison côte à côte (durées, taille de sortie, limites, données identiques ou non).

```
VS Code (webview) ─┐
                   ├─> src/core (TypeScript, en process) ──@azure/identity──> Entra ID
CLI de validation ─┘          │
                              ├─ POST  /v1/workspaces/{ws}/items/{pipeline}/jobs/instances?jobType=Pipeline   (runQuery)
                              ├─ GET   /v1/workspaces/{ws}/items/{pipeline}/jobs/instances/{jobId}             (pollJobStatus)
                              └─ POST  /v1/workspaces/{ws}/datapipelines/pipelineruns/{jobId}/queryactivityruns (getResult)
```

Il n'y a pas de serveur HTTP séparé. Le « backend » est la librairie `src/core`, appelée directement par l'extension et par le CLI. C'est le cas le plus simple prévu par le brief, et le même code tourne des deux côtés.

| Dossier | Rôle |
|---|---|
| `src/core/auth.ts` | Session Azure CLI ou connexion navigateur (@azure/identity), token en mémoire |
| `src/core/fabricClient.ts` | Appels REST, gestion des 429 (loguée), Location/Retry-After, opérations longues |
| `src/core/pipelineRunner.ts` | `runQuery` / `pollJobStatus` / `getResult` / `execute` : timings et checks à chaque run |
| `src/core/scenarios.ts` | Tests P1 plafond et taille, P2 latence, P3 concurrence, P4 swap de connexion |
| `src/core/compare.ts` | Comparaison entre activités de requête (ex. Lookup1 vs Script1) |
| `src/core/provision.ts` | `inspect` (lecture de la définition) et `provision` (création via API) |
| `src/cli/main.ts` | CLI de validation |
| `src/extension/*`, `media/*` | Extension VS Code (webview) |
| `test/mock-selftest.ts` | Auto-test hors ligne contre un faux Fabric (vérifie la logique, **pas** Fabric) |

## 1. Authentification

Même mécanisme que FabricPulse (`@azure/identity`), **aucune app registration n'est nécessaire** :
1. Si une session Azure CLI existe pour le tenant (`az login --tenant <tenantId>`), elle est utilisée sans popup.
2. Sinon, le navigateur s'ouvre pour la connexion (`InteractiveBrowserCredential`). `clientId` étant **vide**, c'est le client public Microsoft qui est utilisé, avec le scope `https://api.fabric.microsoft.com/.default`.

Au sign-in, le log `auth.success` affiche l'utilisateur, l'appId et les scopes réellement accordés au token.

- `authFlow` : `auto` (défaut), `azureCli`, `interactive` ou `deviceCode`.
- Ne renseigner `clientId` que si une app registration autorisée pour les connexions utilisateur existe.
- Les tokens restent en mémoire : l'extension les garde pendant la session VS Code, alors que le CLI redemande la connexion à chaque commande. Un `az login` évite ces popups répétés.
- Le compte doit être au minimum **Contributor** du workspace et **utilisateur de la connexion** utilisée (gateway ou cloud).

## 2. Build

```bash
npm install
```
```bash
npm run compile
```
```bash
npm test
```

## 3. CLI de validation

```bash
cp gatepulse.config.example.json gatepulse.config.json
```
Renseigner `tenantId`, `workspaceId`, `pipelineId`, `connectionGuid` et `databaseName`. Pour P4, ajouter `validation.alternateConnectionGuid` et `alternateDatabaseName`.

Ordre recommandé :

```bash
node dist/cli.js login
```
```bash
node dist/cli.js inspect
```
```bash
node dist/cli.js run --query "SELECT 1 AS one"
```
```bash
node dist/cli.js all
```

- `inspect` vérifie que le pipeline déclare bien les 3 paramètres, que `firstRowOnly=false`, et que la connexion du Lookup référence `pipeline().parameters.connectionGuid`. Il liste aussi les 10 derniers jobs, ce qui permet de récupérer l'id d'un run lancé depuis l'UI (voir P4).
- `all` enchaîne latency, rowcap, size, concurrency et swap, puis affiche un **VALIDATION SUMMARY** et, s'il y a plusieurs activités de requête, une **QUERY ACTIVITY COMPARISON** (aussi écrite dans `logs/reports/comparison-*.json`). Le code de sortie vaut 1 si un check est en FAIL.

Sorties :
- `logs/gatepulse-YYYY-MM-DD.jsonl` : tous les événements horodatés, y compris les appels HTTP (`--verbose` les affiche aussi dans la console).
- `logs/reports/<scenario>-<timestamp>.json` : rapport complet (runs, timings, checks, preuves).

## 4. Extension VS Code

1. Ouvrir ce dossier dans VS Code, puis **F5** (« Run GatePulse extension »).
2. Dans la fenêtre Extension Development Host, renseigner les settings `gatepulse.*` (`tenantId`, `workspaceId`, `pipelineId`, `connectionGuid`, `databaseName`).
3. Palette de commandes : **GatePulse: Open SQL Panel**.
4. Taper la requête, puis **Run** (ou Ctrl+Entrée). Pendant l'exécution, le panneau affiche un spinner, le temps écoulé en direct, la phase, le statut du job et le nombre de polls. Ensuite viennent le tableau des résultats, la décomposition de la latence et les checks P1 à P4.
5. Les boutons *P2 Latence / P1 Plafond / P1 Taille / P3 Concurrence / P4 Swap connexion* lancent les scénarios. Chaque activité de requête a son propre bloc de résultat.
6. Les logs sont dans le canal de sortie **GatePulse**. Le JSONL et les rapports sont dans `gatepulse.logDirectory` (par défaut, le global storage de l'extension).

Les erreurs sont classées par type, avec un badge distinct : `sql`, `resultTooLarge` (sortie > 4 Mo), `connection` (gateway, GUID, identifiants), `auth`, `permission`, `timeout`, `trigger`, `rateLimit`, `deduped`, `resultRetrieval`, `pipelineFailed`, `cancelled`, `network`, `config`. Le classement sql/connection est une heuristique sur le message de l'activité : le message brut est toujours affiché.

## 5. Comment chaque point est validé

Chaque verdict est logué explicitement (`validation.P<n>.<CHECK>`, niveau ERROR si FAIL, WARN si WARN ou UNVERIFIED). Le code ne contourne rien sans le signaler : les 429 sont retentés, mais chaque tentative est loguée en WARN.

### P1 — Aller-retour via API et plafond de lignes
- `API_TRIGGER` : 202 reçu et id du job extrait du header `Location`. Sinon, erreur `trigger` explicite.
- `API_RESULT` : la sortie du Lookup a été lue via `queryactivityruns`. La forme de la réponse (`array` ou `{value}`) et le **squelette exact** du run d'activité sont logués (`result.rawStructure`). Si le job est `Completed` mais la sortie est introuvable, le check passe en FAIL.
- `PARAM_BINDING` : la requête envoyée doit se retrouver dans `input` de l'activité Lookup. Si elle n'y est pas, c'est un FAIL : les paramètres ne sont pas liés et le pipeline tourne sur ses valeurs par défaut. Voir `parameterPayloadFormat` plus bas.
- `ROW_CAP` et le scénario `rowcap` : demande 100, 5000, 5001 et 7500 lignes, puis indique pour chaque activité si elle **échoue**, **tronque silencieusement** à 5000 ou **ne plafonne pas**.
- `PAYLOAD_SIZE` et le scénario `size` : requêtes de 500, 900, 1100 et 2000 lignes d'environ 4 Ko (`validation.sizeTestRows`), pour situer la limite de taille de sortie (4 194 304 octets mesurés sur le Lookup) et voir si l'activité échoue ou tronque.

### P2 — Latence
Chaque run logue `trigger | wait (file Fabric, run Fabric, durée du Lookup, retard de détection) | result | TOTAL`. Le temps d'authentification est mesuré à part et **exclu** du total. Le scénario `latency` exécute N runs séquentiels et calcule min, médiane et max par étape. Le premier run est affiché séparément, car il peut être « froid ».
La précision de `wait` dépend de `pollIntervalMs` (2 s par défaut). `completionDetectionLagMs` quantifie ce biais à partir de `endTimeUtc` côté Fabric.

### P3 — Concurrence
N runs (3 par défaut) partent simultanément sur le même item, chacun avec un tag unique (`SELECT 'gp1_ab12cd34' AS run_tag`). Les checks :
- `DISTINCT_JOB_INSTANCES`
- `NO_DEDUP` : statut `Deduped`
- `RUN_ID_MATCH`
- `PARAM_ISOLATION` : chaque input ne contient que son propre tag.
- `RESULT_ISOLATION` : chaque résultat ne contient que son propre tag.
- `TRUE_PARALLELISM` : chevauchement réel des fenêtres start/end côté Fabric. Si Fabric a mis les runs en file, le check passe en WARN : l'isolation reste valide, mais la latence s'additionne.

### P4 — Swap dynamique de connexion via API (point le plus incertain)
Scénario `swap`, sur le même pipeline, où seul le paramètre change :
- **A** : requête d'identité (`@@SERVERNAME`, `DB_NAME()`) sur la connexion principale.
- **B** : même requête sur la connexion alternative. `IDENTITY_DIFFERS` vérifie que la réponse vient bien d'un autre serveur ou d'une autre base.
- **C, contrôle négatif** : un GUID aléatoire inexistant. **S'il réussit, le check est en FAIL** : le GUID passé par API est ignoré et le pipeline retombe sur une connexion figée.
- `CONNECTION_RESOLUTION`, à chaque run : où le GUID apparaît dans l'input de l'activité. Si un *autre* GUID de connexion apparaît, c'est un FAIL. S'il n'apparaît pas du tout, le check est UNVERIFIED.
- **D, optionnel** (`validation.referenceUiJobInstanceId`) : diff structurel entre l'input du Lookup d'un run **lancé depuis l'UI** et celui d'un run API (`UI_VS_API`). C'est la réponse directe à « même comportement qu'en manuel ? ». L'id du run UI s'obtient avec `node dist/cli.js inspect`.

## 6. Hypothèses non confirmées, à trancher au premier run réel

| Sujet | Hypothèse du code | Comment le vérifier / ajuster |
|---|---|---|
| Format des paramètres du job | `{"executionData":{"parameters":{...}}}` | Si `PARAM_BINDING` est en FAIL, passer `parameterPayloadFormat` à `typedParameters` (`{"parameters":[{name,value,type:"Text"}]}`) et relancer. |
| Point d'API pour le résultat | `POST .../datapipelines/pipelineruns/{jobId}/queryactivityruns` (documenté dans *REST API capabilities for Fabric Data Factory*) | Logué à chaque run (`result.activityRuns`, `result.rawStructure`). Des cas de réponse vide sont signalés sur le forum Fabric : d'où les retries (`resultFetchRetries`) et un FAIL explicite en cas d'échec. |
| Scopes | `.default` via le client public Microsoft : le token porte `user_impersonation` | Si un appel renvoie 401/403 : erreur `auth`/`permission` avec requestId. |
| Plafond Lookup | 5000 lignes (confirmé : troncature silencieuse) | Scénario `rowcap`. |
| Limite de taille | 4 194 304 octets sur le Lookup (confirmé : échec `resultTooLarge`) | Scénario `size`, par activité. |
| Sortie de l'activité Script | `output.resultSets[0].rows` / `rowCount` | Structure loguée (`result.rawStructure`) ; ERROR explicite si `resultSets` est absent. |
| JSON du pipeline provisionné | `provisioning/pipeline-template.json`, forme **non vérifiée** de `externalReferences.connection` dynamique | Préférer `provision --name X --from <pipelineId créé dans l'UI>` (clone d'une définition connue). `provision` relit ensuite la définition créée et avertit si la connexion n'est plus dynamique. |
| Types de base | Requêtes de validation en T-SQL | Settings `validation.*QueryTemplate` / `identityQuery` / `latencyQuery`. |

## 7. Limites (démo)
- Tokens en mémoire uniquement (pas de cache persistant).
- Hors scope, conformément au brief : multi-tenant, licences, liste dynamique des connexions, gros volumes (Copy vers Lakehouse), UX.
