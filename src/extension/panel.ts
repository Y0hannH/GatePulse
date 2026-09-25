import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';
import { checkConfig, checkTenants, isGuid } from '../core/config';
import { serializeError } from '../core/errors';
import { ensurePipeline } from '../core/provision';
import { runSingle } from '../core/runQuery';
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

  static show(
    context: vscode.ExtensionContext,
    getSession: () => Session,
    getTenants: () => TenantEntry[],
    getActiveTenantAlias: () => string,
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
      channel,
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: () => Session,
    private readonly getTenants: () => TenantEntry[],
    private readonly getActiveTenantAlias: () => string,
    private readonly channel: vscode.OutputChannel,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      this.controller?.abort();
      SqlPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m));
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
        return this.refreshDefaults();
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
      case 'run':
        return this.execute(m);
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
    this.channel.show(true);
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
      // Empty pipelineId = not yet resolved for this session; resolved once and cached on cfg
      // (FabricClient reads cfg.pipelineId live, so mutating it here is enough — see V1-SCOPE.md §1).
      if (!session.cfg.pipelineId) {
        const resolved = await ensurePipeline(
          session.client,
          session.logger,
          session.cfg.parameterNames,
        );
        session.cfg.pipelineId = resolved.id;
        if (resolved.created) {
          void vscode.window.showInformationMessage(
            `GatePulse : pipeline "${resolved.displayName}" provisionné automatiquement dans ce workspace.`,
          );
        }
      }
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
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('panel.css')}">
  <title>GatePulse SQL</title>
</head>
<body>
  <header>
    <h1>GatePulse <span class="sub">SQL via un pipeline Fabric</span></h1>
    <div class="links"><a href="#" id="openSettings">Paramètres</a> · <a href="#" id="showLogs">Logs</a></div>
  </header>
  <div class="tenant-bar">
    <label class="tenant-label">Tenant
      <select id="tenantSelect"></select>
    </label>
    <button id="addTenant" class="secondary" title="Ajouter un tenant">+ Tenant</button>
  </div>
  <div id="configProblems" class="banner hidden"></div>

  <section class="params">
    <label>Connection GUID
      <div class="with-button">
        <input id="connectionGuid" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000">
        <button id="pickConnection" class="secondary" title="Choisir une connexion SQL (gateway ou cloud)">Parcourir…</button>
      </div>
    </label>
    <label>Base de données<input id="databaseName" spellcheck="false"></label>
  </section>

  <section>
    <textarea id="query" spellcheck="false" placeholder="SELECT TOP 10 * FROM sys.tables">SELECT TOP 10 name, create_date FROM sys.tables ORDER BY create_date DESC</textarea>
    <div class="actions">
      <button id="run" class="primary">▶ Run <kbd>Ctrl+Enter</kbd></button>
      <button id="cancel" class="secondary" disabled>■ Annuler</button>
    </div>
  </section>

  <section id="status" class="status hidden">
    <span class="spinner"></span>
    <span id="elapsed" class="elapsed">0.0 s</span>
    <span id="statusText"></span>
  </section>

  <section id="alertBanner" class="alert-banner hidden"></section>
  <section id="error" class="error hidden"></section>
  <section id="summary" class="hidden"></section>
  <section id="result"></section>
  <details id="diagnostics" class="diagnostics hidden">
    <summary>Diagnostics</summary>
    <ul id="diagnosticsList" class="checks"></ul>
  </details>

  <details id="history" class="history hidden">
    <summary>Historique</summary>
    <ul id="historyList"></ul>
  </details>

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
