// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const inputs = {
    connectionGuid: /** @type {HTMLInputElement} */ ($('connectionGuid')),
    databaseName: /** @type {HTMLInputElement} */ ($('databaseName')),
    query: /** @type {HTMLTextAreaElement} */ ($('query')),
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
  for (const k of Object.keys(inputs)) if (saved[k]) inputs[k].value = saved[k];
  const persist = () =>
    vscode.setState({
      connectionGuid: inputs.connectionGuid.value,
      databaseName: inputs.databaseName.value,
      query: inputs.query.value,
    });
  Object.values(inputs).forEach((el) => el.addEventListener('input', persist));

  let timer = 0;
  let startedAt = 0;

  // ---------------------------------------------------------------- actions
  const conn = () => ({ connectionGuid: inputs.connectionGuid.value, databaseName: inputs.databaseName.value });
  const run = () => vscode.postMessage({ type: 'run', ...conn(), query: inputs.query.value });
  $('run').addEventListener('click', run);
  inputs.query.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!(/** @type {HTMLButtonElement} */ ($('run')).disabled)) run();
    }
  });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('pickConnection').addEventListener('click', () => vscode.postMessage({ type: 'pickConnection' }));
  $('showLogs').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'showLogs' })));
  $('openSettings').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'openSettings' })));
  tenantSelect.addEventListener('change', () => vscode.postMessage({ type: 'switchTenant', alias: tenantSelect.value }));
  $('addTenant').addEventListener('click', () => vscode.postMessage({ type: 'addTenant' }));

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
        break;
      }
      case 'setConnectionGuid':
        inputs.connectionGuid.value = m.value;
        persist();
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
              inputs.query.value = h.query;
              persist();
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
    document.querySelectorAll('button').forEach((b) => (b.disabled = b.id === 'cancel' ? !busy : busy));
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

  /** One block per query activity (Lookup / Script): header + export button, error if any, then its rows. */
  function resultTable(activity) {
    const ok = activity.succeeded;
    const shown = activity.rows.length;
    const total = activity.rowsTruncatedInReport || shown;
    const header = el(
      'h3',
      { className: 'activity-title' },
      el('span', { className: `chip ${ok ? 'PASS' : 'FAIL'}` }, ok ? 'OK' : activity.errorKind || activity.status),
      ` ${activity.activityName} `,
      el(
        'span',
        { className: 'meta' },
        `<${activity.activityType}> — ${total} ligne(s)${total !== shown ? ` (${shown} affichées)` : ''} — ${activity.columns.length} colonne(s)${activity.durationInMs !== undefined ? ` — ${(activity.durationInMs / 1000).toFixed(2)} s` : ''}`,
      ),
      el('span', { className: 'spacer' }),
      activity.columns.length
        ? el(
            'button',
            {
              className: 'secondary export',
              onclick: () =>
                vscode.postMessage({
                  type: 'exportCsv',
                  activityName: activity.activityName,
                  columns: activity.columns,
                  rows: activity.rows,
                }),
            },
            'Exporter CSV',
          )
        : '',
    );
    const block = el('div', { className: 'activity' }, header);
    if (!ok && activity.error) {
      const [title] = ERROR_TITLES[activity.errorKind] || ERROR_TITLES.unexpected;
      block.append(el('div', { className: 'error-message' }, `${title} : ${activity.error.message}`));
    }
    if (activity.columns.length) {
      const table = el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...activity.columns.map((c) => el('th', {}, c)))),
        el('tbody', {}, ...activity.rows.map((row) => el('tr', {}, ...activity.columns.map((c) => cell(row[c]))))),
      );
      block.append(el('div', { className: 'table-wrap' }, table));
    }
    return block;
  }

  function cell(v) {
    if (v === null || v === undefined) return el('td', { className: 'null' }, 'NULL');
    return el('td', {}, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  /** Minimal DOM builder; text is always inserted as text nodes (no innerHTML). */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c !== '' && c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }
})();
