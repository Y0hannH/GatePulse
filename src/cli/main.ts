import type { AuthUi } from '@evolve-data/pulse-core';
import * as fs from 'fs';
import * as path from 'path';

import type { ActivityComparison } from '../core/compare';
import { compareActivities } from '../core/compare';
import type { GatePulseConfig } from '../core/config';
import { checkConfig, mergeConfig } from '../core/config';
import { serializeError } from '../core/errors';
import type { ValidationCheck, ValidationPoint } from '../core/logger';
import { ConsoleSink } from '../core/logger';
import { inspectPipeline, provisionPipeline } from '../core/provision';
import { runSingle } from '../core/runQuery';
import type { ScenarioContext, ScenarioReport } from '../core/scenarios';
import {
  aggregateVerdicts,
  formatVerdicts,
  runConcurrencyTest,
  runLatencyTest,
  runRowCapTest,
  runSizeTest,
  runSwapTest,
} from '../core/scenarios';
import { createSession } from '../core/session';

const USAGE = `GatePulse demo CLI — SQL via Fabric pipeline + gateway

Usage: node dist/cli.js <command> [options]

  login                         Check sign-in (Azure CLI session or browser) and show granted scopes
  inspect                       Dump the pipeline definition (params, query activities' connection binding) + recent job instances
  run --query "<sql>"           Single run [--connection <guid>] [--database <name>]
  latency                       P2 — sequential runs of validation.latencyQuery, timing stats
  rowcap                        P1 — row cap behaviour for validation.rowCapSizes
  size                          P1 — output size limit (4 MB) for validation.sizeTestRows
  concurrency                   P3 — N parallel runs with unique tags, isolation checks
  swap                          P4 — primary vs alternate connection + bogus GUID control (+ UI run diff)
  all                           latency, rowcap, size, concurrency, swap (+ Lookup vs Script comparison)
  provision --name <name>       Create the pipeline via API [--from <pipelineId> | --template <file>]

Global options:
  --config <file>               Default: ./gatepulse.config.json
  --verbose                     Print debug logs (HTTP calls) to the console
`;

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { command, flags };
}

const cliAuthUi: AuthUi = {
  showDeviceCode(info) {
    console.log(`\n${info.message}\n`);
  },
};

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }

  const configPath = path.resolve(
    typeof flags.config === 'string' ? flags.config : 'gatepulse.config.json',
  );
  if (!fs.existsSync(configPath)) {
    console.error(
      `Config file not found: ${configPath}\nCopy gatepulse.config.example.json to gatepulse.config.json and fill it in.`,
    );
    return 2;
  }
  const cfg: GatePulseConfig = mergeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const problems = checkConfig(cfg);
  if (problems.length) {
    console.error(`[config] ${problems.join('\n[config] ')}`);
    return 2;
  }

  const logDir = path.resolve('logs');
  const session = createSession({
    cfg,
    logDir,
    authUi: cliAuthUi,
    sinks: [new ConsoleSink(flags.verbose ? 'debug' : 'info')],
  });
  const log = session.logger;
  log.info('cli.start', `Command "${command}" — JSONL log: ${session.logFile}`, {
    workspaceId: cfg.workspaceId,
    pipelineId: cfg.pipelineId,
    parameterPayloadFormat: cfg.parameterPayloadFormat,
  });

  const controller = new AbortController();
  process.on('SIGINT', () => {
    log.warn('cli.interrupt', 'Ctrl+C received: cancelling running jobs…');
    controller.abort();
  });

  const ctx: ScenarioContext = {
    cfg,
    runner: session.runner,
    client: session.client,
    logger: log,
    signal: controller.signal,
    onProgress: (e) => {
      if (e.phase === 'waiting' && e.pollCount && e.pollCount % 5 !== 0) return;
      log.debug(
        'progress',
        `${e.runLabel} ${e.phase} ${e.message} (${(e.elapsedMs / 1000).toFixed(1)} s)`,
      );
    },
  };
  const conn = {
    connectionGuid: typeof flags.connection === 'string' ? flags.connection : cfg.connectionGuid,
    databaseName: typeof flags.database === 'string' ? flags.database : cfg.databaseName,
  };
  const needsConnection = [
    'run',
    'latency',
    'rowcap',
    'size',
    'concurrency',
    'swap',
    'all',
  ].includes(command);
  if (needsConnection && !conn.connectionGuid) {
    console.error('[config] connectionGuid is not set (config or --connection)');
    return 2;
  }

  try {
    const reports: ScenarioReport[] = [];
    const record = (r: ScenarioReport) => {
      reports.push(r);
      session.saveReport(r);
    };
    switch (command) {
      case 'login':
        await session.auth.getToken();
        log.info('cli.login', 'Sign-in OK (identity and granted scopes logged above)');
        return 0;
      case 'inspect': {
        const { summary } = await inspectPipeline(
          session.client,
          cfg.pipelineId,
          cfg.parameterNames,
          log,
        );
        const file = path.join(logDir, 'pipeline-definition.json');
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(summary, null, 2));
        const jobs = (await session.client.listJobInstances()).slice(0, 10);
        log.info(
          'inspect.jobs',
          `Last ${jobs.length} job instances (use a UI-triggered id as validation.referenceUiJobInstanceId)`,
          jobs.map((j) => ({
            id: j.id,
            invokeType: j.invokeType,
            status: j.status,
            start: j.startTimeUtc,
          })),
        );
        log.info('inspect.saved', `Definition summary written to ${file}`);
        return 0;
      }
      case 'provision': {
        if (typeof flags.name !== 'string')
          throw new Error('provision requires --name <displayName>');
        const created = await provisionPipeline(session.client, log, cfg.parameterNames, {
          displayName: flags.name,
          fromPipelineId: typeof flags.from === 'string' ? flags.from : undefined,
          templatePath:
            typeof flags.template === 'string'
              ? flags.template
              : typeof flags.from === 'string'
                ? undefined
                : path.resolve('provisioning', 'pipeline-template.json'),
        });
        console.log(
          `\nCreated pipeline ${created.id}. Set "pipelineId" to it to run the validation against the provisioned pipeline.`,
        );
        return 0;
      }
      case 'run': {
        if (typeof flags.query !== 'string') throw new Error('run requires --query "<sql>"');
        const r = await runSingle(ctx, { ...conn, query: flags.query });
        record(r);
        for (const a of r.runs[0].activities) {
          console.log(
            `\n${a.activityName} <${a.activityType}> — ${a.status}, ${a.rows.length} row(s)${a.errorKind ? ` [${a.errorKind}]` : ''}`,
          );
          if (a.rows.length) console.table(a.rows.slice(0, 10));
        }
        break;
      }
      case 'latency':
        record(await runLatencyTest(ctx, conn));
        break;
      case 'rowcap':
        record(await runRowCapTest(ctx, conn));
        break;
      case 'size':
        record(await runSizeTest(ctx, conn));
        break;
      case 'concurrency':
        record(await runConcurrencyTest(ctx, conn));
        break;
      case 'swap':
        record(await runSwapTest(ctx, conn));
        break;
      case 'all':
        for (const fn of [
          runLatencyTest,
          runRowCapTest,
          runSizeTest,
          runConcurrencyTest,
          runSwapTest,
        ]) {
          if (controller.signal.aborted) break;
          record(await fn(ctx, conn));
        }
        break;
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
    const code = printSummary(reports);
    if (reports.length) {
      const comparison = compareActivities(reports);
      if (Object.keys(comparison.activities).length > 1) {
        printComparison(comparison);
        const file = path.join(
          logDir,
          'reports',
          `comparison-${command}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(comparison, null, 2));
        log.info('comparison.saved', `Activity comparison written to ${file}`);
      }
    }
    return code;
  } catch (err) {
    const e = serializeError(err);
    log.error('cli.failed', `[${e.kind}] ${e.message}`, e.raw);
    return 1;
  }
}

function printSummary(reports: ScenarioReport[]): number {
  const all: ValidationCheck[] = reports.flatMap((r) => [
    ...r.checks,
    ...r.runs.flatMap((x) => x.checks),
  ]);
  const verdicts = aggregateVerdicts(all);
  const labels: Record<ValidationPoint, string> = {
    P1: 'API round-trip & row cap',
    P2: 'Latency',
    P3: 'Concurrency / isolation',
    P4: 'Dynamic connection via API',
  };
  console.log('\n================ VALIDATION SUMMARY ================');
  for (const r of reports)
    console.log(
      `scenario ${r.scenario.padEnd(12)} ${(r.wallClockMs / 1000).toFixed(1).padStart(6)} s   ${formatVerdicts(r.verdicts)}`,
    );
  console.log('');
  // P2 is informational: show the aggregated summary when available, otherwise each run's breakdown.
  const hasLatencySummary = all.some((c) => c.name === 'LATENCY_SUMMARY');
  for (const p of ['P1', 'P2', 'P3', 'P4'] as ValidationPoint[]) {
    if (!verdicts[p]) continue;
    console.log(`${p} ${labels[p].padEnd(28)} ${verdicts[p]}`);
    const notable = all.filter(
      (c) =>
        c.point === p &&
        (p === 'P2' ? !(hasLatencySummary && c.name === 'LATENCY') : c.status !== 'PASS'),
    );
    for (const c of notable)
      console.log(
        `   - [${c.status}] ${c.name}${c.runLabel ? ` (${c.runLabel})` : ''}: ${c.message}`,
      );
  }
  console.log('====================================================\n');
  return Object.values(verdicts).includes('FAIL') ? 1 : 0;
}

function printComparison(c: ActivityComparison): void {
  const s = (ms?: number) => (ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
  const names = Object.keys(c.activities);
  const col = (text: string) => text.padEnd(34);
  const row = (label: string, f: (n: string) => string) =>
    console.log(`${label.padEnd(26)}${names.map((n) => col(f(n))).join('')}`);
  console.log('============ QUERY ACTIVITY COMPARISON =============');
  row('', (n) => `${n} <${c.activities[n].type}>`);
  row('runs (succeeded)', (n) => `${c.activities[n].runs} (${c.activities[n].succeeded})`);
  row(
    'failures by kind',
    (n) =>
      Object.entries(c.activities[n].failuresByKind)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '-',
  );
  row('duration min/med/max', (n) => {
    const d = c.activities[n].durationMs;
    return `${s(d.min)} / ${s(d.median)} / ${s(d.max)}`;
  });
  row('start offset (median)', (n) => s(c.activities[n].startOffsetMs.median));
  row('silent result losses', (n) => String(c.activities[n].silentFailures));
  row('output keys', (n) => c.activities[n].outputKeys.join(', '));
  if (c.limits.length) {
    console.log('\nLimits (rowcap / size runs):');
    for (const l of c.limits) row(`  ${l.run}`, (n) => l.outcomes[n] ?? '-');
  }
  if (c.pairs) {
    const p = c.pairs;
    console.log(
      `\n${p.a} vs ${p.b}: both succeeded in ${p.bothSucceeded} run(s), identical rows in ${p.identicalRows}, same row count in ${p.sameRowCount}; median duration delta (${p.b} - ${p.a}) ${s(p.medianDurationDeltaMs)}; output bytes ${p.b}/${p.a} = ${p.medianOutputBytesRatio ?? 'n/a'}`,
    );
    for (const d of p.divergences.slice(0, 10))
      console.log(`   - data differs (${d.run}): ${d.detail}`);
    for (const d of p.oneFailed) console.log(`   - only one failed (${d.run}): ${d.detail}`);
  }
  console.log('====================================================\n');
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
