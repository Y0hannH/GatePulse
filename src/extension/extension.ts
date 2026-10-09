import type { AuthUi } from '@evolve-data/pulse-core';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AuthFlow, ParameterNames, ParameterPayloadFormat, TenantEntry } from '../core/config';
import { buildConfigForTenant, isGuid, tenantConnections } from '../core/config';
import type { FabricConnection } from '../core/fabricClient';
import { isSupportedSqlConnection } from '../core/fabricClient';
import type { LogEntry, LogSink } from '../core/logger';
import { formatEntry } from '../core/logger';
import { ensurePipeline } from '../core/provision';
import type { ColumnInfo, SchemaObject } from '../core/runQuery';
import {
  convertedColumnExpression,
  listColumns,
  listDatabases,
  listSchemaObjects,
  sqlIdentifier,
} from '../core/runQuery';
import type { ScenarioContext } from '../core/scenarios';
import type { Session } from '../core/session';
import { createSession } from '../core/session';
import type { PanelServices } from './panel';
import { SqlPanel } from './panel';
import type { ConnectionTreeItem, DatabaseTreeItem, TableTreeItem } from './tenantTree';
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
      `GatePulse: pipeline "${resolved.displayName}" was provisioned automatically in this workspace.`,
    );
  }
}

function scenarioContext(session: Session): ScenarioContext {
  return { cfg: session.cfg, runner: session.runner, client: session.client, logger: session.logger };
}

const CACHE_STORAGE_KEY = 'gatepulse.schemaMetadataCache';
const CONNECTION_NAMES_KEY = 'gatepulse.connectionNames';

interface PersistedSchemaCache {
  databases: Record<string, string[]>;
  objects: Record<string, SchemaObject[]>;
  columns: Record<string, ColumnInfo[]>;
}

function schemaCachingEnabled(): boolean {
  return vscode.workspace.getConfiguration('gatepulse').get<boolean>('cacheSchemaMetadata', true);
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
  return {
    clientId: c.get<string>('clientId')?.trim(),
    authFlow: c.get<AuthFlow>('authFlow'),
    scopes: c.get<string[]>('scopes'),
    pollIntervalMs: c.get<number>('pollIntervalMs'),
    timeoutMs: c.get<number>('timeoutMs'),
    activityNames: c.get<string[]>('activityNames'),
    parameterPayloadFormat: c.get<ParameterPayloadFormat>('parameterPayloadFormat'),
    parameterNames: c.get<Partial<ParameterNames>>('parameterNames'),
  };
}

/** Unfiltered read of `gatepulse.tenants`, kept separate from readTenants() below so a write-back
 *  (addTenant, updateActiveTenant) never has to round-trip through the filtered list — doing so
 *  would silently drop any entry a user has mid-edit (e.g. an alias typed before tenantId/workspaceId)
 *  the next time any unrelated tenant action wrote the setting. */
function readRawTenants(): unknown[] {
  return vscode.workspace.getConfiguration('gatepulse').get<unknown[]>('tenants', []);
}

/**
 * `gatepulse.tenants`: no `scope: "resource"` — lives in User Settings by default, not tied to a
 * project/repo. GatePulse is used standalone, like the mssql extension (V1-SCOPE.md §2).
 */
export function readTenants(): TenantEntry[] {
  return readRawTenants().filter(
    (t): t is TenantEntry =>
      !!t &&
      typeof (t as TenantEntry).alias === 'string' &&
      typeof (t as TenantEntry).tenantId === 'string' &&
      typeof (t as TenantEntry).workspaceId === 'string',
  );
}

/** Rewrites one connection's manual databases. The default connection's legacy tenant-level list is
 *  folded in and cleared so it can't resurrect a database that was just removed. */
async function updateConnectionExtras(
  tenant: TenantEntry,
  connectionGuid: string,
  change: (current: string[]) => string[],
): Promise<void> {
  const same = (id: string | undefined) => id?.toLowerCase() === connectionGuid.toLowerCase();
  const current = tenantConnections(tenant).find((c) => same(c.id))?.extraDatabases ?? [];
  const next = change(current);
  const connections = [...(tenant.connections ?? [])];
  const i = connections.findIndex((c) => same(c.id));
  if (i >= 0) connections[i] = { ...connections[i], extraDatabases: next };
  else connections.push({ id: connectionGuid, extraDatabases: next });
  await updateTenant(tenant.alias, {
    connections,
    ...(same(tenant.connectionGuid) ? { extraDatabases: [] } : {}),
  });
}

const ACTIVE_TENANT_KEY = 'gatepulse.activeTenantAlias';
const EMPTY_TENANT: TenantEntry = { alias: '', tenantId: '', workspaceId: '' };

/** globalState, not workspaceState — the active tenant must survive with no folder open (V1-SCOPE.md §2). */
function getActiveTenant(context: vscode.ExtensionContext, tenants: TenantEntry[]): TenantEntry {
  const activeAlias = context.globalState.get<string>(ACTIVE_TENANT_KEY);
  return tenants.find((t) => t.alias === activeAlias) ?? tenants[0] ?? EMPTY_TENANT;
}

/** Merges a patch into the active tenant's `gatepulse.tenants` entry — Global scope, never Workspace
 *  (V1-SCOPE.md §2/§3). Writes back over readRawTenants(), not readTenants(): any other malformed
 *  entry in the array is passed through untouched instead of being dropped by the round-trip. */
async function updateActiveTenant(
  context: vscode.ExtensionContext,
  patch: Partial<Omit<TenantEntry, 'alias' | 'tenantId' | 'workspaceId'>>,
): Promise<void> {
  await updateTenant(getActiveTenant(context, readTenants()).alias, patch);
}

/** Same as updateActiveTenant, for any tenant by alias (sidebar actions on a non-active tenant). */
async function updateTenant(
  alias: string,
  patch: Partial<Omit<TenantEntry, 'alias' | 'tenantId' | 'workspaceId'>>,
): Promise<void> {
  const updated = readRawTenants().map((t) =>
    t && typeof t === 'object' && (t as TenantEntry).alias === alias ? { ...t, ...patch } : t,
  );
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

  // Schema-metadata caches, shared by the panel (database picker + editor autocomplete) and the
  // sidebar tree — whichever surface asks first fetches, the other reuses it (no reason to run the
  // same discovery query twice). Loaded from globalState at startup so a VS Code reload doesn't
  // throw away what was already discovered; gated by gatepulse.cacheSchemaMetadata.
  const persisted = context.globalState.get<PersistedSchemaCache>(CACHE_STORAGE_KEY);
  const databaseCache = new Map<string, string[]>(
    schemaCachingEnabled() && persisted ? Object.entries(persisted.databases) : [],
  );
  const schemaCache = new Map<string, SchemaObject[]>(
    schemaCachingEnabled() && persisted ? Object.entries(persisted.objects) : [],
  );
  const columnsCache = new Map<string, ColumnInfo[]>(
    schemaCachingEnabled() && persisted ? Object.entries(persisted.columns) : [],
  );

  const persistSchemaCaches = (): void => {
    if (!schemaCachingEnabled()) return;
    void context.globalState.update(CACHE_STORAGE_KEY, {
      databases: Object.fromEntries(databaseCache),
      objects: Object.fromEntries(schemaCache),
      columns: Object.fromEntries(columnsCache),
    } satisfies PersistedSchemaCache);
  };

  /** Invalidates the cached session (tenant or settings changed) and refreshes the panel/tree if
   *  open. Deliberately does NOT touch databaseCache/schemaCache/columnsCache: those are keyed by
   *  connectionGuid, not by tenant, so they stay valid across a tenant switch — only "GatePulse:
   *  Refresh Schema Tree" or disabling gatepulse.cacheSchemaMetadata clears them. */
  const invalidateSession = (): void => {
    session = undefined; // rebuilt lazily; tokens are in memory, so sign-in happens again
    cachedConnections = undefined;
    SqlPanel.current?.refreshDefaults();
    tenantTree.refresh();
  };

  /** Shared by the command palette entry, the panel's own tenant dropdown, and the sidebar tree. */
  const switchToTenant = async (alias: string): Promise<void> => {
    await context.globalState.update(ACTIVE_TENANT_KEY, alias);
    invalidateSession();
  };

  // guid -> display name, remembered across restarts (and across tenants: the dropdown/tree show the
  // default connection's name for tenants that aren't the active one, whose token can't list it now).
  const connectionNames: Record<string, string> = {
    ...context.globalState.get<Record<string, string>>(CONNECTION_NAMES_KEY, {}),
  };
  const getConnectionName = (guid: string | undefined): string | undefined =>
    guid ? connectionNames[guid.toLowerCase()] : undefined;
  const rememberConnectionNames = (connections: FabricConnection[]): void => {
    let changed = false;
    for (const c of connections) {
      const key = c.id.toLowerCase();
      if (connectionNames[key] !== c.displayName) {
        connectionNames[key] = c.displayName;
        changed = true;
      }
    }
    if (changed) void context.globalState.update(CONNECTION_NAMES_KEY, connectionNames);
  };

  /** Listed databases + the ones the user added by hand under this connection of the active tenant. */
  const withExtraDatabases = (names: string[], connectionGuid: string): string[] => {
    const tenant = getActiveTenant(context, readTenants());
    const extras =
      tenantConnections(tenant).find((c) => c.id.toLowerCase() === connectionGuid.toLowerCase())
        ?.extraDatabases ?? [];
    const seen = new Set(names.map((n) => n.toLowerCase()));
    return [...names, ...extras.filter((e) => !seen.has(e.toLowerCase()))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  };

  /** Never throws: a listing failure degrades to "no connections found", never blocks manual entry. */
  const getConnections = async (force = false): Promise<FabricConnection[]> => {
    if (force) cachedConnections = undefined;
    if (cachedConnections) return cachedConnections;
    const s = getSession();
    try {
      cachedConnections = (await s.client.listConnections()).filter(isSupportedSqlConnection);
      rememberConnectionNames(cachedConnections);
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

  // In-flight dedup for the three discovery calls below: the panel and the sidebar tree can both
  // ask for the same (connection, database[, schema, table]) within the same tick — e.g. opening
  // the panel while its schema tree node is already expanding — and each is a real Fabric pipeline
  // run, not a local lookup. Sharing the pending promise means a second caller awaits the first
  // one's result instead of triggering a second run for data the first is already fetching.
  const databasesInFlight = new Map<string, Promise<string[]>>();
  const schemaObjectsInFlight = new Map<string, Promise<SchemaObject[]>>();
  const columnsInFlight = new Map<string, Promise<ColumnInfo[]>>();

  const getDatabases = async (
    connectionGuid: string,
    databaseNameHint: string,
    force: boolean,
  ): Promise<string[]> => {
    if (!force) {
      const cached = databaseCache.get(connectionGuid);
      if (cached) return cached;
      const pending = databasesInFlight.get(connectionGuid);
      if (pending) return pending;
    }
    const promise = (async () => {
      const s = getSession();
      await ensurePipelineResolved(s);
      const names = await listDatabases(scenarioContext(s), connectionGuid, databaseNameHint);
      databaseCache.set(connectionGuid, names);
      persistSchemaCaches();
      return names;
    })();
    databasesInFlight.set(connectionGuid, promise);
    try {
      return await promise;
    } finally {
      if (databasesInFlight.get(connectionGuid) === promise) databasesInFlight.delete(connectionGuid);
    }
  };

  const getSchemaObjects = async (
    connectionGuid: string,
    databaseName: string,
  ): Promise<SchemaObject[]> => {
    const key = `${connectionGuid}:${databaseName}`;
    const cached = schemaCache.get(key);
    if (cached) return cached;
    const pending = schemaObjectsInFlight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const s = getSession();
      await ensurePipelineResolved(s);
      const objects = await listSchemaObjects(scenarioContext(s), connectionGuid, databaseName);
      schemaCache.set(key, objects);
      persistSchemaCaches();
      return objects;
    })();
    schemaObjectsInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (schemaObjectsInFlight.get(key) === promise) schemaObjectsInFlight.delete(key);
    }
  };

  const getColumns = async (
    connectionGuid: string,
    databaseName: string,
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> => {
    const key = `${connectionGuid}:${databaseName}:${schema}:${table}`;
    const cached = columnsCache.get(key);
    if (cached) return cached;
    const pending = columnsInFlight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const s = getSession();
      await ensurePipelineResolved(s);
      const columns = await listColumns(scenarioContext(s), connectionGuid, databaseName, schema, table);
      columnsCache.set(key, columns);
      persistSchemaCaches();
      return columns;
    })();
    columnsInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (columnsInFlight.get(key) === promise) columnsInFlight.delete(key);
    }
  };

  const panelServices: PanelServices = {
    getSession,
    getTenants: readTenants,
    getActiveTenantAlias,
    ensurePipelineResolved,
    getDatabases: async (connectionGuid, hint, force) =>
      withExtraDatabases(await getDatabases(connectionGuid, hint, force), connectionGuid),
    getSchemaObjects,
    getColumns,
    getConnections,
    getConnectionName,
  };

  const tenantTree = new TenantTreeProvider(
    readTenants,
    getActiveTenantAlias,
    getConnectionName,
    async () => void (await getConnections()),
    ensureActiveTenantForTree,
    (connectionGuid) => getDatabases(connectionGuid, '', false),
    getSchemaObjects,
    getColumns,
  );
  const tenantTreeView = vscode.window.createTreeView('gatepulse.tenantsView', {
    treeDataProvider: tenantTree,
  });

  /** Builds `SELECT TOP 100 ...` for "GatePulse: Select Top 100 Rows". Uses `*` unless a column has
   *  a type the Lookup can't transfer (binary, xml, spatial...): then every column is listed and
   *  those are cast to text, so the query just works instead of failing on its first run. Falls back
   *  to `*` if the column list can't be fetched at all (metadata is never a precondition to querying). */
  const buildTableQuery = async (
    connectionGuid: string,
    databaseName: string,
    schema: string,
    table: string,
  ): Promise<string> => {
    try {
      const columns = await getColumns(connectionGuid, databaseName, schema, table);
      const items = columns.map((c) => {
        const id = sqlIdentifier(c.name);
        const expr = convertedColumnExpression(id, c.dataType);
        return { text: expr ? `${expr} AS ${id}` : id, converted: !!expr };
      });
      if (items.some((i) => i.converted)) {
        return `SELECT TOP 100 ${items.map((i) => i.text).join(', ')} FROM ${sqlIdentifier(schema)}.${sqlIdentifier(table)}`;
      }
    } catch {
      // Fall through to the plain `*`.
    }
    return `SELECT TOP 100 * FROM ${sqlIdentifier(schema)}.${sqlIdentifier(table)}`;
  };

  context.subscriptions.push(
    tenantTreeView,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gatepulse.cacheSchemaMetadata')) {
        if (schemaCachingEnabled()) persistSchemaCaches();
        else void context.globalState.update(CACHE_STORAGE_KEY, undefined);
      }
      if (!e.affectsConfiguration('gatepulse')) return;
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.openPanel', () =>
      SqlPanel.show(context, panelServices, channel),
    ),
    // Sidebar tree row click: one step from "pick a tenant" to "query it", no palette involved.
    vscode.commands.registerCommand('gatepulse.openTenant', async (alias: string) => {
      if (alias !== getActiveTenantAlias()) await switchToTenant(alias);
      SqlPanel.show(context, panelServices, channel);
    }),
    // Right-click on a table/view in the tree — deliberately NOT a plain-click side effect anymore:
    // that used to overwrite whatever the user was typing in the editor the moment they clicked a
    // row just to browse it. VS Code passes the clicked TreeItem itself as the sole argument for a
    // view/item/context command.
    vscode.commands.registerCommand('gatepulse.selectTop100', async (item: TableTreeItem) => {
      if (!item) return;
      const { tenantAlias, connectionGuid, databaseName, schemaName, tableName } = item;
      if (tenantAlias !== getActiveTenantAlias()) await switchToTenant(tenantAlias);
      SqlPanel.show(context, panelServices, channel);
      // Immediate `*` first — the exclusion check is itself a real query and can take a few seconds;
      // no reason to leave the panel empty that whole time when a plain SELECT * works right away.
      // Silently upgraded to an explicit column list moments later if one needs excluding.
      SqlPanel.current?.prefillQuery(
        connectionGuid,
        databaseName,
        `SELECT TOP 100 * FROM ${sqlIdentifier(schemaName)}.${sqlIdentifier(tableName)}`,
      );
      const refined = await buildTableQuery(connectionGuid, databaseName, schemaName, tableName);
      SqlPanel.current?.prefillQuery(connectionGuid, databaseName, refined);
    }),
    vscode.commands.registerCommand('gatepulse.refreshSchemaTree', () => {
      databaseCache.clear();
      schemaCache.clear();
      columnsCache.clear();
      void context.globalState.update(CACHE_STORAGE_KEY, undefined);
      tenantTree.refresh();
    }),
    // "+" on a tenant row: attach another connection to browse under it.
    vscode.commands.registerCommand('gatepulse.addConnection', async (item?: { tenant: TenantEntry }) => {
      const tenant = item?.tenant ?? getActiveTenant(context, readTenants());
      if (!tenant.alias) {
        void vscode.window.showWarningMessage('GatePulse: add a tenant first.');
        return;
      }
      if (tenant.alias !== getActiveTenantAlias()) await switchToTenant(tenant.alias);
      const already = new Set(tenantConnections(tenant).map((c) => c.id.toLowerCase()));
      const listed = (await getConnections()).filter((c) => !already.has(c.id.toLowerCase()));
      const MANUAL = 'manual';
      const picked = await vscode.window.showQuickPick(
        [
          ...listed.map((c) => ({
            label: c.displayName,
            description: c.id,
            detail: c.gatewayId ? 'Gateway' : c.connectivityType,
            id: c.id as string,
            name: c.displayName as string | undefined,
          })),
          { label: '$(edit) Enter a connection GUID…', description: '', detail: undefined, id: MANUAL, name: undefined },
        ],
        { placeHolder: `GatePulse: add a connection to "${tenant.alias}"` },
      );
      if (!picked) return;
      let id = picked.id;
      let name = picked.name;
      if (id === MANUAL) {
        id =
          (
            await vscode.window.showInputBox({
              prompt: 'GatePulse: connection GUID',
              placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
              ignoreFocusOut: true,
              validateInput: (v) =>
                !isGuid(v.trim())
                  ? 'GUID expected'
                  : already.has(v.trim().toLowerCase())
                    ? 'This connection is already on the tenant'
                    : null,
            })
          )?.trim() ?? '';
        if (!id) return;
        name = getConnectionName(id);
      }
      const patch: Partial<TenantEntry> = {
        connections: [...(tenant.connections ?? []), { id, ...(name ? { name } : {}) }],
      };
      if (!tenant.connectionGuid) patch.connectionGuid = id; // first connection becomes the default
      await updateTenant(tenant.alias, patch);
    }),
    vscode.commands.registerCommand('gatepulse.removeConnection', async (item?: ConnectionTreeItem) => {
      const tenant = item && readTenants().find((t) => t.alias === item.tenantAlias);
      if (!item || !tenant) return;
      const same = (id: string | undefined) => id?.toLowerCase() === item.connectionGuid.toLowerCase();
      await updateTenant(tenant.alias, {
        connections: (tenant.connections ?? []).filter((c) => !same(c.id)),
        ...(same(tenant.connectionGuid) ? { connectionGuid: '', extraDatabases: [] } : {}),
      });
    }),
    // "+" on a connection row: databases `sys.databases` does not list for this login (queryable all
    // the same) are added by hand, under that connection.
    vscode.commands.registerCommand('gatepulse.addDatabase', async (item?: ConnectionTreeItem) => {
      const tenant = readTenants().find((t) => t.alias === (item?.tenantAlias ?? getActiveTenantAlias()));
      const connection =
        tenant &&
        tenantConnections(tenant).find((c) =>
          item ? c.id.toLowerCase() === item.connectionGuid.toLowerCase() : c.isDefault,
        );
      if (!tenant || !connection) {
        void vscode.window.showWarningMessage('GatePulse: pick a connection first.');
        return;
      }
      const name = (
        await vscode.window.showInputBox({
          prompt: `GatePulse: database to add under "${connection.name ?? getConnectionName(connection.id) ?? connection.id}"`,
          placeHolder: 'MyDatabase',
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : 'Name required'),
        })
      )?.trim();
      if (!name || connection.extraDatabases.some((d) => d.toLowerCase() === name.toLowerCase())) return;
      await updateConnectionExtras(tenant, connection.id, (cur) => [...cur, name]);
    }),
    vscode.commands.registerCommand('gatepulse.removeDatabase', async (item?: DatabaseTreeItem) => {
      const tenant = item && readTenants().find((t) => t.alias === item.tenantAlias);
      if (!item || !tenant) return;
      await updateConnectionExtras(tenant, item.connectionGuid, (cur) =>
        cur.filter((d) => d.toLowerCase() !== item.databaseName.toLowerCase()),
      );
    }),
    vscode.commands.registerCommand('gatepulse.showLogs', () => channel.show()),
    // The user guide ships inside the extension (media/guide.md); VS Code's built-in Markdown
    // preview renders it, so it works offline and needs no webview of our own.
    vscode.commands.registerCommand('gatepulse.openGuide', () =>
      vscode.commands.executeCommand(
        'markdown.showPreview',
        vscode.Uri.joinPath(context.extensionUri, 'media', 'guide.md'),
      ),
    ),
    vscode.commands.registerCommand('gatepulse.signOut', async () => {
      await getSession().auth.signOut();
      void vscode.window.showInformationMessage(
        'GatePulse: signed out — the next run will ask you to sign in again.',
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
          'GatePulse: no tenant configured ("gatepulse.tenants" is empty).',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tenants.map((t) => ({ label: t.alias, description: t.tenantId, tenant: t })),
        { placeHolder: 'GatePulse: choose the active tenant' },
      );
      if (!picked) return;
      await switchToTenant(picked.tenant.alias);
    }),
    vscode.commands.registerCommand('gatepulse.addTenant', async () => {
      // Raw, not readTenants(): the duplicate-alias check should also catch a malformed entry that
      // already has this alias, and the write-back below must preserve every existing entry as-is
      // (including malformed ones still being edited by hand) rather than dropping them.
      const existingRaw = readRawTenants();
      const existingAliases = existingRaw
        .map((t) => (t && typeof t === 'object' ? (t as TenantEntry).alias : undefined))
        .filter((a): a is string => typeof a === 'string');
      // ignoreFocusOut: filling in a tenantId/workspaceId almost always means copying it from
      // elsewhere (Azure / Fabric portal) — without it the box closed as soon as the window lost focus.
      const alias = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse: tenant name (alias)',
          placeHolder: 'Client A - Prod',
          ignoreFocusOut: true,
          validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) return 'Alias required';
            if (existingAliases.some((a) => a.toLowerCase() === trimmed.toLowerCase()))
              return `The alias "${trimmed}" already exists`;
            return null;
          },
        })
      )?.trim();
      if (!alias) return;
      const tenantId = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse: tenant ID (Entra ID GUID)',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput: (v) => (isGuid(v.trim()) ? null : 'GUID expected'),
        })
      )?.trim();
      if (!tenantId) return;
      const workspaceId = (
        await vscode.window.showInputBox({
          prompt: 'GatePulse: workspace ID (Fabric GUID)',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          ignoreFocusOut: true,
          validateInput: (v) => (isGuid(v.trim()) ? null : 'GUID expected'),
        })
      )?.trim();
      if (!workspaceId) return;
      // Global, never Workspace: GatePulse is used without an open folder (V1-SCOPE.md §2).
      await vscode.workspace
        .getConfiguration('gatepulse')
        .update('tenants', [...existingRaw, { alias, tenantId, workspaceId }], vscode.ConfigurationTarget.Global);
      await context.globalState.update(ACTIVE_TENANT_KEY, alias);
      invalidateSession();
    }),
    vscode.commands.registerCommand('gatepulse.pickConnection', async () => {
      const connections = await getConnections();
      if (connections.length === 0) {
        void vscode.window.showInformationMessage(
          'GatePulse: no SQL connection found (or the list is unavailable) — enter the GUID by hand in the panel.',
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
        { placeHolder: 'GatePulse: choose a SQL connection' },
      );
      if (!picked) return;
      // Fills the panel field directly when it's the source of the request; clipboard copy stays
      // useful for the command-palette entry point, where no panel field is in reach.
      SqlPanel.current?.setConnectionGuid(picked.connection.id);
      const choice = await vscode.window.showInformationMessage(
        `GatePulse: using connection "${picked.connection.displayName}".`,
        'Save as default for this tenant',
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
          `GatePulse: could not list the workspace's pipelines (${(err as Error).message}).`,
        );
        return;
      }
      if (items.length === 0) {
        void vscode.window.showInformationMessage('GatePulse: no pipeline found in this workspace.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.displayName, description: i.id, item: i })),
        { placeHolder: 'GatePulse: manual override — choose the pipeline for this tenant' },
      );
      if (!picked) return;
      await updateActiveTenant(context, { pipelineId: picked.item.id });
      invalidateSession();
      void vscode.window.showInformationMessage(
        `GatePulse: pipeline "${picked.item.displayName}" set as the override for this tenant.`,
      );
    }),
    vscode.commands.registerCommand('gatepulse.refreshConnections', async () => {
      cachedConnections = undefined;
      const connections = await getConnections();
      void vscode.window.showInformationMessage(
        `GatePulse: ${connections.length} SQL connection(s) found.`,
      );
    }),
  );
}

export function deactivate(): void {}
