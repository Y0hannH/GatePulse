import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';
import { checkConfig, checkTenants, isGuid } from '../core/config';
import { serializeError } from '../core/errors';
import type { FabricConnection } from '../core/fabricClient';
import type { ColumnInfo, SchemaObject } from '../core/runQuery';
import { runSingle } from '../core/runQuery';
import type { ScenarioContext, ScenarioReport } from '../core/scenarios';
import type { Session } from '../core/session';
import { compactRun } from '../core/session';

/**
 * Everything the panel needs from extension.ts, bundled instead of threaded as positional
 * arguments — session/auth, pipeline resolution, and the three metadata caches (databases, schema
 * objects, columns) are all owned by extension.ts and *shared* with the sidebar tree, so the panel
 * only ever calls through these, never touches a cache directly.
 */
export interface PanelServices {
  getSession: () => Session;
  getTenants: () => TenantEntry[];
  getActiveTenantAlias: () => string;
  ensurePipelineResolved: (session: Session) => Promise<void>;
  getDatabases: (connectionGuid: string, databaseNameHint: string, force: boolean) => Promise<string[]>;
  getSchemaObjects: (connectionGuid: string, databaseName: string) => Promise<SchemaObject[]>;
  getColumns: (
    connectionGuid: string,
    databaseName: string,
    schema: string,
    table: string,
  ) => Promise<ColumnInfo[]>;
  /** Fabric SQL connections the active tenant can use (cached; `force` re-lists). Never throws. */
  getConnections: (force?: boolean) => Promise<FabricConnection[]>;
  /** Display name remembered for a connection GUID, if it was ever listed. */
  getConnectionName: (guid: string | undefined) => string | undefined;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'run'; connectionGuid: string; databaseName: string; query: string }
  | { type: 'cancel' }
  | { type: 'showLogs' }
  | { type: 'openSettings' }
  | { type: 'openGuide' }
  | { type: 'newTab'; connectionGuid: string; databaseName: string }
  | { type: 'editorState'; databaseName: string; empty: boolean }
  | { type: 'switchTenant'; alias: string }
  | { type: 'addTenant' }
  | { type: 'refreshConnections' }
  | { type: 'listDatabases'; connectionGuid: string; databaseNameHint: string; force: boolean }
  | { type: 'listTables'; connectionGuid: string; databaseName: string }
  | { type: 'listTableColumns'; connectionGuid: string; databaseName: string; schema: string; table: string }
  | { type: 'exportCsv'; activityName: string; columns: string[]; rows: Record<string, unknown>[] };

interface HistoryEntry {
  query: string;
  timestamp: string;
  tenantAlias: string;
  connectionGuid: string;
  databaseName: string;
  succeeded: boolean;
}

const HISTORY_KEY = 'gatepulse.history';
const HISTORY_CAP = 50;

const PANEL_TITLE = 'GatePulse SQL';

export class SqlPanel {
  /** Every open query tab. Each one is its own webview (own editor, own results, own run). */
  private static readonly panels = new Set<SqlPanel>();
  private static lastActive: SqlPanel | undefined;
  private controller: AbortController | undefined;
  private disposed = false;
  /** Reported by the webview: lets "Select Top 100" reuse an untouched tab instead of opening another. */
  private editorEmpty = true;

  /** The tab the user was last in (or, failing that, the most recently opened one). */
  static get current(): SqlPanel | undefined {
    if (SqlPanel.lastActive && SqlPanel.panels.has(SqlPanel.lastActive)) return SqlPanel.lastActive;
    return [...SqlPanel.panels].pop();
  }

  /** Same entry point for every tab: a tenant switch or a settings change reaches all of them. */
  static refreshAllDefaults(): void {
    for (const p of SqlPanel.panels) p.refreshDefaults();
  }

  static invalidateAllSchemas(): void {
    for (const p of SqlPanel.panels) p.invalidateSchema();
  }
  /** UI-level dedup only (avoid two 'databasesLoading' messages in flight) — the actual fetch and
   *  its cache live in extension.ts, shared with the sidebar tree. */
  private readonly databasesInFlight = new Set<string>();

  /** Set right before a fresh panel's webview has finished loading (e.g. a schema-tree table
   *  click): `prefillQuery()` posts immediately too, but that post is lost if the webview's own
   *  message listener isn't attached yet — 'ready' re-sends whatever is still pending here. */
  private pendingPrefill: { connectionGuid: string; databaseName: string; query: string } | undefined;

  /** Brings the current tab forward, or opens the first one. */
  static show(
    context: vscode.ExtensionContext,
    services: PanelServices,
    channel: vscode.OutputChannel,
  ): SqlPanel {
    const existing = SqlPanel.current;
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    return SqlPanel.create(context, services, channel);
  }

  /** Always opens a new tab (next to the current one, so tabs stay grouped). */
  static create(
    context: vscode.ExtensionContext,
    services: PanelServices,
    channel: vscode.OutputChannel,
  ): SqlPanel {
    const beside = SqlPanel.current?.panel.viewColumn;
    const panel = vscode.window.createWebviewPanel(
      'gatepulse.sql',
      PANEL_TITLE,
      beside ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    return new SqlPanel(panel, context, services, channel);
  }

  /** For a command that fills in a query: reuses the current tab when its editor is still empty,
   *  otherwise opens a new one — never overwrites what the user is writing. */
  static forNewQuery(
    context: vscode.ExtensionContext,
    services: PanelServices,
    channel: vscode.OutputChannel,
  ): SqlPanel {
    const existing = SqlPanel.current;
    if (existing?.editorEmpty) {
      existing.panel.reveal();
      return existing;
    }
    return SqlPanel.create(context, services, channel);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices,
    private readonly channel: vscode.OutputChannel,
  ) {
    SqlPanel.panels.add(this);
    SqlPanel.lastActive = this;
    panel.webview.html = this.html();
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) SqlPanel.lastActive = this;
    });
    panel.onDidDispose(() => {
      this.disposed = true;
      this.controller?.abort();
      SqlPanel.panels.delete(this);
      if (SqlPanel.lastActive === this) SqlPanel.lastActive = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) =>
      // onMessage's own handlers already catch what they expect to fail (listDatabases, run...);
      // this is the backstop for anything that doesn't — an unhandled rejection here would
      // otherwise vanish silently instead of surfacing anywhere a user could see it.
      this.onMessage(m).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.channel.appendLine(`[panel] unhandled error handling "${m.type}": ${message}`);
      }),
    );
  }

  /** Prefills the editor from outside (schema-tree table click) — 'ready' flushes this if the
   *  webview wasn't loaded yet when this was called (see `pendingPrefill`). */
  prefillQuery(connectionGuid: string, databaseName: string, query: string): void {
    this.editorEmpty = !query.trim(); // known now, without waiting for the webview's report
    this.pendingPrefill = { connectionGuid, databaseName, query };
    void this.post({ type: 'prefillQuery', connectionGuid, databaseName, query });
  }

  /** Called after a tenant switch or a settings change — same entry point either way. */
  refreshDefaults(): void {
    const { cfg } = this.services.getSession();
    void this.post({
      type: 'init',
      defaults: { connectionGuid: cfg.connectionGuid, databaseName: cfg.databaseName },
      configProblems: [...checkTenants(this.services.getTenants()), ...checkConfig(cfg)],
      tenants: this.services.getTenants().map((t) => ({
        alias: t.alias,
        tenantId: t.tenantId,
        connectionName: this.services.getConnectionName(t.connectionGuid),
      })),
      activeTenantAlias: this.services.getActiveTenantAlias(),
      history: this.getHistory(),
    });
    void this.sendConnections(false);
  }

  /** Posts the connection list (names + GUIDs) for the panel's connection dropdown. A failure just
   *  leaves the dropdown on manual GUID entry — and, once names are known, the tenant dropdown is
   *  re-sent so it can show the default connection's name. */
  private async sendConnections(force: boolean): Promise<void> {
    if (checkConfig(this.services.getSession().cfg).length) return; // nothing to list with yet
    const connections = await this.services.getConnections(force);
    await this.post({
      type: 'connections',
      items: connections.map((c) => ({
        id: c.id,
        name: c.displayName,
        detail: c.gatewayId ? 'Gateway' : c.connectivityType,
      })),
      tenants: this.services.getTenants().map((t) => ({
        alias: t.alias,
        tenantId: t.tenantId,
        connectionName: this.services.getConnectionName(t.connectionGuid),
      })),
      activeTenantAlias: this.services.getActiveTenantAlias(),
    });
  }

  private post(message: unknown): Thenable<boolean> {
    // A tab closed mid-run (or mid-prefill) must not throw "Webview is disposed" from a late post.
    if (this.disposed) return Promise.resolve(false);
    return this.panel.webview.postMessage(message);
  }

  private getHistory(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  /** Query text + metadata only — never the result rows (V1-SCOPE.md §4, point D.1). */
  private async addHistory(entry: HistoryEntry): Promise<void> {
    const next = [entry, ...this.getHistory()].slice(0, HISTORY_CAP);
    await this.context.globalState.update(HISTORY_KEY, next);
    // The history is shared by every tab.
    for (const p of SqlPanel.panels) void p.post({ type: 'history', entries: next });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.refreshDefaults();
        if (this.pendingPrefill) {
          void this.post({ type: 'prefillQuery', ...this.pendingPrefill });
          this.pendingPrefill = undefined;
        }
        return;
      case 'cancel':
        this.controller?.abort();
        return;
      case 'showLogs':
        this.channel.show();
        return;
      case 'openGuide':
        await vscode.commands.executeCommand('gatepulse.openGuide');
        return;
      case 'newTab':
        // Same connection and database as this tab, empty editor.
        await vscode.commands.executeCommand('gatepulse.newQuery', {
          tenantAlias: this.services.getActiveTenantAlias(),
          connectionGuid: m.connectionGuid.trim(),
          databaseName: m.databaseName.trim(),
        });
        return;
      case 'editorState':
        this.editorEmpty = m.empty;
        // The tab title carries the database so several tabs can be told apart.
        this.panel.title = m.databaseName.trim() ? `${PANEL_TITLE} · ${m.databaseName.trim()}` : PANEL_TITLE;
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gatepulse');
        return;
      case 'switchTenant':
        return vscode.commands.executeCommand('gatepulse.switchTenant', m.alias);
      case 'addTenant':
        return vscode.commands.executeCommand('gatepulse.addTenant');
      case 'refreshConnections':
        return this.sendConnections(true);
      case 'exportCsv':
        return this.exportCsv(m);
      case 'listDatabases':
        return this.handleListDatabases(m);
      case 'listTables':
        return this.handleListTables(m);
      case 'listTableColumns':
        return this.handleListTableColumns(m);
      case 'run':
        return this.execute(m);
    }
  }

  private async handleListDatabases(m: Extract<FromWebview, { type: 'listDatabases' }>): Promise<void> {
    const connectionGuid = m.connectionGuid.trim();
    if (!isGuid(connectionGuid)) return; // silently ignored: the field isn't a usable GUID yet
    if (this.databasesInFlight.has(connectionGuid)) return;
    this.databasesInFlight.add(connectionGuid);
    await this.post({ type: 'databasesLoading', connectionGuid });
    try {
      const session = this.services.getSession();
      const problems = [...checkTenants(this.services.getTenants()), ...checkConfig(session.cfg)];
      if (problems.length) throw new Error(problems.join(' • '));
      const names = await this.services.getDatabases(connectionGuid, m.databaseNameHint, m.force);
      await this.post({ type: 'databases', connectionGuid, names });
    } catch (err) {
      // Never blocking: the field stays a plain text input either way (V1-SCOPE.md §3's "repli").
      const error = serializeError(err);
      this.services.getSession().logger.warn('panel.listDatabases.failed', `[${error.kind}] ${error.message}`);
      await this.post({ type: 'databases', connectionGuid, names: [], error: error.message });
    } finally {
      this.databasesInFlight.delete(connectionGuid);
    }
  }

  /** Table list for the editor's autocomplete — shares extension.ts's cache with the sidebar tree
   *  (V1-SCOPE.md §4, point D): whichever surface asks first fetches, the other reuses it. */
  private async handleListTables(m: Extract<FromWebview, { type: 'listTables' }>): Promise<void> {
    const connectionGuid = m.connectionGuid.trim();
    const databaseName = m.databaseName.trim();
    if (!isGuid(connectionGuid) || !databaseName) {
      await this.post({ type: 'tables', connectionGuid, databaseName, objects: [] });
      return;
    }
    try {
      const objects = await this.services.getSchemaObjects(connectionGuid, databaseName);
      await this.post({ type: 'tables', connectionGuid, databaseName, objects });
    } catch (err) {
      const error = serializeError(err);
      this.services.getSession().logger.warn('panel.listTables.failed', `[${error.kind}] ${error.message}`);
      await this.post({ type: 'tables', connectionGuid, databaseName, objects: [] });
    }
  }

  private async handleListTableColumns(
    m: Extract<FromWebview, { type: 'listTableColumns' }>,
  ): Promise<void> {
    const connectionGuid = m.connectionGuid.trim();
    const databaseName = m.databaseName.trim();
    try {
      const columns = await this.services.getColumns(connectionGuid, databaseName, m.schema, m.table);
      await this.post({ type: 'tableColumns', table: m.table, columns });
    } catch (err) {
      const error = serializeError(err);
      this.services.getSession().logger.warn('panel.listTableColumns.failed', `[${error.kind}] ${error.message}`);
      await this.post({ type: 'tableColumns', table: m.table, columns: [] });
    }
  }

  /** The shared object/column caches changed (a "Refresh" in the tree): the webview's own copy used
   *  by the autocomplete is dropped and re-requested. */
  invalidateSchema(): void {
    void this.post({ type: 'invalidateSchema' });
  }

  /** setConnectionGuid: applies a picked GUID directly to the open panel — see extension.ts's pickConnection. */
  setConnectionGuid(value: string): void {
    void this.post({ type: 'setConnectionGuid', value });
  }

  private async exportCsv(m: Extract<FromWebview, { type: 'exportCsv' }>): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${m.activityName || 'result'}.csv`),
      filters: { CSV: ['csv'] },
    });
    if (!uri) return;
    try {
      await fs.promises.writeFile(uri.fsPath, toCsv(m.columns, m.rows), 'utf8');
      void vscode.window.showInformationMessage(`GatePulse: exported to ${uri.fsPath}`);
    } catch (err) {
      // A locked/read-only target (e.g. the CSV still open in Excel) used to throw synchronously
      // and vanish — the write is now async and its failure is surfaced explicitly.
      void vscode.window.showErrorMessage(
        `GatePulse: CSV export to ${uri.fsPath} failed — ${(err as Error).message}`,
      );
    }
  }

  private async execute(m: Extract<FromWebview, { type: 'run' }>): Promise<void> {
    if (this.controller) {
      void vscode.window.showWarningMessage('GatePulse: a query is already running.');
      return;
    }
    const session = this.services.getSession();
    const problems = [...checkTenants(this.services.getTenants()), ...checkConfig(session.cfg)];
    const conn = { connectionGuid: m.connectionGuid.trim(), databaseName: m.databaseName.trim() };
    if (!isGuid(conn.connectionGuid))
      problems.push(`connectionGuid is not a GUID: "${conn.connectionGuid}"`);
    if (!m.query.trim()) problems.push('query is empty');
    if (problems.length) {
      await this.post({ type: 'error', error: { kind: 'config', message: problems.join(' • ') } });
      return;
    }

    this.controller = new AbortController();
    await this.post({ type: 'busy' });
    // Logs stay opt-in: the "Logs" button in the header calls channel.show() on demand — a run
    // should never yank focus/layout by popping the Output panel open on its own.
    const ctx: ScenarioContext = {
      cfg: session.cfg,
      runner: session.runner,
      client: session.client,
      logger: session.logger,
      signal: this.controller.signal,
      onProgress: (e) => void this.post({ type: 'progress', event: e }),
    };
    let succeeded = false;
    try {
      await this.services.ensurePipelineResolved(session);
      const report: ScenarioReport = await runSingle(
        ctx,
        { ...conn, query: m.query },
        {
          autoConvertUnsupportedTypes: vscode.workspace
            .getConfiguration('gatepulse')
            .get<boolean>('autoConvertUnsupportedColumns', true),
        },
      );
      succeeded = report.runs[0]?.succeeded ?? false;
      const file = session.saveReport(report);
      // Whole activity results shown (<= 5000 rows each, capped for the JSONL report only).
      const forUi = { ...report, runs: report.runs.map((r) => compactRun(r, 5000)) };
      await this.post({ type: 'report', report: forUi, reportFile: file });
    } catch (err) {
      succeeded = false;
      const error = serializeError(err);
      session.logger.error('panel.failed', `[${error.kind}] ${error.message}`, error.raw);
      await this.post({ type: 'error', error });
    } finally {
      this.controller = undefined;
      await this.post({ type: 'idle' });
      await this.addHistory({
        query: m.query,
        timestamp: new Date().toISOString(),
        tenantAlias: this.services.getActiveTenantAlias(),
        connectionGuid: conn.connectionGuid,
        databaseName: conn.databaseName,
        succeeded,
      });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = randomBytes(16).toString('base64');
    // CSP allows only nonce'd scripts and the webview's own resource origin for styles — every
    // vendored file below is served from media/ (covered by SqlPanel.show's localResourceRoots).
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('vendor/codicons/codicon.css')}">
  <link rel="stylesheet" href="${media('vendor/codemirror/codemirror.css')}">
  <link rel="stylesheet" href="${media('vendor/codemirror/addon/hint/show-hint.css')}">
  <link rel="stylesheet" href="${media('panel.css')}">
  <title>GatePulse SQL</title>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><i class="codicon codicon-database"></i></span>
      <span class="brand-title">GatePulse</span>
    </div>
    <div class="topbar-actions">
      <button id="newTab" class="icon-btn ghost" title="New query tab (same connection and database)"><i class="codicon codicon-new-file"></i></button>
      <button id="openGuide" class="icon-btn ghost" title="Open the GatePulse guide"><i class="codicon codicon-book"></i></button>
      <button id="showLogs" class="icon-btn ghost" title="Show GatePulse logs"><i class="codicon codicon-output"></i></button>
      <button id="openSettings" class="icon-btn ghost" title="GatePulse settings"><i class="codicon codicon-gear"></i></button>
    </div>
  </header>

  <div id="configProblems" class="banner hidden"></div>

  <section class="context-bar">
    <div class="ctx">
      <label for="tenantSelect"><i class="codicon codicon-organization"></i> Tenant</label>
      <div class="with-button">
        <select id="tenantSelect"></select>
        <button id="addTenant" class="icon-btn secondary" title="Add a tenant"><i class="codicon codicon-add"></i></button>
      </div>
    </div>
    <div class="ctx">
      <label for="connectionSelect"><i class="codicon codicon-plug"></i> Connection</label>
      <div class="with-button">
        <select id="connectionSelect"></select>
        <button id="refreshConnections" class="icon-btn secondary" title="Refresh the connection list"><i class="codicon codicon-refresh"></i></button>
      </div>
      <input id="connectionGuid" class="hidden" spellcheck="false" placeholder="Connection GUID: 00000000-0000-0000-0000-000000000000">
    </div>
    <div class="ctx">
      <label for="databaseName"><i class="codicon codicon-server"></i> Database</label>
      <div class="with-button">
        <select id="databaseSelect"></select>
        <button id="refreshDatabases" class="icon-btn secondary" title="Refresh the database list"><i class="codicon codicon-refresh"></i></button>
      </div>
      <input id="databaseName" class="hidden" spellcheck="false" placeholder="Database name (default: master)">
      <div id="databaseHint" class="field-hint hidden"></div>
    </div>
  </section>

  <section class="card editor-card">
    <div class="card-toolbar">
      <span class="card-title"><i class="codicon codicon-code"></i> Query</span>
      <span id="status" class="status hidden"><span class="spinner"></span><span id="statusText">Running…</span><span id="elapsed" class="elapsed"></span></span>
      <span class="spacer"></span>
      <button id="cancel" class="secondary" disabled><i class="codicon codicon-debug-stop"></i> Cancel</button>
      <button id="run" class="primary"><i class="codicon codicon-play"></i> Run <kbd>Ctrl+Enter</kbd></button>
    </div>
    <div id="queryEditor" class="query-editor"></div>
  </section>

  <section id="alertBanner" class="alert-banner hidden"></section>
  <section id="error" class="error hidden"></section>
  <section id="result">
    <div id="resultEmpty" class="empty-state">
      <i class="codicon codicon-table"></i>
      <p>Your query results will appear here.</p>
    </div>
  </section>

  <details id="history" class="card history hidden">
    <summary>Query history</summary>
    <ul id="historyList"></ul>
  </details>

  <script nonce="${nonce}" src="${media('vendor/codemirror/codemirror.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/mode/sql/sql.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/addon/edit/matchbrackets.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/addon/edit/closebrackets.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/addon/hint/show-hint.js')}"></script>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula injection: Excel/LibreOffice/Sheets can interpret a cell starting with =, +, -, @, a
  // tab or a CR as a formula when the CSV is later opened — a query result column isn't something
  // GatePulse controls the content of. Prefixing a single quote is Excel's own "force text" escape;
  // it's visible but harmless, and cheaper than rejecting/altering the exported value otherwise.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\n,\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}
