# Changelog

All notable changes to GatePulse are documented here.

## [Unreleased]

### Added
- Several query tabs: each one has its own editor, connection, database and results, and can run
  its own query. `New Query` (icon on a database row, right-click, Command Palette, or the new-tab
  button in the panel header) opens a tab straight on that database. The tab title shows the
  database. `Select Top 100 Rows` reuses a tab whose editor is empty and opens a new one otherwise,
  so it no longer overwrites a query being written.

### Changed
- The *Database* field of the query panel is a real dropdown over the listed databases (no more
  clearing a text field to switch). *Default (master)* and *Enter a name manually…* remain available
  for a database that is not listed or when the list cannot be loaded.

## [1.1.0] - 2026-10-14

### Added
- Stored procedures and functions are listed in the sidebar, under their schema, with their
  parameters (and a function's return type) one level down. They are also offered by the editor's
  autocomplete.
- `Refresh` on right-click of a database, a schema, or a Tables / Views / Procedures / Functions
  folder: re-reads only that part of the object list (and drops the cached columns/parameters of the
  objects it covers) instead of clearing the whole cache.
- `Search Objects` (magnifier on a database row, title bar, Command Palette): a search box over all
  the objects of a database across schemas; Enter opens `Select Top 100 Rows` or `Script as CREATE`.
- `Script as CREATE` (right-click a view, procedure or function): opens the object's `CREATE`
  statement in a new SQL editor, with the `SET ANSI_NULLS` / `SET QUOTED_IDENTIFIER` options it was
  created with. An encrypted object, or one the login cannot read (`VIEW DEFINITION`), is reported
  instead of producing an empty script.

### Changed
- Under a schema, objects are grouped by kind: Tables, Views, Procedures, Functions (with counts).
- The list of a database's objects is fetched page by page, so databases with more than 5,000
  tables/views/procedures/functions are listed in full instead of being cut off silently.
- The schema cache is versioned: the first expansion of a database after the update re-fetches its
  object list once, so that procedures and functions show up without a manual refresh.
- If a server rejects the procedure/function listing (`INFORMATION_SCHEMA.ROUTINES`), the tree falls
  back to tables and views only and logs a warning, as in 1.0.x.

## [1.0.1] - 2026-10-09

### Changed
- New extension icon: a SQL prompt on a database instead of a pulse line, which suggested monitoring.

## [1.0.0] - 2026-10-09

First product release. GatePulse leaves its proof-of-concept stage and becomes an internal tool for
data engineers, with the VS Code extension as its only product surface.

### Added
- Multi-tenant sidebar: Tenant → Connection → Database → Schema → Table/View → Column, each level
  loaded on demand and cached (cache persisted across restarts, `gatepulse.cacheSchemaMetadata`).
- Several connections per tenant, shown by name; databases that `sys.databases` does not list for a
  login can be added by hand under a connection.
- Automatic provisioning of the generic pipeline per workspace (reused by every user of the workspace,
  never duplicated or deleted automatically).
- SQL panel: T-SQL editor with syntax highlighting and schema-aware autocomplete, sortable and
  per-column filterable results, CSV export, query history (last 50, text only).
- `Select Top 100 Rows` from the tree (right-click on a table or view).
- Automatic text cast of column types the Lookup cannot transfer (binary, xml, geography, geometry,
  hierarchyid, sql_variant), announced in the result (`gatepulse.autoConvertUnsupportedColumns`).
- Alerts for silent truncation at 5,000 rows and for unbound parameters.
- Built-in user guide (`GatePulse: Open Documentation`).

### Changed
- Package renamed from `gatepulse-fabric-sql-demo` to `gatepulse`.
- The whole UI is in English.
- Sign-in goes through `@evolve-data/pulse-core` (shared `AzureAuthService`), consumed as a git
  dependency on the public `pulse-shared` repository.
- Sensitive settings (`tenants`, `clientId`, `scopes`, `logDirectory`) are application-scoped: a
  workspace's `.vscode/settings.json` cannot override them.
- Build output moved to `dist/`; npm scripts aligned with the other Pulse Suite extensions.

### Security
- Pagination URLs returned by Fabric are only followed on the Fabric API origin.
- Hard 30 s timeout on every HTTP call; the operation id header is validated before use in a URL.
- Identifiers in generated SQL are escaped; webview messages are handled defensively.

### Removed from the product
- The twelve `gatepulse.validation.*` settings (PoC test queries, sizes and iteration counts): they only
  fed the archived CLI scenarios, which read their own `gatepulse.config.json`.
- The validation CLI (scenarios P1–P4) is archived and frozen; it is no longer shipped in the
  extension package. Its findings are kept in `docs/POC-VALIDATION.md`.

## [0.1.0] - 2026-09-17

### Added
- Initial proof of concept: ad hoc SQL on an on-prem / IP-filtered database through a Fabric
  pipeline (Lookup / Script activities + gateway connection), driven by the Fabric REST API.
- VS Code panel and validation CLI over the same `src/core`.
- Validation scenarios P1 (result cap / size), P2 (latency), P3 (concurrency), P4 (connection swap).
- Offline self-test against an in-process mock of the Fabric REST API.
