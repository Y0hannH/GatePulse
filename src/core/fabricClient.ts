import type { GatePulseConfig } from './config';
import { GatePulseError } from './errors';
import type { Logger } from './logger';

export type JobStatus =
  'NotStarted' | 'InProgress' | 'Completed' | 'Failed' | 'Cancelled' | 'Deduped' | string;

/** GET /v1/connections item shape — field names/values unconfirmed against a real tenant (V1-SCOPE.md §3). */
export interface FabricConnection {
  id: string;
  displayName: string;
  connectivityType: string;
  gatewayId?: string;
  connectionDetails?: { type?: string; path?: string };
}

/**
 * The pipeline's Lookup activity takes a connection GUID as a runtime parameter
 * (`externalReferences.connection`, see provisioning/pipeline-template.json) — it never cares
 * whether that connection is gateway-routed or cloud (P4 of the PoC confirmed this: whatever GUID
 * is passed is the one resolved at runtime). So the only real constraint is the connector family
 * (SQL), not connectivityType. Kept as a named predicate — not inlined into the `.filter()` call —
 * because "what counts as usable here" is a decision worth a name, not just a one-off filter.
 */
export function isSupportedSqlConnection(c: FabricConnection): boolean {
  return /sql/i.test(c.connectionDetails?.type ?? '');
}

export interface JobInstance {
  id: string;
  itemId: string;
  jobType: string;
  invokeType: string;
  status: JobStatus;
  rootActivityId?: string;
  startTimeUtc?: string | null;
  endTimeUtc?: string | null;
  failureReason?: { errorCode?: string; message?: string; requestId?: string } | null;
}

export interface ActivityRun {
  pipelineName: string;
  pipelineRunId: string;
  activityName: string;
  activityType: string;
  activityRunId: string;
  status: string;
  activityRunStart?: string;
  activityRunEnd?: string;
  durationInMs?: number;
  input?: unknown;
  output?: unknown;
  error?: {
    errorCode?: string;
    message?: string;
    failureType?: string;
    target?: string;
    details?: unknown;
  };
  [key: string]: unknown;
}

export interface HttpResult<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
  requestId?: string;
  durationMs: number;
}

interface RequestOptions {
  label: string;
  body?: unknown;
  expected: number[];
  signal?: AbortSignal;
}

const MAX_429_RETRIES = 5;

/** Hard ceiling on one HTTP call, independent of cfg.timeoutMs (which only bounds the job-status
 *  poll loop). A dead gateway or a black-holed connection would otherwise hang `fetch()` forever. */
const HTTP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Only follows a `continuationUri` that is actually on the configured API origin. The previous
 * `startsWith(apiBaseUrl)` check was a bare string prefix: it would accept
 * "https://api.fabric.microsoft.com.evil.com/..." or "https://api.fabric.microsoft.com@evil.com/...",
 * both of which pass a prefix test but resolve to a different host — which would receive this
 * client's bearer token on the next paginated request.
 */
function sameOriginPath(candidate: string | undefined, apiBaseUrl: string): string | undefined {
  if (!candidate) return undefined;
  try {
    const base = new URL(apiBaseUrl);
    const next = new URL(candidate, apiBaseUrl);
    if (next.origin !== base.origin) return undefined;
    return `${next.pathname}${next.search}`;
  } catch {
    return undefined;
  }
}

export class FabricClient {
  constructor(
    private readonly cfg: GatePulseConfig,
    private readonly getToken: () => Promise<string>,
    private readonly logger: Logger,
  ) {}

  private get itemPath(): string {
    return `/v1/workspaces/${this.cfg.workspaceId}/items/${this.cfg.pipelineId}`;
  }

  // ---------------------------------------------------------------- jobs

  /** POST .../jobs/instances?jobType=Pipeline — returns the job instance id parsed from the Location header. */
  async runPipelineJob(parameters: Record<string, string>, signal?: AbortSignal) {
    const body =
      this.cfg.parameterPayloadFormat === 'executionData'
        ? { executionData: { parameters } }
        : {
            parameters: Object.entries(parameters).map(([name, value]) => ({
              name,
              value,
              type: 'Text',
            })),
          };

    const res = await this.request<unknown>(
      'POST',
      `${this.itemPath}/jobs/instances?jobType=Pipeline`,
      {
        label: 'job.trigger',
        body,
        expected: [202],
        signal,
      },
    );
    const location = res.headers['location'] ?? '';
    const jobInstanceId = /\/jobs\/instances\/([0-9a-f-]{36})/i.exec(location)?.[1];
    if (!jobInstanceId) {
      throw new GatePulseError(
        'trigger',
        `Job accepted (202) but no job instance id in Location header: "${location}"`,
        {
          httpStatus: res.status,
          requestId: res.requestId,
          raw: res.headers,
        },
      );
    }
    const retryAfter = Number(res.headers['retry-after']);
    return {
      jobInstanceId,
      location,
      retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : undefined,
      http: res,
      requestBody: body,
    };
  }

  async getJobInstance(
    jobInstanceId: string,
    signal?: AbortSignal,
  ): Promise<HttpResult<JobInstance>> {
    return this.request<JobInstance>('GET', `${this.itemPath}/jobs/instances/${jobInstanceId}`, {
      label: 'job.get',
      expected: [200],
      signal,
    });
  }

  async listJobInstances(): Promise<JobInstance[]> {
    const res = await this.request<{ value: JobInstance[] }>(
      'GET',
      `${this.itemPath}/jobs/instances`,
      { label: 'job.list', expected: [200] },
    );
    return res.body.value ?? [];
  }

  async cancelJobInstance(jobInstanceId: string): Promise<void> {
    await this.request('POST', `${this.itemPath}/jobs/instances/${jobInstanceId}/cancel`, {
      label: 'job.cancel',
      expected: [200, 202],
    });
  }

  /**
   * POST /v1/workspaces/{ws}/datapipelines/pipelineruns/{jobId}/queryactivityruns
   * The docs show a bare array response; ADF returns { value, continuationToken }. Both are accepted
   * and the observed shape is reported so the finding can be documented.
   */
  async queryActivityRuns(
    jobInstanceId: string,
    lastUpdatedAfter: Date,
    lastUpdatedBefore: Date,
    signal?: AbortSignal,
  ) {
    const res = await this.request<unknown>(
      'POST',
      `/v1/workspaces/${this.cfg.workspaceId}/datapipelines/pipelineruns/${jobInstanceId}/queryactivityruns`,
      {
        label: 'activityRuns.query',
        body: {
          filters: [],
          orderBy: [{ orderBy: 'ActivityRunStart', order: 'DESC' }],
          lastUpdatedAfter: lastUpdatedAfter.toISOString(),
          lastUpdatedBefore: lastUpdatedBefore.toISOString(),
        },
        expected: [200],
        signal,
      },
    );
    let runs: ActivityRun[];
    let shape: 'array' | 'object.value' | 'unknown';
    if (Array.isArray(res.body)) {
      runs = res.body as ActivityRun[];
      shape = 'array';
    } else if (res.body && Array.isArray((res.body as { value?: unknown }).value)) {
      runs = (res.body as { value: ActivityRun[] }).value;
      shape = 'object.value';
    } else {
      runs = [];
      shape = 'unknown';
    }
    return { runs, shape, http: res };
  }

  // ---------------------------------------------------------------- items (provisioning / inspection)

  /**
   * GET /v1/workspaces/{workspaceId}/items[?type=X], follows continuationUri.
   * Used to find an already-provisioned pipeline by name before creating a new one
   * (ensurePipeline, provision.ts) — see V1-SCOPE.md §1.
   */
  async listItems(type?: string): Promise<{ id: string; displayName: string; type: string }[]> {
    return this.paginate(
      `/v1/workspaces/${this.cfg.workspaceId}/items${type ? `?type=${type}` : ''}`,
      'item.list',
    );
  }

  /**
   * GET /v1/connections — tenant-wide, not scoped to a workspace: a gateway connection is
   * referenced by GUID from a pipeline, not listed as a workspace item. Used to let the user pick
   * a connection instead of typing its GUID — see V1-SCOPE.md §3 (endpoint shape unconfirmed
   * against a real tenant, same spirit as the hypotheses in README §6).
   */
  async listConnections(): Promise<FabricConnection[]> {
    return this.paginate<FabricConnection>('/v1/connections', 'connection.list');
  }

  /** Follows `continuationUri` pages, capped defensively (a single workspace/tenant call is never expected to need it). */
  private async paginate<T>(path: string, label: string): Promise<T[]> {
    const MAX_PAGES = 50;
    const out: T[] = [];
    let apiPath: string | undefined = path;
    let page = 0;
    while (apiPath && page < MAX_PAGES) {
      const res: HttpResult<{ value?: T[]; continuationUri?: string }> = await this.request(
        'GET',
        apiPath,
        { label, expected: [200] },
      );
      out.push(...(res.body.value ?? []));
      apiPath = sameOriginPath(res.body.continuationUri, this.cfg.apiBaseUrl);
      page++;
    }
    return out;
  }

  async getItem(itemId: string) {
    return (
      await this.request<{ id: string; displayName: string; type: string }>(
        'GET',
        `/v1/workspaces/${this.cfg.workspaceId}/items/${itemId}`,
        { label: 'item.get', expected: [200] },
      )
    ).body;
  }

  async getItemDefinition(
    itemId: string,
  ): Promise<{ definition: { parts: { path: string; payload: string; payloadType: string }[] } }> {
    const res = await this.request<unknown>(
      'POST',
      `/v1/workspaces/${this.cfg.workspaceId}/items/${itemId}/getDefinition`,
      {
        label: 'item.getDefinition',
        expected: [200, 202],
      },
    );
    return (res.status === 202 ? await this.waitForOperation(res) : res.body) as {
      definition: { parts: { path: string; payload: string; payloadType: string }[] };
    };
  }

  async createDataPipeline(
    displayName: string,
    description: string,
    pipelineContent: object,
  ): Promise<{ id: string; displayName: string }> {
    const res = await this.request<unknown>(
      'POST',
      `/v1/workspaces/${this.cfg.workspaceId}/items`,
      {
        label: 'item.create',
        body: {
          displayName,
          description,
          type: 'DataPipeline',
          definition: {
            parts: [
              {
                path: 'pipeline-content.json',
                payload: Buffer.from(JSON.stringify(pipelineContent)).toString('base64'),
                payloadType: 'InlineBase64',
              },
            ],
          },
        },
        expected: [201, 202],
      },
    );
    return (res.status === 202 ? await this.waitForOperation(res) : res.body) as {
      id: string;
      displayName: string;
    };
  }

  /** Long-running operation: poll /v1/operations/{id} then fetch /result. */
  private async waitForOperation(accepted: HttpResult<unknown>): Promise<unknown> {
    const operationId = accepted.headers['x-ms-operation-id'];
    // The id is interpolated straight into a URL path below — a sanity check on its shape costs
    // nothing and rules out a malformed/hostile header value steering the request elsewhere.
    if (!operationId || !/^[A-Za-z0-9-]+$/.test(operationId))
      throw new GatePulseError('unexpected', 'LRO accepted without a usable x-ms-operation-id header', {
        raw: accepted.headers,
      });
    let delay = (Number(accepted.headers['retry-after']) || 2) * 1000;
    for (let i = 0; i < 60; i++) {
      await sleep(Math.min(delay, 5000));
      const state = await this.request<{ status: string; error?: unknown }>(
        'GET',
        `/v1/operations/${operationId}`,
        { label: 'operation.get', expected: [200] },
      );
      if (state.body.status === 'Succeeded') {
        return (
          await this.request<unknown>('GET', `/v1/operations/${operationId}/result`, {
            label: 'operation.result',
            expected: [200],
          })
        ).body;
      }
      if (state.body.status === 'Failed')
        throw new GatePulseError('unexpected', `Operation ${operationId} failed`, {
          raw: state.body.error,
        });
      delay = (Number(state.headers['retry-after']) || 2) * 1000;
    }
    throw new GatePulseError('timeout', `Operation ${operationId} did not complete`);
  }

  // ---------------------------------------------------------------- HTTP

  private async request<T>(
    method: string,
    apiPath: string,
    opts: RequestOptions,
  ): Promise<HttpResult<T>> {
    const url = `${this.cfg.apiBaseUrl}${apiPath}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const started = performance.now();
      let response: Response;
      // Combine the caller's cancellation signal with a hard per-request timeout: without this, a
      // connection that never responds (dead gateway, black-holed network) hangs forever — nothing
      // upstream bounds a bare `fetch()` on its own, and cfg.timeoutMs only governs the job-status
      // poll loop, not an individual HTTP call.
      const requestController = new AbortController();
      const timeoutTimer = setTimeout(() => requestController.abort(), HTTP_REQUEST_TIMEOUT_MS);
      const onCallerAbort = () => requestController.abort();
      opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
      try {
        try {
          response = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: requestController.signal,
          });
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            // Distinguish a real user cancellation (rethrown as-is — callers check err.name) from
            // this request's own timeout firing.
            if (opts.signal?.aborted) throw err;
            throw new GatePulseError(
              'network',
              `${opts.label}: ${method} ${apiPath} timed out after ${HTTP_REQUEST_TIMEOUT_MS} ms with no response`,
            );
          }
          throw new GatePulseError(
            'network',
            `${opts.label}: ${method} ${apiPath} failed: ${(err as Error).message}`,
          );
        }
      } finally {
        clearTimeout(timeoutTimer);
        opts.signal?.removeEventListener('abort', onCallerAbort);
      }
      const durationMs = Math.round(performance.now() - started);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const text = await response.text();
      const body = text ? safeJson(text) : undefined;
      const requestId =
        headers['requestid'] ??
        headers['x-ms-request-id'] ??
        (body as { requestId?: string } | undefined)?.requestId;

      this.logger.debug(
        `http.${opts.label}`,
        `${method} ${apiPath} -> ${response.status} (${durationMs} ms)`,
        { requestId, headers: pickHeaders(headers) },
      );

      if (opts.expected.includes(response.status))
        return { status: response.status, headers, body: body as T, requestId, durationMs };

      const errBody = (body ?? {}) as { errorCode?: string; message?: string };
      const detail = {
        httpStatus: response.status,
        errorCode: errBody.errorCode,
        requestId,
        raw: body ?? text,
      };

      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        const waitSec = Number(headers['retry-after']) || 5;
        // Not silent: throttling directly impacts latency (P2) and concurrency (P3) conclusions.
        this.logger.warn(
          'http.throttled',
          `${opts.label} throttled (429 ${errBody.errorCode ?? ''}); retrying in ${waitSec}s (attempt ${attempt + 1}/${MAX_429_RETRIES})`,
          detail,
        );
        await sleep(waitSec * 1000, opts.signal);
        continue;
      }
      const reason =
        `${opts.label}: HTTP ${response.status} ${errBody.errorCode ?? ''} ${errBody.message ?? text.slice(0, 500)}`.trim();
      this.logger.error(`http.${opts.label}.error`, reason, detail);
      if (response.status === 401) throw new GatePulseError('auth', reason, detail);
      if (response.status === 403 || errBody.errorCode === 'InsufficientPrivileges')
        throw new GatePulseError('permission', reason, detail);
      if (response.status === 429) throw new GatePulseError('rateLimit', reason, detail);
      throw new GatePulseError(
        opts.label === 'job.trigger' ? 'trigger' : 'unexpected',
        reason,
        detail,
      );
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickHeaders(h: Record<string, string>): Record<string, string> {
  const keep = [
    'location',
    'retry-after',
    'requestid',
    'x-ms-request-id',
    'x-ms-operation-id',
    'x-ms-public-api-error-code',
  ];
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.includes(k)));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

/** Fabric returns UTC timestamps without a zone designator ("2024-05-23T13:43:03.6397566"). */
export function parseFabricUtc(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
