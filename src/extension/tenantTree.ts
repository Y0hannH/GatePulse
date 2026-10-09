import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';
import { tenantConnections } from '../core/config';
import type { ColumnInfo, SchemaObject } from '../core/runQuery';

export class TenantTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenant: TenantEntry,
    isActive: boolean,
    connectionName: string | undefined,
  ) {
    // Collapsed even without a connectionGuid: expanding it is how the user discovers they need to
    // set one (via the MessageTreeItem hint in getChildren), rather than a dead end with no arrow.
    super(tenant.alias, vscode.TreeItemCollapsibleState.Collapsed);
    // Which connection this tenant browses is the thing you most need to see at a glance.
    this.description = connectionName ?? tenant.connectionGuid ?? 'no default connection';
    this.tooltip = [
      isActive ? 'Active tenant' : undefined,
      `Tenant: ${tenant.tenantId}`,
      `Workspace: ${tenant.workspaceId}`,
      tenant.connectionGuid ? `Connection: ${connectionName ?? '?'} (${tenant.connectionGuid})` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
    this.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'circle-large-outline');
    this.contextValue = isActive ? 'tenant-active' : 'tenant-inactive';
    // Click = same one-step action as the sidebar's purpose: switch to this tenant and open the panel.
    this.command = { command: 'gatepulse.openTenant', title: 'Open', arguments: [tenant.alias] };
  }
}

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenantAlias: string,
    public readonly connectionGuid: string,
    public readonly connectionName: string | undefined,
    public readonly isDefault: boolean,
  ) {
    super(connectionName ?? connectionGuid, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isDefault ? 'default' : undefined;
    this.tooltip = `${connectionName ?? 'Connection'}
${connectionGuid}`;
    this.iconPath = new vscode.ThemeIcon('plug');
    this.contextValue = isDefault ? 'connection-default' : 'connection';
  }
}

export class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenantAlias: string,
    public readonly connectionGuid: string,
    public readonly databaseName: string,
    /** Added by hand (gatepulse.tenants[].extraDatabases) rather than listed by sys.databases. */
    public readonly manual = false,
  ) {
    super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('database');
    this.description = manual ? 'added manually' : undefined;
    this.contextValue = manual ? 'database-manual' : 'database';
  }
}

export class SchemaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenantAlias: string,
    public readonly connectionGuid: string,
    public readonly databaseName: string,
    public readonly schemaName: string,
    /** Pre-filtered to this schema — computed once per database fetch, not once per schema. */
    public readonly objects: SchemaObject[],
  ) {
    super(schemaName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(objects.length);
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.contextValue = 'schema';
  }
}

export class TableTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenantAlias: string,
    public readonly connectionGuid: string,
    public readonly databaseName: string,
    public readonly schemaName: string,
    public readonly tableName: string,
    public readonly objectType: 'table' | 'view',
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = `${schemaName}.${tableName} (${objectType === 'view' ? 'view' : 'table'})`;
    this.iconPath = new vscode.ThemeIcon(objectType === 'view' ? 'eye' : 'table');
    // No `command`: a click only expands to the columns (browsing shouldn't have a side effect on
    // the editor — "GatePulse: Select Top 100 Rows", right-click, is the explicit way to query it).
    this.contextValue = objectType;
  }
}

export class ColumnTreeItem extends vscode.TreeItem {
  constructor(column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${column.dataType}${column.nullable ? ' (nullable)' : ''}`;
    this.iconPath = new vscode.ThemeIcon('symbol-field');
    this.contextValue = 'column';
  }
}

/** Non-interactive leaf for hints/errors — tree views have no built-in way to show an inline
 *  message, so this is a normal, childless item instead. */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string, icon: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

export type GatePulseTreeItem =
  | TenantTreeItem
  | ConnectionTreeItem
  | DatabaseTreeItem
  | SchemaTreeItem
  | TableTreeItem
  | ColumnTreeItem
  | MessageTreeItem;

/**
 * Backs `gatepulse.tenantsView`. Beyond the tenant row itself (unchanged since the sidebar's first
 * version), lazily drills into Databases → Schemas → Tables/Views → Columns — each level fetched
 * (and cached) only when its parent is actually expanded, via the callbacks injected from
 * extension.ts, which own the session/pipeline/caching concerns this provider has no business with.
 */
export class TenantTreeProvider implements vscode.TreeDataProvider<GatePulseTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly getTenants: () => TenantEntry[],
    private readonly getActiveAlias: () => string,
    private readonly getConnectionName: (guid: string | undefined) => string | undefined,
    private readonly ensureConnectionNames: () => Promise<void>,
    private readonly ensureActiveTenant: (alias: string) => Promise<void>,
    private readonly listDatabasesFor: (connectionGuid: string) => Promise<string[]>,
    private readonly listObjectsFor: (connectionGuid: string, databaseName: string) => Promise<SchemaObject[]>,
    private readonly listColumnsFor: (
      connectionGuid: string,
      databaseName: string,
      schema: string,
      table: string,
    ) => Promise<ColumnInfo[]>,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: GatePulseTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GatePulseTreeItem): Promise<GatePulseTreeItem[]> {
    if (!element) {
      const active = this.getActiveAlias();
      return this.getTenants().map(
        (t) => new TenantTreeItem(t, t.alias === active, this.getConnectionName(t.connectionGuid)),
      );
    }

    if (element instanceof TenantTreeItem) {
      return this.getConnectionItems(element.tenant);
    }
    if (element instanceof ConnectionTreeItem) {
      return this.getDatabases(element);
    }
    if (element instanceof DatabaseTreeItem) {
      return this.getSchemas(element);
    }
    if (element instanceof SchemaTreeItem) {
      return element.objects
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (o) =>
            new TableTreeItem(
              element.tenantAlias,
              element.connectionGuid,
              element.databaseName,
              element.schemaName,
              o.name,
              o.type,
            ),
        );
    }
    if (element instanceof TableTreeItem) {
      return this.getColumns(element);
    }
    return [];
  }

  /** Tenant children: its connections (default first), named when Fabric has told us the name. */
  private async getConnectionItems(tenant: TenantEntry): Promise<GatePulseTreeItem[]> {
    try {
      await this.ensureActiveTenant(tenant.alias);
      await this.ensureConnectionNames();
    } catch (err) {
      return [new MessageTreeItem(`Error: ${(err as Error).message}`, 'warning')];
    }
    const connections = tenantConnections(tenant);
    if (connections.length === 0) {
      const hint = new MessageTreeItem('No connection — click to add one', 'info');
      hint.command = { command: 'gatepulse.addConnection', title: 'Add Connection', arguments: [{ tenant }] };
      return [hint];
    }
    return connections.map(
      (c) =>
        new ConnectionTreeItem(tenant.alias, c.id, c.name ?? this.getConnectionName(c.id), c.isDefault),
    );
  }

  private async getDatabases(conn: ConnectionTreeItem): Promise<GatePulseTreeItem[]> {
    const tenant = this.getTenants().find((t) => t.alias === conn.tenantAlias);
    const extras = (tenant ? tenantConnections(tenant) : []).find(
      (c) => c.id.toLowerCase() === conn.connectionGuid.toLowerCase(),
    )?.extraDatabases ?? [];
    const items = (listed: string[]) => {
      const seen = new Set(listed.map((n) => n.toLowerCase()));
      return [
        ...listed.map((name) => ({ name, manual: false })),
        ...extras.filter((e) => !seen.has(e.toLowerCase())).map((name) => ({ name, manual: true })),
      ]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((d) => new DatabaseTreeItem(conn.tenantAlias, conn.connectionGuid, d.name, d.manual));
    };
    try {
      const result = items(await this.listDatabasesFor(conn.connectionGuid));
      return result.length ? result : [new MessageTreeItem('No database found', 'info')];
    } catch (err) {
      // Listing can fail (no access to master...) — databases added by hand stay usable regardless.
      return [...items([]), new MessageTreeItem(`Error: ${(err as Error).message}`, 'warning')];
    }
  }

  private async getSchemas(db: DatabaseTreeItem): Promise<GatePulseTreeItem[]> {
    try {
      const objects = await this.listObjectsFor(db.connectionGuid, db.databaseName);
      if (objects.length === 0) return [new MessageTreeItem('No table or view found', 'info')];
      const schemas = [...new Set(objects.map((o) => o.schema))].sort((a, b) => a.localeCompare(b));
      return schemas.map(
        (schema) =>
          new SchemaTreeItem(
            db.tenantAlias,
            db.connectionGuid,
            db.databaseName,
            schema,
            objects.filter((o) => o.schema === schema),
          ),
      );
    } catch (err) {
      return [new MessageTreeItem(`Error: ${(err as Error).message}`, 'warning')];
    }
  }

  private async getColumns(table: TableTreeItem): Promise<GatePulseTreeItem[]> {
    try {
      const columns = await this.listColumnsFor(
        table.connectionGuid,
        table.databaseName,
        table.schemaName,
        table.tableName,
      );
      if (columns.length === 0) return [new MessageTreeItem('No column found', 'info')];
      return columns.map((c) => new ColumnTreeItem(c));
    } catch (err) {
      return [new MessageTreeItem(`Error: ${(err as Error).message}`, 'warning')];
    }
  }
}
