/**
 * Offline self-test for the V1 auto-provisioning flow (ensurePipeline, listItems): validates the
 * discovery/reuse/create/duplicate logic against an in-process mock of the Fabric Items API, not
 * against real Fabric. Covers V1-SCOPE.md §1 (points 1-4 of ensurePipeline's decision flow).
 *
 *   npx tsx test/provision-selftest.ts
 */
import { randomUUID } from 'crypto';
import * as http from 'http';

import { buildConfigForTenant, checkTenants, mergeConfig } from '../src/core/config';
import { FabricClient } from '../src/core/fabricClient';
import { ConsoleSink, Logger } from '../src/core/logger';
import { ensurePipeline, GATEPULSE_PIPELINE_NAME } from '../src/core/provision';

const NAMES = { connectionGuid: 'connectionGuid', databaseName: 'databaseName', query: 'query' };

const VALID_CONTENT = {
  properties: {
    activities: [
      {
        name: 'LookupQuery',
        type: 'Lookup',
        typeProperties: {
          firstRowOnly: false,
          datasetSettings: {
            externalReferences: { connection: '@pipeline().parameters.connectionGuid' },
          },
        },
      },
    ],
    parameters: {
      connectionGuid: { type: 'string' },
      databaseName: { type: 'string' },
      query: { type: 'string' },
    },
  },
};

const BROKEN_CONTENT = {
  properties: {
    activities: [{ name: 'LookupQuery', type: 'Lookup', typeProperties: { firstRowOnly: false } }],
    // missing "query" parameter → inspectPipeline reports it as missing → ensurePipeline must reject it.
    parameters: { connectionGuid: { type: 'string' }, databaseName: { type: 'string' } },
  },
};

interface MockItem {
  id: string;
  displayName: string;
  type: string;
  content: unknown;
}

/** In-process mock of the Fabric Items API (list / get / getDefinition / create) — no real network. */
function startItemsMock(initial: MockItem[] = []): Promise<{
  url: string;
  close: () => void;
  items: Map<string, MockItem>;
}> {
  const items = new Map(initial.map((i) => [i.id, i]));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const url = req.url ?? '';
      let m: RegExpExecArray | null;
      if ((m = /\/workspaces\/([^/]+)\/items\/([^/]+)\/getDefinition$/.exec(url))) {
        const item = items.get(m[2]);
        if (!item) return send(404, { errorCode: 'ItemNotFound', message: 'not found' });
        return send(200, {
          definition: {
            parts: [
              {
                path: 'pipeline-content.json',
                payload: Buffer.from(JSON.stringify(item.content)).toString('base64'),
                payloadType: 'InlineBase64',
              },
            ],
          },
        });
      }
      if (req.method === 'GET' && (m = /\/workspaces\/([^/]+)\/items\/([^/]+)$/.exec(url))) {
        const item = items.get(m[2]);
        if (!item) return send(404, { errorCode: 'ItemNotFound', message: 'not found' });
        return send(200, { id: item.id, displayName: item.displayName, type: item.type });
      }
      if (req.method === 'GET' && (m = /\/workspaces\/([^/]+)\/items(?:\?type=([^&]+))?$/.exec(url))) {
        const type = m[2];
        const value = [...items.values()]
          .filter((i) => !type || i.type === type)
          .map(({ id, displayName, type: t }) => ({ id, displayName, type: t }));
        return send(200, { value });
      }
      if (req.method === 'POST' && /\/workspaces\/[^/]+\/items$/.test(url)) {
        const payload = JSON.parse(body) as {
          displayName: string;
          type: string;
          definition: { parts: { payload: string }[] };
        };
        const id = randomUUID();
        const content: unknown = JSON.parse(
          Buffer.from(payload.definition.parts[0].payload, 'base64').toString('utf8'),
        );
        items.set(id, { id, displayName: payload.displayName, type: payload.type, content });
        return send(201, { id, displayName: payload.displayName });
      }
      send(404, { errorCode: 'NotFound', message: url });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => server.close(),
        items,
      }),
    ),
  );
}

function makeClient(apiBaseUrl: string): FabricClient {
  const cfg = mergeConfig({ workspaceId: randomUUID(), apiBaseUrl });
  const logger = new Logger([new ConsoleSink('warn')]);
  return new FabricClient(cfg, async () => 'fake-token', logger);
}

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(
    `${ok ? '\x1b[32m✔' : '\x1b[31m✘'} ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}\x1b[0m`,
  );
  if (!ok) process.exitCode = 1;
}

void (async () => {
  // 1. Empty workspace → provisions from the bundled template.
  {
    const mock = await startItemsMock([]);
    const client = makeClient(mock.url);
    const logger = new Logger([new ConsoleSink('warn')]);
    const result = await ensurePipeline(client, logger, NAMES);
    expect('empty workspace: created', result.created, true);
    expect('empty workspace: displayName', result.displayName, GATEPULSE_PIPELINE_NAME);
    expect('empty workspace: item persisted', mock.items.size, 1);
    mock.close();
  }

  // 2. One valid pre-existing pipeline → reused, not re-created.
  {
    const existingId = randomUUID();
    const mock = await startItemsMock([
      { id: existingId, displayName: GATEPULSE_PIPELINE_NAME, type: 'DataPipeline', content: VALID_CONTENT },
    ]);
    const client = makeClient(mock.url);
    const logger = new Logger([new ConsoleSink('warn')]);
    const result = await ensurePipeline(client, logger, NAMES);
    expect('reuse: not created', result.created, false);
    expect('reuse: same id', result.id, existingId);
    expect('reuse: no duplicate provisioned', mock.items.size, 1);
    mock.close();
  }

  // 3. One pre-existing pipeline with the right name but a broken definition → rejected, not duplicated.
  {
    const existingId = randomUUID();
    const mock = await startItemsMock([
      { id: existingId, displayName: GATEPULSE_PIPELINE_NAME, type: 'DataPipeline', content: BROKEN_CONTENT },
    ]);
    const client = makeClient(mock.url);
    const logger = new Logger([new ConsoleSink('error')]); // inspectPipeline logs the missing-param ERROR itself
    let threw: unknown;
    try {
      await ensurePipeline(client, logger, NAMES);
    } catch (err) {
      threw = err;
    }
    expect('broken candidate: throws', threw instanceof Error, true);
    expect(
      'broken candidate: provisioning error kind',
      (threw as { kind?: string } | undefined)?.kind,
      'provisioning',
    );
    expect('broken candidate: no second pipeline created', mock.items.size, 1);
    mock.close();
  }

  // 4. Two duplicates (race lost by two colleagues) → deterministic winner, no deletion, no third pipeline.
  {
    const idA = randomUUID();
    const idB = randomUUID();
    const [first, second] = [idA, idB].sort();
    const mock = await startItemsMock([
      { id: idA, displayName: GATEPULSE_PIPELINE_NAME, type: 'DataPipeline', content: VALID_CONTENT },
      { id: idB, displayName: GATEPULSE_PIPELINE_NAME, type: 'DataPipeline', content: VALID_CONTENT },
    ]);
    const client = makeClient(mock.url);
    const logger = new Logger([new ConsoleSink('warn')]);
    const result = await ensurePipeline(client, logger, NAMES);
    expect('duplicates: deterministic winner (smallest id)', result.id, first);
    expect('duplicates: not created (no third pipeline)', result.created, false);
    expect('duplicates: nothing deleted', mock.items.size, 2);
    void second;
    mock.close();
  }

  console.log('\n--- checkTenants / buildConfigForTenant ---');
  expect('checkTenants: empty list flagged', checkTenants([]).length > 0, true);
  expect(
    'checkTenants: valid entry passes',
    checkTenants([{ alias: 'A', tenantId: randomUUID(), workspaceId: randomUUID() }]).length,
    0,
  );
  expect(
    'checkTenants: duplicate alias flagged',
    checkTenants([
      { alias: 'A', tenantId: randomUUID(), workspaceId: randomUUID() },
      { alias: 'a', tenantId: randomUUID(), workspaceId: randomUUID() },
    ]).some((p) => p.includes('Duplicate')),
    true,
  );
  expect(
    'checkTenants: invalid GUID flagged',
    checkTenants([{ alias: 'A', tenantId: 'not-a-guid', workspaceId: randomUUID() }]).some((p) =>
      p.includes('tenantId'),
    ),
    true,
  );

  const tenantClientId = randomUUID();
  const cfgForTenant = buildConfigForTenant(
    { clientId: 'global-client-id' },
    { alias: 'A', tenantId: randomUUID(), workspaceId: randomUUID(), clientId: tenantClientId },
  );
  expect('buildConfigForTenant: tenant clientId overrides global', cfgForTenant.clientId, tenantClientId);
  const cfgFallback = buildConfigForTenant(
    { clientId: 'global-client-id' },
    { alias: 'B', tenantId: randomUUID(), workspaceId: randomUUID() },
  );
  expect('buildConfigForTenant: falls back to global clientId', cfgFallback.clientId, 'global-client-id');
  expect('buildConfigForTenant: pipelineId empty by default', cfgFallback.pipelineId, '');
})();
