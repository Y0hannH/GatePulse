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
  const report = await ctx.runner.execute(
    { connectionGuid, databaseName: databaseNameHint.trim() || 'master', query: LIST_DATABASES_QUERY },
    { signal: ctx.signal, runLabel: `list-databases-${randomUUID().slice(0, 6)}` },
  );
  if (!report.succeeded) {
    throw new GatePulseError(
      report.error?.kind ?? 'unexpected',
      report.error?.message ?? 'Could not list databases',
    );
  }
  const names = report.activities
    .flatMap((a) => a.rows)
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string');
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
