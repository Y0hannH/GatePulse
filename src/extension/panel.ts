import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';
import { checkConfig, checkTenants, isGuid } from '../core/config';
import { serializeError } from '../core/errors';
import { ensurePipeline } from '../core/provision';
import type { ScenarioContext, ScenarioName, ScenarioReport } from '../core/scenarios';
import {
  runConcurrencyTest,
  runLatencyTest,
  runRowCapTest,
  runSingle,
  runSizeTest,
  runSwapTest,
} from '../core/scenarios';
import type { Session } from '../core/session';
import { compactRun } from '../core/session';

type FromWebview =
  | { type: 'ready' }
  | { type: 'run'; connectionGuid: string; databaseName: string; query: string }
  | {
      type: 'scenario';
      name: Exclude<ScenarioName, 'single'>;
      connectionGuid: string;
      databaseName: string;
    }
  | { type: 'cancel' }
  | { type: 'showLogs' }
  | { type: 'openSettings' };

const SCENARIOS = {
  latency: runLatencyTest,
  rowcap: runRowCapTest,
  size: runSizeTest,
  concurrency: runConcurrencyTest,
  swap: runSwapTest,
};

export class SqlPanel {
  static current: SqlPanel | undefined;
  private controller: AbortController | undefined;

  static show(
    context: vscode.ExtensionContext,
    getSession: () => Session,
    getTenants: () => TenantEntry[],
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
    SqlPanel.current = new SqlPanel(panel, context, getSession, getTenants, channel);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: () => Session,
    private readonly getTenants: () => TenantEntry[],
    private readonly channel: vscode.OutputChannel,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      this.controller?.abort();
      SqlPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m));
  }

  refreshDefaults(): void {
    const { cfg } = this.getSession();
    void this.post({
      type: 'init',
      defaults: { connectionGuid: cfg.connectionGuid, databaseName: cfg.databaseName },
      configProblems: [...checkTenants(this.getTenants()), ...checkConfig(cfg)],
    });
  }

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
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
      case 'run':
      case 'scenario':
        return this.execute(m);
    }
  }

  private async execute(m: Extract<FromWebview, { type: 'run' | 'scenario' }>): Promise<void> {
    if (this.controller) {
      void vscode.window.showWarningMessage('GatePulse: an execution is already in progress.');
      return;
    }
    const session = this.getSession();
    const problems = [...checkTenants(this.getTenants()), ...checkConfig(session.cfg)];
    const conn = { connectionGuid: m.connectionGuid.trim(), databaseName: m.databaseName.trim() };
    if (!isGuid(conn.connectionGuid))
      problems.push(`connectionGuid is not a GUID: "${conn.connectionGuid}"`);
    if (m.type === 'run' && !m.query.trim()) problems.push('query is empty');
    if (problems.length) {
      await this.post({ type: 'error', error: { kind: 'config', message: problems.join(' • ') } });
      return;
    }

    this.controller = new AbortController();
    const label = m.type === 'run' ? 'single' : m.name;
    await this.post({ type: 'busy', scenario: label });
    this.channel.show(true);
    const ctx: ScenarioContext = {
      cfg: session.cfg,
      runner: session.runner,
      client: session.client,
      logger: session.logger,
      signal: this.controller.signal,
      onProgress: (e) => void this.post({ type: 'progress', event: e }),
    };
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
      const report: ScenarioReport =
        m.type === 'run'
          ? await runSingle(ctx, { ...conn, query: m.query })
          : await SCENARIOS[m.name](ctx, conn);
      const file = session.saveReport(report);
      // Single runs show whole activity results (<= 5000 rows each); scenario tables are only evidence.
      const forUi = {
        ...report,
        runs: report.runs.map((r) => compactRun(r, m.type === 'run' ? 5000 : 20)),
      };
      await this.post({ type: 'report', report: forUi, reportFile: file });
    } catch (err) {
      const error = serializeError(err);
      session.logger.error('panel.failed', `[${error.kind}] ${error.message}`, error.raw);
      await this.post({ type: 'error', error });
    } finally {
      this.controller = undefined;
      await this.post({ type: 'idle' });
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
    <h1>GatePulse <span class="sub">SQL via Fabric Gateway — démo</span></h1>
    <div class="links"><a href="#" id="openSettings">Paramètres</a> · <a href="#" id="showLogs">Logs</a></div>
  </header>
  <div id="configProblems" class="banner hidden"></div>

  <section class="params">
    <label>Connection GUID<input id="connectionGuid" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000"></label>
    <label>Base de données<input id="databaseName" spellcheck="false"></label>
  </section>

  <section>
    <textarea id="query" spellcheck="false" placeholder="SELECT TOP 10 * FROM sys.tables">SELECT TOP 10 name, create_date FROM sys.tables ORDER BY create_date DESC</textarea>
    <div class="actions">
      <button id="run" class="primary">▶ Run <kbd>Ctrl+Enter</kbd></button>
      <button id="cancel" class="secondary" disabled>■ Annuler</button>
      <span class="spacer"></span>
      <span class="label">Tests de validation :</span>
      <button class="secondary scenario" data-scenario="latency" title="P2 — runs séquentiels, stats de latence">P2 Latence</button>
      <button class="secondary scenario" data-scenario="rowcap" title="P1 — comportement du plafond de lignes">P1 Plafond</button>
      <button class="secondary scenario" data-scenario="size" title="P1 — limite de taille (4 Mo)">P1 Taille</button>
      <button class="secondary scenario" data-scenario="concurrency" title="P3 — runs parallèles, isolation">P3 Concurrence</button>
      <button class="secondary scenario" data-scenario="swap" title="P4 — swap de connexion + GUID bidon">P4 Swap connexion</button>
    </div>
  </section>

  <section id="status" class="status hidden">
    <span class="spinner"></span>
    <span id="elapsed" class="elapsed">0.0 s</span>
    <span id="statusText"></span>
    <div id="runs" class="runs"></div>
  </section>

  <section id="error" class="error hidden"></section>
  <section id="summary" class="hidden"></section>
  <section id="result"></section>

  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}
