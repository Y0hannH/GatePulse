# Changelog

All notable changes to GatePulse are documented here.

## [1.0.0] - unreleased

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
