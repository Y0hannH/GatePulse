# GatePulse User Guide

GatePulse lets you run **ad hoc SQL from VS Code** against any SQL connection your Microsoft Fabric tenant authorizes — an on-premises or IP-restricted database reached through a **gateway**, or a **cloud** database you are allowed to use through a Fabric connection but cannot reach directly.

It does this without any server of its own: GatePulse drives a generic **Fabric Data Pipeline** through the Fabric REST API, and reads the result back.

**Contents**

1. [How it works](#1-how-it-works)
2. [Quick start](#2-quick-start)
3. [The sidebar](#3-the-sidebar)
4. [The SQL panel](#4-the-sql-panel)
5. [Results](#5-results)
6. [Unsupported column types](#6-unsupported-column-types)
7. [Limits to know about](#7-limits-to-know-about)
8. [Settings reference](#8-settings-reference)
9. [Commands reference](#9-commands-reference)
10. [Privacy and security](#10-privacy-and-security)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. How it works

```
VS Code ──(Azure sign-in)──> Entra ID
   │
   └──(Fabric REST API)──> Workspace ──> generic pipeline ──> Fabric connection ──> your SQL database
                               ▲                                (gateway or cloud)
                               └── result read back through the API
```

1. You write a query and press **Run**.
2. GatePulse starts a run of a generic pipeline in your Fabric **workspace**, passing three parameters: the **connection** GUID, the **database** name and the **query** text.
3. The pipeline's Lookup/Script activity executes the query *through the Fabric connection*. It runs with the credentials configured **on that connection**, not with yours — that is what makes it useful when you have no direct access to the database.
4. GatePulse waits for the job to finish, reads the activity output through the API and shows it as a table.

Consequences worth remembering:

- **Every query is a pipeline run.** Expect a few seconds per query, not milliseconds. Browsing the sidebar and autocomplete also run small queries behind the scenes (results are cached, see [Settings](#8-settings-reference)).
- **What you can do in SQL is decided by the connection's credentials**, not by GatePulse. GatePulse does not restrict statements to read-only: use a connection whose login has the permissions you intend.
- You need access to the Fabric **workspace** and to the **connection** itself.

## 2. Quick start

### Prerequisites

- A Microsoft Fabric tenant and a **workspace** where the pipeline can live. Your account needs at least the **Contributor** role on it (to create and run the pipeline).
- A Fabric **connection** to your SQL database that you are allowed to use.
- Optional but recommended: the Azure CLI, so that `az login` is reused and no browser pop-up is needed.

### Steps

1. **Add a tenant.** Open the GatePulse icon in the activity bar and click **+** (or run `GatePulse: Add Tenant`). Enter:
   - an **alias** (any name you like, e.g. `Client A - Prod`),
   - the **tenant ID** (Entra ID tenant GUID),
   - the **workspace ID** (the Fabric workspace GUID — visible in the workspace URL).
2. **Add a connection.** Click the **+** on the tenant row (`Add Connection to Tenant`). Pick one of the connections Fabric lists, or enter a connection GUID by hand. The first connection you add becomes the tenant's **default**.
3. **Open the panel.** Click the tenant row, or the ▶ button in the sidebar title.
4. **Pick a database** in the *Database* field (the list is filled from the server) and type a query.
5. Press **Run** or `Ctrl+Enter`.

The first run in a workspace **creates the generic pipeline automatically** (named *GatePulse — Generic SQL Lookup Pipeline*) and tells you so with a notification. Later runs — yours or a colleague's — reuse it. GatePulse never deletes or duplicates pipelines on its own.

Sign-in happens on first use: an existing `az login` session is reused silently; otherwise the browser opens.

## 3. The sidebar

The **GatePulse** view shows everything as a tree, loaded lazily — a level is only fetched when you expand it:

```
Tenant            ← "+" adds a connection
└─ Connection     ← "+" adds a database by hand
   └─ Database
      └─ Schema
         └─ Table / View
            └─ Column (type, nullable)
```

- **Tenant** — the alias, with the default connection's name next to it. Expanding or clicking a tenant makes it the **active tenant** (one tenant is active at a time).
- **Connection** — shown by name when Fabric reports one, otherwise by GUID. The default one is marked *default*. Right-click → **Remove Connection From Tenant**.
- **Database** — listed from the server (`sys.databases`). If a database you can query is **not listed** (the login cannot see it in `sys.databases`), use **+** on the connection row to add it by hand. It shows as *added manually* and can be removed with a right-click.
- **Table / View** — click to expand its columns. **Right-click → Select Top 100 Rows** opens the panel with a ready-made `SELECT TOP 100` query. Clicking never touches your editor.
- Title bar buttons: open the panel, add a tenant, pick a connection, **refresh** (clears all cached metadata and re-fetches), and a menu with *Pick Pipeline (Override)*, *Show Logs*, *Sign Out* and this guide.

## 4. The SQL panel

The top strip tells you **where you are**:

| Field | Meaning |
|---|---|
| **Tenant** | Active tenant, shown as `alias · default connection name`. Changing it switches tenant (and reloads that tenant's defaults). **+** adds a tenant. |
| **Connection** | The Fabric connection the query goes through, by name. *Enter a GUID manually…* is the fallback if the list is unavailable or the connection is not in it. ↻ re-lists connections. |
| **Database** | The database the query runs in. Type or pick; ↻ refreshes the list. Databases you added by hand are included. |

Below is the **editor** (CodeMirror):

- T-SQL syntax highlighting, line numbers, bracket matching and auto-closing.
- **Autocomplete**: `Ctrl+Space` anywhere, and automatically after a `.`
  - bare word → schemas, tables and views,
  - `schema.` → that schema's tables and views,
  - `table.` → that table's columns.
  
  Each kind has its own icon. Names come from the same cache as the sidebar, warmed as soon as connection and database are set.
- **Run** (`Ctrl+Enter`) and **Cancel**. While a query runs you see a *Running…* indicator; Cancel stops the job.
- The editor can be resized by dragging its bottom edge. The panel remembers your connection, database and query across reloads.

**Query history** (below the results) keeps your last 50 queries — text, tenant, connection, database and success flag, **never the results**. Click an entry to load it into the editor *without* running; click its ▶ to load **and** run. Entries from another tenant switch to that tenant first.

## 5. Results

- Each query activity of the pipeline run produces a result table (normally one).
- **Sort** by clicking a column header (ascending → descending → none). **Filter** with the box under each header (case-insensitive substring; all filters combine).
- The header shows the row count (`filtered / total` while filtering).
- **Export CSV** saves the rows **currently shown** (after filter and sort) through a save dialog. Cells starting with `=`, `+`, `-` or `@` are prefixed with a quote so spreadsheets don't interpret them as formulas.
- `NULL` values are shown dimmed.

Above the table, a coloured **banner** appears only when something deserves attention:

| Banner | Meaning |
|---|---|
| Result looks truncated at 5,000 rows | The Lookup silently caps output; add `TOP`/`WHERE`. |
| Query sent doesn't match the one executed | The pipeline probably used default parameter values. |
| Different connection / database than selected | The run did not use what you picked. |
| Converted to text | Some columns were cast automatically, see below. |

Errors are shown in a red box with a category (SQL error, connection/gateway, permission, timeout…) and a hint. The raw message is always included.

## 6. Unsupported column types

Fabric's data-transfer engine cannot move some SQL Server types — `varbinary`/`binary`/`image`, `timestamp`/`rowversion`, `xml`, `geography`/`geometry`, `hierarchyid`, `sql_variant`. A plain `SELECT *` over a table containing one fails with *DataTypeNotSupported*.

GatePulse handles this for you:

1. If a query fails for that reason, GatePulse **describes the result set** (one extra pipeline run), then **re-runs the query once** with those columns cast to text. A banner lists which columns were converted.
2. **Select Top 100 Rows** casts such columns up front, so it works the first time.

| Type | Shown as |
|---|---|
| binary, varbinary, image, timestamp, rowversion | Hex text (`0x…`), cut at **128 bytes** |
| xml | Text (`nvarchar(max)`) |
| geography, geometry | Well-known text (`STAsText()`) |
| hierarchyid | Text (`ToString()`) |
| sql_variant | Text (`nvarchar(4000)`) |

Limits of the automatic rewrite: queries starting with `WITH` (CTE) or `EXEC` are not rewritten; a result with unnamed or duplicate column names is not rewritten; and an `ORDER BY` without `TOP` inside a query that has to be wrapped is rejected by SQL Server. In those cases you keep the original error — cast the columns yourself (`CONVERT(varchar(max), col, 1)`, `CAST(col AS nvarchar(max))`, `col.STAsText()`) or leave them out. Turn the feature off with `gatepulse.autoConvertUnsupportedColumns`.

## 7. Limits to know about

| Limit | Detail |
|---|---|
| **5,000 rows** per activity | The Lookup activity silently truncates beyond this. GatePulse flags it in a banner when it detects it, but cannot recover the rest — use `TOP`, `WHERE` or paging. |
| **4 MB** of output | Larger results make the run fail (*Result too large*). Select fewer columns instead of `SELECT *`. |
| **Latency** | Each query is a pipeline job: queueing plus execution is typically seconds. |
| **Concurrency** | One query at a time per panel. Many parallel jobs can hit Fabric rate limits (HTTP 429, retried automatically). |
| **Large data movement** | Not a goal. GatePulse is for ad hoc inspection, not bulk export or copy to a Lakehouse. |
| **Timeout** | A job not finished after `gatepulse.timeoutMs` (default 2 minutes) is cancelled. |

## 8. Settings reference

Settings live in **User Settings** (the sensitive ones cannot be overridden by a workspace's `.vscode/settings.json`). Open them with the ⚙ button in the panel or search for `gatepulse`.

### Tenants — `gatepulse.tenants`

An array, normally edited through the **+** buttons, but plain JSON works too:

```jsonc
"gatepulse.tenants": [
  {
    "alias": "Client A - Prod",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "workspaceId": "00000000-0000-0000-0000-000000000000",
    "connectionGuid": "00000000-0000-0000-0000-000000000000",   // default connection
    "databaseName": "MyDb",                                      // pre-filled in the panel
    "connections": [
      { "id": "…", "name": "Gateway A", "extraDatabases": ["HiddenDb"] }
    ],
    "clientId": "",      // optional app registration for this tenant
    "pipelineId": ""     // optional: skip auto-provisioning, use this pipeline
  }
]
```

### Everything else

| Setting | Default | Purpose |
|---|---|---|
| `gatepulse.authFlow` | `auto` | `auto` reuses the Azure CLI session, else opens the browser. Also `azureCli`, `interactive`, `deviceCode`. |
| `gatepulse.clientId` | empty | Leave empty to use Microsoft's first-party public client — **no app registration needed**. |
| `gatepulse.scopes` | Fabric `.default` | Token scopes. |
| `gatepulse.cacheSchemaMetadata` | `true` | Keep discovered databases/tables/columns across restarts (stored locally). Off = memory only. |
| `gatepulse.autoConvertUnsupportedColumns` | `true` | Auto-retry with text casts, see [section 6](#6-unsupported-column-types). |
| `gatepulse.timeoutMs` | `120000` | Maximum wait for a job. |
| `gatepulse.pollIntervalMs` | `2000` | How often job status is checked. |
| `gatepulse.activityNames` | `[]` | Restrict which pipeline activities are read. Empty = every Lookup and Script activity. |
| `gatepulse.parameterNames` | `connectionGuid` / `databaseName` / `query` | Parameter names, if you use a hand-made pipeline that names them differently. |
| `gatepulse.parameterPayloadFormat` | `executionData` | How parameters are sent to the job API. |
| `gatepulse.logDirectory` | empty | Where JSONL logs and reports are written (empty = extension storage). |

## 9. Commands reference

All commands are in the Command Palette under **GatePulse:**.

| Command | What it does |
|---|---|
| Open SQL Panel | Opens (or reveals) the query panel. |
| Add Tenant / Switch Tenant | Create a tenant entry / change the active one. |
| Add Connection to Tenant | Attach a Fabric connection to a tenant (also the **+** on the tenant row). |
| Remove Connection From Tenant | Detach a connection (right-click a connection). |
| Add Database to Tenant | Add a database by hand under a connection (the **+** on the connection row). |
| Remove Manually Added Database | Remove such a database (right-click). |
| Pick Connection | Choose the connection used by the open panel; can be saved as the tenant default. |
| Refresh Connections | Re-list the connections Fabric exposes. |
| Select Top 100 Rows | Right-click a table or view in the tree. |
| Refresh Schema Tree | Clear all cached metadata and re-fetch on demand. |
| Pick Pipeline (Override) | Choose an existing pipeline for the tenant instead of the auto-provisioned one. |
| Show Logs | Open the GatePulse output channel. |
| Sign Out | Forget the session; the next run asks you to sign in again. |
| Open Documentation | Opens this guide. |

Shortcuts in the editor: `Ctrl+Enter` run, `Ctrl+Space` autocomplete.

## 10. Privacy and security

- **Nothing leaves your machine except calls to the Fabric API** and the sign-in with Entra ID. There is no GatePulse backend and no telemetry.
- **Tokens stay in memory** for the VS Code session. Sign Out clears them.
- **Credentials of the SQL database are never seen by GatePulse**: they belong to the Fabric connection.
- **Logs and reports** (JSONL, in the log directory) contain the query text, run metadata and a sample of result rows. Treat that folder as sensitive, and point `gatepulse.logDirectory` somewhere appropriate if needed. They are *not* shown in the panel; use **Show Logs** for the live output.
- **Query history** (last 50) is stored locally in VS Code's state: query text and metadata only, never result rows.
- **Cached metadata** (database, table and column names) is stored locally; turn it off with `gatepulse.cacheSchemaMetadata`.
- **Sensitive settings** (tenants, client ID, scopes, log folder) are application-scoped, so an untrusted repository cannot silently redirect your queries to another tenant or workspace.
- GatePulse does not restrict SQL to read-only — see [section 1](#1-how-it-works). A write you send is executed with the connection's credentials.

## 11. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Sign-in loops or fails | Run `az login --tenant <tenantId>` and retry, or set `gatepulse.authFlow` to `interactive`. |
| *Permission* error / 403 when listing or creating the pipeline | You need the **Contributor** role on the workspace, and rights on the connection. Ask the workspace admin. |
| Connection list is empty or says *unavailable* | Your account may not be allowed to list connections. Use *Enter a GUID manually…*; the run itself is the source of truth. |
| Database list is empty or missing one | The login may not see it in `sys.databases`. Add it with **+** on the connection row, or just type its name in the panel. |
| *Generic pipeline unusable* | A pipeline with the expected name exists but is malformed (parameters or Lookup activity missing). Fix or rename it in Fabric, or use *Pick Pipeline (Override)*. |
| Two pipelines with the same name | Two colleagues created it at the same moment. GatePulse picks the smallest id deterministically and logs a warning; delete the duplicate in Fabric when convenient. |
| *Column type not supported* | See [section 6](#6-unsupported-column-types). |
| Result truncated at 5,000 rows | Add `TOP` or `WHERE`. |
| *Result too large* | Select fewer columns or fewer rows. |
| *Connection / gateway error* | Check the connection's credentials and gateway status in Fabric. |
| A query seems to hang | The job is queued in Fabric; it is cancelled after `gatepulse.timeoutMs`. Use **Cancel** to stop earlier. |
| Autocomplete is empty | Connection and database must be set; the first fetch takes a few seconds. Use **Refresh Schema Tree** if the schema changed. |
| Something unexpected | Open **Show Logs**, then check the JSONL log in the log directory (its path is printed when the session starts). |
