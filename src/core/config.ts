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

export interface GatePulseConfig {
  tenantId: string;
  /** Optional. Empty = Microsoft first-party public client (no app registration needed). */
  clientId: string;
  workspaceId: string;
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

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID_RE.test(value.trim());
}

/** Returns human-readable problems; empty array = config usable. */
export function checkConfig(cfg: GatePulseConfig): string[] {
  const problems: string[] = [];
  if (cfg.clientId && !isGuid(cfg.clientId))
    problems.push(`"clientId" is not a GUID: ${cfg.clientId}`);
  for (const key of ['tenantId', 'workspaceId', 'pipelineId'] as const) {
    if (!cfg[key]) problems.push(`"${key}" is not set`);
    else if (!isGuid(cfg[key])) problems.push(`"${key}" is not a GUID: ${cfg[key]}`);
  }
  for (const [key, name] of Object.entries(cfg.parameterNames))
    if (!name) problems.push(`"parameterNames.${key}" is empty`);
  if (cfg.scopes.length === 0) problems.push('"scopes" is empty');
  if (cfg.pollIntervalMs < 250) problems.push('"pollIntervalMs" must be >= 250');
  return problems;
}
