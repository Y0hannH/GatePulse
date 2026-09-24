/**
 * Error taxonomy surfaced to the UI. Each kind maps to a distinct message/badge so a demo viewer
 * can tell a SQL error from a gateway/connection problem, an auth failure or a timeout.
 */
export type ErrorKind =
  | 'config' // missing/invalid settings
  | 'auth' // MSAL sign-in failed or token rejected (401)
  | 'permission' // 403 / InsufficientPrivileges
  | 'trigger' // job could not be started
  | 'rateLimit' // 429 persisted after retries
  | 'timeout' // job did not finish within timeoutMs
  | 'cancelled' // user cancelled or job cancelled
  | 'deduped' // Fabric deduplicated the job instance (relevant for concurrency)
  | 'sql' // the database rejected the query
  | 'resultTooLarge' // Lookup output over 4 MB (4194304 bytes): the run fails, nothing is returned
  | 'connection' // gateway / connection GUID / credentials problem
  | 'pipelineFailed' // pipeline failed for another reason
  | 'resultRetrieval' // job finished but the Lookup output could not be read via API
  | 'provisioning' // ensurePipeline: candidate pipeline malformed, or duplicates found (see provision.ts)
  | 'network'
  | 'unexpected';

export class GatePulseError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: {
      httpStatus?: number;
      errorCode?: string;
      requestId?: string;
      jobInstanceId?: string;
      raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'GatePulseError';
  }
}

export interface SerializedError {
  kind: ErrorKind;
  message: string;
  httpStatus?: number;
  errorCode?: string;
  requestId?: string;
  jobInstanceId?: string;
  raw?: unknown;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof GatePulseError)
    return { kind: err.kind, message: err.message, ...err.details };
  if (err instanceof Error) {
    if (err.name === 'AbortError') return { kind: 'cancelled', message: 'Cancelled by user' };
    const cause = (err as { cause?: { code?: string } }).cause;
    if (err.message === 'fetch failed' || cause?.code) {
      return { kind: 'network', message: `${err.message}${cause?.code ? ` (${cause.code})` : ''}` };
    }
    return { kind: 'unexpected', message: err.message };
  }
  return { kind: 'unexpected', message: String(err) };
}

// Heuristics on the Lookup activity error. Deliberately conservative: anything unrecognised
// stays "pipelineFailed" with the raw message shown, never silently re-labelled.
const CONNECTION_PATTERNS = [
  /gateway/i,
  /connection.*(not found|does not exist|invalid|could not be found|failed)/i,
  /cannot connect|could not connect|failed to connect|unable to connect/i,
  /login failed/i,
  /network-related|instance-specific error|server was not found/i,
  /timeout expired/i,
  /InvalidConnection|ConnectionNotFound|SqlFailedToConnect|UserErrorFailedToConnect/i,
  /credential/i,
];
const SQL_PATTERNS = [
  /incorrect syntax/i,
  /invalid object name/i,
  /invalid column name/i,
  /must declare the scalar variable/i,
  /permission was denied/i,
  /conversion failed/i,
  /divide by zero/i,
  /SqlErrorNumber|SqlException|Msg \d+, Level \d+/i,
  /UserErrorSqlOperationFailed|SqlOperationFailed/i,
];

export function classifyActivityError(message: string, errorCode?: string): ErrorKind {
  const haystack = `${errorCode ?? ''} ${message}`;
  if (
    /size of lookup activity result exceeds the limitation|object size exceeds limit|outputTruncated=true/i.test(
      haystack,
    )
  )
    return 'resultTooLarge';
  // "Login failed" is reported through SqlException too: check connection patterns first.
  if (CONNECTION_PATTERNS.some((p) => p.test(haystack))) return 'connection';
  if (SQL_PATTERNS.some((p) => p.test(haystack))) return 'sql';
  return 'pipelineFailed';
}
