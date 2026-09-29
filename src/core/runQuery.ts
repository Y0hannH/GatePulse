import { randomUUID } from 'crypto';

import { GatePulseError } from './errors';
import type { CheckStatus, ValidationCheck, ValidationPoint } from './logger';
import type { ExecuteOptions, QueryParams } from './pipelineRunner';
import type { ScenarioContext, ScenarioReport } from './scenarios';

const SEVERITY: CheckStatus[] = ['INFO', 'PASS', 'WARN', 'UNVERIFIED', 'FAIL'];

/**
 * Duplicated from scenarios.ts rather than imported: that file is frozen (V1-SCOPE.md §"CLI de
 * validation" — the P1-P4 scenarios are archived), this one is the live V1 product path. Nine
 * lines, pure, unlikely to ever need to diverge — not worth a shared import across that boundary.
 */
function aggregateVerdicts(checks: ValidationCheck[]): Partial<Record<ValidationPoint, CheckStatus>> {
  const out: Partial<Record<ValidationPoint, CheckStatus>> = {};
  for (const c of checks) {
    const current = out[c.point];
    if (!current || SEVERITY.indexOf(c.status) > SEVERITY.indexOf(current)) out[c.point] = c.status;
  }
  return out;
}

/**
 * Executes one ad hoc query — the panel's daily-use path (V1-SCOPE.md §4). Not a validation
 * scenario: `pipelineRunner.execute()` already emits its own per-run checks (silent truncation,
 * param binding, ...), this just wraps one run into the same `ScenarioReport` shape the panel and
 * `saveReport` already consume, without any of the frozen P1-P4 machinery.
 */
export async function runSingle(ctx: ScenarioContext, params: QueryParams): Promise<ScenarioReport> {
  const log = ctx.logger.child({ scenario: 'single' });
  const startedAt = new Date();
  const t0 = performance.now();
  log.info('run.start', 'Query run started');
  const onProgress: ExecuteOptions['onProgress'] = ctx.onProgress;
  const run = await ctx.runner.execute(params, {
    signal: ctx.signal,
    onProgress,
    runLabel: `single-${randomUUID().slice(0, 6)}`,
  });
  const wallClockMs = Math.round(performance.now() - t0);
  log.info('run.end', `Query run finished in ${(wallClockMs / 1000).toFixed(1)} s`);
  return {
    scenario: 'single',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs,
    runs: [run],
    checks: [],
    verdicts: aggregateVerdicts(run.checks),
  };
}

/** T-SQL: `sys.databases` enumerates every database on the instance regardless of which one the
 *  connection is currently pointed at — `state = 0` excludes offline/restoring/recovering ones. */
export const LIST_DATABASES_QUERY = 'SELECT name FROM sys.databases WHERE state = 0 ORDER BY name';

/**
 * Lists databases visible through a connection, for the panel's database picker (V1-SCOPE.md §4,
 * point D). `sys.databases` needs *some* initial catalog to connect through even though it lists
 * every database on the instance — `databaseNameHint` is whatever the user already typed (kept as
 * the connection context if non-empty), falling back to "master" otherwise. Unverified against a
 * SQL Server login with no access to master (same spirit as V1-SCOPE.md's other flagged
 * assumptions) — the panel's free-text database field remains the fallback if this fails.
 */
export async function listDatabases(
  ctx: ScenarioContext,
  connectionGuid: string,
  databaseNameHint: string,
): Promise<string[]> {
  const rows = await runDiscoveryQuery(
    ctx,
    { connectionGuid, databaseName: databaseNameHint.trim() || 'master', query: LIST_DATABASES_QUERY },
    'list-databases',
  );
  const names = rows.map((r) => r.name).filter((n): n is string => typeof n === 'string');
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Runs one query and throws GatePulseError with the run's own error on failure — shared shape for
 *  every "discover metadata" helper below (databases, schema objects, columns). */
async function runDiscoveryQuery(
  ctx: ScenarioContext,
  params: QueryParams,
  runLabelPrefix: string,
): Promise<Record<string, unknown>[]> {
  const report = await ctx.runner.execute(params, {
    signal: ctx.signal,
    runLabel: `${runLabelPrefix}-${randomUUID().slice(0, 6)}`,
  });
  if (!report.succeeded) {
    throw new GatePulseError(report.error?.kind ?? 'unexpected', report.error?.message ?? 'Query failed');
  }
  return report.activities.flatMap((a) => a.rows);
}

export interface SchemaObject {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

/** INFORMATION_SCHEMA is standard SQL — works the same across the databases of one SQL Server
 *  instance, unlike sys.databases which is instance-wide. Tables and views come back in one round
 *  trip (TABLE_TYPE distinguishes them) since each is a real pipeline run — worth minimizing. */
const LIST_SCHEMA_OBJECTS_QUERY =
  'SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS objectName, TABLE_TYPE AS objectType ' +
  'FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME';

/** Lists tables and views of one database, for the sidebar's schema tree (V1-SCOPE.md §4, point D). */
export async function listSchemaObjects(
  ctx: ScenarioContext,
  connectionGuid: string,
  databaseName: string,
): Promise<SchemaObject[]> {
  const rows = await runDiscoveryQuery(
    ctx,
    { connectionGuid, databaseName, query: LIST_SCHEMA_OBJECTS_QUERY },
    'list-objects',
  );
  return rows
    .map((r) => ({
      schema: String(r.schemaName ?? ''),
      name: String(r.objectName ?? ''),
      type: (String(r.objectType ?? '').toUpperCase().includes('VIEW') ? 'view' : 'table') as
        | 'table'
        | 'view',
    }))
    .filter((o) => o.schema && o.name);
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

/** Single-quotes in a schema/table name (rare, but SQL Server quoted identifiers allow it) doubled
 *  to stay a valid string literal — these values come from our own listSchemaObjects(), not raw
 *  user input, but escaping costs nothing and avoids a broken query either way. */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `]` in a bracketed T-SQL identifier (SQL Server quoted identifiers allow almost anything) must
 *  be doubled or it closes the identifier early — turning `[${name}]` built without escaping into
 *  arbitrary SQL. These names come from our own discovery queries, not raw user input, but the
 *  query they feed ("Select Top 100 Rows") is one click away from running via the history panel's
 *  ▶ button — escaping costs nothing and closes the gap either way. */
export function sqlIdentifier(value: string): string {
  return `[${value.replace(/]/g, ']]')}]`;
}

/** Lists one table/view's columns, for the sidebar's schema tree — lazy, one table at a time (never
 *  all tables' columns up front: that would be one pipeline run per table for nothing).  */
export async function listColumns(
  ctx: ScenarioContext,
  connectionGuid: string,
  databaseName: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const query =
    'SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType, IS_NULLABLE AS isNullable ' +
    `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${sqlStringLiteral(schema)} ` +
    `AND TABLE_NAME = ${sqlStringLiteral(table)} ORDER BY ORDINAL_POSITION`;
  const rows = await runDiscoveryQuery(ctx, { connectionGuid, databaseName, query }, 'list-columns');
  return rows.map((r) => ({
    name: String(r.columnName ?? ''),
    dataType: String(r.dataType ?? ''),
    nullable: String(r.isNullable ?? '').toUpperCase() === 'YES',
  }));
}
