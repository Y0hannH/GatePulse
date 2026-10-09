/**
 * Offline self-test for the unsupported-column-type rewrite (runQuery.ts): the pure conversion map
 * and the query rewrite built from a faked `sys.dm_exec_describe_first_result_set` answer. Validates
 * the generated T-SQL text, not that Fabric/SQL Server accepts it.
 *
 *   npx tsx test/convert-selftest.ts
 */
import { tenantConnections } from '../src/core/config';
import { convertedColumnExpression, rewriteForUnsupportedTypes } from '../src/core/runQuery';
import type { ScenarioContext } from '../src/core/scenarios';

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✘'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`);
}

/** A context whose runner answers any discovery query with the given describe-result rows. */
function fakeCtx(rows: Record<string, unknown>[]): { ctx: ScenarioContext; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    execute: async (params: { query: string }) => {
      queries.push(params.query);
      return { succeeded: true, activities: [{ rows }], checks: [] };
    },
  };
  return { ctx: { runner } as unknown as ScenarioContext, queries };
}

const params = { connectionGuid: 'c', databaseName: 'db', query: '' };

void (async () => {
  console.log('--- convertedColumnExpression ---');
  expect('int needs no conversion', convertedColumnExpression('[Id]', 'int'), undefined);
  expect(
    'varbinary(max) -> hex text',
    convertedColumnExpression('[Photo]', 'varbinary(max)'),
    'CONVERT(varchar(258), CAST([Photo] AS varbinary(max)), 1)',
  );
  expect('xml -> nvarchar', convertedColumnExpression('[Doc]', 'XML'), 'CAST([Doc] AS nvarchar(max))');
  expect('geography -> WKT', convertedColumnExpression('[Loc]', 'geography'), '[Loc].STAsText()');

  console.log('--- rewriteForUnsupportedTypes ---');
  const describeRows = [
    { name: 'Id', system_type_name: 'int', error_message: null },
    { name: 'Photo', system_type_name: 'varbinary(max)', error_message: null },
  ];
  {
    const { ctx, queries } = fakeCtx(describeRows);
    const r = await rewriteForUnsupportedTypes(ctx, { ...params, query: 'SELECT TOP 10 * FROM dbo.Product;' });
    expect(
      'SELECT TOP n * : the star is replaced in place',
      r?.query,
      'SELECT TOP 10 [Id], CONVERT(varchar(258), CAST([Photo] AS varbinary(max)), 1) AS [Photo] FROM dbo.Product',
    );
    expect('reports what was converted', r?.converted, [{ name: 'Photo', type: 'varbinary(max)' }]);
    expect(
      'describes the query without its trailing semicolon, quotes doubled',
      queries[0].includes("N'SELECT TOP 10 * FROM dbo.Product', NULL, 0)"),
      true,
    );
  }
  {
    const { ctx } = fakeCtx(describeRows);
    const r = await rewriteForUnsupportedTypes(ctx, { ...params, query: 'SELECT Id, Photo FROM dbo.Product WHERE Id > 3' });
    expect(
      'explicit select list : wrapped as a derived table',
      r?.query,
      'SELECT [Id], CONVERT(varchar(258), CAST([Photo] AS varbinary(max)), 1) AS [Photo] FROM (\nSELECT Id, Photo FROM dbo.Product WHERE Id > 3\n) AS gp_src',
    );
  }
  {
    const { ctx } = fakeCtx([{ name: 'Id', system_type_name: 'int', error_message: null }]);
    expect('nothing to convert -> undefined', await rewriteForUnsupportedTypes(ctx, { ...params, query: 'SELECT * FROM t' }), undefined);
  }
  {
    const { ctx } = fakeCtx(describeRows);
    let threw = false;
    try {
      await rewriteForUnsupportedTypes(ctx, { ...params, query: 'WITH x AS (SELECT 1) SELECT * FROM x' });
    } catch {
      threw = true;
    }
    expect('CTE query is refused rather than mangled', threw, true);
  }
  {
    const { ctx } = fakeCtx([
      { name: 'A', system_type_name: 'int', error_message: null },
      { name: 'a', system_type_name: 'xml', error_message: null },
    ]);
    let threw = false;
    try {
      await rewriteForUnsupportedTypes(ctx, { ...params, query: 'SELECT * FROM t' });
    } catch {
      threw = true;
    }
    expect('duplicate result column names are refused', threw, true);
  }

  console.log('--- tenantConnections ---');
  const tc = tenantConnections({
    alias: 'a',
    tenantId: 't',
    workspaceId: 'w',
    connectionGuid: 'AAA',
    extraDatabases: ['legacyDb'],
    connections: [
      { id: 'aaa', name: 'Gateway A', extraDatabases: ['Hidden', 'legacydb'] },
      { id: 'bbb' },
    ],
  });
  expect('default first, deduplicated by GUID', tc.map((c) => c.id), ['AAA', 'bbb']);
  expect('default keeps its name from the connections entry', tc[0].name, 'Gateway A');
  expect('extras merged, case-insensitive dedupe', tc[0].extraDatabases, ['legacyDb', 'Hidden']);
  expect('only the default is flagged', tc.map((c) => c.isDefault), [true, false]);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
})();
