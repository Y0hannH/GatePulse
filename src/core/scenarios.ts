import { randomUUID } from 'crypto';

import type { GatePulseConfig } from './config';
import type { FabricClient } from './fabricClient';
import { parseFabricUtc } from './fabricClient';
import { findGuids, findStrings, structuralDiff } from './inspect';
import type { CheckStatus, Logger, ValidationCheck, ValidationPoint } from './logger';
import type {
  ActivityResult,
  ExecuteOptions,
  ExecutionReport,
  PipelineRunner,
  QueryParams,
} from './pipelineRunner';
import { LOOKUP_ROW_CAP } from './pipelineRunner';

export type ScenarioName = 'single' | 'latency' | 'rowcap' | 'size' | 'concurrency' | 'swap';

export interface ScenarioReport {
  scenario: ScenarioName;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  runs: ExecutionReport[];
  /** Scenario-level checks (per-run checks live in runs[].checks). */
  checks: ValidationCheck[];
  /** Worst status per validation point across scenario + per-run checks. */
  verdicts: Partial<Record<ValidationPoint, CheckStatus>>;
}

export interface ScenarioContext {
  cfg: GatePulseConfig;
  runner: PipelineRunner;
  client: FabricClient;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: ExecuteOptions['onProgress'];
}

const SEVERITY: CheckStatus[] = ['INFO', 'PASS', 'WARN', 'UNVERIFIED', 'FAIL'];

export function aggregateVerdicts(
  checks: ValidationCheck[],
): Partial<Record<ValidationPoint, CheckStatus>> {
  const out: Partial<Record<ValidationPoint, CheckStatus>> = {};
  for (const c of checks) {
    const current = out[c.point];
    if (!current || SEVERITY.indexOf(c.status) > SEVERITY.indexOf(current)) out[c.point] = c.status;
  }
  return out;
}

async function scenario(
  name: ScenarioName,
  ctx: ScenarioContext,
  body: (log: Logger, checks: ValidationCheck[]) => Promise<ExecutionReport[]>,
): Promise<ScenarioReport> {
  const log = ctx.logger.child({ scenario: name });
  const startedAt = new Date();
  const t0 = performance.now();
  log.info('scenario.start', `===== Scenario "${name}" started =====`);
  const checks: ValidationCheck[] = [];
  const runs = await body(log, checks);
  const all = [...checks, ...runs.flatMap((r) => r.checks)];
  const report: ScenarioReport = {
    scenario: name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs: Math.round(performance.now() - t0),
    runs,
    checks,
    verdicts: aggregateVerdicts(all),
  };
  log.info(
    'scenario.end',
    `===== Scenario "${name}" finished in ${(report.wallClockMs / 1000).toFixed(1)} s — verdicts: ${formatVerdicts(report.verdicts)} =====`,
  );
  return report;
}

export function formatVerdicts(v: Partial<Record<ValidationPoint, CheckStatus>>): string {
  return (
    (['P1', 'P2', 'P3', 'P4'] as ValidationPoint[])
      .filter((p) => v[p])
      .map((p) => `${p}=${v[p]}`)
      .join(' ') || 'none'
  );
}

const sec = (ms?: number) => (ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
const kb = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;
const failure = (r: ExecutionReport) => `[${r.error?.kind}] ${r.error?.message}`;
const activityFailure = (a: ActivityResult) => `[${a.errorKind}] ${a.error?.message ?? a.status}`;
/** Distinguishes an explicit Fabric failure from a Succeeded status that hides a lost result. */
const failureNature = (a: ActivityResult) =>
  a.silentFailure ? 'reports Succeeded but LOSES the result' : 'FAILS';

export function describe(values: number[]) {
  if (!values.length)
    return { n: 0 } as { n: number; min?: number; median?: number; max?: number; mean?: number };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    min: s[0],
    median: s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

// ------------------------------------------------------------------ single run

export function runSingle(ctx: ScenarioContext, params: QueryParams): Promise<ScenarioReport> {
  return scenario('single', ctx, async () => [
    await ctx.runner.execute(params, {
      signal: ctx.signal,
      onProgress: ctx.onProgress,
      runLabel: `single-${randomUUID().slice(0, 6)}`,
    }),
  ]);
}

// ------------------------------------------------------------------ P2: latency

export function runLatencyTest(
  ctx: ScenarioContext,
  conn: Omit<QueryParams, 'query'>,
): Promise<ScenarioReport> {
  const { latencyIterations, latencyQuery } = ctx.cfg.validation;
  return scenario('latency', ctx, async (log, checks) => {
    const runs: ExecutionReport[] = [];
    for (let i = 1; i <= latencyIterations; i++) {
      if (ctx.signal?.aborted) break;
      runs.push(
        await ctx.runner.execute(
          { ...conn, query: latencyQuery },
          { runLabel: `latency-${i}`, signal: ctx.signal, onProgress: ctx.onProgress },
        ),
      );
    }
    const ok = runs.filter((r) => r.succeeded);
    if (ok.length < runs.length) {
      checks.push(
        log.check({
          point: 'P2',
          name: 'LATENCY_RUNS',
          status: 'FAIL',
          message: `${runs.length - ok.length}/${runs.length} latency run(s) failed: ${runs
            .filter((r) => !r.succeeded)
            .map((r) => `${r.runLabel}: ${failure(r)}`)
            .join(' | ')}`,
        }),
      );
    }
    if (ok.length) {
      const keys = [
        'totalMs',
        'triggerMs',
        'waitMs',
        'resultMs',
        'fabricQueueMs',
        'fabricRunMs',
        'completionDetectionLagMs',
      ] as const;
      const stats: Record<string, ReturnType<typeof describe>> = Object.fromEntries(
        keys.map((k) => [
          k,
          describe(ok.map((r) => r.timings[k]).filter((v): v is number => typeof v === 'number')),
        ]),
      );
      const names = [...new Set(ok.flatMap((r) => Object.keys(r.timings.activityMs)))].sort();
      for (const name of names)
        stats[`activity:${name}`] = describe(
          ok
            .map((r) => r.timings.activityMs[name])
            .filter((v): v is number => typeof v === 'number'),
        );
      const total = stats.totalMs;
      checks.push(
        log.check({
          point: 'P2',
          name: 'LATENCY_SUMMARY',
          status: 'INFO',
          message: `"${latencyQuery}" x${ok.length}: TOTAL min ${sec(total.min)} / median ${sec(total.median)} / max ${sec(total.max)} — first run ${sec(ok[0].timings.totalMs)} (cold?) — median breakdown: trigger ${sec(stats.triggerMs.median)}, wait ${sec(stats.waitMs.median)} (Fabric queue ${sec(stats.fabricQueueMs.median)}, run ${sec(stats.fabricRunMs.median)}), result ${sec(stats.resultMs.median)} — activities (median): ${names.map((n) => `${n} ${sec(stats[`activity:${n}`].median)}`).join(', ')}`,
          evidence: stats,
        }),
      );
    }
    return runs;
  });
}

// ------------------------------------------------------------------ P1: row cap / payload size

/** Runs one query per size and lets `judge` emit a check per query activity. */
async function perSizeRuns(
  ctx: ScenarioContext,
  log: Logger,
  checks: ValidationCheck[],
  conn: Omit<QueryParams, 'query'>,
  opts: { sizes: number[]; template: string; label: string; checkName: string },
  judge: (
    n: number,
    r: ExecutionReport,
    a: ActivityResult,
  ) => Pick<ValidationCheck, 'status' | 'message'>,
): Promise<ExecutionReport[]> {
  const runs: ExecutionReport[] = [];
  for (const n of opts.sizes) {
    if (ctx.signal?.aborted) break;
    const r = await ctx.runner.execute(
      { ...conn, query: opts.template.replaceAll('{{n}}', String(n)) },
      { runLabel: `${opts.label}-${n}`, signal: ctx.signal, onProgress: ctx.onProgress },
    );
    runs.push(r);
    const base = {
      point: 'P1' as const,
      name: `${opts.checkName}_${n}`,
      runLabel: r.runLabel,
      jobInstanceId: r.jobInstanceId,
    };
    if (r.activities.length === 0) {
      checks.push(
        log.check({
          ...base,
          status: 'FAIL',
          message: `Requested ${n} rows → run failed before any activity result: ${failure(r)}`,
        }),
      );
      continue;
    }
    for (const a of r.activities) {
      const verdict = judge(n, r, a);
      checks.push(
        log.check({
          ...base,
          activity: a.activityName,
          ...verdict,
          message: `[${a.activityName}] ${verdict.message}`,
          evidence: {
            requested: n,
            returned: a.rows.length,
            reportedCount: a.reportedCount,
            outputBytes: a.outputBytes,
            error: a.error,
          },
        }),
      );
    }
  }
  return runs;
}

export function runRowCapTest(
  ctx: ScenarioContext,
  conn: Omit<QueryParams, 'query'>,
): Promise<ScenarioReport> {
  const { rowCapSizes, rowCountQueryTemplate } = ctx.cfg.validation;
  return scenario('rowcap', ctx, (log, checks) =>
    perSizeRuns(
      ctx,
      log,
      checks,
      conn,
      {
        sizes: rowCapSizes,
        template: rowCountQueryTemplate,
        label: 'rowcap',
        checkName: 'ROW_CAP',
      },
      (n, _r, a) => {
        const ok = a.succeeded;
        const got = a.rows.length;
        const size = `, output ${kb(a.outputBytes)}`;
        if (n <= LOOKUP_ROW_CAP) {
          return ok && got === n
            ? { status: 'PASS', message: `Requested ${n} rows → got ${got}${size}` }
            : {
                status: 'FAIL',
                message: `Requested ${n} rows (under cap) → ${ok ? `got ${got}` : `activity failed ${activityFailure(a)}`}`,
              };
        }
        if (!ok)
          return {
            status: 'WARN',
            message: `Requested ${n} rows (over ${LOOKUP_ROW_CAP}) → the activity ${failureNature(a)} rather than truncating: ${activityFailure(a)}`,
          };
        if (got === LOOKUP_ROW_CAP)
          return {
            status: 'WARN',
            message: `Requested ${n} rows (over ${LOOKUP_ROW_CAP}) → SILENTLY TRUNCATED to ${got} rows, no error${size}`,
          };
        if (got === n)
          return {
            status: 'INFO',
            message: `Requested ${n} rows (over ${LOOKUP_ROW_CAP}) → got all ${got} rows: no ${LOOKUP_ROW_CAP}-row cap${size}`,
          };
        return {
          status: 'WARN',
          message: `Requested ${n} rows (over ${LOOKUP_ROW_CAP}) → got ${got}: unexpected truncation${size}`,
        };
      },
    ),
  );
}

export function runSizeTest(
  ctx: ScenarioContext,
  conn: Omit<QueryParams, 'query'>,
): Promise<ScenarioReport> {
  const { sizeTestRows, sizeQueryTemplate } = ctx.cfg.validation;
  return scenario('size', ctx, (log, checks) =>
    perSizeRuns(
      ctx,
      log,
      checks,
      conn,
      {
        sizes: sizeTestRows,
        template: sizeQueryTemplate,
        label: 'size',
        checkName: 'PAYLOAD_SIZE',
      },
      (n, _r, a) => {
        if (a.succeeded) {
          return a.rows.length === n
            ? { status: 'INFO', message: `${n} rows returned, output ${kb(a.outputBytes)}` }
            : {
                status: 'WARN',
                message: `${n} rows requested, ${a.rows.length} returned (output ${kb(a.outputBytes)}): partial result`,
              };
        }
        return a.errorKind === 'resultTooLarge'
          ? {
              status: 'WARN',
              message: `${n} rows requested → activity ${failureNature(a)} on output size: ${a.error?.message}`,
            }
          : {
              status: 'FAIL',
              message: `${n} rows requested → activity failed for another reason: ${activityFailure(a)}`,
            };
      },
    ),
  );
}

// ------------------------------------------------------------------ P3: concurrency

export function runConcurrencyTest(
  ctx: ScenarioContext,
  conn: Omit<QueryParams, 'query'>,
): Promise<ScenarioReport> {
  const { concurrency, markerQueryTemplate } = ctx.cfg.validation;
  return scenario('concurrency', ctx, async (log, checks) => {
    const tags = Array.from(
      { length: concurrency },
      (_, i) => `gp${i + 1}_${randomUUID().slice(0, 8)}`,
    );
    log.info(
      'concurrency.launch',
      `Launching ${concurrency} runs simultaneously on the same pipeline item`,
      { tags },
    );
    const runs = await Promise.all(
      tags.map((tag, i) =>
        ctx.runner.execute(
          { ...conn, query: markerQueryTemplate.replaceAll('{{tag}}', tag) },
          { runLabel: `conc-${i + 1}`, signal: ctx.signal, onProgress: ctx.onProgress },
        ),
      ),
    );
    const check = (c: Omit<ValidationCheck, 'point'>) =>
      checks.push(log.check({ point: 'P3', ...c }));

    const failed = runs.filter((r) => !r.succeeded);
    check(
      failed.length === 0
        ? {
            name: 'ALL_SUCCEEDED',
            status: 'PASS',
            message: `${runs.length}/${runs.length} concurrent runs succeeded`,
          }
        : {
            name: 'ALL_SUCCEEDED',
            status: 'FAIL',
            message: `${failed.length}/${runs.length} concurrent run(s) failed: ${failed.map((r) => `${r.runLabel}: ${failure(r)}`).join(' | ')}`,
          },
    );

    const ids = runs.map((r) => r.jobInstanceId).filter(Boolean);
    check(
      new Set(ids).size === runs.length
        ? {
            name: 'DISTINCT_JOB_INSTANCES',
            status: 'PASS',
            message: `${runs.length} distinct job instance ids: ${ids.join(', ')}`,
          }
        : {
            name: 'DISTINCT_JOB_INSTANCES',
            status: 'FAIL',
            message: `Expected ${runs.length} distinct job instance ids, got: ${ids.join(', ') || 'none'}`,
          },
    );

    const deduped = runs.filter((r) => r.jobStatus === 'Deduped');
    if (deduped.length)
      check({
        name: 'NO_DEDUP',
        status: 'FAIL',
        message: `Fabric deduplicated ${deduped.length} run(s) (${deduped.map((r) => r.runLabel).join(', ')}): concurrent triggers on the same item are NOT all executed`,
      });

    tags.forEach((tag, i) => {
      const r = runs[i];
      const others = tags.filter((t) => t !== tag);
      for (const a of r.activities) {
        const ids = {
          runLabel: r.runLabel,
          jobInstanceId: r.jobInstanceId,
          activity: a.activityName,
        };
        const where = `${r.runLabel} [${a.activityName}]`;
        if (a.succeeded) {
          const ownInRows = findStrings(a.rows, (s) => s.includes(tag)).length > 0;
          const foreignInRows = others.filter(
            (o) => findStrings(a.rows, (s) => s.includes(o)).length > 0,
          );
          check(
            ownInRows && foreignInRows.length === 0
              ? {
                  ...ids,
                  name: 'RESULT_ISOLATION',
                  status: 'PASS',
                  message: `${where} result contains its own tag ${tag} and no other run's tag`,
                }
              : {
                  ...ids,
                  name: 'RESULT_ISOLATION',
                  status: 'FAIL',
                  message: `${where} result mismatch: own tag ${ownInRows ? 'present' : 'MISSING'}, foreign tags: ${foreignInRows.join(', ') || 'none'}`,
                  evidence: a.rows,
                },
          );
        }
        if (!a.inputAvailable) continue;
        const ownInInput = findStrings(a.input, (s) => s.includes(tag)).length > 0;
        const foreignInInput = others.filter(
          (o) => findStrings(a.input, (s) => s.includes(o)).length > 0,
        );
        check(
          ownInInput && foreignInInput.length === 0
            ? {
                ...ids,
                name: 'PARAM_ISOLATION',
                status: 'PASS',
                message: `${where} input carries its own query (tag ${tag}) only`,
              }
            : {
                ...ids,
                name: 'PARAM_ISOLATION',
                status: 'FAIL',
                message: `${where} input: own tag ${ownInInput ? 'present' : 'MISSING'}, foreign tags: ${foreignInInput.join(', ') || 'none'}`,
                evidence: a.input,
              },
        );
      }
    });

    // Did the runs really overlap inside Fabric, or were they queued one after another?
    const intervals = runs
      .map((r) => ({
        label: r.runLabel,
        start: parseFabricUtc(r.timings.jobStartUtc)?.getTime(),
        end: parseFabricUtc(r.timings.jobEndUtc)?.getTime(),
      }))
      .filter(
        (x): x is { label: string; start: number; end: number } =>
          x.start !== undefined && x.end !== undefined,
      );
    if (intervals.length >= 2) {
      const maxOverlap = maxConcurrent(intervals);
      const detail = intervals
        .map(
          (x) =>
            `${x.label} ${new Date(x.start).toISOString().slice(11, 23)}→${new Date(x.end).toISOString().slice(11, 23)}`,
        )
        .join(', ');
      const queues = runs.map((r) => `${r.runLabel}=${sec(r.timings.fabricQueueMs)}`).join(', ');
      check(
        maxOverlap === intervals.length
          ? {
              name: 'TRUE_PARALLELISM',
              status: 'PASS',
              message: `All ${intervals.length} runs executed simultaneously in Fabric (${detail}); queue: ${queues}`,
            }
          : {
              name: 'TRUE_PARALLELISM',
              status: 'WARN',
              message: `Max ${maxOverlap} run(s) overlapped out of ${intervals.length}: Fabric partly serialized them (${detail}); queue: ${queues}. Isolation verdict holds, but latency under concurrency will stack.`,
            },
      );
    } else {
      check({
        name: 'TRUE_PARALLELISM',
        status: 'UNVERIFIED',
        message: 'Not enough Fabric start/end timestamps to assess overlap',
      });
    }
    return runs;
  });
}

function maxConcurrent(intervals: { start: number; end: number }[]): number {
  const events = intervals
    .flatMap((i) => [
      { t: i.start, d: 1 },
      { t: i.end, d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  for (const e of events) max = Math.max(max, (cur += e.d));
  return max;
}

// ------------------------------------------------------------------ P4: connection swap

export function runSwapTest(
  ctx: ScenarioContext,
  primary: Omit<QueryParams, 'query'>,
): Promise<ScenarioReport> {
  const v = ctx.cfg.validation;
  return scenario('swap', ctx, async (log, checks) => {
    const check = (c: Omit<ValidationCheck, 'point'>) =>
      checks.push(log.check({ point: 'P4', ...c }));
    const exec = (label: string, p: Omit<QueryParams, 'query'>) =>
      ctx.runner.execute(
        { ...p, query: v.identityQuery },
        { runLabel: label, signal: ctx.signal, onProgress: ctx.onProgress },
      );
    const runs: ExecutionReport[] = [];

    /** One check per activity of `r`, or a run-level check when no activity result exists. */
    const connectionCheck = (name: string, r: ExecutionReport, guid: string) => {
      if (r.activities.length === 0) {
        check({
          name,
          status: 'FAIL',
          runLabel: r.runLabel,
          jobInstanceId: r.jobInstanceId,
          message: `Connection ${guid} failed via API before any activity result: ${failure(r)}`,
        });
        return;
      }
      for (const a of r.activities) {
        const ids = {
          name,
          runLabel: r.runLabel,
          jobInstanceId: r.jobInstanceId,
          activity: a.activityName,
        };
        check(
          a.succeeded
            ? {
                ...ids,
                status: 'PASS',
                message: `[${a.activityName}] connection ${guid} answered: ${JSON.stringify(a.rows[0])}`,
              }
            : {
                ...ids,
                status: 'FAIL',
                message: `[${a.activityName}] connection ${guid} failed via API: ${activityFailure(a)}`,
              },
        );
      }
    };

    // A: primary connection
    const a = await exec('swap-A-primary', primary);
    runs.push(a);
    connectionCheck('PRIMARY_CONNECTION', a, primary.connectionGuid);

    // B: alternate connection, same pipeline item, only the parameter changes
    if (v.alternateConnectionGuid) {
      const b = await exec('swap-B-alternate', {
        connectionGuid: v.alternateConnectionGuid,
        databaseName: v.alternateDatabaseName || primary.databaseName,
      });
      runs.push(b);
      connectionCheck('ALTERNATE_CONNECTION', b, v.alternateConnectionGuid);
      for (const aa of a.activities) {
        const ba = b.activities.find((x) => x.activityName === aa.activityName);
        if (!ba || !aa.succeeded || !ba.succeeded) continue;
        const same = JSON.stringify(aa.rows) === JSON.stringify(ba.rows);
        check(
          same
            ? {
                name: 'IDENTITY_DIFFERS',
                activity: aa.activityName,
                status: 'WARN',
                message: `[${aa.activityName}] both connections returned the SAME identity row: same server/database, or the GUID swap is not effective`,
                evidence: aa.rows,
              }
            : {
                name: 'IDENTITY_DIFFERS',
                activity: aa.activityName,
                status: 'PASS',
                message: `[${aa.activityName}] swapping only the connectionGuid parameter changed the server/database that answered`,
                evidence: { A: aa.rows, B: ba.rows },
              },
        );
      }
    } else {
      check({
        name: 'ALTERNATE_CONNECTION',
        status: 'UNVERIFIED',
        message:
          'No validation.alternateConnectionGuid configured: swap between two real connections not tested (only the bogus-GUID control below)',
      });
    }

    // C: negative control. If a non-existent GUID still succeeds, the parameter is ignored.
    const bogus = randomUUID();
    const c = await exec('swap-C-bogus-guid', {
      connectionGuid: bogus,
      databaseName: primary.databaseName,
    });
    runs.push(c);
    if (c.activities.length === 0) {
      check(
        c.succeeded
          ? {
              name: 'NEGATIVE_CONTROL',
              status: 'FAIL',
              runLabel: c.runLabel,
              message: `Bogus GUID ${bogus} produced a successful run`,
            }
          : {
              name: 'NEGATIVE_CONTROL',
              status: c.error?.kind === 'connection' ? 'PASS' : 'WARN',
              runLabel: c.runLabel,
              jobInstanceId: c.jobInstanceId,
              message: `Bogus GUID ${bogus} failed: ${failure(c)}`,
            },
      );
    }
    for (const ca of c.activities) {
      const ids = {
        name: 'NEGATIVE_CONTROL',
        runLabel: c.runLabel,
        jobInstanceId: c.jobInstanceId,
        activity: ca.activityName,
      };
      if (ca.succeeded) {
        check({
          ...ids,
          status: 'FAIL',
          message: `[${ca.activityName}] a NON-EXISTENT connection GUID (${bogus}) produced a successful result: the connectionGuid passed via API is IGNORED at runtime`,
          evidence: ca.rows,
        });
      } else if (ca.errorKind === 'connection') {
        check({
          ...ids,
          status: 'PASS',
          message: `[${ca.activityName}] bogus GUID rejected with a connection error → the GUID parameter is really resolved at runtime: ${ca.error?.message}`,
        });
      } else {
        check({
          ...ids,
          status: 'WARN',
          message: `[${ca.activityName}] bogus GUID failed, but not with a recognised connection error (${activityFailure(ca)}) — check the message manually`,
        });
      }
    }

    // D: optional diff against a run triggered manually in the Fabric UI.
    if (v.referenceUiJobInstanceId && a.activities.length) {
      try {
        const ref = await ctx.client.getJobInstance(v.referenceUiJobInstanceId);
        const since = parseFabricUtc(ref.body.startTimeUtc) ?? new Date(Date.now() - 24 * 3600_000);
        // activityNames: [] → read whatever query activities the (possibly older) UI run has.
        const refResult = await ctx.runner.getResult(v.referenceUiJobInstanceId, since, {
          log,
          until: parseFabricUtc(ref.body.endTimeUtc),
          activityNames: [],
        });
        const connPaths = (x: unknown) =>
          findGuids(x)
            .filter((g) => /connection|externalreference/i.test(g.path))
            .map((g) => g.path)
            .sort();
        for (const apiAct of a.activities) {
          const refAct = refResult.activities.find((x) => x.activityName === apiAct.activityName);
          if (!refAct) {
            check({
              name: 'UI_VS_API',
              activity: apiAct.activityName,
              status: 'INFO',
              message: `[${apiAct.activityName}] not present in UI reference run ${v.referenceUiJobInstanceId} (activity added after that run): trigger a new UI run and update validation.referenceUiJobInstanceId to compare it`,
            });
            continue;
          }
          const diff = structuralDiff(refAct.input, apiAct.input);
          const refPaths = connPaths(refAct.input);
          const apiPaths = connPaths(apiAct.input);
          const identical =
            diff.onlyInA.length === 0 &&
            diff.onlyInB.length === 0 &&
            JSON.stringify(refPaths) === JSON.stringify(apiPaths);
          check(
            identical
              ? {
                  name: 'UI_VS_API',
                  activity: apiAct.activityName,
                  status: 'PASS',
                  message: `[${apiAct.activityName}] API run input has the same structure as UI run ${v.referenceUiJobInstanceId} (connection GUID at: ${apiPaths.join(', ') || 'not visible'})`,
                }
              : {
                  name: 'UI_VS_API',
                  activity: apiAct.activityName,
                  status: refPaths.length > 0 && apiPaths.length === 0 ? 'FAIL' : 'WARN',
                  message: `[${apiAct.activityName}] input differs between UI run and API run — only in UI: [${diff.onlyInA.join(', ')}], only in API: [${diff.onlyInB.join(', ')}], connection GUID paths UI=[${refPaths.join(', ')}] API=[${apiPaths.join(', ')}]`,
                  evidence: { uiInput: refAct.input, apiInput: apiAct.input },
                },
          );
        }
      } catch (err) {
        check({
          name: 'UI_VS_API',
          status: 'UNVERIFIED',
          message: `Could not read reference UI run ${v.referenceUiJobInstanceId}: ${(err as Error).message}`,
        });
      }
    }
    return runs;
  });
}
