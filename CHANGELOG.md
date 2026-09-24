# Changelog

All notable changes to the GatePulse demo are documented here.

## [Unreleased]

### Decided
- 2026-09-24 : PoC validé, cadrage V1 acté (voir `V1-SCOPE.md`). Le CLI de validation
  (`src/cli/main.ts`, scénarios P1-P4) sort du périmètre produit et est **archivé, gelé** — plus
  aucune modification prévue, y compris si les évolutions de `src/core` pour la V1 le cassent.

### Changed
- `src/core/auth.ts` (`FabricAuth`) replaced by `@evolve-data/pulse-core`'s `AzureAuthService`,
  consumed via a `"file:../pulse-shared"` dependency (pulse-shared has no remote yet). GatePulse is
  the second pilot for the Pulse Suite's shared auth (HARMONISATION.md phase 2), after VaultPulse.
  Token-cache/dedup/timeout behavior unchanged; the `open`/ESM shim (`src/shims/open-*.ts`) keeps
  working unmodified since esbuild's `alias` applies inside the bundled pulse-core code too.
  `auth.success`/`auth.failed` JSONL logging (with decoded JWT claims) is preserved in
  `src/core/session.ts`; the more granular `auth.cliExpired`/`auth.cliUnavailable`/`auth.browser`
  event codes are now a single generic `auth.diagnostic`.
- Build layout aligned with the rest of the Pulse Suite: output moved from `out/` to `dist/`,
  `esbuild.mjs` replaced by a CommonJS `esbuild.js`, and the npm scripts renamed to the shared set
  (`compile`, `watch`, `package`, `typecheck`, `lint`, `test`, `vsix`). `npm run build` is now
  `npm run compile`, and `npm run selftest` is now `npm test`.
- ESLint (flat config) and a `typecheck` script added, matching the other extensions.

## [0.1.0] - 2026-09-17

### Added
- Initial demo: ad hoc SQL on an on-prem / IP-filtered database through a Fabric pipeline
  (Lookup / Script activities + gateway connection), driven by the Fabric REST API
- VS Code panel and validation CLI over the same `src/core`
- Validation scenarios P1 (result cap / size), P2 (latency), P3 (concurrency), P4 (connection swap)
- Offline self-test against an in-process mock of the Fabric REST API
