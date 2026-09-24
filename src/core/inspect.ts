/** Helpers to explore undocumented JSON payloads (activity run input/output) and log their structure. */

const GUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function walk(value: unknown, path: string, visit: (path: string, value: string) => void): void {
  if (typeof value === 'string') {
    visit(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
  }
}

/** Paths of string leaves matching the predicate. */
export function findStrings(value: unknown, predicate: (s: string) => boolean): string[] {
  const hits: string[] = [];
  walk(value, '', (p, s) => {
    if (predicate(s)) hits.push(p);
  });
  return hits;
}

/** Every GUID found in string leaves, lower-cased, with its JSON path. */
export function findGuids(value: unknown): { path: string; value: string }[] {
  const hits: { path: string; value: string }[] = [];
  walk(value, '', (p, s) => {
    for (const m of s.matchAll(GUID_GLOBAL)) hits.push({ path: p, value: m[0].toLowerCase() });
  });
  return hits;
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Type skeleton of a JSON value: { output: { count: "number", value: [ { i: "number" } ] } } */
export function typeSkeleton(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value))
    return value.length === 0 ? [] : [typeSkeleton(value[0], depth + 1), `(${value.length} items)`];
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as object).map(([k, v]) => [k, typeSkeleton(v, depth + 1)]),
    );
  return typeof value;
}

/** Activity run with output.value truncated to `maxRows` rows. */
export function summarizeActivityRun(run: { output?: unknown }, maxRows: number): unknown {
  const output = run.output as { value?: unknown[] } | undefined;
  if (!output || !Array.isArray(output.value) || output.value.length <= maxRows) return run;
  return {
    ...run,
    output: {
      ...output,
      value: [
        ...output.value.slice(0, maxRows),
        `… ${output.value.length - maxRows} more row(s) truncated in log`,
      ],
    },
  };
}

/** Structural diff between two JSON values: paths present in only one side, and differing leaf types. */
export function structuralDiff(a: unknown, b: unknown): { onlyInA: string[]; onlyInB: string[] } {
  const paths = (v: unknown) => {
    const out = new Set<string>();
    const rec = (x: unknown, p: string) => {
      if (Array.isArray(x)) {
        out.add(`${p}[]`);
        if (x.length) rec(x[0], `${p}[]`);
      } else if (x && typeof x === 'object') {
        for (const [k, val] of Object.entries(x)) {
          const np = p ? `${p}.${k}` : k;
          out.add(np);
          rec(val, np);
        }
      }
    };
    rec(v, '');
    return out;
  };
  const pa = paths(a);
  const pb = paths(b);
  return { onlyInA: [...pa].filter((p) => !pb.has(p)), onlyInB: [...pb].filter((p) => !pa.has(p)) };
}
