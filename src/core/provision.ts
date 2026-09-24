import * as fs from 'fs';

import type { ParameterNames } from './config';
import { GatePulseError } from './errors';
import type { FabricClient } from './fabricClient';
import type { Logger } from './logger';
import { QUERY_ACTIVITY_TYPES } from './pipelineRunner';

interface PipelineContent {
  name?: string;
  properties: {
    activities: {
      name: string;
      type: string;
      typeProperties?: Record<string, unknown>;
      externalReferences?: unknown;
      dependsOn?: unknown[];
    }[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    [k: string]: unknown;
  };
}

/** Decodes an item definition and summarizes what matters for this demo (params, Lookup wiring). */
export async function inspectPipeline(
  client: FabricClient,
  pipelineId: string,
  names: ParameterNames,
  log: Logger,
) {
  const item = await client.getItem(pipelineId);
  const def = await client.getItemDefinition(pipelineId);
  const part = def.definition.parts.find((p) => p.path === 'pipeline-content.json');
  if (!part)
    throw new GatePulseError(
      'unexpected',
      `No pipeline-content.json in definition (parts: ${def.definition.parts.map((p) => p.path).join(', ')})`,
    );
  const content = JSON.parse(
    Buffer.from(part.payload, 'base64').toString('utf8'),
  ) as PipelineContent;

  const queryActivities = content.properties.activities.filter((a) =>
    QUERY_ACTIVITY_TYPES.includes(a.type),
  );
  const summary = {
    item,
    parameters: content.properties.parameters ?? {},
    missingParameters: Object.values(names).filter(
      (p) => !(content.properties.parameters ?? {})[p],
    ),
    activities: content.properties.activities.map((a) => `${a.name} <${a.type}>`),
    queryActivities: queryActivities.map((a) => {
      const tp = (a.typeProperties ?? {}) as Record<string, any>;
      return {
        name: a.name,
        type: a.type,
        dependsOn: a.dependsOn ?? [],
        firstRowOnly: tp.firstRowOnly,
        typeProperties: tp,
        // How the connection is bound: literal GUID (static) vs expression on pipeline().parameters (dynamic).
        // Lookup keeps it under datasetSettings, Script at the activity level.
        connectionBinding:
          tp.datasetSettings?.externalReferences ??
          a.externalReferences ??
          tp.externalReferences ??
          '(not found — inspect the activity JSON)',
      };
    }),
  };
  log.info(
    'inspect.pipeline',
    `Pipeline "${item.displayName}": ${summary.activities.join(', ')}`,
    summary,
  );
  if (summary.missingParameters.length) {
    log.error(
      'inspect.missingParameters',
      `Pipeline does not declare: ${summary.missingParameters.join(', ')} — set "parameterNames" to the declared names (${Object.keys(summary.parameters).join(', ')})`,
    );
  } else {
    log.info(
      'inspect.parameters',
      `Pipeline declares the configured parameters: ${Object.values(names).join(', ')}`,
    );
  }
  const withDefaults = Object.entries(summary.parameters).filter(
    ([, p]) => p.defaultValue !== undefined && p.defaultValue !== '',
  );
  if (withDefaults.length) {
    // A run whose API parameters are silently dropped would still succeed on these values.
    log.warn(
      'inspect.defaultValues',
      `Parameters with default values: ${withDefaults.map(([k]) => k).join(', ')} — a run ignoring API parameters would still succeed; rely on PARAM_BINDING and the swap test`,
    );
  }
  if (summary.queryActivities.length === 0)
    log.error(
      'inspect.noQueryActivity',
      `Pipeline has no ${QUERY_ACTIVITY_TYPES.join(' / ')} activity`,
    );
  for (const a of summary.queryActivities) {
    if (a.type === 'Lookup' && a.firstRowOnly !== false)
      log.warn(
        'inspect.firstRowOnly',
        `Lookup "${a.name}" firstRowOnly=${a.firstRowOnly}: only one row will be returned`,
      );
    const expected = `pipeline().parameters.${names.connectionGuid}`;
    if (JSON.stringify(a.connectionBinding).includes(expected)) {
      log.info(
        'inspect.dynamicConnection',
        `${a.type} "${a.name}" connection is bound dynamically to @${expected}`,
      );
    } else {
      log.warn(
        'inspect.staticConnection',
        `${a.type} "${a.name}" connection binding does not reference @${expected} — the connection may be static`,
        a.connectionBinding,
      );
    }
  }
  return { content, summary };
}

/**
 * Creates the generic 3-parameter Lookup pipeline through the API.
 * - fromPipelineId: clones the definition of a pipeline built in the UI (known-good JSON).
 * - templatePath:   uses provisioning/pipeline-template.json (hand-written; validate with `inspect`).
 */
export async function provisionPipeline(
  client: FabricClient,
  log: Logger,
  names: ParameterNames,
  opts: { displayName: string; fromPipelineId?: string; templatePath?: string },
): Promise<{ id: string; displayName: string }> {
  let content: PipelineContent;
  if (opts.fromPipelineId) {
    content = (await inspectPipeline(client, opts.fromPipelineId, names, log)).content;
    log.info('provision.source', `Cloning definition of pipeline ${opts.fromPipelineId}`);
  } else if (opts.templatePath) {
    content = JSON.parse(fs.readFileSync(opts.templatePath, 'utf8')) as PipelineContent;
    log.info('provision.source', `Using template ${opts.templatePath}`);
  } else {
    throw new GatePulseError('config', 'provision needs --from <pipelineId> or --template <file>');
  }
  const missing = Object.values(names).filter((p) => !(content.properties.parameters ?? {})[p]);
  if (missing.length)
    throw new GatePulseError(
      'config',
      `Pipeline definition lacks parameters: ${missing.join(', ')}`,
    );
  if (!content.properties.activities.some((a) => QUERY_ACTIVITY_TYPES.includes(a.type)))
    throw new GatePulseError('config', 'Pipeline definition has no Lookup or Script activity');

  const started = performance.now();
  const created = await client.createDataPipeline(
    opts.displayName,
    'GatePulse generic SQL Lookup pipeline (provisioned via API)',
    content,
  );
  log.info(
    'provision.created',
    `Pipeline "${created.displayName}" created with id ${created.id} in ${Math.round(performance.now() - started)} ms`,
  );
  // Round-trip check: the stored definition must still bind the connection dynamically.
  await inspectPipeline(client, created.id, names, log);
  return created;
}
