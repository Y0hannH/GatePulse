import type { AuthUi } from '@evolve-data/pulse-core';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AuthFlow, ParameterNames, ParameterPayloadFormat, TenantEntry } from '../core/config';
import { buildConfigForTenant, isGuid } from '../core/config';
import type { FabricConnection } from '../core/fabricClient';
import { isSupportedSqlConnection } from '../core/fabricClient';
import type { LogEntry, LogSink } from '../core/logger';
import { formatEntry } from '../core/logger';
import { ensurePipeline } from '../core/provision';
import type { ColumnInfo, SchemaObject } from '../core/runQuery';
import { listColumns, listDatabases, listSchemaObjects } from '../core/runQuery';
import type { ScenarioContext } from '../core/scenarios';
import type { Session } from '../core/session';
import { createSession } from '../core/session';
import { SqlPanel } from './panel';
import { TenantTreeProvider } from './tenantTree';

/** Resolves and caches the pipeline id on `session.cfg` — shared by a query run, the panel's
 *  database picker, and the sidebar's schema tree, since all three need a working pipeline before
 *  they can execute anything (V1-SCOPE.md §1). */
async function ensurePipelineResolved(session: Session): Promise<void> {
  if (session.cfg.pipelineId) return;
  const resolved = await ensurePipeline(session.client, session.logger, session.cfg.parameterNames);
  session.cfg.pipelineId = resolved.id;
  if (resolved.created) {
    void vscode.window.showInformationMessage(
      `GatePulse : pipeline "${resolved.displayName}" provisionné automatiquement dans ce workspace.`,
    );
  }
}

function scenarioContext(session: Session): ScenarioContext {
  return { cfg: session.cfg, runner: session.runner, client: session.client, logger: session.logger };
}

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

/** Merges a patch into the active tenant's `gatepulse.tenants` entry — Global scope, never Workspace (V1-SCOPE.md §2/§3). */
async function updateActiveTenant(
  context: vscode.ExtensionContext,
  patch: Partial<Omit<TenantEntry, 'alias' | 'tenantId' | 'workspaceId'>>,
): Promise<void> {
  const tenants = readTenants();
  const active = getActiveTenant(context, tenants);
  const updated = tenants.map((t) => (t.alias === active.alias ? { ...t, ...patch } : t));
  await vscode.workspace
    .getConfiguration('gatepulse')
    .update('tenants', updated, vscode.ConfigurationTarget.Global);
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('GatePulse');
  context.subscriptions.push(channel);
  let session: Session | undefined;
  // Resolved once per session (in memory only) — invalidated on tenant switch, same as `session`
  // itself, since the token used to call /v1/connections is the active tenant's (V1-SCOPE.md §3).
  let cachedConnections: FabricConnection[] | undefined;

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

  const getActiveTenantAlias = (): string => getActiveTenant(context, readTenants()).alias;

  // Schema-tree caches — separate from SqlPanel's own database cache (the tree exists even when the
  // panel is closed) and from cachedConnections (unrelated data). Keyed so a database's schema list
  // and a table's columns are each fetched once per session, not once per tree render.
  const schemaCache = new Map<string, SchemaObject[]>(); // `${connectionGuid}:${databaseName}`
  const columnsCache = new Map<string, ColumnInfo[]>(); // `${connectionGuid}:${databaseName}:${schema}:${table}`
  const treeDatabaseCache = new Map<string, string[]>(); // `${connectionGuid}`

  /** Invalidates the cached session (tenant or settings changed) and refreshes the panel/tree if open. */
  const invalidateSession = (): void => {
    session = undefined; // rebuilt lazily; tokens are in memory, so sign-in happens again
    cachedConnections = undefined;
    schemaCache.clear();
    columnsCache.clear();
    treeDatabaseCache.clear();
    SqlPanel.current?.refreshDefaults();
    tenantTree.refresh();
  };

  /** Shared by the command palette entry, the panel's own tenant dropdown, and the sidebar tree. */
  const switchToTenant = async (alias: string): Promise<void> => {
    await context.globalState.update(ACTIVE_TENANT_KEY, alias);
    invalidateSession();
  };

  /** Never throws: a listing failure degrades to "no connections found", never blocks manual entry. */
  const getConnections = async (): Promise<FabricConnection[]> => {
    if (cachedConnections) return cachedConnections;
    const s = getSession();
    try {
      cachedConnections = (await s.client.listConnections()).filter(isSupportedSqlConnection);
    } catch (err) {
      s.logger.warn(
        'connections.listFailed',
        `Could not list Fabric connections: ${(err as Error).message}`,
      );
      return [];
    }
    return cachedConnections;
  };

  // Expanding a tenant's node in the sidebar tree makes it the active tenant first — GatePulse has
  // one active tenant at a time (V1-SCOPE.md §2), so "browse this tenant's schema" and "this is the
  // tenant I'm working with" are the same action already used by clicking its row.
  const ensureActiveTenantForTree = async (alias: string): Promise<void> => {
    if (alias !== getActiveTenantAlias()) await switchToTenant(alias);
  };

  const treeListDatabases = async (connectionGuid: string): Promise<string[]> => {
    const cached = treeDatabaseCache.get(connectionGuid);
    if (cached) return cached;
    const s = getSession();
    await ensurePipelineResolved(s);
    const names = await listDatabases(scenarioContext(s), connectionGuid, '');
    treeDatabaseCache.set(connectionGuid, names);
    return names;
  };

  const treeListObjects = async (connectionGuid: string, databaseName: string): Promise<SchemaObject[]> => {
    const key = `${connectionGuid}:${databaseName}`;
    const cached = schemaCache.get(key);
    if (cached) return cached;
    const s = getSession();
    await ensurePipelineResolved(s);
    const objects = await listSchemaObjects(scenarioContext(s), connectionGuid, databaseName);
    schemaCache.set(key, objects);
    return objects;
  };

  const treeListColumns = async (
    connectionGuid: string,
    databaseName: string,
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> => {
    const key = `${connectionGuid}:${databaseName}:${schema}:${table}`;
    const cached = columnsCache.get(key);
    if (cached) return cached;
    const s = getSession();
    await ensurePipelineResolved(s);
    const columns = await listColumns(scenarioContext(s), connectionGuid, databaseName, schema, table);
    columnsCache.set(key, columns);
    return columns;
  };

  const tenantTree = new TenantTreeProvider(
    readTenants,
    getActiveTenantAlias,
    ensureActiveTenantForTree,
    treeListDatabases,
    treeListObjects,
    treeListColumns,
  );
  const tenantTreeView = vscode.window.createTreeView('gatepulse.tenantsView', {
    treeDataProvider: tenantTree,
  });

  context.subscriptions.push(
    tenantTreeView,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gatepulse')) return;
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.openPanel', () =>
      SqlPanel.show(context, getSession, readTenants, getActiveTenantAlias, ensurePipelineResolved, channel),
    ),
    // Sidebar tree row click: one step from "pick a tenant" to "query it", no palette involved.
    vscode.commands.registerCommand('gatepulse.openTenant', async (alias: string) => {
      if (alias !== getActiveTenantAlias()) await switchToTenant(alias);
      SqlPanel.show(context, getSession, readTenants, getActiveTenantAlias, ensurePipelineResolved, channel);
    }),
    // Sidebar tree table/view click: one step further than openTenant — also fills the panel's
    // connection/database/query so the "browse" and "query" flows meet in one click.
    vscode.commands.registerCommand(
      'gatepulse.openTableQuery',
      async (args: {
        alias: string;
        connectionGuid: string;
        databaseName: string;
        schema: string;
        table: string;
      }) => {
        if (args.alias !== getActiveTenantAlias()) await switchToTenant(args.alias);
        SqlPanel.show(context, getSession, readTenants, getActiveTenantAlias, ensurePipelineResolved, channel);
        SqlPanel.current?.prefillQuery(
          args.connectionGuid,
          args.databaseName,
          `SELECT TOP 100 * FROM [${args.schema}].[${args.table}]`,
        );
      },
    ),
    vscode.commands.registerCommand('gatepulse.refreshSchemaTree', () => {
      schemaCache.clear();
      columnsCache.clear();
      treeDatabaseCache.clear();
      tenantTree.refresh();
    }),
    vscode.commands.registerCommand('gatepulse.showLogs', () => channel.show()),
    vscode.commands.registerCommand('gatepulse.signOut', async () => {
      await getSession().auth.signOut();
      void vscode.window.showInformationMessage(
        'GatePulse : session effacée, la prochaine exécution redemandera la connexion.',
      );
    }),
    // alias: passed directly by the panel's own tenant dropdown; omitted from the command palette,
    // which falls back to a QuickPick (V1-SCOPE.md §4.C).
    vscode.commands.registerCommand('gatepulse.switchTenant', async (alias?: string) => {
      if (alias) {
        await switchToTenant(alias);
        return;
      }
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
      await switchToTenant(picked.tenant.alias);
    }),
    vscode.commands.registerCommand('gatepulse.addTenant', async () => {
      const existing = readTenants();
      // ignoreFocusOut: renseigner un tenantId/workspaceId implique presque toujours d'aller le
      // copier ailleurs (portail Azure, Fabric) — sans ça, la boîte se fermait dès qu'on changeait
      // de fenêtre et il fallait tout recommencer depuis l'alias.
      const alias = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse : nom du tenant (alias)',
          placeHolder: 'Client A - Prod',
          ignoreFocusOut: true,
          validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) return 'Alias requis';
            if (existing.some((t) => t.alias.toLowerCase() === trimmed.toLowerCase()))
              return `L'alias "${trimmed}" existe déjà`;
            return null;
          },
        })
      )?.trim();
      if (!alias) return;
      const tenantId = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse : tenant ID (GUID Entra ID)',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput: (v) => (isGuid(v.trim()) ? null : 'GUID attendu'),
        })
      )?.trim();
      if (!tenantId) return;
      const workspaceId = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse : workspace ID (GUID Fabric)',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput: (v) => (isGuid(v.trim()) ? null : 'GUID attendu'),
        })
      )?.trim();
      if (!workspaceId) return;
      // Global, jamais Workspace : GatePulse s'utilise sans dossier ouvert (V1-SCOPE.md §2).
      await vscode.workspace
        .getConfiguration('gatepulse')
        .update('tenants', [...existing, { alias, tenantId, workspaceId }], vscode.ConfigurationTarget.Global);
      await context.globalState.update(ACTIVE_TENANT_KEY, alias);
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.pickConnection', async () => {
      const connections = await getConnections();
      if (connections.length === 0) {
        void vscode.window.showInformationMessage(
          'GatePulse : aucune connexion SQL trouvée (ou liste indisponible) — saisir le GUID à la main dans le panel.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        connections.map((c) => ({
          label: c.displayName,
          description: c.id,
          // No gatewayId on a cloud connection — detail then just shows the connection's own type.
          detail: c.gatewayId ? `gateway ${c.gatewayId}` : c.connectivityType,
          connection: c,
        })),
        { placeHolder: 'GatePulse : choisir une connexion SQL (GUID copié dans le presse-papiers)' },
      );
      if (!picked) return;
      // Fills the panel field directly when it's the source of the request; clipboard copy stays
      // useful for the command-palette entry point, where no panel field is in reach.
      SqlPanel.current?.setConnectionGuid(picked.connection.id);
      await vscode.env.clipboard.writeText(picked.connection.id);
      const choice = await vscode.window.showInformationMessage(
        `GatePulse : GUID de "${picked.connection.displayName}" copié dans le presse-papiers.`,
        'Enregistrer comme connexion par défaut pour ce tenant',
      );
      if (choice) {
        await updateActiveTenant(context, { connectionGuid: picked.connection.id });
        invalidateSession();
      }
    }),
    vscode.commands.registerCommand('gatepulse.pickPipelineOverride', async () => {
      const s = getSession();
      let items: { id: string; displayName: string; type: string }[];
      try {
        items = await s.client.listItems('DataPipeline');
      } catch (err) {
        void vscode.window.showErrorMessage(
          `GatePulse : impossible de lister les pipelines du workspace (${(err as Error).message}).`,
        );
        return;
      }
      if (items.length === 0) {
        void vscode.window.showInformationMessage('GatePulse : aucun pipeline trouvé dans ce workspace.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.displayName, description: i.id, item: i })),
        { placeHolder: 'GatePulse : override manuel — choisir le pipeline pour ce tenant' },
      );
      if (!picked) return;
      await updateActiveTenant(context, { pipelineId: picked.item.id });
      invalidateSession();
      void vscode.window.showInformationMessage(
        `GatePulse : pipeline "${picked.item.displayName}" défini comme override pour ce tenant.`,
      );
    }),
    vscode.commands.registerCommand('gatepulse.refreshConnections', async () => {
      cachedConnections = undefined;
      const connections = await getConnections();
      void vscode.window.showInformationMessage(
        `GatePulse : ${connections.length} connexion(s) SQL trouvée(s).`,
      );
    }),
  );
}

export function deactivate(): void {}
