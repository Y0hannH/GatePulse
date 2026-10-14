/**
 * Offline self-test for procedure/function listing and "Script as CREATE" (runQuery.ts): the
 * generated T-SQL text, the row parsing, the fallback to tables/views, and the script layout.
 * Validates our own logic against a faked runner, not that Fabric/SQL Server accepts the queries.
 *
 *   npx tsx test/routines-selftest.ts
 */
import { GatePulseError } from '../src/core/errors';
import {
  buildCreateScript,
  formatParameterType,
  getCreateScript,
  listRoutineParameters,
  listSchemaObjects,
  SCHEMA_OBJECTS_PAGE_SIZE,
  toSchemaObjectType,
} from '../src/core/runQuery';
import type { ScenarioContext } from '../src/core/scenarios';

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✔' : '✘'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`,
  );
}

type Answer = Record<string, unknown>[] | GatePulseError;

/** A context whose runner answers each successive query with the next scripted answer. */
function fakeCtx(answers: Answer[]): { ctx: ScenarioContext; queries: string[]; warnings: string[] } {
  const queries: string[] = [];
  const warnings: string[] = [];
  const runner = {
    execute: async (params: { query: string }) => {
      queries.push(params.query);
      const answer = answers.shift() ?? [];
      if (answer instanceof GatePulseError) {
        return { succeeded: false, error: { kind: answer.kind, message: answer.message }, activities: [], checks: [] };
      }
      return { succeeded: true, activities: [{ rows: answer }], checks: [] };
    },
  };
  const logger = { warn: (_event: string, message: string) => warnings.push(message) };
  return { ctx: { runner, logger } as unknown as ScenarioContext, queries, warnings };
}

void (async () => {
  console.log('--- toSchemaObjectType ---');
  expect('BASE TABLE -> table', toSchemaObjectType('BASE TABLE'), 'table');
  expect('VIEW -> view', toSchemaObjectType('VIEW'), 'view');
  expect('PROCEDURE -> procedure', toSchemaObjectType('PROCEDURE'), 'procedure');
  expect('FUNCTION -> function', toSchemaObjectType('FUNCTION'), 'function');
  expect('unknown -> table', toSchemaObjectType(undefined), 'table');

  console.log('--- listSchemaObjects ---');
  {
    const { ctx, queries } = fakeCtx([
      [
        { schemaName: 'dbo', objectName: 'Orders', objectType: 'BASE TABLE' },
        { schemaName: 'dbo', objectName: 'vOrders', objectType: 'VIEW' },
        { schemaName: 'dbo', objectName: 'usp_Load', objectType: 'PROCEDURE' },
        { schemaName: 'dbo', objectName: 'fn_Tax', objectType: 'FUNCTION' },
        { schemaName: '', objectName: 'broken', objectType: 'VIEW' },
      ],
    ]);
    const objects = await listSchemaObjects(ctx, 'c', 'db');
    expect(
      'tables, views, procedures and functions come back typed; unnamed rows are dropped',
      objects,
      [
        { schema: 'dbo', name: 'Orders', type: 'table' },
        { schema: 'dbo', name: 'vOrders', type: 'view' },
        { schema: 'dbo', name: 'usp_Load', type: 'procedure' },
        { schema: 'dbo', name: 'fn_Tax', type: 'function' },
      ],
    );
    expect('one round trip', queries.length, 1);
    expect(
      'asks INFORMATION_SCHEMA for both tables and routines',
      queries[0].includes('INFORMATION_SCHEMA.TABLES') && queries[0].includes('INFORMATION_SCHEMA.ROUTINES'),
      true,
    );
  }
  {
    const { ctx, queries, warnings } = fakeCtx([
      new GatePulseError('sql', "Invalid object name 'INFORMATION_SCHEMA.ROUTINES'."),
      [{ schemaName: 'dbo', objectName: 'Orders', objectType: 'BASE TABLE' }],
    ]);
    const objects = await listSchemaObjects(ctx, 'c', 'db');
    expect('a rejected routines query falls back to tables and views', objects, [
      { schema: 'dbo', name: 'Orders', type: 'table' },
    ]);
    expect('the fallback query no longer mentions ROUTINES', queries[1].includes('ROUTINES'), false);
    expect('the fallback is logged, not silent', warnings.length, 1);
  }
  {
    const { ctx, queries } = fakeCtx([new GatePulseError('auth', 'token rejected')]);
    let kind: string | undefined;
    try {
      await listSchemaObjects(ctx, 'c', 'db');
    } catch (err) {
      kind = (err as GatePulseError).kind;
    }
    expect('an auth failure is not retried as tables-only', [kind, queries.length], ['auth', 1]);
  }

  console.log('--- listSchemaObjects: paging ---');
  const fullPage = (prefix: string): Record<string, unknown>[] =>
    Array.from({ length: SCHEMA_OBJECTS_PAGE_SIZE }, (_, i) => ({
      schemaName: 'dbo',
      objectName: `${prefix}${i}`,
      objectType: 'BASE TABLE',
    }));
  {
    const { ctx, queries } = fakeCtx([
      fullPage('a'),
      [{ schemaName: 'dbo', objectName: 'last', objectType: 'PROCEDURE' }],
    ]);
    const objects = await listSchemaObjects(ctx, 'c', 'db');
    expect('a full page is followed by the next one, until a short page', objects.length, SCHEMA_OBJECTS_PAGE_SIZE + 1);
    expect('the last object of the second page is kept, typed', objects[objects.length - 1], {
      schema: 'dbo',
      name: 'last',
      type: 'procedure',
    });
    expect(
      'pages are asked at consecutive offsets',
      queries.map((q) => /OFFSET (\d+) ROWS/.exec(q)?.[1]),
      ['0', String(SCHEMA_OBJECTS_PAGE_SIZE)],
    );
    expect('the order is total, so paging cannot skip or repeat a row', queries[0].includes('ORDER BY schemaName, objectName, objectType'), true);
  }
  {
    const { ctx, queries } = fakeCtx([fullPage('a'), []]);
    const objects = await listSchemaObjects(ctx, 'c', 'db');
    expect('a database of exactly one page costs one empty extra query, no more', [objects.length, queries.length], [
      SCHEMA_OBJECTS_PAGE_SIZE,
      2,
    ]);
  }
  {
    const { ctx, queries } = fakeCtx([new GatePulseError('sql', 'Incorrect syntax near OFFSET'), []]);
    await listSchemaObjects(ctx, 'c', 'db');
    expect('the fallback is the plain, unpaged query', queries[1].includes('OFFSET'), false);
  }

  console.log('--- listRoutineParameters ---');
  expect('nvarchar(50)', formatParameterType('nvarchar', 50), 'nvarchar(50)');
  expect('max length -1 is "max"', formatParameterType('varchar', -1), 'varchar(max)');
  expect('no length', formatParameterType('int', null), 'int');
  {
    const { ctx, queries } = fakeCtx([
      [
        { parameterName: '@From', dataType: 'date', parameterMode: 'IN', isResult: 'NO', maxLength: null },
        { parameterName: '@Label', dataType: 'nvarchar', parameterMode: 'INOUT', isResult: 'NO', maxLength: 50 },
        { parameterName: null, dataType: 'int', parameterMode: 'OUT', isResult: 'YES', maxLength: null },
      ],
    ]);
    const parameters = await listRoutineParameters(ctx, 'c', 'db', 'dbo', "o'brien");
    expect('parameters, with the function return value labelled', parameters, [
      { name: '@From', dataType: 'date', mode: 'IN', isReturn: false },
      { name: '@Label', dataType: 'nvarchar(50)', mode: 'INOUT', isReturn: false },
      { name: '(returns)', dataType: 'int', mode: 'OUT', isReturn: true },
    ]);
    expect('name is a unicode literal, quotes doubled', queries[0].includes("SPECIFIC_NAME = N'o''brien'"), true);
  }

  console.log('--- buildCreateScript ---');
  const base = {
    databaseName: 'Sales',
    schema: 'dbo',
    name: 'usp_Load',
    kind: 'procedure' as const,
    ansiNulls: true,
    quotedIdentifier: false,
  };
  expect(
    'SET options and GO around the untouched definition',
    buildCreateScript({ ...base, definition: 'CREATE PROCEDURE dbo.usp_Load AS SELECT 1  \n' }),
    '-- GatePulse: procedure [dbo].[usp_Load] in database [Sales]\n' +
      'SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER OFF\nGO\n' +
      'CREATE PROCEDURE dbo.usp_Load AS SELECT 1\nGO\n',
  );
  expect(
    'CRLF definitions keep CRLF throughout',
    buildCreateScript({ ...base, definition: 'CREATE PROCEDURE p\r\nAS\r\nSELECT 1' }).split('\n').every(
      (line, i, all) => i === all.length - 1 || line.endsWith('\r'),
    ),
    true,
  );
  expect(
    'a closing bracket in a name is escaped in the header',
    buildCreateScript({ ...base, name: 'a]b', definition: 'x' }).split('\n')[0],
    '-- GatePulse: procedure [dbo].[a]]b] in database [Sales]',
  );

  console.log('--- getCreateScript ---');
  {
    const { ctx, queries } = fakeCtx([
      [{ definition: 'CREATE VIEW dbo.v AS SELECT 1 AS a', ansiNulls: 1, quotedIdentifier: 1 }],
    ]);
    const script = await getCreateScript(ctx, 'c', 'Sales', 'dbo', 'v', 'view');
    expect(
      'view script',
      script,
      '-- GatePulse: view [dbo].[v] in database [Sales]\n' +
        'SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE VIEW dbo.v AS SELECT 1 AS a\nGO\n',
    );
    expect(
      'looks the object up by schema and name, as unicode literals',
      queries[0].includes("s.name = N'dbo' AND o.name = N'v'"),
      true,
    );
  }
  {
    const { ctx } = fakeCtx([[{ definition: null, ansiNulls: 1, quotedIdentifier: 1 }]]);
    let kind: string | undefined;
    try {
      await getCreateScript(ctx, 'c', 'Sales', 'dbo', 'p', 'procedure');
    } catch (err) {
      kind = (err as GatePulseError).kind;
    }
    expect('a NULL definition (encrypted / no VIEW DEFINITION) is an error, never an empty script', kind, 'permission');
  }
  {
    const { ctx } = fakeCtx([[]]);
    let message = '';
    try {
      await getCreateScript(ctx, 'c', 'Sales', 'dbo', 'gone', 'function');
    } catch (err) {
      message = (err as Error).message;
    }
    expect('an object that no longer exists says so', message.includes('was not found'), true);
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nall routines self-tests passed');
})();
