import type { AuthUi } from '@evolve-data/pulse-core';
import { AzureAuthService } from '@evolve-data/pulse-core';
import * as fs from 'fs';
import * as path from 'path';

import type { GatePulseConfig } from './config';
import { GatePulseError } from './errors';
import { FabricClient } from './fabricClient';
import type { LogSink } from './logger';
import { JsonlFileSink, Logger, timestampForFile } from './logger';
import type { ExecutionReport } from './pipelineRunner';
import { PipelineRunner } from './pipelineRunner';
import type { ScenarioReport } from './scenarios';

export interface SessionOptions {
  cfg: GatePulseConfig;
  logDir: string;
  authUi: AuthUi;
  sinks: LogSink[];
}

/** Wires logger → auth → REST client → runner. Shared by the CLI and the VS Code extension. */
export function createSession(opts: SessionOptions) {
  const logFile = path.join(
    opts.logDir,
    `gatepulse-${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  const logger = new Logger([new JsonlFileSink(logFile), ...opts.sinks]);
  const authLogger = logger.child({ component: 'auth' });

  // The first-party client only accepts one `.default` scope per acquisition — cfg.scopes is an
  // array for parity with the Azure SDK's own getToken() signature, but GatePulse never has more
  // than the one entry validated by config.ts.
  const scope = opts.cfg.scopes[0];

  const azureAuth = new AzureAuthService({
    authFlow: opts.cfg.authFlow,
    clientId: opts.cfg.clientId || undefined,
    ui: opts.authUi,
    brand: { name: 'GatePulse', glyph: '🚪' },
    onDiagnostic: (message) => authLogger.info('auth.diagnostic', message),
  });

  // pulse-core's AuthState events fire only on a real acquisition (cache hits return early), so
  // comparing tokens is enough to log auth.success once per acquisition/renewal instead of on
  // every getToken() call — matches FabricAuth's original log volume.
  let lastLoggedToken: string | undefined;

  const getToken = async (): Promise<string> => {
    try {
      const token = await azureAuth.getToken(opts.cfg.tenantId, scope);
      if (token !== lastLoggedToken) {
        lastLoggedToken = token;
        authLogger.info('auth.success', 'Token acquired', describeToken(token));
      }
      return token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      authLogger.error('auth.failed', `Sign-in failed (${opts.cfg.authFlow}): ${message}`);
      throw new GatePulseError('auth', `Sign-in failed (${opts.cfg.authFlow}): ${message}`);
    }
  };

  const auth = {
    getToken,
    signOut: (): void => {
      azureAuth.clearCredential(opts.cfg.tenantId);
      lastLoggedToken = undefined;
      authLogger.info('auth.signOut', 'In-memory credential and token cleared');
    },
  };

  const client = new FabricClient(opts.cfg, getToken, logger);
  const runner = new PipelineRunner(opts.cfg, client, getToken, logger);

  const saveReport = (report: ScenarioReport): string => {
    const file = path.join(opts.logDir, 'reports', `${report.scenario}-${timestampForFile()}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const compact = { ...report, runs: report.runs.map((r) => compactRun(r, 50)) };
    fs.writeFileSync(file, JSON.stringify(compact, null, 2), 'utf8');
    logger.info('report.saved', `Report written to ${file}`);
    return file;
  };

  return { cfg: opts.cfg, logger, auth, client, runner, logFile, saveReport };
}

export type Session = ReturnType<typeof createSession>;

/** Keeps reports readable: rows beyond `maxRows` are dropped per activity (the count is kept). */
export function compactRun(run: ExecutionReport, maxRows: number): ExecutionReport {
  return {
    ...run,
    activities: run.activities.map((a) =>
      a.rows.length <= maxRows
        ? a
        : { ...a, rows: a.rows.slice(0, maxRows), rowsTruncatedInReport: a.rows.length },
    ),
  };
}

/** Logs who is signed in and which delegated scopes the token actually carries (useful for 403s). */
function describeToken(jwt: string): Record<string, unknown> {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return {
      user: claims.upn ?? claims.unique_name,
      appId: claims.appid,
      audience: claims.aud,
      scopes: claims.scp,
    };
  } catch {
    return {};
  }
}
