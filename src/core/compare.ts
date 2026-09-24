import { parseFabricUtc } from './fabricClient';
import type { ScenarioReport } from './scenarios';
import { describe } from './scenarios';

/** Side-by-side view of the query activities (e.g. Lookup1 vs Script1) across every run of the given scenarios. */
export interface ActivityComparison {
  activities: Record<
    string,
    {
      type: string;
      runs: number;
      succeeded: number;
      failuresByKind: Record<string, number>;
      durationMs: ReturnType<typeof describe>;
      /** activityRunStart minus job start: time before the activity actually begins. */
      startOffsetMs: ReturnType<typeof describe>;
      silentFailures: number;
      outputKeys: string[];
    }
  >;
  /** Per requested size (rowcap / size scenarios): what each activity returned. */
  limits: { run: string; outcomes: Record<string, string> }[];
  /** Runs where both activities succeeded: did they return the same data? */
  pairs?: {
    a: string;
    b: string;
    bothSucceeded: number;
    identicalRows: number;
    sameRowCount: number;
    divergences: { run: string; detail: string }[];
    /** Median of b.outputBytes / a.outputBytes over runs where both returned identical rows. */
    medianOutputBytesRatio?: number;
    oneFailed: { run: string; detail: string }[];
    /** Median of (b.durationInMs - a.durationInMs). */
    medianDurationDeltaMs?: number;
  };
}

export function compareActivities(reports: ScenarioReport[]): ActivityComparison {
  const runs = reports.flatMap((r) => r.runs.map((run) => ({ scenario: r.scenario, run })));
  const names = [
    ...new Set(runs.flatMap(({ run }) => run.activities.map((a) => a.activityName))),
  ].sort();

  const activities: ActivityComparison['activities'] = {};
  for (const name of names) {
    const acts = runs.flatMap(({ run }) =>
      run.activities.filter((a) => a.activityName === name).map((a) => ({ run, a })),
    );
    const ok = acts.filter(({ a }) => a.succeeded);
    const failuresByKind: Record<string, number> = {};
    for (const { a } of acts)
      if (!a.succeeded)
        failuresByKind[a.errorKind ?? 'unknown'] =
          (failuresByKind[a.errorKind ?? 'unknown'] ?? 0) + 1;
    activities[name] = {
      type: acts[0]?.a.activityType ?? '?',
      runs: acts.length,
      succeeded: ok.length,
      failuresByKind,
      durationMs: describe(
        acts.map(({ a }) => a.durationInMs).filter((v): v is number => typeof v === 'number'),
      ),
      startOffsetMs: describe(
        acts
          .map(({ run, a }) => {
            const start = parseFabricUtc(a.activityRunStart)?.getTime();
            const jobStart = parseFabricUtc(run.timings.jobStartUtc)?.getTime();
            return start !== undefined && jobStart !== undefined ? start - jobStart : undefined;
          })
          .filter((v): v is number => typeof v === 'number'),
      ),
      silentFailures: acts.filter(({ a }) => a.silentFailure).length,
      outputKeys: [...new Set(ok.flatMap(({ a }) => a.outputKeys))],
    };
  }

  const limits = runs
    .filter(({ scenario }) => scenario === 'rowcap' || scenario === 'size')
    .map(({ run }) => ({
      run: run.runLabel,
      outcomes: Object.fromEntries(
        run.activities.map((a) => [
          a.activityName,
          a.succeeded
            ? `${a.rows.length} rows, ${(a.outputBytes / 1024 / 1024).toFixed(2)} MB`
            : `${a.silentFailure ? 'SILENT LOSS' : 'FAILED'} [${a.errorKind}]`,
        ]),
      ),
    }));

  const comparison: ActivityComparison = { activities, limits };
  if (names.length >= 2) {
    const [na, nb] = names;
    const pairs: NonNullable<ActivityComparison['pairs']> = {
      a: na,
      b: nb,
      bothSucceeded: 0,
      identicalRows: 0,
      sameRowCount: 0,
      divergences: [],
      oneFailed: [],
    };
    const deltas: number[] = [];
    const ratios: number[] = [];
    for (const { run } of runs) {
      const a = run.activities.find((x) => x.activityName === na);
      const b = run.activities.find((x) => x.activityName === nb);
      if (!a || !b) continue;
      if (a.durationInMs !== undefined && b.durationInMs !== undefined)
        deltas.push(b.durationInMs - a.durationInMs);
      const aOk = a.succeeded;
      const bOk = b.succeeded;
      if (aOk !== bOk) {
        const bad = aOk ? b : a;
        pairs.oneFailed.push({
          run: run.runLabel,
          detail: `${bad.activityName} ${bad.silentFailure ? 'lost its result silently' : 'failed'} [${bad.errorKind}], ${aOk ? na : nb} returned ${(aOk ? a : b).rows.length} rows`,
        });
        continue;
      }
      if (!aOk) continue;
      pairs.bothSucceeded++;
      if (a.rows.length === b.rows.length) pairs.sameRowCount++;
      if (JSON.stringify(a.rows) === JSON.stringify(b.rows)) {
        pairs.identicalRows++;
        if (a.rows.length && a.outputBytes) ratios.push(b.outputBytes / a.outputBytes);
      } else {
        pairs.divergences.push({
          run: run.runLabel,
          detail: firstDifference(a.rows, b.rows, na, nb),
        });
      }
    }
    pairs.medianDurationDeltaMs = describe(deltas).median;
    const sorted = ratios.sort((x, y) => x - y);
    if (sorted.length)
      pairs.medianOutputBytesRatio = Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
    comparison.pairs = pairs;
  }
  return comparison;
}

/** Human-readable first difference between two row sets (count, columns, or first differing cell). */
function firstDifference(
  a: Record<string, unknown>[],
  b: Record<string, unknown>[],
  na: string,
  nb: string,
): string {
  if (a.length !== b.length) return `row count ${na}=${a.length} vs ${nb}=${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const keys = [...new Set([...Object.keys(a[i]), ...Object.keys(b[i])])];
    for (const k of keys) {
      const va = JSON.stringify(a[i][k]);
      const vb = JSON.stringify(b[i][k]);
      if (va !== vb)
        return `row ${i}, column "${k}": ${na}=${truncate(va)} vs ${nb}=${truncate(vb)}`;
    }
  }
  return 'same values, different key order';
}

function truncate(s: string | undefined): string {
  if (s === undefined) return '(missing)';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
