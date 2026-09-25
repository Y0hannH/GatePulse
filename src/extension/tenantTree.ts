import * as vscode from 'vscode';

import type { TenantEntry } from '../core/config';

export class TenantTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tenant: TenantEntry,
    isActive: boolean,
  ) {
    super(tenant.alias, vscode.TreeItemCollapsibleState.None);
    this.description = isActive ? 'actif' : tenant.tenantId;
    this.tooltip = `Tenant: ${tenant.tenantId}\nWorkspace: ${tenant.workspaceId}`;
    this.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'circle-large-outline');
    this.contextValue = isActive ? 'tenant-active' : 'tenant-inactive';
    // Click = same one-step action as the sidebar's purpose: switch to this tenant and open the panel.
    this.command = { command: 'gatepulse.openTenant', title: 'Open', arguments: [tenant.alias] };
  }
}

/** Backs `gatepulse.tenantsView` — one row per `gatepulse.tenants` entry, refreshed by extension.ts on any change. */
export class TenantTreeProvider implements vscode.TreeDataProvider<TenantTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly getTenants: () => TenantEntry[],
    private readonly getActiveAlias: () => string,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TenantTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TenantTreeItem[] {
    const active = this.getActiveAlias();
    return this.getTenants().map((t) => new TenantTreeItem(t, t.alias === active));
  }
}
