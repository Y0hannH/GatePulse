import type { AuthUi } from '@evolve-data/pulse-core';
import * as path from 'path';
import * as vscode from 'vscode';

import type {
  AuthFlow,
  GatePulseConfig,
  ParameterNames,
  ParameterPayloadFormat,
} from '../core/config';
import { mergeConfig } from '../core/config';
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

export function readConfig(): GatePulseConfig {
  const c = vscode.workspace.getConfiguration('gatepulse');
  const v = (key: string) => c.get(`validation.${key}`);
  return mergeConfig({
    tenantId: c.get<string>('tenantId')?.trim(),
    clientId: c.get<string>('clientId')?.trim(),
    workspaceId: c.get<string>('workspaceId')?.trim(),
    pipelineId: c.get<string>('pipelineId')?.trim(),
    connectionGuid: c.get<string>('connectionGuid')?.trim(),
    databaseName: c.get<string>('databaseName')?.trim(),
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
  });
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
      const cfg = readConfig();
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
        workspaceId: cfg.workspaceId,
        pipelineId: cfg.pipelineId,
        parameterPayloadFormat: cfg.parameterPayloadFormat,
      });
    }
    return session;
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gatepulse')) return;
      session = undefined; // rebuilt lazily with the new settings; tokens are in memory, so sign-in happens again
      SqlPanel.current?.refreshDefaults();
    }),
    vscode.commands.registerCommand('gatepulse.openPanel', () =>
      SqlPanel.show(context, getSession, channel),
    ),
    vscode.commands.registerCommand('gatepulse.showLogs', () => channel.show()),
    vscode.commands.registerCommand('gatepulse.signOut', async () => {
      await getSession().auth.signOut();
      void vscode.window.showInformationMessage(
        'GatePulse : session effacée, la prochaine exécution redemandera la connexion.',
      );
    }),
  );
}

export function deactivate(): void {}
