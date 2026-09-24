import type { AuthUi } from '@evolve-data/pulse-core';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AuthFlow, ParameterNames, ParameterPayloadFormat, TenantEntry } from '../core/config';
import { buildConfigForTenant, isGuid } from '../core/config';
import type { LogEntry, LogSink } from '../core/logger';
import { formatEntry } from '../core/logger';
import type { Session } from '../core/session';
import { createSession } from '../core/session';
import { SqlPanel } from './panel';

class OutputChannelSink implements LogSink {
  constructor(private readonly channel: vscode.OutputChannel) {}
  write(entry: LogEntry): void {
    // Debug entries (HTTP calls) stay in the JSONL file only, to keep the demo output readable.
    if (entry.level === 'debug') return;
    this.channel.appendLine(formatEntry(entry));
  }
}

/** Everything settings-based except tenant identity/targeting — merged with one TenantEntry by buildConfigForTenant. */
function readGlobalConfig() {
  const c = vscode.workspace.getConfiguration('gatepulse');
  const v = (key: string) => c.get(`validation.${key}`);
  return {
    clientId: c.get<string>('clientId')?.trim(),
    authFlow: c.get<AuthFlow>('authFlow'),
    scopes: c.get<string[]>('scopes'),
    pollIntervalMs: c.get<number>('pollIntervalMs'),
    timeoutMs: c.get<number>('timeoutMs'),
    activityNames: c.get<string[]>('activityNames'),
    parameterPayloadFormat: c.get<ParameterPayloadFormat>('parameterPayloadFormat'),
    parameterNames: c.get<Partial<ParameterNames>>('parameterNames'),
    validation: {
      concurrency: v('concurrency') as number,
      alternateConnectionGuid: (v('alternateConnectionGuid') as string)?.trim(),
      alternateDatabaseName: (v('alternateDatabaseName') as string)?.trim(),
      referenceUiJobInstanceId: (v('referenceUiJobInstanceId') as string)?.trim(),
      identityQuery: v('identityQuery') as string,
      markerQueryTemplate: v('markerQueryTemplate') as string,
      rowCountQueryTemplate: v('rowCountQueryTemplate') as string,
      rowCapSizes: v('rowCapSizes') as number[],
      latencyQuery: v('latencyQuery') as string,
      latencyIterations: v('latencyIterations') as number,
      sizeTestRows: v('sizeTestRows') as number[],
      sizeQueryTemplate: v('sizeQueryTemplate') as string,
    },
  };
}

/**
 * `gatepulse.tenants`: no `scope: "resource"` — lives in User Settings by default, not tied to a
 * project/repo. GatePulse is used standalone, like the mssql extension (V1-SCOPE.md §2).
 */
export function readTenants(): TenantEntry[] {
  const raw = vscode.workspace.getConfiguration('gatepulse').get<TenantEntry[]>('tenants', []);
  return raw.filter(
    (t) => t && typeof t.alias === 'string' && typeof t.tenantId === 'string' && typeof t.workspaceId === 'string',
  );
}

const ACTIVE_TENANT_KEY = 'gatepulse.activeTenantAlias';
const EMPTY_TENANT: TenantEntry = { alias: '', tenantId: '', workspaceId: '' };

/** globalState, not workspaceState — the active tenant must survive with no folder open (V1-SCOPE.md §2). */
function getActiveTenant(context: vscode.ExtensionContext, tenants: TenantEntry[]): TenantEntry {
  const activeAlias = context.globalState.get<string>(ACTIVE_TENANT_KEY);
  return tenants.find((t) => t.alias === activeAlias) ?? tenants[0] ?? EMPTY_TENANT;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('GatePulse');
  context.subscriptions.push(channel);
  let session: Session | undefined;

  const authUi: AuthUi = {
    showDeviceCode(info) {
      channel.appendLine(info.message);
      channel.show(true);
      void vscode.window
        .showInformationMessage(
          `GatePulse sign-in: enter code ${info.userCode} at ${info.verificationUri}`,
          'Copy code & open browser',
        )
        .then(async (choice) => {
          if (!choice) return;
          await vscode.env.clipboard.writeText(info.userCode);
          await vscode.env.openExternal(vscode.Uri.parse(info.verificationUri));
        });
    },
  };

  const getSession = (): Session => {
    if (!session) {
      const tenant = getActiveTenant(context, readTenants());
      const cfg = buildConfigForTenant(readGlobalConfig(), tenant);
      const configuredLogDir = vscode.workspace
        .getConfiguration('gatepulse')
        .get<string>('logDirectory')
        ?.trim();
      const logDir = configuredLogDir || path.join(context.globalStorageUri.fsPath, 'logs');
      session = createSession({
        cfg,
        logDir,
        authUi,
        sinks: [new OutputChannelSink(channel)],
      });
      session.logger.info('extension.session', `Session ready — JSONL log: ${session.logFile}`, {
        tenantAlias: tenant.alias,
        workspaceId: cfg.workspaceId,
        pipelineId: cfg.pipelineId,
        parameterPayloadFormat: cfg.parameterPayloadFormat,
      });
    }
    return session;
  };

  /** Invalidates the cached session (tenant or settings changed) and refreshes the panel if open. */
  const invalidateSession = (): void => {
    session = undefined; // rebuilt lazily; tokens are in memory, so sign-in happens again
    SqlPanel.current?.refreshDefaults();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gatepulse')) return;
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.openPanel', () =>
      SqlPanel.show(context, getSession, readTenants, channel),
    ),
    vscode.commands.registerCommand('gatepulse.showLogs', () => channel.show()),
    vscode.commands.registerCommand('gatepulse.signOut', async () => {
      await getSession().auth.signOut();
      void vscode.window.showInformationMessage(
        'GatePulse : session effacée, la prochaine exécution redemandera la connexion.',
      );
    }),
    vscode.commands.registerCommand('gatepulse.switchTenant', async () => {
      const tenants = readTenants();
      if (tenants.length === 0) {
        void vscode.window.showWarningMessage(
          'GatePulse : aucun tenant configuré ("gatepulse.tenants" est vide).',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tenants.map((t) => ({ label: t.alias, description: t.tenantId, tenant: t })),
        { placeHolder: 'GatePulse : choisir le tenant actif' },
      );
      if (!picked) return;
      await context.globalState.update(ACTIVE_TENANT_KEY, picked.tenant.alias);
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.addTenant', async () => {
      const alias = (await vscode.window.showInputBox({
        prompt: 'GatePulse : nom du tenant (alias)',
        placeHolder: 'Client A - Prod',
      }))?.trim();
      if (!alias) return;
      const existing = readTenants();
      if (existing.some((t) => t.alias.toLowerCase() === alias.toLowerCase())) {
        void vscode.window.showErrorMessage(`GatePulse : l'alias "${alias}" existe déjà.`);
        return;
      }
      const tenantId = (await vscode.window.showInputBox({
        prompt: 'GatePulse : tenant ID (GUID Entra ID)',
      }))?.trim();
      if (!tenantId) return;
      if (!isGuid(tenantId)) {
        void vscode.window.showErrorMessage('GatePulse : tenantId invalide (GUID attendu).');
        return;
      }
      const workspaceId = (await vscode.window.showInputBox({
        prompt: 'GatePulse : workspace ID (GUID Fabric)',
      }))?.trim();
      if (!workspaceId) return;
      if (!isGuid(workspaceId)) {
        void vscode.window.showErrorMessage('GatePulse : workspaceId invalide (GUID attendu).');
        return;
      }
      // Global, jamais Workspace : GatePulse s'utilise sans dossier ouvert (V1-SCOPE.md §2).
      await vscode.workspace
        .getConfiguration('gatepulse')
        .update('tenants', [...existing, { alias, tenantId, workspaceId }], vscode.ConfigurationTarget.Global);
      await context.globalState.update(ACTIVE_TENANT_KEY, alias);
      invalidateSession();
    }),
  );
}

export function deactivate(): void {}
