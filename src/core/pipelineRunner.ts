import { randomUUID } from 'crypto';

import type { GatePulseConfig } from './config';
import type { ErrorKind, SerializedError } from './errors';
import { classifyActivityError, GatePulseError, serializeError } from './errors';
import type { ActivityRun, FabricClient, JobInstance } from './fabricClient';
import { parseFabricUtc, sleep } from './fabricClient';
import {
  findGuids,
  findStrings,
  normalizeSql,
  summarizeActivityRun,
  typeSkeleton,
} from './inspect';
import type { Logger, ValidationCheck } from './logger';

export const LOOKUP_ROW_CAP = 5000;

/** Activity types able to return a query result to the pipeline run output. */
export const QUERY_ACTIVITY_TYPES = ['Lookup', 'Script'];

export interface QueryParams {
  connectionGuid: string;
  databaseName: string;
  query: string;
}

export type Phase = 'auth' | 'triggering' | 'waiting' | 'fetchingResult' | 'done' | 'failed';

export interface ProgressEvent {
  runLabel: string;
  phase: Phase;
  message: string;
  jobInstanceId?: string;
  jobStatus?: string;
  pollCount?: number;
  elapsedMs: number;
}

export interface ExecuteOptions {
  runLabel?: string;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}

/** Result of one query activity (Lookup or Script) of a pipeline run. */
export interface ActivityResult {
  activityName: string;
  activityType: string;
  activityRunId: string;
  pipelineRunId: string;
  /** Status reported by Fabric. */
  status: string;
  /**
   * Fabric status Succeeded AND a usable result. A Script activity can report Succeeded while returning
   * no rows (outputTruncated=true, or an "Object size exceeds limit" placeholder): that is NOT a success.
   */
  succeeded: boolean;
  /** Set when Fabric said Succeeded but the result is unusable (see `succeeded`). */
  silentFailure?: string;
  /** False when Fabric replaced the activity run input by a size-limit placeholder. */
  inputAvailable: boolean;
  durationInMs?: number;
  activityRunStart?: string;
  activityRunEnd?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** output.count (Lookup) or resultSets[0].rowCount (Script). */
  reportedCount?: number;
  /** Lookup only: firstRowOnly=true. */
  firstRowOnly: boolean;
  /** Script only: number of result sets returned. */
  resultSetCount?: number;
  outputKeys: string[];
  outputBytes: number;
  input: unknown;
  error?: ActivityRun['error'];
  errorKind?: ErrorKind;
  /** Everything except input/output — integrationRuntimeNames, executionDetails... */
  runMetadata: Record<string, unknown>;
}

export interface RunTimings {
  /** Token acquisition (excluded from totalMs: interactive sign-in would skew the figure). */
  authMs?: number;
  /** POST jobs/instances round-trip. */
  triggerMs?: number;
  /** From 202 received until a terminal job status was observed by polling. */
  waitMs?: number;
  /** queryactivityruns round-trip(s) until all query activity outputs were available. */
  resultMs?: number;
  /** Trigger sent → result available. The end-to-end figure users experience. */
  totalMs?: number;
  pollCount: number;
  resultAttempts: number;
  /** Fabric-side view (server timestamps; subject to clock skew with this machine). */
  fabricQueueMs?: number;
  fabricRunMs?: number;
  /** durationInMs per query activity name. */
  activityMs: Record<string, number>;
  /** Observed completion minus Fabric endTimeUtc: polling granularity + status propagation delay. */
  completionDetectionLagMs?: number;
  triggerSentAt?: string;
  triggerAcceptedAt?: string;
  completionObservedAt?: string;
  resultAvailableAt?: string;
  jobStartUtc?: string;
  jobEndUtc?: string;
}

export interface ExecutionReport {
  runLabel: string;
  params: QueryParams;
  /** Job Completed and every query activity Succeeded. */
  succeeded: boolean;
  jobInstanceId?: string;
  jobStatus?: string;
  job?: JobInstance;
  /** One entry per query activity (Lookup / Script), in pipeline order of name. */
  activities: ActivityResult[];
  responseShape?: string;
  timings: RunTimings;
  checks: ValidationCheck[];
  /** First failure (auth, trigger, timeout… or the first failed activity). */
  error?: SerializedError;
  evidence: {
    triggerRequestBody?: unknown;
    triggerResponseHeaders?: Record<string, string>;
  };
}

/**
 * The three primitives from the brief (runQuery / pollJobStatus / getResult) plus `execute`,
 * which chains them with timing and per-run validation checks.
 */
export class PipelineRunner {
  constructor(
    private readonly cfg: GatePulseConfig,
    private readonly client: FabricClient,
    private readonly getToken: () => Promise<string>,
    private readonly logger: Logger,
  ) {}

  /** Triggers the pipeline and returns the job instance id. */
  async runQuery(params: QueryParams, log = this.logger, signal?: AbortSignal) {
    const names = this.cfg.parameterNames;
    const parameters = {
      [names.connectionGuid]: params.connectionGuid,
      [names.databaseName]: params.databaseName,
      [names.query]: params.query,
    };
    log.info(
      'job.trigger.request',
      `POST jobs/instances?jobType=Pipeline (payload format: ${this.cfg.parameterPayloadFormat})`,
      { parameters },
    );
    const res = await this.client.runPipelineJob(parameters, signal);
    log.info(
      'job.trigger.accepted',
      `Job instance ${res.jobInstanceId} accepted in ${res.http.durationMs} ms (Retry-After: ${res.retryAfterSec ?? 'n/a'}s)`,
      {
        location: res.location,
        requestId: res.http.requestId,
      },
    );
    return res;
  }

  /** Polls the job instance until a terminal status, the timeout, or cancellation. */
  async pollJobStatus(
    jobInstanceId: string,
    opts: {
      log?: Logger;
      signal?: AbortSignal;
      onPoll?: (job: JobInstance, pollCount: number) => void;
    } = {},
  ): Promise<{ job: JobInstance; pollCount: number }> {
    const log = opts.log ?? this.logger;
    const deadline = performance.now() + this.cfg.timeoutMs;
    let pollCount = 0;
    let lastStatus = '';
    while (true) {
      if (performance.now() > deadline) {
        log.error(
          'job.timeout',
          `Job ${jobInstanceId} not finished after ${this.cfg.timeoutMs} ms (last status: ${lastStatus}); cancelling it`,
        );
        await this.client
          .cancelJobInstance(jobInstanceId)
          .catch((e) => log.warn('job.cancel.failed', `Cancel failed: ${(e as Error).message}`));
        throw new GatePulseError(
          'timeout',
          `Job did not complete within ${Math.round(this.cfg.timeoutMs / 1000)} s (last status: ${lastStatus || 'unknown'})`,
          { jobInstanceId },
        );
      }
      let job: JobInstance;
      try {
        await sleep(this.cfg.pollIntervalMs, opts.signal);
        job = (await this.client.getJobInstance(jobInstanceId, opts.signal)).body;
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          log.warn('job.cancel', `Cancellation requested; cancelling job ${jobInstanceId}`);
          await this.client
            .cancelJobInstance(jobInstanceId)
            .catch((e) => log.warn('job.cancel.failed', `Cancel failed: ${(e as Error).message}`));
        }
        throw err;
      }
      pollCount++;
      opts.onPoll?.(job, pollCount);
      if (job.status !== lastStatus) {
        log.info(
          'job.status',
          `Status ${lastStatus || '(start)'} -> ${job.status} (poll #${pollCount})`,
          job.status === 'Failed' ? { failureReason: job.failureReason } : undefined,
        );
        lastStatus = job.status;
      }
      if (['Completed', 'Failed', 'Cancelled', 'Deduped'].includes(job.status))
        return { job, pollCount };
    }
  }

  /** Reads every query activity run (Lookup / Script: input + output) through queryactivityruns. */
  async getResult(
    jobInstanceId: string,
    since: Date,
    /** activityNames overrides cfg.activityNames (e.g. [] for an older run that predates an activity). */
    opts: { log?: Logger; signal?: AbortSignal; until?: Date; activityNames?: string[] } = {},
  ): Promise<{ activities: ActivityResult[]; shape: string; attempts: number }> {
    const log = opts.log ?? this.logger;
    const names = opts.activityNames ?? this.cfg.activityNames;
    const after = new Date(since.getTime() - 10 * 60_000);
    let lastSeen: string[] = [];
    for (let attempt = 1; attempt <= this.cfg.resultFetchRetries; attempt++) {
      const before = new Date((opts.until?.getTime() ?? Date.now()) + 10 * 60_000);
      const { runs, shape, http } = await this.client.queryActivityRuns(
        jobInstanceId,
        after,
        before,
        opts.signal,
      );
      lastSeen = runs.map((r) => `${r.activityName}<${r.activityType}>:${r.status}`);
      log.info(
        'result.activityRuns',
        `queryactivityruns attempt ${attempt}: HTTP ${http.status}, shape=${shape}, ${runs.length} activity run(s) [${lastSeen.join(', ')}] (${http.durationMs} ms)`,
      );
      if (shape === 'unknown')
        log.error('result.unexpectedShape', 'queryactivityruns returned an unexpected body', {
          body: http.body,
        });

      const wanted = runs
        .filter((r) =>
          names.length
            ? names.includes(r.activityName)
            : QUERY_ACTIVITY_TYPES.includes(r.activityType),
        )
        .sort((a, b) => a.activityName.localeCompare(b.activityName));
      const missingNamed = names.filter((n) => !wanted.some((r) => r.activityName === n));
      const allTerminal =
        wanted.length > 0 &&
        missingNamed.length === 0 &&
        wanted.every((r) => ['Succeeded', 'Failed', 'Cancelled', 'Skipped'].includes(r.status));
      if (!allTerminal) {
        if (attempt < this.cfg.resultFetchRetries) {
          log.warn(
            'result.notReady',
            `Query activity runs not all available yet (attempt ${attempt}/${this.cfg.resultFetchRetries}); retrying in ${this.cfg.resultFetchDelayMs} ms`,
          );
          await sleep(this.cfg.resultFetchDelayMs, opts.signal);
        }
        continue;
      }

      for (const run of wanted) {
        if (run.pipelineRunId && run.pipelineRunId.toLowerCase() !== jobInstanceId.toLowerCase()) {
          log.error(
            'result.runIdMismatch',
            `${run.activityName} belongs to pipelineRunId ${run.pipelineRunId}, expected ${jobInstanceId}`,
          );
        }
        // The exact structure returned by the API, as requested (rows truncated to keep logs readable).
        log.info(
          'result.rawStructure',
          `${run.activityName} <${run.activityType}> activity run structure (shape=${shape})`,
          {
            typeSkeleton: typeSkeleton(run),
            sample: summarizeActivityRun(run, 3),
          },
        );
      }
      return {
        activities: wanted.map((r) => this.parseActivity(r, log)),
        shape,
        attempts: attempt,
      };
    }
    throw new GatePulseError(
      'resultRetrieval',
      `Query activity runs not all terminal after ${this.cfg.resultFetchRetries} queryactivityruns attempts (seen: ${lastSeen.join(', ') || 'nothing'})`,
      { jobInstanceId },
    );
  }

  private parseActivity(run: ActivityRun, log: Logger): ActivityResult {
    const output = (run.output ?? {}) as Record<string, unknown>;
    let rows: Record<string, unknown>[] = [];
    let firstRowOnly = false;
    let reportedCount: number | undefined;
    let resultSetCount: number | undefined;
    let silentFailure: string | undefined;
    // When the activity run object is too large for the monitoring API, Fabric replaces input and output
    // by { errorMessage: "Warning: Object size exceeds limit..." } while keeping status Succeeded.
    const placeholder =
      typeof output.errorMessage === 'string' &&
      output.errorMessage &&
      !('resultSets' in output) &&
      !('value' in output)
        ? output.errorMessage
        : undefined;
    const inputAvailable = !(
      run.input &&
      typeof run.input === 'object' &&
      'errorMessage' in run.input &&
      Object.keys(run.input).length === 1
    );

    if (placeholder) {
      if (run.status === 'Succeeded')
        silentFailure = `Fabric reports Succeeded but replaced the activity output by: "${placeholder}" — no rows available through the API`;
    } else if (run.activityType === 'Script') {
      const sets = Array.isArray(output.resultSets)
        ? (output.resultSets as { rowCount?: number; rows?: Record<string, unknown>[] }[])
        : undefined;
      if (sets) {
        resultSetCount =
          typeof output.resultSetCount === 'number' ? output.resultSetCount : sets.length;
        rows = sets[0]?.rows ?? [];
        reportedCount = sets[0]?.rowCount;
        if (sets.length > 1)
          log.warn(
            'result.multipleResultSets',
            `${run.activityName} returned ${sets.length} result sets; only the first one is used`,
          );
        if (output.outputTruncated === true && run.status === 'Succeeded') {
          silentFailure = `Fabric reports Succeeded but outputTruncated=true (resultSetCount=${resultSetCount}, ${rows.length} row(s) kept): the result was dropped for exceeding the Script output limit`;
        }
      } else if (run.status === 'Succeeded') {
        log.error(
          'result.unexpectedOutput',
          `${run.activityName} (Script) succeeded but output has no "resultSets" (keys: ${Object.keys(output).join(', ') || 'none'})`,
          { output },
        );
      }
    } else if (Array.isArray(output.value)) {
      rows = output.value as Record<string, unknown>[];
      reportedCount = typeof output.count === 'number' ? output.count : undefined;
    } else if (output.firstRow && typeof output.firstRow === 'object') {
      rows = [output.firstRow as Record<string, unknown>];
      firstRowOnly = true;
    } else if (run.status === 'Succeeded') {
      log.error(
        'result.unexpectedOutput',
        `${run.activityName} (Lookup) succeeded but output has neither "value" nor "firstRow" (keys: ${Object.keys(output).join(', ') || 'none'})`,
        { output },
      );
    }

    const columns: string[] = [];
    for (const row of rows)
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    if (silentFailure) log.error('result.silentFailure', `${run.activityName}: ${silentFailure}`);
    const { input, output: _o, ...runMetadata } = run;
    const failed = run.status !== 'Succeeded' || silentFailure !== undefined;
    const error = silentFailure
      ? { errorCode: 'SilentOutputLoss', message: silentFailure }
      : run.error;
    return {
      activityName: run.activityName,
      activityType: run.activityType,
      activityRunId: run.activityRunId,
      pipelineRunId: run.pipelineRunId,
      status: run.status,
      succeeded: !failed,
      silentFailure,
      inputAvailable,
      durationInMs: run.durationInMs,
      activityRunStart: run.activityRunStart,
      activityRunEnd: run.activityRunEnd,
      columns,
      rows,
      reportedCount,
      firstRowOnly,
      resultSetCount,
      outputKeys: Object.keys(output),
      outputBytes: Buffer.byteLength(JSON.stringify(run.output ?? null)),
      input,
      error: failed ? error : undefined,
      errorKind: failed ? classifyActivityError(error?.message ?? '', error?.errorCode) : undefined,
      runMetadata,
    };
  }

  /** Full round-trip with timings, error classification and per-run validation checks. */
  async execute(params: QueryParams, opts: ExecuteOptions = {}): Promise<ExecutionReport> {
    const runLabel = opts.runLabel ?? `run-${randomUUID().slice(0, 8)}`;
    const log = this.logger.child({ run: runLabel });
    const report: ExecutionReport = {
      runLabel,
      params,
      succeeded: false,
      activities: [],
      timings: { pollCount: 0, resultAttempts: 0, activityMs: {} },
      checks: [],
      evidence: {},
    };
    const t = report.timings;
    const clockStart = performance.now();
    const progress = (phase: Phase, message: string, extra: Partial<ProgressEvent> = {}) =>
      opts.onProgress?.({
        runLabel,
        phase,
        message,
        elapsedMs: Math.round(performance.now() - clockStart),
        jobInstanceId: report.jobInstanceId,
        ...extra,
      });

    try {
      progress('auth', 'Acquiring Fabric token');
      const authStart = performance.now();
      await this.getToken();
      t.authMs = Math.round(performance.now() - authStart);

      // 1. trigger
      progress('triggering', 'Triggering pipeline job');
      const triggerSentWall = new Date();
      t.triggerSentAt = triggerSentWall.toISOString();
      const tTrigger = performance.now();
      const triggered = await this.runQuery(params, log, opts.signal);
      const tAccepted = performance.now();
      t.triggerMs = Math.round(tAccepted - tTrigger);
      t.triggerAcceptedAt = new Date().toISOString();
      report.jobInstanceId = triggered.jobInstanceId;
      report.evidence.triggerRequestBody = triggered.requestBody;
      report.evidence.triggerResponseHeaders = triggered.http.headers;
      report.checks.push(
        log.check({
          point: 'P1',
          name: 'API_TRIGGER',
          status: 'PASS',
          runLabel,
          jobInstanceId: triggered.jobInstanceId,
          message: `Pipeline job started via REST API (HTTP 202) in ${t.triggerMs} ms — job ${triggered.jobInstanceId}`,
        }),
      );

      // 2. wait
      progress('waiting', 'Waiting for job completion', { jobStatus: 'NotStarted', pollCount: 0 });
      const { job, pollCount } = await this.pollJobStatus(triggered.jobInstanceId, {
        log,
        signal: opts.signal,
        onPoll: (j, n) =>
          progress('waiting', `Job ${j.status}`, { jobStatus: j.status, pollCount: n }),
      });
      const completionObserved = performance.now();
      t.waitMs = Math.round(completionObserved - tAccepted);
      t.completionObservedAt = new Date().toISOString();
      t.pollCount = pollCount;
      report.job = job;
      report.jobStatus = job.status;
      this.fillFabricTimings(report, triggerSentWall);

      if (job.status === 'Deduped') {
        throw new GatePulseError(
          'deduped',
          'Fabric deduplicated this job instance (status Deduped): it was NOT executed',
          { jobInstanceId: job.id, raw: job },
        );
      }
      if (job.status === 'Cancelled')
        throw new GatePulseError('cancelled', 'Job was cancelled', { jobInstanceId: job.id });

      // 3. results (also fetched on failure: activity errors carry the SQL / connection / size message)
      progress('fetchingResult', 'Fetching activity outputs (queryactivityruns)', {
        jobStatus: job.status,
      });
      try {
        const res = await this.getResult(job.id, triggerSentWall, { log, signal: opts.signal });
        report.activities = res.activities;
        report.responseShape = res.shape;
        t.resultAttempts = res.attempts;
      } catch (err) {
        if (job.status === 'Completed') {
          report.checks.push(
            log.check({
              point: 'P1',
              name: 'API_RESULT',
              status: 'FAIL',
              runLabel,
              jobInstanceId: job.id,
              message: `Job Completed but its activity outputs could NOT be retrieved via API: ${(err as Error).message}`,
            }),
          );
          throw err;
        }
        log.warn(
          'result.unavailableAfterFailure',
          `Could not read activity runs of failed job: ${(err as Error).message}`,
        );
      }
      const tResult = performance.now();
      t.resultMs = Math.round(tResult - completionObserved);
      t.resultAvailableAt = new Date().toISOString();
      t.totalMs = Math.round(tResult - tTrigger);
      for (const a of report.activities)
        if (a.durationInMs !== undefined) t.activityMs[a.activityName] = a.durationInMs;

      const failedActivity = report.activities.find((a) => !a.succeeded);
      if (job.status === 'Failed' || failedActivity) {
        const message =
          failedActivity?.error?.message ||
          job.failureReason?.message ||
          'Pipeline failed without error message';
        const errorCode = failedActivity?.error?.errorCode || job.failureReason?.errorCode;
        const kind = failedActivity?.errorKind ?? classifyActivityError(message, errorCode);
        const others = report.activities
          .filter((a) => !a.succeeded && a !== failedActivity)
          .map((a) => `${a.activityName}: [${a.errorKind}]`);
        throw new GatePulseError(
          kind,
          `${failedActivity ? `[${failedActivity.activityName}] ` : ''}${message}${others.length ? ` (also failed: ${others.join(', ')})` : ''}`,
          {
            errorCode,
            jobInstanceId: job.id,
            raw: {
              jobFailureReason: job.failureReason,
              activityErrors: Object.fromEntries(
                report.activities.filter((a) => a.error).map((a) => [a.activityName, a.error]),
              ),
            },
          },
        );
      }

      report.succeeded = true;
      progress(
        'done',
        `${report.activities.map((a) => `${a.activityName}: ${a.rows.length} row(s)`).join(', ')} in ${(t.totalMs / 1000).toFixed(1)} s`,
        { jobStatus: job.status },
      );
    } catch (err) {
      report.error = serializeError(err);
      if (report.error.kind === 'cancelled' && report.jobInstanceId)
        report.error.jobInstanceId = report.jobInstanceId;
      log.error('run.failed', `[${report.error.kind}] ${report.error.message}`, report.error.raw);
      progress('failed', report.error.message, { jobStatus: report.jobStatus });
    } finally {
      report.checks.push(...this.perRunChecks(report, log));
    }
    return report;
  }

  private fillFabricTimings(report: ExecutionReport, triggerSentWall: Date): void {
    const t = report.timings;
    const start = parseFabricUtc(report.job?.startTimeUtc);
    const end = parseFabricUtc(report.job?.endTimeUtc);
    t.jobStartUtc = start?.toISOString();
    t.jobEndUtc = end?.toISOString();
    if (start) t.fabricQueueMs = start.getTime() - triggerSentWall.getTime();
    if (start && end) t.fabricRunMs = end.getTime() - start.getTime();
    if (end && t.completionObservedAt)
      t.completionDetectionLagMs = new Date(t.completionObservedAt).getTime() - end.getTime();
  }

  private perRunChecks(report: ExecutionReport, log: Logger): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const base = { runLabel: report.runLabel, jobInstanceId: report.jobInstanceId };
    const push = (c: Omit<ValidationCheck, 'runLabel' | 'jobInstanceId'>) =>
      checks.push(log.check({ ...base, ...c }));
    const { timings: t, params } = report;
    const s = (ms?: number) => (ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);

    // ---- P2: latency breakdown (always logged, even on failure)
    if (t.triggerMs !== undefined) {
      const perActivity = Object.entries(t.activityMs)
        .map(([name, ms]) => `${name} ${s(ms)}`)
        .join(', ');
      push({
        point: 'P2',
        name: 'LATENCY',
        status: 'INFO',
        message: `trigger ${s(t.triggerMs)} | wait ${s(t.waitMs)} (Fabric queue ${s(t.fabricQueueMs)}, Fabric run ${s(t.fabricRunMs)}, ${perActivity || 'no activity timing'}, detection lag ${s(t.completionDetectionLagMs)}, ${t.pollCount} polls) | result ${s(t.resultMs)} (${t.resultAttempts} attempt(s)) | TOTAL ${s(t.totalMs)} [auth ${s(t.authMs)} excluded]`,
        evidence: t,
      });
    }

    for (const a of report.activities) {
      const tag = `[${a.activityName}]`;
      const ok = a.succeeded;
      if (a.silentFailure) {
        push({
          point: 'P1',
          name: 'SILENT_FAILURE',
          activity: a.activityName,
          status: 'WARN',
          message: `${tag} ${a.silentFailure}`,
        });
      }

      // ---- P1: result via API
      if (ok) {
        push({
          point: 'P1',
          name: 'API_RESULT',
          activity: a.activityName,
          status: 'PASS',
          message: `${tag} ${a.activityType} output retrieved via queryactivityruns (shape "${report.responseShape}", output keys: ${a.outputKeys.join(', ')}, ${a.outputBytes} bytes)`,
        });
      }

      // ---- P1/P4: were the API parameters actually bound? (a pipeline silently using default values would still "work")
      if (!a.inputAvailable) {
        push({
          point: 'P1',
          name: 'PARAM_BINDING',
          activity: a.activityName,
          status: 'UNVERIFIED',
          message: `${tag} activity input replaced by a size-limit placeholder: parameter binding cannot be checked for this run`,
        });
        continue;
      }
      const queryHits = findStrings(a.input, (x) => normalizeSql(x) === normalizeSql(params.query));
      push(
        queryHits.length > 0
          ? {
              point: 'P1',
              name: 'PARAM_BINDING',
              activity: a.activityName,
              status: 'PASS',
              message: `${tag} query sent via API is the one executed (found at input.${queryHits[0]})`,
            }
          : {
              point: 'P1',
              name: 'PARAM_BINDING',
              activity: a.activityName,
              status: 'FAIL',
              message: `${tag} the query sent via API was NOT found in the activity input — parameters may be ignored (payload format "${this.cfg.parameterPayloadFormat}") and default values used`,
              evidence: { input: a.input },
            },
      );

      // ---- P1: row cap
      if (a.firstRowOnly) {
        push({
          point: 'P1',
          name: 'ROW_CAP',
          activity: a.activityName,
          status: 'WARN',
          message: `${tag} firstRowOnly=true: only the first row is returned. Turn "First row only" off in the pipeline.`,
        });
      } else if (ok) {
        const n = a.rows.length;
        const countNote =
          a.reportedCount !== undefined && a.reportedCount !== n
            ? ` (reported count ${a.reportedCount} differs from ${n} rows returned!)`
            : '';
        if (n === LOOKUP_ROW_CAP) {
          push({
            point: 'P1',
            name: 'ROW_CAP',
            activity: a.activityName,
            status: 'WARN',
            message: `${tag} exactly ${LOOKUP_ROW_CAP} rows returned${countNote}: result is most likely TRUNCATED, and Fabric raised no error`,
          });
        } else if (n > LOOKUP_ROW_CAP) {
          push({
            point: 'P1',
            name: 'ROW_CAP',
            activity: a.activityName,
            status: 'INFO',
            message: `${tag} ${n} rows returned: above the ${LOOKUP_ROW_CAP}-row Lookup cap${countNote}`,
          });
        } else {
          push({
            point: 'P1',
            name: 'ROW_CAP',
            activity: a.activityName,
            status: 'INFO',
            message: `${tag} ${n} row(s) returned${countNote}`,
          });
        }
      }

      // ---- P3: the run identity used for isolation
      if (a.pipelineRunId) {
        const match = a.pipelineRunId.toLowerCase() === report.jobInstanceId?.toLowerCase();
        push({
          point: 'P3',
          name: 'RUN_ID_MATCH',
          activity: a.activityName,
          status: match ? 'PASS' : 'FAIL',
          message: match
            ? `${tag} activity run pipelineRunId == job instance id`
            : `${tag} activity run pipelineRunId ${a.pipelineRunId} != job instance id ${report.jobInstanceId}`,
        });
      }

      // ---- P4: which connection did the activity resolve at runtime?
      const scope = { input: a.input, runMetadata: a.runMetadata };
      const guids = findGuids(scope);
      const wanted = params.connectionGuid.toLowerCase();
      const hit = guids.find((g) => g.value === wanted);
      const otherConnectionGuids = guids.filter(
        (g) => g.value !== wanted && /connection|linkedservice|externalreference/i.test(g.path),
      );
      if (hit) {
        push({
          point: 'P4',
          name: 'CONNECTION_RESOLUTION',
          activity: a.activityName,
          status: ok ? 'PASS' : 'INFO',
          message: `${tag} input references the connection GUID passed via API (at ${hit.path})${ok ? '' : ' — but the activity failed, see error'}`,
        });
      } else if (otherConnectionGuids.length > 0) {
        push({
          point: 'P4',
          name: 'CONNECTION_RESOLUTION',
          activity: a.activityName,
          status: 'FAIL',
          message: `${tag} resolved a DIFFERENT connection than the one passed via API: ${otherConnectionGuids.map((g) => `${g.value} at ${g.path}`).join('; ')} (expected ${wanted})`,
          evidence: scope,
        });
      } else {
        push({
          point: 'P4',
          name: 'CONNECTION_RESOLUTION',
          activity: a.activityName,
          status: 'UNVERIFIED',
          message: `${tag} ${a.activityType} does not expose the connection GUID in its activity run input: only the swap test (alternate connection + bogus GUID control) can conclude`,
          evidence: {
            inputKeys: a.input && typeof a.input === 'object' ? Object.keys(a.input) : [],
          },
        });
      }
      if (params.databaseName) {
        const dbHits = findStrings(a.input, (x) => x === params.databaseName);
        push({
          point: 'P4',
          name: 'DATABASE_BINDING',
          activity: a.activityName,
          status: dbHits.length ? 'PASS' : 'WARN',
          message: dbHits.length
            ? `${tag} databaseName found in input (at input.${dbHits[0]})`
            : `${tag} databaseName "${params.databaseName}" not found in input`,
        });
      }
    }
    return checks;
  }
}
