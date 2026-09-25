// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DEFAULT_QUERY = 'SELECT TOP 10 name, create_date FROM sys.tables ORDER BY create_date DESC';

  const inputs = {
    connectionGuid: /** @type {HTMLInputElement} */ ($('connectionGuid')),
    databaseName: /** @type {HTMLInputElement} */ ($('databaseName')),
  };
  const tenantSelect = /** @type {HTMLSelectElement} */ ($('tenantSelect'));

  const PHASES = {
    auth: 'Authentification',
    triggering: 'Déclenchement du job',
    waiting: 'Attente de complétion',
    fetchingResult: 'Récupération du résultat',
    done: 'Terminé',
    failed: 'Échec',
  };
  const ERROR_TITLES = {
    config: ['Configuration invalide', 'Vérifier les paramètres GatePulse.'],
    auth: ["Échec d'authentification", 'Vérifier tenantId/clientId, la plateforme de redirection de l’app Entra, ou relancer le sign-in.'],
    permission: ['Permissions insuffisantes', 'Le compte doit avoir un rôle sur le workspace et les scopes Fabric consentis.'],
    trigger: ['Échec du déclenchement du pipeline', 'Voir errorCode ; vérifier workspaceId/pipelineId.'],
    rateLimit: ['Limitation de débit Fabric (429)', 'Trop de requêtes / jobs simultanés.'],
    timeout: ['Timeout', 'Le job n’a pas terminé dans le délai ; il a été annulé.'],
    cancelled: ['Annulé', ''],
    deduped: ['Job dédupliqué par Fabric', 'Fabric n’a pas exécuté ce job (statut Deduped).'],
    sql: ['Erreur SQL', 'La base a rejeté la requête.'],
    resultTooLarge: ['Résultat trop volumineux (> 4 Mo)', 'Le Lookup refuse les résultats de plus de 4 Mo : réduire les colonnes (éviter SELECT *) ou ajouter TOP / WHERE.'],
    connection: ['Erreur de connexion / gateway', 'GUID de connexion, gateway, identifiants ou base inaccessibles.'],
    pipelineFailed: ['Échec du pipeline', 'Erreur non classée : voir le message brut.'],
    resultRetrieval: ['Résultat non récupérable via API', 'Le job a tourné mais la sortie du Lookup n’a pas pu être lue.'],
    provisioning: ['Pipeline générique non utilisable', 'Un pipeline du bon nom existe dans ce workspace mais n’est pas valide (paramètres manquants, ou pas d’activité Lookup/Script) : le corriger ou le renommer à la main.'],
    network: ['Erreur réseau', ''],
    unexpected: ['Erreur inattendue', ''],
  };
  /** Reformulates the checks that matter day-to-day (V1-SCOPE.md §4.B) — everything else stays in Diagnostics. */
  const ALERT_MESSAGES = {
    SILENT_FAILURE: (c) => `${activityLabel(c)} : échec silencieux détecté — ${c.message.replace(/^\[.*?\]\s*/, '')}`,
    ROW_CAP: (c) => `${activityLabel(c)} : le résultat semble tronqué à 5000 lignes, sans erreur remontée par Fabric — ajouter TOP/WHERE ou vérifier le nombre de lignes attendu.`,
    PARAM_BINDING: (c) => `${activityLabel(c)} : la requête envoyée ne correspond pas à celle exécutée par le pipeline (valeurs par défaut probablement utilisées).`,
    CONNECTION_RESOLUTION: (c) => `${activityLabel(c)} : le pipeline a utilisé une connexion différente de celle sélectionnée.`,
    DATABASE_BINDING: (c) => `${activityLabel(c)} : la base sélectionnée n’a pas été retrouvée dans l’exécution — vérifier qu’elle est bien prise en compte.`,
  };
  function activityLabel(c) {
    return c.activity ? `[${c.activity}]` : 'Exécution';
  }

  // ---------------------------------------------------------------- state
  const saved = vscode.getState() || {};
  if (saved.connectionGuid) inputs.connectionGuid.value = saved.connectionGuid;
  if (saved.databaseName) inputs.databaseName.value = saved.databaseName;

  // eslint-disable-next-line no-undef
  const cm = CodeMirror($('queryEditor'), {
    value: saved.query || DEFAULT_QUERY,
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
    },
  });
  // The editor box is CSS-resizable (see .query-editor .CodeMirror { resize: vertical }); CodeMirror
  // doesn't notice a manual CSS resize on its own, so it needs a nudge to re-measure lines/gutter.
  new ResizeObserver(() => cm.refresh()).observe(cm.getWrapperElement());

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

  // ---------------------------------------------------------------- actions
  const conn = () => ({ connectionGuid: inputs.connectionGuid.value, databaseName: inputs.databaseName.value });
  function tryRun() {
    if (!(/** @type {HTMLButtonElement} */ ($('run')).disabled)) run();
  }
  const run = () => vscode.postMessage({ type: 'run', ...conn(), query: cm.getValue() });
  $('run').addEventListener('click', run);
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('pickConnection').addEventListener('click', () => vscode.postMessage({ type: 'pickConnection' }));
  $('showLogs').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'showLogs' })));
  $('openSettings').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'openSettings' })));
  tenantSelect.addEventListener('change', () => vscode.postMessage({ type: 'switchTenant', alias: tenantSelect.value }));
  $('addTenant').addEventListener('click', () => vscode.postMessage({ type: 'addTenant' }));

  // ---------------------------------------------------------------- database picker
  // Fired on blur/commit (not every keystroke) so a half-typed GUID never triggers a run.
  inputs.connectionGuid.addEventListener('change', () => requestDatabases(false));
  $('refreshDatabases').addEventListener('click', () => requestDatabases(true));

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

  // ---------------------------------------------------------------- messages
  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'init': {
        if (!inputs.connectionGuid.value) inputs.connectionGuid.value = m.defaults.connectionGuid || '';
        if (!inputs.databaseName.value) inputs.databaseName.value = m.defaults.databaseName || '';
        renderTenants(m.tenants, m.activeTenantAlias);
        const problems = m.configProblems.filter((p) => !p.startsWith('No tenant configured'));
        const banner = $('configProblems');
        banner.classList.toggle('hidden', problems.length === 0);
        banner.textContent = problems.length ? `Configuration incomplète : ${problems.join(' • ')}` : '';
        renderHistory(m.history || []);
        requestDatabases(false); // uses the panel-side cache if this connection was already resolved this session
        break;
      }
      case 'setConnectionGuid':
        inputs.connectionGuid.value = m.value;
        persist();
        requestDatabases(false);
        break;
      case 'databasesLoading':
        if (m.connectionGuid === inputs.connectionGuid.value.trim()) setDatabasesLoading(true);
        break;
      case 'databases':
        if (m.connectionGuid !== inputs.connectionGuid.value.trim()) break; // stale: field changed meanwhile
        setDatabasesLoading(false);
        renderDatabaseOptions(m.names);
        $('databaseHint').classList.toggle('hidden', !m.error);
        $('databaseHint').textContent = m.error ? 'Liste indisponible — saisie manuelle' : '';
        break;
      case 'history':
        renderHistory(m.entries);
        break;
      case 'busy':
        setBusy(true);
        break;
      case 'progress':
        onProgress(m.event);
        break;
      case 'report':
        renderReport(m.report, m.reportFile);
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
      tenantSelect.replaceChildren(el('option', {}, 'Aucun tenant configuré'));
      return;
    }
    tenantSelect.replaceChildren(...tenants.map((t) => el('option', { value: t.alias }, t.alias)));
    tenantSelect.value = tenants.some((t) => t.alias === activeAlias) ? activeAlias : tenants[0].alias;
  }

  // ---------------------------------------------------------------- history
  function renderHistory(entries) {
    const section = $('history');
    section.classList.toggle('hidden', entries.length === 0);
    $('historyList').replaceChildren(
      ...entries.map((h) =>
        el(
          'li',
          {
            onclick: () => {
              inputs.connectionGuid.value = h.connectionGuid;
              inputs.databaseName.value = h.databaseName;
              cm.setValue(h.query);
              persist();
              requestDatabases(false);
              run();
            },
          },
          el('span', { className: h.succeeded ? '' : 'failed-marker' }, h.succeeded ? '✓' : '✗'),
          ' ',
          el('code', {}, h.query.length > 80 ? `${h.query.slice(0, 80)}…` : h.query),
          el(
            'span',
            { className: 'meta' },
            `${h.tenantAlias} — ${new Date(h.timestamp).toLocaleString()}${h.durationMs !== undefined ? ` — ${(h.durationMs / 1000).toFixed(1)} s` : ''}`,
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- status
  function setBusy(busy) {
    document.querySelectorAll('header button, .card-toolbar button, .connection-card button')
      .forEach((b) => (b.disabled = b.id === 'cancel' ? !busy : busy));
    $('status').classList.remove('hidden');
    $('status').classList.toggle('busy', busy);
    if (busy) {
      for (const id of ['error', 'summary', 'alertBanner']) $(id).classList.add('hidden');
      $('result').replaceChildren();
      $('diagnostics').classList.add('hidden');
      $('statusText').textContent = 'Démarrage…';
      startedAt = performance.now();
      tick();
      timer = window.setInterval(tick, 100);
    } else {
      window.clearInterval(timer);
      tick();
    }
  }

  function tick() {
    $('elapsed').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
  }

  function onProgress(e) {
    $('statusText').textContent =
      `${PHASES[e.phase] || e.phase}${e.jobStatus ? ` — job ${e.jobStatus}` : ''}${e.pollCount ? ` (poll #${e.pollCount})` : ''}`;
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

  /** One run per report since V1 (runQuery.ts) — no more P1-P4 scenario chips (V1-SCOPE.md §4.A). */
  function renderReport(report, reportFile) {
    const r = report.runs[0];
    const summary = $('summary');
    summary.classList.remove('hidden');
    summary.replaceChildren(
      el('div', { className: 'meta' }, `${(report.wallClockMs / 1000).toFixed(1)} s — rapport : ${reportFile}`),
      timingsBlock(r.timings),
    );
    if (!r.succeeded && r.error) renderError(r.error);

    renderAlertBanner(r.checks);
    const diagnostics = $('diagnostics');
    diagnostics.classList.remove('hidden');
    $('diagnosticsList').replaceChildren(...checksListItems(r.checks));

    $('result').replaceChildren(...r.activities.map(resultTable));
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

  function timingsBlock(t) {
    const s = (ms) => (ms === undefined || ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
    const items = [
      ['Total', t.totalMs, true],
      ['Déclenchement', t.triggerMs],
      ['Attente', t.waitMs],
      ['Résultat', t.resultMs],
      ['File Fabric', t.fabricQueueMs],
      ['Run Fabric', t.fabricRunMs],
      ...Object.entries(t.activityMs || {}).map(([name, ms]) => [name, ms]),
      ['Auth (exclu)', t.authMs],
    ];
    return el(
      'div',
      { className: 'timings' },
      ...items.map(([label, v, strong]) =>
        el('div', { className: `metric${strong ? ' strong' : ''}` }, el('div', { className: 'v' }, s(v)), el('div', { className: 'l' }, label)),
      ),
      el('div', { className: 'metric' }, el('div', { className: 'v' }, String(t.pollCount)), el('div', { className: 'l' }, 'Polls')),
    );
  }

  function checksListItems(checks) {
    return checks.map((c) =>
      el('li', {}, el('span', { className: `chip ${c.status}` }, `${c.point} ${c.status}`), el('code', {}, c.name), ` ${c.message}`),
    );
  }

  /** One block per query activity (Lookup / Script): header + export button, error if any, then its
   *  sortable/filterable table. */
  function resultTable(activity) {
    const ok = activity.succeeded;
    const built = activity.columns.length ? buildDataTable(activity.columns, activity.rows) : null;
    const total = activity.rowsTruncatedInReport || activity.rows.length;

    const header = el(
      'h3',
      { className: 'activity-title' },
      el('span', { className: `chip ${ok ? 'PASS' : 'FAIL'}` }, ok ? 'OK' : activity.errorKind || activity.status),
      ` ${activity.activityName} `,
      el(
        'span',
        { className: 'meta' },
        `<${activity.activityType}>${activity.durationInMs !== undefined ? ` — ${(activity.durationInMs / 1000).toFixed(2)} s` : ''} — ${activity.columns.length} colonne(s) — `,
      ),
      built ? built.countEl : el('span', { className: 'meta' }, `${total} ligne(s)`),
      el('span', { className: 'spacer' }),
      built
        ? el(
            'button',
            {
              className: 'secondary export',
              title: 'Exporter les lignes actuellement affichées (filtre/tri appliqués)',
              onclick: () =>
                vscode.postMessage({
                  type: 'exportCsv',
                  activityName: activity.activityName,
                  columns: activity.columns,
                  rows: built.getVisibleRows(),
                }),
            },
            icon('save'),
            ' Exporter CSV',
          )
        : '',
    );
    const block = el('div', { className: 'activity' }, header);
    if (!ok && activity.error) {
      const [title] = ERROR_TITLES[activity.errorKind] || ERROR_TITLES.unexpected;
      block.append(el('div', { className: 'error-message' }, `${title} : ${activity.error.message}`));
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
        visible.length === allRows.length ? `${allRows.length} ligne(s)` : `${visible.length} / ${allRows.length} ligne(s)`;
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

      const filterInput = el('input', { type: 'text', placeholder: 'filtrer…', className: 'col-filter', spellcheck: false });
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
