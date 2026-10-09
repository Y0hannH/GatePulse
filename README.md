# GatePulse

**Run ad hoc SQL from VS Code on any Microsoft Fabric-authorized connection — gateway or cloud — through a generic Fabric pipeline, driven only by the Fabric REST API.**

GatePulse is a VS Code extension for data engineers. It is useful when the database you need to query is not directly reachable from your machine:

- **Gateway:** an on-premises or IP-restricted database that only a Fabric gateway can reach.
- **Cloud:** a database you are allowed to use through a Fabric connection, but to which you have no direct login or network access.

The pipeline only receives a connection GUID as a parameter and executes your query **with the credentials configured on that connection**, not yours. There is no backend, no telemetry, and nothing to install on the database side.

## Features

- **Multi-tenant sidebar** — browse Tenant → Connection → Database → Schema → Table/View → Column, each level loaded on demand and cached.
- **SQL panel** — T-SQL editor with syntax highlighting and schema-aware autocomplete (`Ctrl+Space`, or automatically after a `.`).
- **Results** — sortable, per-column filterable tables, with CSV export of the rows currently shown.
- **Connection names, not GUIDs** — connections are listed from Fabric and shown by name; databases the login can't see in `sys.databases` can be added by hand.
- **Automatic provisioning** — the generic pipeline is created in your workspace on first use and reused by everyone afterwards.
- **Unsupported column types handled** — `varbinary`, `xml`, `geography`, `sql_variant`… can't cross the Lookup activity; GatePulse re-runs the query with those columns cast to text and tells you so.
- **Safe signals** — a banner warns about silent truncation at 5,000 rows and about parameters that were not bound.
- **Query history** — the last 50 queries (text only, never results), re-runnable in one click.
- **Built-in guide** — full documentation shipped inside the extension (`GatePulse: Open Documentation`).

## How it works

```
VS Code ──(Azure sign-in)──> Entra ID
   │
   └──(Fabric REST API)──> Workspace ──> generic pipeline ──> Fabric connection ──> your SQL database
                               ▲                                (gateway or cloud)
                               └── result read back through the API
```

1. You press **Run**. GatePulse starts a run of the generic pipeline, passing the connection GUID, database name and query as parameters.
2. The pipeline's Lookup/Script activity runs the query through the Fabric connection.
3. GatePulse polls the job, reads the activity output through the API and displays it.

Every query is a pipeline job, so expect seconds, not milliseconds. See the guide for the limits (5,000 rows and 4 MB per result).

## Getting started

### Prerequisites

- A Microsoft Fabric tenant, a **workspace** where the pipeline can live (the **Contributor** role is needed to create and run it), and a Fabric **connection** you are allowed to use.
- VS Code `1.90` or later and Node.js `20` or later (to build from source).
- Optional: the Azure CLI. An existing `az login` session is reused silently; otherwise the browser opens. No app registration is required.

### Install

GatePulse is not on the Marketplace. Build the `.vsix` and install it:

```bash
npm install
npm run vsix
code --install-extension gatepulse-fabric-sql-demo-0.1.0.vsix
```

To try it from source instead, open this folder in VS Code and press **F5** to start an Extension Development Host.

### First query

1. Click the GatePulse icon in the activity bar, then **+** to add a tenant: an alias, the Entra ID **tenant ID** and the Fabric **workspace ID**.
2. Click **+** on the tenant row to add a connection (pick one Fabric lists, or paste a GUID). The first one becomes the default.
3. Click the tenant to open the SQL panel, pick a database, write a query and press **Run** (`Ctrl+Enter`).

The first run in a workspace creates the pipeline *GatePulse — Generic SQL Lookup Pipeline* and notifies you.

## Documentation

- **User guide** — [`media/guide.md`](media/guide.md): concepts, sidebar, panel, limits, settings, commands, privacy, troubleshooting. Also available in VS Code via `GatePulse: Open Documentation` or the book button in the panel.
- [`V1-SCOPE.md`](V1-SCOPE.md) — product scope and design decisions (French).
- [`docs/POC-VALIDATION.md`](docs/POC-VALIDATION.md) — notes from the original proof of concept and the measured Fabric behaviour (French, archived).

## Privacy and security

- Nothing leaves your machine except calls to the Fabric API and sign-in with Entra ID.
- Tokens stay in memory for the VS Code session; the SQL credentials live on the Fabric connection and are never seen by GatePulse.
- Logs and reports (query text, metadata, a sample of result rows) are written locally — treat the log folder as sensitive.
- Sensitive settings (tenants, client ID, scopes, log folder) are application-scoped: a workspace's `.vscode/settings.json` cannot override them.
- GatePulse does not restrict SQL to read-only. A statement runs with whatever rights the Fabric connection has.

## Development

```bash
npm run compile     # esbuild → dist/
npm run watch       # esbuild in watch mode
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # offline self-tests against a fake Fabric (logic only, not Fabric itself)
npm run vsix        # build the .vsix
```

| Path | Role |
|---|---|
| `src/core/` | In-process "backend": auth session, Fabric REST client, pipeline runner, query/discovery helpers, provisioning |
| `src/extension/` | VS Code integration: activation and commands, SQL panel (webview), sidebar tree |
| `media/` | Webview assets (`panel.js`, `panel.css`), vendored CodeMirror and codicons, the user guide |
| `provisioning/` | Template of the generic pipeline |
| `test/` | Offline self-tests |
| `src/cli/` | Validation CLI from the PoC — **archived and frozen**, not part of the product |

There is no separate server: the extension calls `src/core` directly. `npm test` validates GatePulse's own logic against a mock; it says nothing about Fabric's behaviour.

## Status

Internal tool for data engineers, past its proof-of-concept stage and manually tested against a real Fabric tenant. Not published on the Marketplace.

## License

[MIT](LICENSE)
