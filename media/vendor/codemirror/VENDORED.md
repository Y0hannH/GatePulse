Vendored from npm `codemirror@5.65.21` (MIT license), used as-is for the SQL editor in the panel
webview — plain `<script>`/`<link>` includes, not an npm runtime dependency (the webview has no
bundler/module resolution). Files kept: `lib/codemirror.js`, `lib/codemirror.css`,
`mode/sql/sql.js`, `addon/edit/matchbrackets.js`, `addon/edit/closebrackets.js`,
`addon/hint/show-hint.js`, `addon/hint/show-hint.css`. Not `addon/hint/sql-hint.js` — GatePulse's
autocomplete is schema-aware (table/column names discovered via the panel's own metadata cache,
V1-SCOPE.md §4), so `panel.js` implements its own hint function against `show-hint`'s
`CodeMirror.showHint()` API instead of the generic keyword-only `sql-hint`.

CodeMirror 5 (not 6) on purpose: CM6 ships as many small ES modules meant to be bundled, which
would need its own build step for the webview; CM5 is a single self-contained file designed for
direct script-tag inclusion, matching how the rest of `media/` is served (no webview build step —
see GatePulse/CLAUDE.md).

To upgrade: re-run the same `npm install --no-save codemirror@<version>` / copy / `npm uninstall`
steps from the git history of this file's introduction, then re-check `mode/sql/sql.js` still
exposes the same `CodeMirror.defineMode('sql', ...)` API `panel.js` relies on.

No theme file is vendored — `media/panel.css` defines a custom `.cm-s-gatepulse` theme using
VS Code's own CSS variables, so the editor matches the active VS Code theme (light/dark) instead
of a fixed CodeMirror theme.
