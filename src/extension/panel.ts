import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';
import { checkConfig, checkTenants, isGuid } from '../core/config';
import { serializeError } from '../core/errors';
import { listDatabases, runSingle } from '../core/runQuery';
import type { ScenarioContext, ScenarioReport } from '../core/scenarios';
import type { Session } from '../core/session';
import { compactRun } from '../core/session';

type FromWebview =
  | { type: 'ready' }
  | { type: 'run'; connectionGuid: string; databaseName: string; query: string }
  | { type: 'cancel' }
  | { type: 'showLogs' }
  | { type: 'openSettings' }
  | { type: 'switchTenant'; alias: string }
  | { type: 'addTenant' }
  | { type: 'pickConnection' }
  | { type: 'listDatabases'; connectionGuid: string; databaseNameHint: string; force: boolean }
  | { type: 'exportCsv'; activityName: string; columns: string[]; rows: Record<string, unknown>[] };

interface HistoryEntry {
  query: string;
  timestamp: string;
  tenantAlias: string;
  connectionGuid: string;
  databaseName: string;
  succeeded: boolean;
  durationMs?: number;
}

const HISTORY_KEY = 'gatepulse.history';
const HISTORY_CAP = 50;

export class SqlPanel {
  static current: SqlPanel | undefined;
  private controller: AbortController | undefined;
  /** In-memory, per connection GUID — never persisted, invalidated only by the refresh button. */
  private readonly databaseCache = new Map<string, string[]>();
  /** Avoids piling up duplicate requests when auto-fetch and a manual refresh race each other. */
  private readonly databasesInFlight = new Set<string>();

  /** Set right before a fresh panel's webview has finished loading (e.g. a schema-tree table
   *  click): `prefillQuery()` posts immediately too, but that post is lost if the webview's own
   *  message listener isn't attached yet — 'ready' re-sends whatever is still pending here. */
  private pendingPrefill: { connectionGuid: string; databaseName: string; query: string } | undefined;

  static show(
    context: vscode.ExtensionContext,
    getSession: () => Session,
    getTenants: () => TenantEntry[],
    getActiveTenantAlias: () => string,
    ensurePipelineResolved: (session: Session) => Promise<void>,
    channel: vscode.OutputChannel,
  ): void {
    if (SqlPanel.current) {
      SqlPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gatepulse.sql',
      'GatePulse SQL',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    SqlPanel.current = new SqlPanel(
      panel,
      context,
      getSession,
      getTenants,
      getActiveTenantAlias,
      ensurePipelineResolved,
      channel,
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: () => Session,
    private readonly getTenants: () => TenantEntry[],
    private readonly getActiveTenantAlias: () => string,
    private readonly ensurePipelineResolved: (session: Session) => Promise<void>,
    private readonly channel: vscode.OutputChannel,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      this.controller?.abort();
      SqlPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m));
  }

  /** Prefills the editor from outside (schema-tree table click) — 'ready' flushes this if the
   *  webview wasn't loaded yet when this was called (see `pendingPrefill`). */
  prefillQuery(connectionGuid: string, databaseName: string, query: string): void {
    this.pendingPrefill = { connectionGuid, databaseName, query };
    void this.post({ type: 'prefillQuery', connectionGuid, databaseName, query });
  }

  /** Called after a tenant switch or a settings change — same entry point either way. */
  refreshDefaults(): void {
    const { cfg } = this.getSession();
    void this.post({
      type: 'init',
      defaults: { connectionGuid: cfg.connectionGuid, databaseName: cfg.databaseName },
      configProblems: [...checkTenants(this.getTenants()), ...checkConfig(cfg)],
      tenants: this.getTenants().map((t) => ({ alias: t.alias, tenantId: t.tenantId })),
      activeTenantAlias: this.getActiveTenantAlias(),
      history: this.getHistory(),
    });
  }

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private getHistory(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  /** Query text + metadata only — never the result rows (V1-SCOPE.md §4, point D.1). */
  private async addHistory(entry: HistoryEntry): Promise<void> {
    const next = [entry, ...this.getHistory()].slice(0, HISTORY_CAP);
    await this.context.globalState.update(HISTORY_KEY, next);
    void this.post({ type: 'history', entries: next });
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
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gatepulse');
        return;
      case 'switchTenant':
        return vscode.commands.executeCommand('gatepulse.switchTenant', m.alias);
      case 'addTenant':
        return vscode.commands.executeCommand('gatepulse.addTenant');
      case 'pickConnection':
        return vscode.commands.executeCommand('gatepulse.pickConnection');
      case 'exportCsv':
        return this.exportCsv(m);
      case 'listDatabases':
        return this.handleListDatabases(m);
      case 'run':
        return this.execute(m);
    }
  }

  private async handleListDatabases(m: Extract<FromWebview, { type: 'listDatabases' }>): Promise<void> {
    const connectionGuid = m.connectionGuid.trim();
    if (!isGuid(connectionGuid)) return; // silently ignored: the field isn't a usable GUID yet
    if (!m.force && this.databaseCache.has(connectionGuid)) {
      await this.post({ type: 'databases', connectionGuid, names: this.databaseCache.get(connectionGuid) });
      return;
    }
    if (this.databasesInFlight.has(connectionGuid)) return;
    this.databasesInFlight.add(connectionGuid);
    await this.post({ type: 'databasesLoading', connectionGuid });
    const session = this.getSession();
    try {
      const problems = [...checkTenants(this.getTenants()), ...checkConfig(session.cfg)];
      if (problems.length) throw new Error(problems.join(' • '));
      await this.ensurePipelineResolved(session);
      const names = await listDatabases(
        { cfg: session.cfg, runner: session.runner, client: session.client, logger: session.logger },
        connectionGuid,
        m.databaseNameHint,
      );
      this.databaseCache.set(connectionGuid, names);
      await this.post({ type: 'databases', connectionGuid, names });
    } catch (err) {
      // Never blocking: the field stays a plain text input either way (V1-SCOPE.md §3's "repli").
      const error = serializeError(err);
      session.logger.warn('panel.listDatabases.failed', `[${error.kind}] ${error.message}`);
      await this.post({ type: 'databases', connectionGuid, names: [], error: error.message });
    } finally {
      this.databasesInFlight.delete(connectionGuid);
    }
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
    fs.writeFileSync(uri.fsPath, toCsv(m.columns, m.rows), 'utf8');
    void vscode.window.showInformationMessage(`GatePulse : export écrit dans ${uri.fsPath}`);
  }

  private async execute(m: Extract<FromWebview, { type: 'run' }>): Promise<void> {
    if (this.controller) {
      void vscode.window.showWarningMessage('GatePulse: an execution is already in progress.');
      return;
    }
    const session = this.getSession();
    const problems = [...checkTenants(this.getTenants()), ...checkConfig(session.cfg)];
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
    const startedAt = Date.now();
    let succeeded = false;
    try {
      await this.ensurePipelineResolved(session);
      const report: ScenarioReport = await runSingle(ctx, { ...conn, query: m.query });
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
        tenantAlias: this.getActiveTenantAlias(),
        connectionGuid: conn.connectionGuid,
        databaseName: conn.databaseName,
        succeeded,
        durationMs: Date.now() - startedAt,
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
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('vendor/codicons/codicon.css')}">
  <link rel="stylesheet" href="${media('vendor/codemirror/codemirror.css')}">
  <link rel="stylesheet" href="${media('panel.css')}">
  <title>GatePulse SQL</title>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-title">GatePulse</span>
      <span class="brand-sub">SQL via un pipeline Fabric</span>
    </div>

    <div class="tenant-switcher">
      <i class="codicon codicon-organization"></i>
      <select id="tenantSelect"></select>
      <button id="addTenant" class="icon-btn ghost" title="Ajouter un tenant"><i class="codicon codicon-add"></i></button>
    </div>

    <div class="topbar-actions">
      <button id="showLogs" class="icon-btn ghost" title="Afficher les logs GatePulse"><i class="codicon codicon-output"></i></button>
      <button id="openSettings" class="icon-btn ghost" title="Paramètres GatePulse"><i class="codicon codicon-gear"></i></button>
    </div>
  </header>

  <div id="configProblems" class="banner hidden"></div>

  <section class="card connection-card">
    <div class="field grow">
      <label for="connectionGuid">Connexion SQL</label>
      <div class="with-button">
        <input id="connectionGuid" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000">
        <button id="pickConnection" class="icon-btn secondary" title="Choisir une connexion SQL (gateway ou cloud)"><i class="codicon codicon-plug"></i></button>
      </div>
    </div>
    <div class="field">
      <label for="databaseName">Base de données</label>
      <div class="with-button">
        <input id="databaseName" list="databaseListOptions" spellcheck="false" placeholder="master">
        <datalist id="databaseListOptions"></datalist>
        <button id="refreshDatabases" class="icon-btn secondary" title="Rafraîchir la liste des bases"><i class="codicon codicon-refresh"></i></button>
      </div>
      <div id="databaseHint" class="field-hint hidden"></div>
    </div>
  </section>

  <section class="card editor-card">
    <div class="card-toolbar">
      <span class="card-title"><i class="codicon codicon-code"></i> Requête SQL</span>
      <span class="spacer"></span>
      <button id="cancel" class="secondary" disabled><i class="codicon codicon-debug-stop"></i> Annuler</button>
      <button id="run" class="primary"><i class="codicon codicon-play"></i> Run <kbd>Ctrl+Enter</kbd></button>
    </div>
    <div id="queryEditor" class="query-editor"></div>
  </section>

  <section id="status" class="status hidden">
    <span class="spinner"></span>
    <span id="elapsed" class="elapsed">0.0 s</span>
    <span id="statusText"></span>
  </section>

  <section id="alertBanner" class="alert-banner hidden"></section>
  <section id="error" class="error hidden"></section>
  <section id="summary" class="hidden"></section>
  <section id="result">
    <div id="resultEmpty" class="empty-state">
      <i class="codicon codicon-database"></i>
      <p>Les résultats de ta requête s'afficheront ici.</p>
    </div>
  </section>
  <details id="diagnostics" class="card diagnostics hidden">
    <summary>Diagnostics</summary>
    <ul id="diagnosticsList" class="checks"></ul>
  </details>

  <details id="history" class="card history hidden">
    <summary>Historique</summary>
    <ul id="historyList"></ul>
  </details>

  <script nonce="${nonce}" src="${media('vendor/codemirror/codemirror.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/mode/sql/sql.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/addon/edit/matchbrackets.js')}"></script>
  <script nonce="${nonce}" src="${media('vendor/codemirror/addon/edit/closebrackets.js')}"></script>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}
