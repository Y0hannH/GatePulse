/**
 * Offline self-test: runs the real runner + scenarios against an in-process mock of the Fabric REST API.
 * It validates the harness logic (timings, parsing, checks), NOT Fabric's behaviour.
 *
 *   npm run selftest
 */
import { randomUUID } from 'crypto';
import * as http from 'http';

import { compareActivities } from '../src/core/compare';
import { mergeConfig } from '../src/core/config';
import { FabricClient } from '../src/core/fabricClient';
import { ConsoleSink, Logger } from '../src/core/logger';
import { PipelineRunner } from '../src/core/pipelineRunner';
import type { ScenarioContext } from '../src/core/scenarios';
import { runConcurrencyTest, runRowCapTest, runSingle, runSwapTest } from '../src/core/scenarios';

const CONN_A = '11111111-1111-1111-1111-111111111111';
const CONN_B = '22222222-2222-2222-2222-222222222222';
const SERVERS: Record<string, string> = { [CONN_A]: 'SRV-A', [CONN_B]: 'SRV-B' };

/** mode "ignoreConnection" simulates a pipeline with a hardcoded connection (P4 must FAIL). */
function startMock(
  mode: 'normal' | 'ignoreConnection',
): Promise<{ url: string; close: () => void }> {
  const jobs = new Map<string, { params: Record<string, string>; created: number }>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const url = req.url ?? '';
      let m: RegExpExecArray | null;
      if (
        req.method === 'POST' &&
        (m = /\/workspaces\/([^/]+)\/items\/([^/]+)\/jobs\/instances\?jobType=Pipeline/.exec(url))
      ) {
        const id = randomUUID();
        jobs.set(id, { params: JSON.parse(body).executionData.parameters, created: Date.now() });
        return send(202, undefined, {
          Location: `http://mock/v1/workspaces/${m[1]}/items/${m[2]}/jobs/instances/${id}`,
          'Retry-After': '60',
        });
      }
      if (req.method === 'GET' && (m = /\/jobs\/instances\/([0-9a-f-]{36})$/.exec(url))) {
        const job = jobs.get(m[1])!;
        const age = Date.now() - job.created;
        const failed = mode === 'normal' && !SERVERS[job.params.connectionGuid];
        const status =
          age < 300 ? 'NotStarted' : age < 900 ? 'InProgress' : failed ? 'Failed' : 'Completed';
        const iso = (t: number) => new Date(t).toISOString().replace('Z', '');
        return send(200, {
          id: m[1],
          itemId: 'x',
          jobType: 'Pipeline',
          invokeType: 'Manual',
          status,
          startTimeUtc: iso(job.created + 300),
          endTimeUtc: age >= 900 ? iso(job.created + 850) : null,
          failureReason: failed ? { message: 'Activity failed' } : null,
        });
      }
      if (
        req.method === 'POST' &&
        (m = /\/pipelineruns\/([0-9a-f-]{36})\/queryactivityruns/.exec(url))
      ) {
        const job = jobs.get(m[1])!;
        const { connectionGuid, databaseName, query } = job.params;
        const effectiveConn = mode === 'ignoreConnection' ? CONN_A : connectionGuid;
        const server = SERVERS[effectiveConn];
        let rows: Record<string, unknown>[];
        let tag: RegExpExecArray | null;
        let n: RegExpExecArray | null;
        if ((tag = /'(gp\d+_[0-9a-f]{8})'/.exec(query)))
          rows = [{ run_tag: tag[1], server_time: new Date().toISOString() }];
        else if ((n = /TOP \((\d+)\)/.exec(query)))
          rows = Array.from({ length: Number(n[1]) }, (_, i) => ({ i: i + 1 }));
        else if (/@@SERVERNAME/.test(query))
          rows = [{ server_name: server, database_name: databaseName }];
        else rows = [{ one: 1 }];
        const ok = !!server;
        const error = ok
          ? { errorCode: '', message: '' }
          : {
              errorCode: '2011',
              message: `The connection ${connectionGuid} could not be found`,
              failureType: 'UserError',
            };
        // Mock assumptions: the Lookup caps at 5000 rows; the Script activity silently drops results above 6000 rows.
        const scriptTruncated = rows.length > 6000;
        return send(200, {
          value: [
            {
              pipelineName: 'x',
              pipelineRunId: m[1],
              activityName: 'Script1',
              activityType: 'Script',
              activityRunId: randomUUID(),
              status: ok ? 'Succeeded' : 'Failed',
              durationInMs: 380,
              input: {
                scripts: [{ type: 'Query', text: query }],
                database: databaseName,
                externalReferences: { connection: effectiveConn },
              },
              output: ok
                ? scriptTruncated
                  ? { resultSetCount: 0, resultSets: [], outputTruncated: true }
                  : {
                      resultSetCount: 1,
                      recordsAffected: 0,
                      resultSets: [{ rowCount: rows.length, rows }],
                      outputParameters: {},
                      outputLogs: '',
                      outputTruncated: false,
                    }
                : {},
              error,
            },
            {
              pipelineName: 'x',
              pipelineRunId: m[1],
              activityName: 'LookupQuery',
              activityType: 'Lookup',
              activityRunId: randomUUID(),
              linkedServiceName: '',
              status: ok ? 'Succeeded' : 'Failed',
              durationInMs: 420,
              input: {
                source: { type: 'SqlServerSource', sqlReaderQuery: query },
                datasetSettings: {
                  typeProperties: { database: databaseName },
                  externalReferences: { connection: effectiveConn },
                },
                firstRowOnly: false,
              },
              output: ok
                ? {
                    count: Math.min(rows.length, 5000),
                    value: rows.slice(0, 5000),
                    effectiveIntegrationRuntime: 'gateway-1',
                  }
                : {},
              error,
            },
          ],
        });
      }
      send(404, { errorCode: 'NotFound', message: url });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

async function scenarioSet(mode: 'normal' | 'ignoreConnection') {
  const mock = await startMock(mode);
  const cfg = mergeConfig({
    tenantId: randomUUID(),
    clientId: randomUUID(),
    workspaceId: randomUUID(),
    pipelineId: randomUUID(),
    apiBaseUrl: mock.url,
    pollIntervalMs: 250,
    resultFetchDelayMs: 100,
    validation: { alternateConnectionGuid: CONN_B, rowCapSizes: [10, 5000, 7000] },
  });
  const logger = new Logger([new ConsoleSink('warn')], { mock: mode });
  const getToken = async () => 'fake-token';
  const client = new FabricClient(cfg, getToken, logger);
  const ctx: ScenarioContext = {
    cfg,
    client,
    logger,
    runner: new PipelineRunner(cfg, client, getToken, logger),
  };
  const conn = { connectionGuid: CONN_A, databaseName: 'DemoDb' };
  const results = {
    single: await runSingle(ctx, { ...conn, query: 'SELECT 1 AS one' }),
    rowcap: await runRowCapTest(ctx, conn),
    concurrency: await runConcurrencyTest(ctx, conn),
    swap: await runSwapTest(ctx, conn),
  };
  mock.close();
  return results;
}

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(
    `${ok ? '\x1b[32m✔' : '\x1b[31m✘'} ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}\x1b[0m`,
  );
  if (!ok) process.exitCode = 1;
}

void (async () => {
  const normal = await scenarioSet('normal');
  console.log('\n--- mock: dynamic connection honoured ---');
  const single = normal.single.runs[0];
  expect('single run succeeded', single.succeeded, true);
  expect(
    'single activities read',
    single.activities.map((a) => a.activityName).join(','),
    'LookupQuery,Script1',
  );
  expect(
    'single rows (Script)',
    single.activities.find((a) => a.activityType === 'Script')?.rows.length,
    1,
  );
  expect('single P1 verdict', normal.single.verdicts.P1, 'PASS');
  expect('single P4 verdict', normal.single.verdicts.P4, 'PASS');
  expect('totalMs measured', typeof single.timings.totalMs, 'number');
  expect('rowcap P1 verdict (truncation flagged)', normal.rowcap.verdicts.P1, 'WARN');
  expect(
    'rowcap 7000 Lookup flagged truncated',
    normal.rowcap.checks
      .find((c) => c.name === 'ROW_CAP_7000' && c.activity === 'LookupQuery')
      ?.message.includes('SILENTLY TRUNCATED'),
    true,
  );
  expect(
    'rowcap 7000 Script silent loss detected',
    normal.rowcap.runs
      .find((r) => r.runLabel === 'rowcap-7000')
      ?.activities.find((a) => a.activityName === 'Script1')?.errorKind,
    'resultTooLarge',
  );
  const cmp = compareActivities(Object.values(normal));
  expect('comparison: 2 activities', Object.keys(cmp.activities).length, 2);
  expect(
    'comparison: rowcap-7000 silent loss listed',
    cmp.pairs?.oneFailed.some((d) => d.run === 'rowcap-7000' && d.detail.includes('silently')),
    true,
  );
  expect('concurrency P3 verdict', normal.concurrency.verdicts.P3, 'PASS');
  expect('swap P4 verdict', normal.swap.verdicts.P4, 'PASS');
  expect(
    'swap bogus GUID classified as connection error',
    normal.swap.runs[2].error?.kind,
    'connection',
  );

  const ignored = await scenarioSet('ignoreConnection');
  console.log('\n--- mock: connection parameter ignored by pipeline ---');
  expect('swap P4 verdict', ignored.swap.verdicts.P4, 'FAIL');
  expect(
    'negative control FAIL',
    ignored.swap.checks.find((c) => c.name === 'NEGATIVE_CONTROL')?.status,
    'FAIL',
  );
  expect(
    'alternate run resolution FAIL',
    ignored.swap.runs[1].checks
      .filter((c) => c.name === 'CONNECTION_RESOLUTION')
      .every((c) => c.status === 'FAIL'),
    true,
  );
})();
