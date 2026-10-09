// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const inputs = {
    connectionGuid: /** @type {HTMLInputElement} */ ($('connectionGuid')),
    databaseName: /** @type {HTMLInputElement} */ ($('databaseName')),
  };
  const tenantSelect = /** @type {HTMLSelectElement} */ ($('tenantSelect'));
  const connectionSelect = /** @type {HTMLSelectElement} */ ($('connectionSelect'));

  const ERROR_TITLES = {
    config: ['Invalid configuration', 'Check the GatePulse settings.'],
    auth: ['Sign-in failed', 'Check tenantId/clientId and the Entra app redirect platform, or sign in again.'],
    permission: ['Insufficient permissions', 'The account needs a role on the workspace and the Fabric scopes consented.'],
    trigger: ['Could not start the pipeline', 'Check workspaceId/pipelineId (see errorCode).'],
    rateLimit: ['Fabric rate limit (429)', 'Too many requests or concurrent jobs.'],
    timeout: ['Timeout', 'The job did not finish in time and was cancelled.'],
    cancelled: ['Cancelled', ''],
    deduped: ['Job deduplicated by Fabric', 'Fabric did not run this job (status Deduped).'],
    sql: ['SQL error', 'The database rejected the query.'],
    unsupportedType: ['Column type not supported', 'A selected column has a type the pipeline cannot transfer (binary, XML, geography, sql_variant...) and it could not be converted automatically. Cast it to text in the SELECT, or leave it out.'],
    resultTooLarge: ['Result too large (> 4 MB)', 'The Lookup refuses results over 4 MB: select fewer columns (avoid SELECT *) or add TOP / WHERE.'],
    connection: ['Connection / gateway error', 'Connection GUID, gateway, credentials or database unreachable.'],
    pipelineFailed: ['Pipeline failed', 'Unclassified error: see the raw message.'],
    resultRetrieval: ['Result could not be retrieved', 'The job ran but the Lookup output could not be read through the API.'],
    provisioning: ['Generic pipeline unusable', 'A pipeline with the expected name exists in this workspace but is not valid (missing parameters, or no Lookup/Script activity): fix or rename it by hand.'],
    network: ['Network error', ''],
    unexpected: ['Unexpected error', ''],
  };
  /** Checks worth a banner in daily use (V1-SCOPE.md §4.B) — everything else stays out of the UI. */
  const ALERT_MESSAGES = {
    SILENT_FAILURE: (c) => `${activityLabel(c)}silent failure detected — ${c.message.replace(/^\[.*?\]\s*/, '')}`,
    ROW_CAP: (c) => `${activityLabel(c)}the result looks truncated at 5,000 rows without any error from Fabric — add TOP/WHERE or check the expected row count.`,
    PARAM_BINDING: (c) => `${activityLabel(c)}the query sent does not match the one the pipeline ran (default values were probably used).`,
    CONNECTION_RESOLUTION: (c) => `${activityLabel(c)}the pipeline used a different connection than the one selected.`,
    DATABASE_BINDING: (c) => `${activityLabel(c)}the selected database was not found in the run — check that it was applied.`,
    COLUMN_CONVERSION: (c) => c.message,
  };
  function activityLabel(c) {
    return c.activity ? `[${c.activity}] ` : '';
  }
  const MANUAL = '__manual__';

  // ---------------------------------------------------------------- state
  const saved = vscode.getState() || {};
  if (saved.connectionGuid) inputs.connectionGuid.value = saved.connectionGuid;
  if (saved.databaseName) inputs.databaseName.value = saved.databaseName;

  // eslint-disable-next-line no-undef
  const cm = CodeMirror($('queryEditor'), {
    value: saved.query || '', // no canned example query — an empty editor, always (explicit request)
    mode: 'text/x-mssql',
    theme: 'gatepulse',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      'Ctrl-Enter': tryRun,
      'Cmd-Enter': tryRun,
      'Ctrl-Space': 'autocomplete',
    },
    hintOptions: { hint: gatepulseHint, completeSingle: false },
  });
  // The editor box is CSS-resizable (see .query-editor .CodeMirror { resize: vertical }); CodeMirror
  // doesn't notice a manual CSS resize on its own, so it needs a nudge to re-measure lines/gutter.
  new ResizeObserver(() => cm.refresh()).observe(cm.getWrapperElement());
  // Auto-popup right after "." — Ctrl+Space above stays for anywhere-anytime completion. Checks the
  // actual character left of the cursor rather than change.text[0]: more robust than assuming the
  // change is exactly one typed character (IME, autoclose-pairs, etc. can shape it differently).
  cm.on('inputRead', (instance) => {
    const cur = instance.getCursor();
    if (instance.getLine(cur.line).charAt(cur.ch - 1) === '.') {
      // eslint-disable-next-line no-undef
      CodeMirror.showHint(instance, gatepulseHint, { completeSingle: false });
    }
  });

  const persist = () =>
    vscode.setState({
      connectionGuid: inputs.connectionGuid.value,
      databaseName: inputs.databaseName.value,
      query: cm.getValue(),
    });
  inputs.connectionGuid.addEventListener('input', persist);
  inputs.databaseName.addEventListener('input', persist);
  cm.on('change', persist);

  let timer = 0;
  let startedAt = 0;

  // Tracks which tenant the fields currently reflect, so a real tenant switch (dropdown, tree, "+
  // Tenant") can force-refresh connectionGuid/databaseName from the new tenant's own defaults —
  // leaving the previous tenant's connection in place used to silently send queries to the wrong
  // workspace. `tenantInitialized` distinguishes that from the panel's very first 'init', where
  // whatever vscode.getState() already restored should win instead.
  let currentTenantAlias = null;
  let tenantInitialized = false;
  // Set when a history entry belonging to a different tenant is loaded/run: switching tenant first
  // (posted below) triggers a fresh 'init', which then applies this entry's own values instead of
  // the new tenant's stored defaults.
  let pendingHistoryAction = null;

  // ---------------------------------------------------------------- actions
  const conn = () => ({ connectionGuid: inputs.connectionGuid.value, databaseName: inputs.databaseName.value });
  function tryRun() {
    if (!(/** @type {HTMLButtonElement} */ ($('run')).disabled)) run();
  }
  const run = () => vscode.postMessage({ type: 'run', ...conn(), query: cm.getValue() });
  $('run').addEventListener('click', run);
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('refreshConnections').addEventListener('click', () => vscode.postMessage({ type: 'refreshConnections' }));
  connectionSelect.addEventListener('change', () => {
    if (connectionSelect.value === MANUAL) {
      manualMode = true;
      syncConnectionUI();
      inputs.connectionGuid.focus();
      return;
    }
    manualMode = false;
    inputs.connectionGuid.value = connectionSelect.value;
    onConnectionChanged();
  });
  $('openGuide').addEventListener('click', () => vscode.postMessage({ type: 'openGuide' }));
  $('showLogs').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'showLogs' })));
  $('openSettings').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'openSettings' })));
  tenantSelect.addEventListener('change', () => vscode.postMessage({ type: 'switchTenant', alias: tenantSelect.value }));
  $('addTenant').addEventListener('click', () => vscode.postMessage({ type: 'addTenant' }));

  // ---------------------------------------------------------------- database picker
  // Fired on blur/commit (not every keystroke) so a half-typed GUID never triggers a run.
  inputs.connectionGuid.addEventListener('change', onConnectionChanged);
  inputs.databaseName.addEventListener('change', () => warmTables());
  $('refreshDatabases').addEventListener('click', () => requestDatabases(true));

  function onConnectionChanged() {
    persist();
    syncConnectionUI();
    requestDatabases(false);
    warmTables();
  }

  // ---------------------------------------------------------------- connection picker
  // The dropdown shows connection *names* (listed through the Fabric API); the GUID input below it
  // stays as the underlying value and as the manual fallback when the list is unavailable or the
  // connection isn't in it.
  let connections = [];
  let manualMode = false;

  function syncConnectionUI() {
    const guid = inputs.connectionGuid.value.trim();
    const known = connections.find((c) => c.id.toLowerCase() === guid.toLowerCase());
    const showManual = manualMode || connections.length === 0;
    const options = [];
    if (!guid && !showManual) options.push(el('option', { value: '' }, 'Select a connection…'));
    for (const c of connections) options.push(el('option', { value: c.id }, c.detail ? `${c.name} · ${c.detail}` : c.name));
    if (guid && !known) options.push(el('option', { value: guid }, `Unnamed connection (${guid.slice(0, 8)}…)`));
    options.push(el('option', { value: MANUAL }, connections.length ? 'Enter a GUID manually…' : 'Connection list unavailable — enter a GUID'));
    connectionSelect.replaceChildren(...options);
    connectionSelect.value = showManual ? MANUAL : guid || '';
    inputs.connectionGuid.classList.toggle('hidden', !showManual);
  }

  function requestDatabases(force) {
    const guid = inputs.connectionGuid.value.trim();
    if (!GUID_RE.test(guid)) return;
    setDatabasesLoading(true);
    vscode.postMessage({
      type: 'listDatabases',
      connectionGuid: guid,
      databaseNameHint: inputs.databaseName.value,
      force: !!force,
    });
  }

  function setDatabasesLoading(loading) {
    $('refreshDatabases').classList.toggle('spinning', loading);
    /** @type {HTMLButtonElement} */ ($('refreshDatabases')).disabled = loading;
  }

  function renderDatabaseOptions(names) {
    $('databaseListOptions').replaceChildren(...names.map((n) => el('option', { value: n })));
  }

  // ---------------------------------------------------------------- autocomplete
  // Table/column names for the editor's Ctrl+Space / "." autocomplete, backed by the same
  // extension.ts cache the sidebar tree uses (V1-SCOPE.md §4) — whichever surface asks first
  // fetches, this just reuses it. This webview-side layer only avoids repeat postMessage chatter
  // within one session; a single "current schema" slot is enough since only one connection/database
  // is ever being typed against at a time (switching back re-asks the extension, which itself
  // answers from its own persistent cache — near-free).
  let schemaKey = '';
  let tablesForSchema = null;
  let tablesInFlightKey = null;
  const pendingTablesResolvers = [];
  const columnsBySchema = new Map(); // `${schemaKey}:${tableNameLower}` -> ColumnInfo[]
  const pendingColumnsResolvers = new Map(); // tableNameLower -> resolve[]

  /** Kicks off the table-list fetch as soon as connection+database are known, well before the user
   *  starts typing — a real discovery query can take real seconds (it's a genuine Fabric pipeline
   *  run, not a local lookup), and firing it only at the moment "." is typed made autocomplete look
   *  broken: by the time it resolved, the cursor had moved and CodeMirror silently drops the (now
   *  stale) completion. Warming it up removes that latency from the interaction entirely. */
  function warmTables() {
    const connectionGuid = inputs.connectionGuid.value.trim();
    const databaseName = inputs.databaseName.value.trim();
    if (GUID_RE.test(connectionGuid) && databaseName) ensureTables(connectionGuid, databaseName);
  }

  function ensureTables(connectionGuid, databaseName) {
    const key = `${connectionGuid}:${databaseName}`;
    if (key !== schemaKey) {
      schemaKey = key;
      tablesForSchema = null;
      columnsBySchema.clear();
    }
    if (tablesForSchema) return Promise.resolve(tablesForSchema);
    if (!GUID_RE.test(connectionGuid) || !databaseName) return Promise.resolve([]);
    return new Promise((resolve) => {
      pendingTablesResolvers.push({ connectionGuid, databaseName, resolve });
      if (tablesInFlightKey !== key) {
        tablesInFlightKey = key;
        vscode.postMessage({ type: 'listTables', connectionGuid, databaseName });
      }
    });
  }

  function ensureColumns(connectionGuid, databaseName, table) {
    const tableKey = table.name.toLowerCase();
    const cacheKey = `${schemaKey}:${tableKey}`;
    const cached = columnsBySchema.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const waiting = pendingColumnsResolvers.get(tableKey);
      if (waiting) {
        waiting.push(resolve);
        return;
      }
      pendingColumnsResolvers.set(tableKey, [resolve]);
      vscode.postMessage({
        type: 'listTableColumns',
        connectionGuid,
        databaseName,
        schema: table.schema,
        table: table.name,
      });
    });
  }

  /** `word.partial` → schema/table members if `word` is known; bare `partial` → schemas + tables. */
  function wordContext(cmInst) {
    const cur = cmInst.getCursor();
    const line = cmInst.getLine(cur.line).slice(0, cur.ch);
    const qualified = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(line);
    if (qualified) {
      return {
        qualifier: qualified[1],
        partial: qualified[2] || '',
        fromCh: cur.ch - (qualified[2] ? qualified[2].length : 0),
      };
    }
    const bare = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
    return { qualifier: null, partial: bare ? bare[1] : '', fromCh: cur.ch - (bare ? bare[1].length : 0) };
  }

  const HINT_ICONS = { schema: 'symbol-namespace', table: 'table', view: 'eye', column: 'symbol-field' };

  /** A rich show-hint item: icon + name, classed by kind so schemas/tables/views/columns are told
   *  apart at a glance instead of one flat list of names. */
  function hintItem(name, kind) {
    return {
      text: name,
      className: `cm-hint-${kind}`,
      render: (elt) => {
        elt.appendChild(icon(HINT_ICONS[kind]));
        elt.appendChild(document.createTextNode(` ${name}`));
      },
    };
  }

  /**
   * Async CodeMirror hint (show-hint addon convention: `.async = true`, resolves via `callback`).
   * Bare word: matching schema names + matching table/view names (unqualified — most queries never
   * bother with the schema prefix). `schema.partial`: tables/views of that schema. `table.partial`:
   * that table's columns (fetched lazily, only for the one table actually being typed against).
   */
  function gatepulseHint(cmInst, callback) {
    const connectionGuid = inputs.connectionGuid.value.trim();
    const databaseName = inputs.databaseName.value.trim();
    const cur = cmInst.getCursor();
    const ctx = wordContext(cmInst);
    // eslint-disable-next-line no-undef
    const from = CodeMirror.Pos(cur.line, ctx.fromCh);
    const partialLower = ctx.partial.toLowerCase();

    ensureTables(connectionGuid, databaseName).then((objects) => {
      if (ctx.qualifier) {
        const qualifierLower = ctx.qualifier.toLowerCase();
        const isSchema = objects.some((o) => o.schema.toLowerCase() === qualifierLower);
        if (isSchema) {
          const list = objects
            .filter((o) => o.schema.toLowerCase() === qualifierLower && o.name.toLowerCase().startsWith(partialLower))
            .map((o) => hintItem(o.name, o.type));
          callback({ list, from, to: cur });
          return;
        }
        const table = objects.find((o) => o.name.toLowerCase() === qualifierLower);
        if (!table) return callback({ list: [], from, to: cur });
        ensureColumns(connectionGuid, databaseName, table).then((columns) => {
          const list = columns
            .filter((c) => c.name.toLowerCase().startsWith(partialLower))
            .map((c) => hintItem(c.name, 'column'));
          callback({ list, from, to: cur });
        });
        return;
      }
      const schemas = [...new Set(objects.map((o) => o.schema))];
      const list = [
        ...schemas.filter((s) => s.toLowerCase().startsWith(partialLower)).map((s) => hintItem(s, 'schema')),
        ...objects.filter((o) => o.name.toLowerCase().startsWith(partialLower)).map((o) => hintItem(o.name, o.type)),
      ];
      callback({ list, from, to: cur });
    });
  }
  gatepulseHint.async = true;

  // ---------------------------------------------------------------- messages
  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'init': {
        const isSwitch = tenantInitialized && m.activeTenantAlias !== currentTenantAlias;
        if (isSwitch) {
          // A real tenant switch: this tenant's own connection/database replace whatever was left
          // typed for the previous one — otherwise a stale connectionGuid gets run through the new
          // tenant's pipeline without any indication anything changed.
          inputs.connectionGuid.value = m.defaults.connectionGuid || '';
          inputs.databaseName.value = m.defaults.databaseName || '';
        } else {
          // First load: keep whatever vscode.getState() already restored for this tenant, falling
          // back to its stored defaults only if nothing was persisted.
          if (!inputs.connectionGuid.value) inputs.connectionGuid.value = m.defaults.connectionGuid || '';
          if (!inputs.databaseName.value) inputs.databaseName.value = m.defaults.databaseName || '';
        }
        tenantInitialized = true;
        currentTenantAlias = m.activeTenantAlias;
        if (isSwitch) manualMode = false;
        syncConnectionUI();

        renderTenants(m.tenants, m.activeTenantAlias);
        const problems = m.configProblems.filter((p) => !p.startsWith('No tenant configured'));
        const banner = $('configProblems');
        banner.classList.toggle('hidden', problems.length === 0);
        banner.textContent = problems.length ? `Incomplete configuration: ${problems.join(' • ')}` : '';
        renderHistory(m.history || []);

        if (pendingHistoryAction) {
          // Resuming a history entry that belonged to a different tenant: its own connection/
          // database/query replace whatever was just applied above, tenant-switch or not.
          const { entry, execute } = pendingHistoryAction;
          pendingHistoryAction = null;
          const matched = m.activeTenantAlias === entry.tenantAlias;
          inputs.connectionGuid.value = entry.connectionGuid;
          inputs.databaseName.value = entry.databaseName;
          cm.setValue(entry.query);
          persist();
          syncConnectionUI();
          requestDatabases(false);
          warmTables();
          // Only auto-run if the switch actually landed on the entry's tenant (e.g. not deleted
          // since) — loading without running is always safe, running against the wrong tenant isn't.
          if (execute && matched) run();
        } else {
          if (isSwitch) persist();
          requestDatabases(false); // uses the panel-side cache if this connection was already resolved this session
          warmTables();
        }
        break;
      }
      case 'setConnectionGuid':
        manualMode = false;
        inputs.connectionGuid.value = m.value;
        onConnectionChanged();
        break;
      case 'connections':
        connections = m.items;
        renderTenants(m.tenants, m.activeTenantAlias);
        syncConnectionUI();
        break;
      case 'prefillQuery':
        inputs.connectionGuid.value = m.connectionGuid;
        inputs.databaseName.value = m.databaseName;
        cm.setValue(m.query);
        persist();
        syncConnectionUI();
        requestDatabases(false);
        warmTables();
        break;
      case 'databasesLoading':
        if (m.connectionGuid === inputs.connectionGuid.value.trim()) setDatabasesLoading(true);
        break;
      case 'databases':
        if (m.connectionGuid !== inputs.connectionGuid.value.trim()) break; // stale: field changed meanwhile
        setDatabasesLoading(false);
        renderDatabaseOptions(m.names);
        $('databaseHint').classList.toggle('hidden', !m.error);
        $('databaseHint').textContent = m.error ? 'Database list unavailable — type the name' : '';
        break;
      case 'tables': {
        const key = `${m.connectionGuid}:${m.databaseName}`;
        if (key === schemaKey) tablesForSchema = m.objects;
        // Only clear the in-flight marker if this response is for the request it was tracking — a
        // stale response for a key the schema already moved on from must not clear the marker for
        // whatever *newer* request is now actually in flight, or that one gets fired a second time.
        if (tablesInFlightKey === key) tablesInFlightKey = null;
        const remaining = [];
        for (const p of pendingTablesResolvers) {
          if (p.connectionGuid === m.connectionGuid && p.databaseName === m.databaseName) p.resolve(m.objects);
          else remaining.push(p);
        }
        pendingTablesResolvers.length = 0;
        pendingTablesResolvers.push(...remaining);
        break;
      }
      case 'tableColumns': {
        const tableKey = m.table.toLowerCase();
        columnsBySchema.set(`${schemaKey}:${tableKey}`, m.columns);
        const resolvers = pendingColumnsResolvers.get(tableKey) || [];
        pendingColumnsResolvers.delete(tableKey);
        resolvers.forEach((resolve) => resolve(m.columns));
        break;
      }
      case 'history':
        renderHistory(m.entries);
        break;
      case 'busy':
        setBusy(true);
        break;
      case 'report':
        renderReport(m.report);
        break;
      case 'error':
        renderError(m.error);
        break;
      case 'idle':
        setBusy(false);
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });

  // ---------------------------------------------------------------- tenants
  function renderTenants(tenants, activeAlias) {
    tenantSelect.disabled = tenants.length === 0;
    if (tenants.length === 0) {
      tenantSelect.replaceChildren(el('option', {}, 'No tenant configured'));
      return;
    }
    // "Alias · connection name": the tenant's default connection, so it's clear where you are.
    tenantSelect.replaceChildren(
      ...tenants.map((t) => el('option', { value: t.alias }, t.connectionName ? `${t.alias} · ${t.connectionName}` : t.alias)),
    );
    tenantSelect.value = tenants.some((t) => t.alias === activeAlias) ? activeAlias : tenants[0].alias;
  }

  // ---------------------------------------------------------------- history
  /** Clicking a row loads it into the editor for review — it does NOT run it. The inline ▶ button
   *  is the one-click "load and run" shortcut, for when you do trust it as-is. */
  function renderHistory(entries) {
    const section = $('history');
    section.classList.toggle('hidden', entries.length === 0);
    $('historyList').replaceChildren(
      ...entries.map((h) => {
        const applyEntry = () => {
          inputs.connectionGuid.value = h.connectionGuid;
          inputs.databaseName.value = h.databaseName;
          cm.setValue(h.query);
          persist();
          syncConnectionUI();
          requestDatabases(false);
          warmTables();
        };
        // A history entry belongs to whichever tenant was active when it ran — loading its
        // connectionGuid/databaseName as-is while a *different* tenant is active would query the
        // right-looking connection through the wrong tenant's pipeline/workspace/credentials.
        // Switch first when needed; 'init' picks pendingHistoryAction back up once the switch lands.
        const load = (execute) => {
          if (h.tenantAlias && h.tenantAlias !== currentTenantAlias) {
            pendingHistoryAction = { entry: h, execute };
            vscode.postMessage({ type: 'switchTenant', alias: h.tenantAlias });
            return;
          }
          applyEntry();
          if (execute) run();
        };
        return el(
          'li',
          { className: 'history-item', onclick: () => load(false), title: 'Load into the editor without running' },
          el(
            'div',
            { className: 'history-text' },
            el('span', { className: h.succeeded ? '' : 'failed-marker' }, h.succeeded ? '✓' : '✗'),
            ' ',
            el('code', {}, h.query.length > 80 ? `${h.query.slice(0, 80)}…` : h.query),
            el(
              'span',
              { className: 'meta' },
              `${h.tenantAlias} — ${new Date(h.timestamp).toLocaleString()}`,
            ),
          ),
          el(
            'button',
            {
              className: 'icon-btn secondary history-run',
              title: 'Load and run',
              onclick: (e) => {
                e.stopPropagation();
                load(true);
              },
            },
            icon('play'),
          ),
        );
      }),
    );
  }

  // ---------------------------------------------------------------- status
  // Only a live "Running…" indicator while a query is in flight — no timings or run details are
  // kept once it finishes (explicit request: no query-log block in the results).
  function setBusy(busy) {
    document.querySelectorAll('header button, .card-toolbar button, .context-bar button, .context-bar select')
      .forEach((b) => (b.disabled = b.id === 'cancel' ? !busy : busy));
    $('status').classList.toggle('hidden', !busy);
    if (busy) {
      for (const id of ['error', 'alertBanner']) $(id).classList.add('hidden');
      $('result').replaceChildren();
      startedAt = performance.now();
      tick();
      timer = window.setInterval(tick, 200);
    } else {
      window.clearInterval(timer);
    }
  }

  function tick() {
    $('elapsed').textContent = `${Math.floor((performance.now() - startedAt) / 1000)} s`;
  }

  // ---------------------------------------------------------------- rendering
  function renderError(error) {
    const [title, hint] = ERROR_TITLES[error.kind] || ERROR_TITLES.unexpected;
    const box = $('error');
    box.classList.remove('hidden');
    box.replaceChildren(
      el('div', { className: 'error-title' }, el('span', { className: `badge kind-${error.kind}` }, error.kind), ` ${title}`),
      el('div', { className: 'error-message' }, error.message),
      hint ? el('div', { className: 'hint' }, hint) : '',
      el(
        'div',
        { className: 'meta' },
        [
          error.errorCode && `errorCode: ${error.errorCode}`,
          error.httpStatus && `HTTP ${error.httpStatus}`,
          error.jobInstanceId && `job: ${error.jobInstanceId}`,
          error.requestId && `requestId: ${error.requestId}`,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
  }

  /** One run per report since V1 (runQuery.ts). Just the outcome: alerts, error or result tables. */
  function renderReport(report) {
    const r = report.runs[0];
    renderAlertBanner(r.checks);
    if (!r.succeeded && r.error) renderError(r.error);
    $('result').replaceChildren(...r.activities.map((a) => resultTable(a, r.activities.length > 1)));
  }

  /** Surfaces only the checks a daily user needs to see; everything else lives in Diagnostics. */
  function renderAlertBanner(checks) {
    const relevant = checks.filter((c) => ALERT_MESSAGES[c.name] && (c.status === 'WARN' || c.status === 'FAIL'));
    const banner = $('alertBanner');
    banner.classList.toggle('hidden', relevant.length === 0);
    if (relevant.length === 0) {
      banner.replaceChildren();
      return;
    }
    banner.replaceChildren(
      el('ul', {}, ...relevant.map((c) => el('li', { className: c.status }, ALERT_MESSAGES[c.name](c)))),
    );
  }

  /** One block per query activity (Lookup / Script): header + export button, error if any, then its
   *  sortable/filterable table. */
  function resultTable(activity, showName) {
    const ok = activity.succeeded;
    const built = activity.columns.length ? buildDataTable(activity.columns, activity.rows) : null;
    const total = activity.rowsTruncatedInReport || activity.rows.length;

    const header = el(
      'div',
      { className: 'activity-title' },
      ok ? icon('pass-filled') : icon('error'),
      showName ? el('span', { className: 'activity-name' }, activity.activityName) : '',
      built ? built.countEl : el('span', { className: 'meta' }, `${total} row(s)`),
      el('span', { className: 'meta' }, `· ${activity.columns.length} column(s)`),
      el('span', { className: 'spacer' }),
      built
        ? el(
            'button',
            {
              className: 'secondary export',
              title: 'Export the rows currently shown (filter/sort applied)',
              onclick: () =>
                vscode.postMessage({
                  type: 'exportCsv',
                  activityName: activity.activityName,
                  columns: activity.columns,
                  rows: built.getVisibleRows(),
                }),
            },
            icon('save'),
            ' Export CSV',
          )
        : '',
    );
    const block = el('div', { className: 'activity card' }, header);
    if (!ok && activity.error) {
      const [title] = ERROR_TITLES[activity.errorKind] || ERROR_TITLES.unexpected;
      block.append(el('div', { className: 'error-message' }, `${title}: ${activity.error.message}`));
    }
    if (built) block.append(built.wrap);
    return block;
  }

  /**
   * A `<table>` with clickable sortable headers (none → asc → desc → none, one column at a time)
   * and a per-column text filter row right under the header — both live-updated client-side, no
   * round trip to the extension (rows are already in the webview). `countEl` reflects the current
   * visible/total count live; `getVisibleRows()` returns exactly what's on screen right now, so
   * "Exporter CSV" exports what the user actually filtered/sorted down to.
   */
  function buildDataTable(columns, allRows) {
    const state = { sortCol: null, sortDir: 1, filters: Object.fromEntries(columns.map((c) => [c, ''])) };
    let debounceTimer = 0;

    const headerCells = [];
    const headerRow = el('tr', {});
    const filterRow = el('tr', { className: 'filter-row' });
    const tbody = el('tbody', {});
    const countEl = el('span', { className: 'meta row-count' });

    function compute() {
      let out = allRows;
      const activeFilters = columns.filter((c) => state.filters[c]);
      if (activeFilters.length) {
        out = out.filter((row) => activeFilters.every((c) => cellText(row[c]).toLowerCase().includes(state.filters[c])));
      }
      if (state.sortCol) {
        const { sortCol, sortDir } = state;
        out = [...out].sort((a, b) => compareValues(a[sortCol], b[sortCol]) * sortDir);
      }
      return out;
    }

    function render() {
      const visible = compute();
      tbody.replaceChildren(...visible.map((row) => el('tr', {}, ...columns.map((c) => cell(row[c])))));
      countEl.textContent =
        visible.length === allRows.length ? `${allRows.length} row(s)` : `${visible.length} / ${allRows.length} row(s)`;
    }

    function updateSortIndicators() {
      headerCells.forEach((th, i) => {
        const arrow = /** @type {HTMLElement} */ (th.querySelector('.sort-arrow'));
        arrow.textContent = state.sortCol === columns[i] ? (state.sortDir === 1 ? '▲' : '▼') : '';
        th.classList.toggle('sorted', state.sortCol === columns[i]);
      });
    }

    columns.forEach((c) => {
      const th = el(
        'th',
        { className: 'sortable' },
        el('span', { className: 'th-label' }, c),
        el('span', { className: 'sort-arrow' }, ''),
      );
      th.addEventListener('click', () => {
        if (state.sortCol !== c) {
          state.sortCol = c;
          state.sortDir = 1;
        } else if (state.sortDir === 1) {
          state.sortDir = -1;
        } else {
          state.sortCol = null;
          state.sortDir = 1;
        }
        updateSortIndicators();
        render();
      });
      headerCells.push(th);
      headerRow.append(th);

      const filterInput = el('input', { type: 'text', placeholder: 'filter…', className: 'col-filter', spellcheck: false });
      filterInput.addEventListener('input', () => {
        state.filters[c] = filterInput.value.trim().toLowerCase();
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(render, 120);
      });
      filterRow.append(el('th', {}, filterInput));
    });

    render();

    const table = el('table', {}, el('thead', {}, headerRow, filterRow), tbody);
    return { wrap: el('div', { className: 'table-wrap' }, table), countEl, getVisibleRows: compute };
  }

  /** Numeric-aware, null-last comparison so sorting numbers/dates-as-strings behaves sanely. */
  function compareValues(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const [na, nb] = [Number(a), Number(b)];
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  function cell(v) {
    if (v === null || v === undefined) return el('td', { className: 'null' }, 'NULL');
    return el('td', {}, cellText(v));
  }

  function icon(name) {
    return el('i', { className: `codicon codicon-${name}` });
  }

  /** Minimal DOM builder; text is always inserted as text nodes (no innerHTML). */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c !== '' && c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }
})();
