/** auto = Azure CLI session if available, else browser. */
export type AuthFlow = 'auto' | 'azureCli' | 'interactive' | 'deviceCode';

/**
 * How pipeline parameters are serialized in the Run On Demand Job request.
 * - executionData:   { executionData: { parameters: { name: value } } }  (Data Pipeline format)
 * - typedParameters: { parameters: [ { name, value, type: "Text" } ] }   (generic Job Scheduler format)
 * Which one Fabric honours for pipelines is exactly what check P1/PARAM_BINDING verifies.
 */
export type ParameterPayloadFormat = 'executionData' | 'typedParameters';

/** Names of the pipeline parameters as declared in the Fabric pipeline. */
export interface ParameterNames {
  connectionGuid: string;
  databaseName: string;
  query: string;
}

export interface ValidationConfig {
  concurrency: number;
  alternateConnectionGuid: string;
  alternateDatabaseName: string;
  referenceUiJobInstanceId: string;
  identityQuery: string;
  markerQueryTemplate: string;
  rowCountQueryTemplate: string;
  rowCapSizes: number[];
  latencyQuery: string;
  latencyIterations: number;
  /** Row counts for the payload size test (4 MB limit). */
  sizeTestRows: number[];
  /** Query returning {{n}} wide rows (~4 KB each by default). */
  sizeQueryTemplate: string;
}

/**
 * One entry of the `gatepulse.tenants` setting — one Fabric workspace per tenant, supplied by the
 * user (GatePulse never creates a workspace). Lives in User Settings by default, not tied to a
 * project/repo: GatePulse is used standalone, like the mssql extension (see V1-SCOPE.md §2).
 */
export interface TenantEntry {
  alias: string;
  tenantId: string;
  workspaceId: string;
  /** Optional: app registration override for this tenant (falls back to the global clientId). */
  clientId?: string;
  /** Optional: manual override, skips ensurePipeline's auto-discovery for this tenant. */
  pipelineId?: string;
  /** Optional pre-fill for the panel. */
  connectionGuid?: string;
  /** Optional pre-fill for the panel. */
  databaseName?: string;
  /** Legacy (first manual-database version): extras of the default connection. Still honoured;
   *  new ones are written under `connections[].extraDatabases`. */
  extraDatabases?: string[];
  /** Optional: further connections to browse under this tenant, besides the default connectionGuid. */
  connections?: TenantConnection[];
}

export interface TenantConnection {
  id: string;
  /** Display name; falls back to the name Fabric reports for this GUID. */
  name?: string;
  /** Databases reachable through this connection that sys.databases doesn't list for the login. */
  extraDatabases?: string[];
}

/** A tenant's connections as the sidebar shows them: the default `connectionGuid` first, then the
 *  `connections` entries, deduplicated by GUID (extras merged, legacy tenant-level extras attached
 *  to the default one). */
export function tenantConnections(
  t: TenantEntry,
): { id: string; name?: string; extraDatabases: string[]; isDefault: boolean }[] {
  const out: { id: string; name?: string; extraDatabases: string[]; isDefault: boolean }[] = [];
  const add = (id: string, name: string | undefined, extras: string[], isDefault: boolean) => {
    const existing = out.find((c) => c.id.toLowerCase() === id.toLowerCase());
    if (existing) {
      existing.name ??= name;
      existing.isDefault ||= isDefault;
      for (const e of extras) if (!existing.extraDatabases.some((x) => x.toLowerCase() === e.toLowerCase())) existing.extraDatabases.push(e);
      return;
    }
    out.push({ id, name, extraDatabases: [...extras], isDefault });
  };
  if (t.connectionGuid) add(t.connectionGuid, undefined, t.extraDatabases ?? [], true);
  for (const c of t.connections ?? []) {
    if (c && typeof c.id === 'string' && c.id) add(c.id, c.name, c.extraDatabases ?? [], false);
  }
  return out;
}

export interface GatePulseConfig {
  tenantId: string;
  /** Optional. Empty = Microsoft first-party public client (no app registration needed). */
  clientId: string;
  workspaceId: string;
  /** Empty = resolved automatically on first use (ensurePipeline, provision.ts). Set = manual override, skips discovery. */
  pipelineId: string;
  connectionGuid: string;
  databaseName: string;
  authFlow: AuthFlow;
  scopes: string[];
  apiBaseUrl: string;
  pollIntervalMs: number;
  timeoutMs: number;
  /** Query activities to read (Lookup / Script). Empty = every Lookup and Script activity of the run. */
  activityNames: string[];
  parameterPayloadFormat: ParameterPayloadFormat;
  parameterNames: ParameterNames;
  /** Activity runs can lag behind the job status: how many times to retry queryactivityruns. */
  resultFetchRetries: number;
  resultFetchDelayMs: number;
  validation: ValidationConfig;
}

export const DEFAULT_CONFIG: GatePulseConfig = {
  tenantId: '',
  clientId: '',
  workspaceId: '',
  pipelineId: '',
  connectionGuid: '',
  databaseName: '',
  authFlow: 'auto',
  // The first-party client only accepts .default; granted scopes are logged at sign-in.
  scopes: ['https://api.fabric.microsoft.com/.default'],
  apiBaseUrl: 'https://api.fabric.microsoft.com',
  pollIntervalMs: 2000,
  timeoutMs: 120_000,
  activityNames: [],
  parameterPayloadFormat: 'executionData',
  parameterNames: {
    connectionGuid: 'connectionGuid',
    databaseName: 'databaseName',
    query: 'query',
  },
  resultFetchRetries: 5,
  resultFetchDelayMs: 2000,
  validation: {
    concurrency: 3,
    alternateConnectionGuid: '',
    alternateDatabaseName: '',
    referenceUiJobInstanceId: '',
    identityQuery:
      'SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, SUSER_SNAME() AS login_name',
    markerQueryTemplate: "SELECT '{{tag}}' AS run_tag, CURRENT_TIMESTAMP AS server_time",
    rowCountQueryTemplate:
      'SELECT TOP ({{n}}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b',
    rowCapSizes: [100, 5000, 5001, 7500],
    latencyQuery: 'SELECT 1 AS one',
    latencyIterations: 3,
    sizeTestRows: [500, 900, 1100, 2000],
    sizeQueryTemplate:
      "SELECT TOP ({{n}}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i, REPLICATE(CAST('x' AS varchar(max)), 4000) AS pad FROM sys.all_objects a CROSS JOIN sys.all_objects b",
  },
};

export function mergeConfig(
  partial: Partial<Omit<GatePulseConfig, 'validation' | 'parameterNames'>> & {
    validation?: Partial<ValidationConfig>;
    parameterNames?: Partial<ParameterNames>;
  },
): GatePulseConfig {
  const pick = <T extends object>(defaults: T, overrides: Partial<T> | undefined): T => {
    const out = { ...defaults };
    for (const [k, v] of Object.entries(overrides ?? {})) {
      if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  };
  const { validation, parameterNames, ...rest } = partial;
  return {
    ...pick(DEFAULT_CONFIG, rest as Partial<GatePulseConfig>),
    parameterNames: pick(DEFAULT_CONFIG.parameterNames, parameterNames),
    validation: pick(DEFAULT_CONFIG.validation, validation),
  };
}

/**
 * Merges the global settings (everything but tenant identity/targeting) with one tenant entry
 * into the flat shape FabricClient/PipelineRunner/session.ts already expect. Multi-tenant is
 * handled entirely above this function (extension.ts) — src/core only ever sees one tenant at a
 * time (V1-SCOPE.md §2).
 */
export function buildConfigForTenant(
  global: Partial<
    Omit<
      GatePulseConfig,
      | 'tenantId'
      | 'workspaceId'
      | 'pipelineId'
      | 'connectionGuid'
      | 'databaseName'
      | 'validation'
      | 'parameterNames'
    >
  > & {
    validation?: Partial<ValidationConfig>;
    parameterNames?: Partial<ParameterNames>;
  },
  tenant: TenantEntry,
): GatePulseConfig {
  return mergeConfig({
    ...global,
    tenantId: tenant.tenantId,
    clientId: tenant.clientId || global.clientId,
    workspaceId: tenant.workspaceId,
    pipelineId: tenant.pipelineId ?? '',
    connectionGuid: tenant.connectionGuid ?? '',
    databaseName: tenant.databaseName ?? '',
  });
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID_RE.test(value.trim());
}

/** Returns human-readable problems; empty array = config usable. */
export function checkConfig(cfg: GatePulseConfig): string[] {
  const problems: string[] = [];
  if (cfg.clientId && !isGuid(cfg.clientId))
    problems.push(`"clientId" is not a GUID: ${cfg.clientId}`);
  for (const key of ['tenantId', 'workspaceId'] as const) {
    if (!cfg[key]) problems.push(`"${key}" is not set`);
    else if (!isGuid(cfg[key])) problems.push(`"${key}" is not a GUID: ${cfg[key]}`);
  }
  // pipelineId is optional: empty means "resolve automatically" (ensurePipeline), not a config error.
  if (cfg.pipelineId && !isGuid(cfg.pipelineId))
    problems.push(`"pipelineId" is not a GUID: ${cfg.pipelineId}`);
  for (const [key, name] of Object.entries(cfg.parameterNames))
    if (!name) problems.push(`"parameterNames.${key}" is empty`);
  if (cfg.scopes.length === 0) problems.push('"scopes" is empty');
  if (cfg.pollIntervalMs < 250) problems.push('"pollIntervalMs" must be >= 250');
  return problems;
}

/** Returns human-readable problems on the `gatepulse.tenants` setting itself, before any tenant is picked. */
export function checkTenants(tenants: TenantEntry[]): string[] {
  const problems: string[] = [];
  if (tenants.length === 0) {
    problems.push('No tenant configured — add one to "gatepulse.tenants"');
    return problems;
  }
  const seenAlias = new Set<string>();
  for (const t of tenants) {
    const label = t.alias || '(no alias)';
    if (!t.alias) problems.push('A "gatepulse.tenants" entry has no "alias"');
    else if (seenAlias.has(t.alias.toLowerCase()))
      problems.push(`Duplicate tenant alias: "${t.alias}"`);
    else seenAlias.add(t.alias.toLowerCase());
    for (const key of ['tenantId', 'workspaceId'] as const) {
      if (!t[key]) problems.push(`Tenant "${label}": "${key}" is not set`);
      else if (!isGuid(t[key])) problems.push(`Tenant "${label}": "${key}" is not a GUID: ${t[key]}`);
    }
    for (const key of ['clientId', 'pipelineId', 'connectionGuid'] as const) {
      const v = t[key];
      if (v && !isGuid(v)) problems.push(`Tenant "${label}": "${key}" is not a GUID: ${v}`);
    }
  }
  return problems;
}
