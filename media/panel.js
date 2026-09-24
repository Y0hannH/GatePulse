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
    resultRetrieval: ['Résultat non récupérable via API', 'Le job a tourné mais la sortie du Lookup n’a pas pu être lue (point P1).'],
    provisioning: ['Pipeline générique non utilisable', 'Un pipeline du bon nom existe dans ce workspace mais n’est pas valide (paramètres manquants, ou pas d’activité Lookup/Script) : le corriger ou le renommer à la main.'],
    network: ['Erreur réseau', ''],
    unexpected: ['Erreur inattendue', ''],
  };

  // ---------------------------------------------------------------- state
  const saved = vscode.getState() || {};
  for (const k of Object.keys(inputs)) if (saved[k]) inputs[k].value = saved[k];
  const persist = () => vscode.setState({ connectionGuid: inputs.connectionGuid.value, databaseName: inputs.databaseName.value, query: inputs.query.value });
  Object.values(inputs).forEach((el) => el.addEventListener('input', persist));

  let timer = 0;
  let startedAt = 0;
  /** @type {Map<string, any>} */
  const runs = new Map();

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
  document.querySelectorAll('button.scenario').forEach((b) =>
    b.addEventListener('click', () => vscode.postMessage({ type: 'scenario', name: /** @type {HTMLElement} */ (b).dataset.scenario, ...conn() })),
  );
  $('showLogs').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'showLogs' })));
  $('openSettings').addEventListener('click', (e) => (e.preventDefault(), vscode.postMessage({ type: 'openSettings' })));

  // ---------------------------------------------------------------- messages
  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'init': {
        if (!inputs.connectionGuid.value) inputs.connectionGuid.value = m.defaults.connectionGuid || '';
        if (!inputs.databaseName.value) inputs.databaseName.value = m.defaults.databaseName || '';
        const banner = $('configProblems');
        banner.classList.toggle('hidden', m.configProblems.length === 0);
        banner.textContent = m.configProblems.length ? `Configuration incomplète : ${m.configProblems.join(' • ')}` : '';
        break;
      }
      case 'busy':
        setBusy(true, m.scenario);
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

  // ---------------------------------------------------------------- status
  function setBusy(busy, scenario) {
    document.querySelectorAll('button').forEach((b) => (b.disabled = b.id === 'cancel' ? !busy : busy));
    $('status').classList.remove('hidden');
    $('status').classList.toggle('busy', busy);
    if (busy) {
      runs.clear();
      $('runs').replaceChildren();
      for (const id of ['error', 'summary']) $(id).classList.add('hidden');
      $('result').replaceChildren();
      $('statusText').textContent = scenario === 'single' ? 'Démarrage…' : `Scénario « ${scenario} » en cours…`;
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
    runs.set(e.runLabel, e);
    const text = (r) =>
      `${PHASES[r.phase] || r.phase}${r.jobStatus ? ` — job ${r.jobStatus}` : ''}${r.pollCount ? ` (poll #${r.pollCount})` : ''}${r.jobInstanceId ? ` — ${r.jobInstanceId}` : ''}`;
    if (runs.size === 1) {
      $('statusText').textContent = text(e);
      return;
    }
    $('statusText').textContent = `${runs.size} run(s)`;
    $('runs').replaceChildren(
      ...[...runs.values()].map((r) => el('div', { className: `run ${r.phase}` }, el('b', {}, r.runLabel), ` ${(r.elapsedMs / 1000).toFixed(1)} s — ${text(r)}`)),
    );
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
      el('div', { className: 'meta' }, [error.errorCode && `errorCode: ${error.errorCode}`, error.httpStatus && `HTTP ${error.httpStatus}`, error.jobInstanceId && `job: ${error.jobInstanceId}`, error.requestId && `requestId: ${error.requestId}`].filter(Boolean).join(' · ')),
    );
  }

  function renderReport(report, reportFile) {
    const summary = $('summary');
    summary.classList.remove('hidden');
    const isSingle = report.scenario === 'single';

    const verdicts = el('div', { className: 'verdicts' },
      ...['P1', 'P2', 'P3', 'P4'].filter((p) => report.verdicts[p]).map((p) => el('span', { className: `chip ${report.verdicts[p]}` }, `${p} ${report.verdicts[p]}`)),
      el('span', { className: 'meta' }, ` ${isSingle ? '' : `scénario ${report.scenario} — `}${(report.wallClockMs / 1000).toFixed(1)} s — rapport : ${reportFile}`),
    );
    summary.replaceChildren(verdicts);

    if (isSingle) {
      const r = report.runs[0];
      if (!r.succeeded && r.error) renderError(r.error);
      summary.append(timingsBlock(r.timings), checksList(r.checks));
      $('result').replaceChildren(...r.activities.map(resultTable));
      return;
    }
    summary.append(checksList(report.checks));
    $('result').replaceChildren(
      ...report.runs.map((r) =>
        el('details', { className: 'run-detail' },
          el('summary', {}, el('span', { className: `chip ${r.succeeded ? 'PASS' : 'FAIL'}` }, r.succeeded ? 'OK' : r.error ? r.error.kind : 'KO'), ` ${r.runLabel} — ${r.timings.totalMs !== undefined ? `${(r.timings.totalMs / 1000).toFixed(2)} s` : 'n/a'} — ${r.jobInstanceId || ''}`),
          r.error ? el('div', { className: 'error-message' }, r.error.message) : '',
          el('pre', { className: 'query' }, r.params.query),
          timingsBlock(r.timings),
          checksList(r.checks),
          ...r.activities.map(resultTable),
        ),
      ),
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
    return el('div', { className: 'timings' },
      ...items.map(([label, v, strong]) => el('div', { className: `metric${strong ? ' strong' : ''}` }, el('div', { className: 'v' }, s(v)), el('div', { className: 'l' }, label))),
      el('div', { className: 'metric' }, el('div', { className: 'v' }, String(t.pollCount)), el('div', { className: 'l' }, 'Polls')),
    );
  }

  function checksList(checks) {
    return el('ul', { className: 'checks' },
      ...checks.map((c) => el('li', {}, el('span', { className: `chip ${c.status}` }, `${c.point} ${c.status}`), el('code', {}, c.name), ` ${c.message}`)),
    );
  }

  /** One block per query activity (Lookup / Script): header, error if any, then its rows. */
  function resultTable(activity) {
    const ok = activity.succeeded;
    const shown = activity.rows.length;
    const total = activity.rowsTruncatedInReport || shown;
    const header = el('h3', { className: 'activity-title' },
      el('span', { className: `chip ${ok ? 'PASS' : 'FAIL'}` }, ok ? 'OK' : activity.errorKind || activity.status),
      ` ${activity.activityName} `,
      el('span', { className: 'meta' }, `<${activity.activityType}> — ${total} ligne(s)${total !== shown ? ` (${shown} affichées)` : ''} — ${activity.columns.length} colonne(s)${activity.durationInMs !== undefined ? ` — ${(activity.durationInMs / 1000).toFixed(2)} s` : ''}`),
    );
    const block = el('div', { className: 'activity' }, header);
    if (!ok && activity.error) {
      const [title] = ERROR_TITLES[activity.errorKind] || ERROR_TITLES.unexpected;
      block.append(el('div', { className: 'error-message' }, `${title} : ${activity.error.message}`));
    }
    if (activity.columns.length) {
      const table = el('table', {},
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
