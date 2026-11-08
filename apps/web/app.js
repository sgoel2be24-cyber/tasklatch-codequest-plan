// TaskLatch operator workspace. Plain ES modules, no build step.
// All dynamic text is escaped with esc(); the UI never renders agent-supplied HTML.

const $app = document.getElementById('app');
const $live = document.getElementById('live');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (minor) => (minor === null || minor === undefined ? 'unknown' : '₹' + (minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '—');
const short = (h, n = 12) => (h ? String(h).replace('sha256:', '').slice(0, n) + '…' : '—');

let state = { me: null, catalog: null, snap: null, sid: null, tab: 'overview', poll: null, lastStatus: null, artifactCache: new Map(), historyFilter: 'all' };

// ---------------------------------------------------------------- API
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { state.me = null; renderLogin(); throw new Error('unauthenticated'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(data?.message || data?.error || `HTTP ${r.status}`); e.data = data; e.status = r.status; throw e; }
  return data;
}
function announce(msg) { $live.textContent = ''; setTimeout(() => { $live.textContent = msg; }, 30); }

// ---------------------------------------------------------------- status vocabulary (text + icon, never colour alone)
const SESSION_CHIP = {
  DRAFT: ['neutral', '✎', 'Reviewing scope'], READY: ['neutral', '○', 'Ready'], RUNNING: ['info', '▶', 'Running'],
  AWAITING_APPROVAL: ['warn', '⏸', 'Waiting for your approval'], VERIFYING: ['info', '⟳', 'Being verified'],
  SUCCEEDED: ['ok', '✓', 'Verified'], PARTIAL: ['warn', '◐', 'Partly verified'], FAILED: ['bad', '✕', 'Failed'],
  CANCELLED: ['neutral', '■', 'Cancelled'], BUDGET_EXHAUSTED: ['bad', '⛁', 'Budget exhausted'],
  NEEDS_VERIFICATION: ['warn', '?', 'Could not verify'], STOP_REQUESTED: ['warn', '■', 'Stop requested'], INTERRUPTED: ['warn', '⚡', 'Interrupted'],
};
const DECISION_CHIP = { ALLOW: ['ok', '✓', 'Allowed'], REQUIRE_APPROVAL: ['warn', '⏸', 'Needs your approval'], DENY: ['bad', '⛔', 'Blocked'] };
const VERIFY_CHIP = {
  verified: ['ok', '✓', 'Verified'], failed: ['bad', '✕', 'Failed'], partial: ['warn', '◐', 'Partly verified'],
  could_not_verify: ['warn', '?', 'Could not verify'], missing: ['bad', '∅', 'Missing'], not_required: ['neutral', '–', 'Not required'],
};
const TASK_CHIP = {
  ready: ['neutral', '○', 'Ready'], running: ['info', '▶', 'Running'], submitted: ['info', '⟳', 'Submitted for verification'],
  verified: ['ok', '✓', 'Verified'], partial: ['warn', '◐', 'Incomplete'], failed: ['bad', '✕', 'Unsuccessful'],
  cancelled: ['neutral', '■', 'Cancelled'], out_of_budget: ['bad', '⛁', 'Out of budget'], awaiting_approval: ['warn', '⏸', 'Needs your approval'],
  waiting: ['warn', '⏸', 'Waiting'], rejected: ['neutral', '✕', 'Rejected by you'], expired: ['neutral', '⌛', 'Expired'],
  invalidated: ['warn', '!', 'Needs a new decision'], uncertain: ['warn', '?', 'Could not verify'], blocked: ['bad', '⛔', 'Blocked'],
  interrupted: ['warn', '⚡', 'Interrupted'], done: ['neutral', '•', 'Done'],
};
const WORKER_CHIP = {
  idle: ['neutral', '○', 'Idle'], starting: ['info', '…', 'Starting'], browsing: ['info', '▶', 'Browsing'], reading: ['info', '▶', 'Reading'],
  extracting: ['info', '▶', 'Extracting'], writing: ['info', '▶', 'Saving'], waiting: ['warn', '⏸', 'Waiting'], blocked: ['bad', '⛔', 'Blocked action'],
  done: ['ok', '✓', 'Done'], failed: ['bad', '✕', 'Unsuccessful'], stopped: ['neutral', '■', 'Stopped'], disconnected: ['bad', '⚡', 'Disconnected'],
  out_of_budget: ['bad', '⛁', 'Out of budget'], out_of_steps: ['bad', '⛁', 'Step limit reached'],
};
const APPROVAL_CHIP = {
  pending: ['warn', '⏸', 'Pending your decision'], approved: ['ok', '✓', 'Approved'], consumed: ['ok', '✓', 'Approved · used once'],
  rejected: ['neutral', '✕', 'Rejected'], expired: ['neutral', '⌛', 'Expired'], cancelled: ['neutral', '■', 'Cancelled'],
  superseded: ['neutral', '↻', 'Replaced by a changed request'], invalidated: ['warn', '!', 'Invalidated — details changed'],
};
const SUB_CHIP = { submitting: ['info', '…', 'Submitting'], saved: ['ok', '✓', 'Saved in SupplierLab'], uncertain: ['warn', '?', 'Outcome uncertain'], failed: ['bad', '✕', 'Refused by SupplierLab'] };
const PROV_CHIP = { observed: ['info', '👁', 'TaskLatch observed'], agent_statement: ['neutral', '💬', 'Agent said'], policy_decision: ['outline', '⚖', 'Policy'], operator_decision: ['ok', '👤', 'You decided'] };
const READY_CHIP = { ready: ['ok', '✓', 'Ready'], limited: ['warn', '!', 'Limited'], unavailable: ['bad', '✕', 'Unavailable'] };
function chip(map, key, extra = '') {
  const [cls, icon, label] = map[key] || ['neutral', '•', key];
  return `<span class="chip ${cls}" data-icon="${icon}"${extra}>${esc(label)}</span>`;
}
const ACTIVE = new Set(['RUNNING', 'AWAITING_APPROVAL', 'VERIFYING', 'STOP_REQUESTED']);
const TERMINAL = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED', 'NEEDS_VERIFICATION']);

// ---------------------------------------------------------------- confirm dialog (native modal <dialog>)
function confirmDialog(title, bodyHtml, okLabel, danger = false) {
  const d = document.getElementById('confirm');
  d.querySelector('#confirm-title').textContent = title;
  d.querySelector('#confirm-body').innerHTML = bodyHtml;
  const ok = d.querySelector('#confirm-ok');
  ok.textContent = okLabel; ok.className = danger ? 'danger' : 'primary';
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => { const v = d.returnValue; d.returnValue = ''; resolve(v === 'ok'); }, { once: true }));
}

// ---------------------------------------------------------------- routing
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  clearInterval(state.poll); state.poll = null;
  document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
  if (!state.me) return renderLogin();
  if (parts[0] === 'new') { document.querySelector('[data-nav=new]').setAttribute('aria-current', 'page'); return renderNew(); }
  if (parts[0] === 's' && parts[1]) { state.sid = parts[1]; state.tab = parts[2] || null; return openSession(); }
  document.querySelector('[data-nav=home]').setAttribute('aria-current', 'page');
  return renderHome();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

async function boot() {
  try { state.me = (await api('GET', '/api/me')).operator; } catch { state.me = null; }
  document.getElementById('who').textContent = state.me ? `Signed in as ${state.me.name}` : '';
  route();
}

// ---------------------------------------------------------------- login
function renderLogin() {
  const expired = location.search.includes('login=expired');
  $app.innerHTML = `<div class="card" style="max-width:560px;margin:40px auto">
    <h1>Sign in to TaskLatch</h1>
    ${expired ? '<div class="banner warn"><span class="icon">!</span><div><b>That sign-in link was already used or has expired.</b></div></div>' : ''}
    <p class="muted">TaskLatch runs only on this computer. Open the one-time sign-in link printed by <code>npm start</code>, or paste the operator token from <code>.runtime/secrets/operator-op_local.token</code>.</p>
    <form id="login" class="stack"><div><label for="tok">Operator token</label><input id="tok" type="password" autocomplete="off" required></div>
    <button class="primary" type="submit">Sign in</button><p id="login-err" class="muted" role="alert"></p></form></div>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', { token: document.getElementById('tok').value.trim() }); history.replaceState(null, '', '/#/'); boot(); }
    catch (err) { document.getElementById('login-err').textContent = err.message; }
  });
}

// ---------------------------------------------------------------- home: readiness + tasks
async function renderHome() {
  $app.innerHTML = `<div class="grid two"><section class="card" aria-labelledby="ready-h"><h2 id="ready-h">Readiness</h2><p class="muted small">Checking local desktops, storage, SupplierLab and model access…</p></section>
    <section class="card" aria-labelledby="tasks-h"><div class="row between"><h2 id="tasks-h">Tasks</h2><a class="btn primary" href="#/new">New task</a></div><div id="tasklist" class="muted">Loading…</div></section></div>`;
  const [ready, list] = await Promise.all([api('GET', '/api/readiness').catch((e) => ({ error: e.message })), api('GET', '/api/sessions')]);
  const readyEl = $app.querySelector('[aria-labelledby=ready-h]');
  readyEl.innerHTML = ready.error ? `<h2 id="ready-h">Readiness</h2><p>${esc(ready.error)}</p>` : `<h2 id="ready-h">Readiness</h2>
    <p class="muted small">Checked ${time(ready.checked_at)}. ${ready.items.find((i) => i.id === 'model')?.paid ? 'Desktops, storage and SupplierLab run locally; model calls go to a paid provider.' : 'Everything runs locally; no paid services are used.'}</p>
    <ul class="ready-list">${ready.items.map((i) => `<li><div><b>${esc(i.label)}</b><br>${chip(READY_CHIP, i.status)}</div><div class="small">${esc(i.detail)}</div></li>`).join('')}</ul>
    ${ready.items.find((i) => i.id === 'model')?.paid ? `<div class="banner warn" style="margin:12px 0 0"><span class="icon">$</span><div><b>Paid model provider in use.</b><p>${esc(ready.items.find((i) => i.id === 'model').provider)}. Every task runs under a token ceiling from the shared allowance; check your Fireworks balance and limits before starting.</p></div></div>` : ''}
    ${ready.items.find((i) => i.id === 'model')?.status !== 'ready' && !ready.items.find((i) => i.id === 'model')?.paid ? `<div class="banner warn" style="margin:12px 0 0"><span class="icon">!</span><div><b>No model access configured.</b><p>Agents use a deterministic <em>local-rules</em> stand-in. Its decisions still go through the same permissions, allowance and verification, and every record is labelled. Set <code>NVIDIA_API_KEY</code> to use a hosted model.</p></div></div>` : ''}`;
  const el = document.getElementById('tasklist');
  if (!list.sessions.length) { el.innerHTML = `<div class="empty">No tasks yet. Create one to delegate supplier research.</div>`; return; }
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Expected result</th><th>Status</th><th>Created</th></tr></thead><tbody>
    ${list.sessions.map((s) => `<tr><td><a href="#/s/${esc(s.id)}">${esc(s.title)}</a><div class="muted small">${esc(s.scenario.replace(/_/g, ' '))} scenario · <code>${esc(s.id)}</code></div></td>
      <td>${esc({ comparison: 'Comparison', draft: 'Comparison + draft', submission: 'Approved submission' }[s.expected_result])}</td><td>${chip(SESSION_CHIP, s.status)}</td><td class="small">${dateTime(s.created_at)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- new task
// ---------------------------------------------------------------- session shell
const TABS = [['overview', 'Status'], ['scope', 'Scope'], ['desktops', 'Desktops'], ['approval', 'Approval'], ['usage', 'Usage & stop'], ['results', 'Results & evidence'], ['history', 'History']];

async function openSession() {
  try { state.snap = await api('GET', `/api/sessions/${state.sid}`); }
  catch (e) { $app.innerHTML = `<div class="card"><h1>Task not found</h1><p class="muted">${esc(e.message)}</p><a href="#/">Back to tasks</a></div>`; return; }
  state.lastStatus = state.snap.session.status;
  if (!state.tab) state.tab = state.snap.session.scope.runtime === 'desktop' ? (['DRAFT', 'READY'].includes(state.snap.session.status) ? 'scope' : 'live') : 'overview';
  renderSession();
  state.poll = setInterval(refresh, 1000);
}

async function refresh() {
  if (document.querySelector('dialog[open]') || document.activeElement?.matches('input, select, textarea')) return;
  try {
    const snap = await api('GET', `/api/sessions/${state.sid}`);
    const prev = state.snap;
    state.snap = snap;
    if (snap.session.status !== state.lastStatus) { announce(`Task status: ${SESSION_CHIP[snap.session.status]?.[2] || snap.session.status}`); state.lastStatus = snap.session.status; }
    tickCountdown();
    if (prev && signature(prev) === signature(snap)) return;
    if (state.tab === 'live' && prev && prev.session.status === snap.session.status && updateLive()) return;
    const y = window.scrollY; renderSession(); window.scrollTo(0, y);
  } catch { /* transient */ }
}

// Re-render only when something the operator can see has changed, so focus and refs stay stable.
function signature(sn) {
  return [sn.session.status, sn.session.stop_confirmed_at, sn.events.length, sn.workers.map((w) => w.updated_at).join(), sn.approvals.map((a) => a.status).join(),
    sn.submissions.map((x) => x.status).join(), Object.values(sn.verification).map((v) => v.created_at).join(), sn.replay.frames.length, sn.budget.time.elapsed_seconds >> 3,
    (sn.live || []).map((l) => l.worker_id + (l.live_url ? 'L' : '') + (l.paused ? 'P' : '') + l.proxy.blocked).join(), (sn.whiteboard || []).length].join('|');
}
function tickCountdown() {
  const el = document.getElementById('apv-left');
  const p = state.snap?.approvals.find((a) => a.status === 'pending');
  if (!el || !p) return;
  const left = Math.max(0, Math.round((Date.parse(p.expires_at) - Date.now()) / 1000));
  el.textContent = `${Math.floor(left / 60)}m ${left % 60}s`;
}

function renderSession() {
  const { session: s, approvals } = state.snap;
  const pending = approvals.filter((a) => a.status === 'pending').length;
  const canStop = !s.stop_requested_at && !TERMINAL.has(s.status) && s.status !== 'DRAFT' && s.status !== 'READY';
  const focusId = document.activeElement?.id;
  $app.innerHTML = `
    <div class="session-head"><div><p class="muted small" style="margin:0"><a href="#/">Tasks</a> / <code>${esc(s.id)}</code></p>
      <h1>${esc(s.title)}</h1>
      <div class="row"><span id="hdr-status">${chip(SESSION_CHIP, s.status)}</span> <span class="chip outline" data-icon="${s.scope.mode === 'web' ? '🌐' : '🧪'}">${s.scope.mode === 'web' ? 'web research' : esc(s.scope.scenario.replace(/_/g, ' ')) + ' scenario'}</span>${s.scope.runtime === 'desktop' ? ' <span class="chip outline" data-icon="🖥">' + s.plan.subtasks.length + ' Linux desktop' + (s.plan.subtasks.length > 1 ? 's' : '') + '</span>' : ''}
      <span class="chip ${state.snap.model.paid ? 'warn' : 'outline'}" data-icon="${state.snap.model.paid ? '$' : '⚙'}">${esc(state.snap.model.provider === 'local-rules' ? 'Local rules · no model inference' : state.snap.model.label)}</span></div></div>
      <div class="row">
        ${s.status === 'DRAFT' || s.status === 'READY' ? `<button class="primary big" id="btn-start">Start task</button>` : ''}
        ${s.status === 'INTERRUPTED' ? `<button class="primary big" id="btn-resume">Resume task</button>` : ''}
        ${canStop || s.status === 'INTERRUPTED' ? `<button class="danger big" id="btn-stop" aria-describedby="stop-help">■ Stop task</button>` : ''}
        ${s.stop_requested_at && !s.stop_confirmed_at ? `<span class="chip warn" data-icon="…">Stop requested — waiting for workers to stop</span>` : ''}
        ${s.stop_confirmed_at ? `<span class="chip neutral" data-icon="■">Stopped · all workers confirmed</span>` : ''}
      </div></div>
    <p id="stop-help" class="sr-only">Stops both workers, refuses new actions and cancels any pending approval.</p>
    ${outcomeBanner()}
    <nav class="tabs" aria-label="Task sections">${tabsFor(s).map(([k, l]) => `<a href="#/s/${esc(s.id)}/${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${l}${k === 'approval' && pending ? `<span class="count">${pending}</span>` : ''}</a>`).join('')}</nav>
    <section id="tab">${({ live: tabLive, board: tabBoard, overview: tabOverview, scope: isWeb() ? tabScopeWeb : tabScope, desktops: tabDesktops, approval: tabApproval, usage: tabUsage, results: isWeb() ? tabResultsWeb : tabResults, history: tabHistory }[state.tab] || (isDesktop() ? tabLive : tabOverview))()}</section>`;
  wireSession();
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
}

function outcomeBanner() {
  const s = state.snap.session;
  if (s.status === 'AWAITING_APPROVAL' && state.tab !== 'approval') return `<div class="banner warn"><span class="icon">⏸</span><div><b>A purchase request needs your decision.</b><p>Nothing is submitted until you approve it. <a href="#/s/${esc(s.id)}/approval">Review the request</a></p></div></div>`;
  if (s.status === 'INTERRUPTED') return `<div class="banner warn"><span class="icon">⚡</span><div><b>Interrupted.</b><p>The controller restarted while this task was active (${esc(s.status_reason || '')}). Previous state is shown below. Nothing resumes until you choose Resume.</p></div></div>`;
  if (s.status === 'BUDGET_EXHAUSTED' && !s.outcome) return `<div class="banner bad"><span class="icon">⛁</span><div><b>Budget exhausted.</b><p>No new work is accepted. Finishing verification of completed work…</p></div></div>`;
  if (!s.outcome) return '';
  const cls = { SUCCEEDED: 'ok', PARTIAL: 'warn', NEEDS_VERIFICATION: 'warn', FAILED: 'bad', BUDGET_EXHAUSTED: 'bad', CANCELLED: 'info' }[s.outcome.status] || 'info';
  const icon = SESSION_CHIP[s.outcome.status]?.[1] || '•';
  return `<div class="banner ${cls}"><span class="icon">${icon}</span><div><b>${esc(s.outcome.label)}.</b><p>${esc(s.outcome.summary)} ${Object.entries(s.outcome.deliverables).map(([k, v]) => `${esc(k)}: ${chip(VERIFY_CHIP, v)}`).join(' ')}</p></div></div>`;
}

function wireSession() {
  const s = state.snap.session;
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
  on('btn-start', async () => { await act(() => api('POST', `/api/sessions/${s.id}/start`)); location.hash = `#/s/${s.id}/${isDesktop() ? 'live' : 'desktops'}`; });
  on('btn-resume', () => act(() => api('POST', `/api/sessions/${s.id}/resume`)));
  on('btn-stop', async () => {
    const ok = await confirmDialog('Stop this task?', `<p>Both workers will stop, new actions will be refused and any pending approval will be cancelled. Work already completed is kept. A request SupplierLab has already saved stays saved.</p>`, 'Stop task', true);
    if (ok) await act(() => api('POST', `/api/sessions/${s.id}/stop`), 'Stop requested');
  });
  const handlers = { live: wireLive, scope: isWeb() ? wireScopeWeb : wireScope, approval: wireApproval, results: isWeb() ? wireResultsWeb : wireResults, history: wireHistory, usage: wireUsage };
  handlers[state.tab]?.();
}

async function act(fn, msg) {
  try { const r = await fn(); if (r?.session) state.snap = r; else if (r?.snapshot) state.snap = r.snapshot; else state.snap = await api('GET', `/api/sessions/${state.sid}`); if (msg) announce(msg); renderSession(); return r; }
  catch (e) { await confirmDialog('That did not work', `<p>${esc(e.message)}</p>`, 'OK'); state.snap = await api('GET', `/api/sessions/${state.sid}`); renderSession(); }
}

// ---------------------------------------------------------------- Status tab
function tabOverview() {
  const { tasks, workers, decision_counts: dc, budget, events } = state.snap;
  return `<div class="grid two">
    <section class="card"><h2>Task status</h2><div class="table-wrap"><table><thead><tr><th>Work item</th><th>Responsible</th><th>Status</th></tr></thead><tbody>
      ${tasks.map((t) => `<tr><td><b>${esc(t.title)}</b>${t.detail ? `<div class="muted small">${esc(t.detail)}</div>` : ''}</td><td>${esc(labelActor(t.assignee))}</td><td>${chip(TASK_CHIP, t.status)}</td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="card"><h2>Workers</h2>${workers.map((w) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><div><b>${esc(w.label)}</b> <span class="muted small">${esc(w.steps_used)} steps used</span><div class="small">${esc(w.activity || '')}</div></div>${chip(WORKER_CHIP, w.status)}</div>`).join('')}
      <h3 style="margin-top:16px">Permission decisions</h3><div class="row">${chip(DECISION_CHIP, 'ALLOW')} <b>${dc.allowed}</b> ${chip(DECISION_CHIP, 'REQUIRE_APPROVAL')} <b>${dc.needs_approval}</b> ${chip(DECISION_CHIP, 'DENY')} <b>${dc.blocked}</b></div>
      <h3 style="margin-top:16px">Shared allowance</h3>${meter('Model calls', budget.model_calls.used, budget.model_calls.in_progress, budget.model_calls.uncertain, budget.model_calls.limit)}</section>
  </div>
  <section class="card"><h2>Latest activity</h2>${timeline(events.slice(-12).reverse())}<p><a href="#/s/${esc(state.sid)}/history">Full history</a></p></section>`;
}
const labelActor = (a) => ({ 'worker-a': 'Worker A', 'worker-b': 'Worker B', 'worker-c': 'Worker C', 'worker-d': 'Worker D', coordinator: 'Coordinator', controller: 'TaskLatch controller', verifier: 'Verifier', operator: 'You', broker: 'Broker (controller)' }[a] || a);

// ---------------------------------------------------------------- Scope tab
function tabScope() {
  const { session: s } = state.snap;
  const sc = s.scope; const editable = s.status === 'DRAFT' || s.status === 'READY';
  const workers = Object.keys(sc.plan_assignments);
  const allWorkers = Array.from({ length: sc.limits.workers }, (_, i) => `worker-${String.fromCharCode(97 + i)}`);
  const L = sc.limits;
  return `
  <div class="banner info"><span class="icon">ⓘ</span><div><b>Preset: ${esc(sc.preset_label)}.</b><p>Agents may read the approved supplier pages and write files in their own task folder. <b>Creating a draft and submitting a purchase request are different actions:</b> ${sc.expected_result === 'submission' ? 'a submission will be prepared, and it is saved in SupplierLab only after you approve the exact request.' : 'this task ends with a draft; submission is blocked.'}</p></div></div>
  <div class="grid three">
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'ALLOW')}</h3><ul>${sc.actions.allowed.filter((a) => sc.expected_result !== 'comparison' || a.type !== 'request.prepare').map((a) => `<li>${esc(a.label)} <code class="muted">${esc(a.type)}</code></li>`).join('')}</ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'REQUIRE_APPROVAL')}</h3><ul>${sc.expected_result === 'submission' ? sc.actions.approval.map((a) => `<li>${esc(a.label)} <code class="muted">${esc(a.type)}</code></li>`).join('') : '<li>Nothing — this task cannot submit anything.</li>'}</ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'DENY')}</h3><ul>${sc.actions.blocked.map((a) => `<li>${esc(a.label)}</li>`).join('')}${sc.expected_result !== 'submission' ? '<li>Submitting a purchase request (not in this task’s scope)</li>' : ''}</ul></section>
  </div>
  <div class="grid two">
    <section class="card"><h2>Where agents may go and write</h2><dl class="kv">
      <dt>Allowed site</dt><dd>${sc.allowed_sites.map((x) => `<code>${esc(x)}</code>`).join(', ')}</dd>
      <dt>Approved pages</dt><dd>${sc.approved_sources.map((a) => `<div><code>${esc(a.path)}</code></div>`).join('')}</dd>
      <dt>Task files</dt><dd><code>${esc(sc.file_location)}</code></dd>
      <dt>Submission destination</dt><dd>${sc.expected_result === 'submission' ? esc(sc.destination_label) : '— (not in scope)'}</dd>
      <dt>Approval valid for</dt><dd>${sc.approval_ttl_seconds} seconds, one submission</dd>
      <dt>Policy version</dt><dd>v${s.policy_version}</dd></dl></section>
    <section class="card"><h2>Shared allowance</h2><p class="muted small">One allowance for both workers, the coordinator and retries.</p><dl class="kv">
      <dt>Workers</dt><dd>${L.workers}</dd><dt>Time limit</dt><dd>${Math.round(L.time_seconds / 60 * 10) / 10} minutes</dd>
      <dt>Steps per worker</dt><dd>${L.steps_per_worker}</dd><dt>Model calls</dt><dd>${L.model_calls} across the task</dd>
      <dt>Retries</dt><dd>up to ${L.retries_per_call} per failed call</dd><dt>Token ceiling</dt><dd>${L.token_ceiling ? L.token_ceiling.toLocaleString() : 'none'}</dd></dl>
      ${editable ? `<details style="margin-top:10px"><summary>Change limits</summary><div class="form-grid" style="margin-top:10px">
        ${['workers', 'time_seconds', 'steps_per_worker', 'model_calls', 'retries_per_call', 'token_ceiling'].map((k) => `<div><label for="sl-${k}">${k.replace(/_/g, ' ')}</label><input id="sl-${k}" type="number" value="${L[k] ?? ''}"></div>`).join('')}
        </div><button id="save-limits" style="margin-top:10px">Save limits</button></details>` : ''}</section>
  </div>
  <section class="card"><h2>Proposed division of work</h2><p class="muted">${esc(s.plan.rationale || '')}</p>
    <div class="table-wrap"><table><thead><tr><th>Approved source</th><th>Vendor</th><th>Assigned to</th></tr></thead><tbody>
    ${sc.approved_sources.map((a) => `<tr><td><code>${esc(a.source_id)}</code></td><td>${esc(sc.vendor_names[a.vendor_id] || a.vendor_id)}</td><td>${editable
      ? `<select data-assign="${esc(a.source_id)}" aria-label="Worker for ${esc(a.source_id)}">${allWorkers.map((w) => `<option value="${w}" ${sc.source_owner[a.source_id] === w ? 'selected' : ''}>${esc(labelActor(w))}</option>`).join('')}</select>`
      : esc(labelActor(sc.source_owner[a.source_id]))}</td></tr>`).join('')}</tbody></table></div>
    ${editable ? `<div class="row" style="margin-top:12px"><button id="save-plan">Save revised plan</button><button class="primary big" id="btn-start-2">Accept scope and start</button></div>` : `<p class="muted small">The scope is locked once the task starts.</p>`}
  </section>`;
}
function wireScope() {
  const s = state.snap.session;
  document.getElementById('save-plan')?.addEventListener('click', () => {
    const assignments = {};
    document.querySelectorAll('[data-assign]').forEach((sel) => { (assignments[sel.value] ||= []).push(sel.dataset.assign); });
    act(() => api('PATCH', `/api/sessions/${s.id}/scope`, { assignments }), 'Plan revised');
  });
  document.getElementById('save-limits')?.addEventListener('click', () => {
    const limits = {}; ['workers', 'time_seconds', 'steps_per_worker', 'model_calls', 'retries_per_call', 'token_ceiling'].forEach((k) => { limits[k] = Number(document.getElementById('sl-' + k).value); });
    act(() => api('PATCH', `/api/sessions/${s.id}/scope`, { limits }), 'Limits saved');
  });
  document.getElementById('btn-start-2')?.addEventListener('click', async () => { await act(() => api('POST', `/api/sessions/${s.id}/start`)); location.hash = `#/s/${s.id}/${isDesktop() ? 'live' : 'desktops'}`; });
}

// ---------------------------------------------------------------- Desktops tab
function tabDesktops() {
  const { workers, actions, findings, session: s } = state.snap;
  if (s.status === 'DRAFT' || s.status === 'READY') return `<div class="card empty">The desktops open when you start the task.</div>`;
  return `<p class="muted small">Each worker has its own headless Chromium browser context on this machine (separate cookies and storage). These are not containers. Screenshots are private to this task.</p>
  <div class="grid two">${workers.map((w) => {
    const mine = actions.filter((a) => a.actor === w.worker_id).slice(-14).reverse();
    const f = findings.filter((x) => x.author_agent === w.worker_id);
    return `<section class="card desktop" aria-label="${esc(w.label)} desktop">
      <div class="row between"><h2>${esc(w.label)}</h2>${chip(WORKER_CHIP, w.status)}</div>
      <div class="chrome"><div class="addr"><span class="dots" aria-hidden="true">●●●</span><span>${esc(w.current_url || 'about:blank')}</span></div>
      <div class="screen">${w.last_screenshot ? `<img alt="Latest screenshot from ${esc(w.label)}'s browser" src="/api/sessions/${esc(s.id)}/screens/${esc(w.last_screenshot)}">` : `<span>${s.recording ? 'No screenshot yet' : 'Screenshot recording is off'}</span>`}</div></div>
      <p class="activity">${esc(w.activity || '')}</p>
      <h3>Findings</h3>${f.length ? f.map(findingLine).join('') : '<p class="muted small">None yet.</p>'}
      <h3 style="margin-top:12px">Actions</h3><ul class="feed">${mine.map((a) => `<li><span class="t">${time(a.created_at)}</span>${chip(DECISION_CHIP, a.decision)}<span><code>${esc(a.action_type)}</code> ${esc(a.resource || '')}${a.decision === 'DENY' ? `<br><span class="muted">${esc(a.reason)}</span>` : ''}</span></li>`).join('') || '<li class="muted">No actions yet.</li>'}</ul>
    </section>`;
  }).join('')}</div>`;
}
function findingLine(f) {
  const st = f.status === 'observed' ? chip({ x: ['info', '💬', 'Reported'] }, 'x') : f.status === 'unavailable' ? chip({ x: ['warn', '⚠', 'Source unavailable'] }, 'x') : chip({ x: ['bad', '⛔', 'Blocked'] }, 'x');
  return `<div class="small" style="padding:6px 0;border-bottom:1px dashed var(--line)">${st} <b>${esc(f.source_id)}</b>${f.source_version ? ` v${f.source_version}` : ''} —
    ${f.status === 'observed' ? `${inr(f.unit_price_minor)} ${esc(f.currency || '')}, ${f.stock_status === 'unknown' ? '<b>stock unknown</b>' : `${f.stock_qty} in stock`}` : ''}
    <span class="muted">· ${time(f.captured_at)}</span>${f.limitations?.length ? `<div class="muted">${f.limitations.map(esc).join(' ')}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------- Approval tab
function tabApproval() {
  const { approvals, submissions, session: s } = state.snap;
  if (s.scope.expected_result !== 'submission') return `<div class="card"><h2>No submission in this task</h2><p>You asked for ${s.scope.expected_result === 'draft' ? 'a comparison and a draft' : 'a comparison'}. Submitting a purchase request is blocked for this task, so there is nothing to approve. The draft is available under Results.</p></div>`;
  const pending = approvals.find((a) => a.status === 'pending');
  const latestSub = submissions[submissions.length - 1];
  let html = '';
  if (pending) {
    const p = pending.payload;
    const left = Math.max(0, Math.round((Date.parse(pending.expires_at) - Date.now()) / 1000));
    html += `<section class="approval" aria-labelledby="apv-h">
      <div class="row between"><h2 id="apv-h">Approve this exact purchase request?</h2>${chip(APPROVAL_CHIP, 'pending')}</div>
      <p class="muted">If you approve, TaskLatch saves exactly this request in SupplierLab once. Any change to supplier, item, quantity, price or destination needs a new decision.</p>
      <div class="grid two" style="margin-top:8px"><dl class="kv">
        <dt>Supplier</dt><dd>${esc(s.scope.vendor_names[p.supplier_id] || p.supplier_id)} <code class="muted">${esc(p.supplier_id)}</code></dd>
        <dt>Item</dt><dd>${esc(p.product_id)} <span class="muted small">(${esc(p.item_id)})</span></dd>
        <dt>Quantity</dt><dd>${p.quantity}</dd>
        <dt>Unit price</dt><dd>${inr(p.unit_price_minor)} ${p.tax_included ? '<span class="muted small">tax included</span>' : ''}</dd>
        <dt>Shipping</dt><dd>${inr(p.shipping_minor)}</dd>
        <dt>Saved to</dt><dd>${esc(s.scope.destination_label)} <code class="muted">${esc(p.destination)}</code></dd>
        <dt>Requester</dt><dd>${esc(p.requester)}</dd>
        <dt>Based on</dt><dd><code>${esc(p.source_id)}</code> v${p.source_version}</dd>
      </dl><div><div class="muted">Total</div><div class="total">${inr(p.total_minor)}</div>
        <p class="small muted">Request hash <code>${short(pending.payload_hash, 16)}</code><br>Expires in <b id="apv-left">${Math.floor(left / 60)}m ${left % 60}s</b> (${time(pending.expires_at)}) · valid for one submission</p>
        <div class="row"><button class="primary big" id="apv-approve">✓ Approve and save</button><button class="big" id="apv-reject">✕ Reject</button></div>
        <details style="margin-top:12px"><summary>Change quantity (needs a new decision)</summary><div class="row" style="margin-top:8px"><label for="apv-qty" class="sr-only">New quantity</label><input id="apv-qty" type="number" min="1" value="${p.quantity}" style="max-width:120px"><button id="apv-revise">Update draft</button></div></details>
      </div></div></section>`;
  } else if (!approvals.length) {
    html += `<div class="card empty">No purchase request has been proposed yet. The coordinator proposes one after the comparison and draft pass verification.</div>`;
  }
  if (latestSub) {
    html += `<section class="card" style="margin-top:16px"><div class="row between"><h2>Submission</h2>${chip(SUB_CHIP, latestSub.status)}</div><dl class="kv">
      <dt>Receipt</dt><dd>${esc(latestSub.receipt_id || '—')}</dd><dt>Request ID</dt><dd>${esc(latestSub.request_id || '—')}</dd>
      <dt>Idempotency key</dt><dd><code>${esc(latestSub.idempotency_key)}</code></dd><dt>Attempts</dt><dd>${latestSub.attempts}</dd><dt>Updated</dt><dd>${dateTime(latestSub.updated_at)}</dd></dl>
      ${latestSub.status === 'uncertain' ? `<div class="banner warn" style="margin-top:12px"><span class="icon">?</span><div><b>Could not verify.</b><p>SupplierLab did not answer. The request may or may not have been saved. Check first; retrying uses the same idempotency key, so at most one request can exist.</p></div></div>
        <div class="row"><button class="primary" data-sub="reconcile" data-id="${esc(latestSub.id)}">Check SupplierLab again</button><button data-sub="retry" data-id="${esc(latestSub.id)}">Retry with the same key</button></div>` : ''}</section>`;
  }
  html += `<section class="card" style="margin-top:16px"><h2>Decision history</h2><div class="table-wrap"><table><thead><tr><th>Requested</th><th>Request</th><th>Status</th><th>Decided</th></tr></thead><tbody>
    ${approvals.map((a) => `<tr><td class="small">${time(a.created_at)}</td><td>${a.payload.quantity} × ${esc(a.payload.product_id)} = <b>${inr(a.payload.total_minor)}</b><div class="muted small">hash ${short(a.payload_hash)}</div></td><td>${chip(APPROVAL_CHIP, a.status)}${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ''}</td><td class="small">${a.decided_at ? time(a.decided_at) + (a.decided_by ? ' by you' : '') : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}
  </tbody></table></div></section>`;
  return html;
}
function wireApproval() {
  const s = state.snap.session;
  const pending = state.snap.approvals.find((a) => a.status === 'pending');
  if (pending) {
    const p = pending.payload;
    document.getElementById('apv-approve')?.addEventListener('click', async () => {
      const ok = await confirmDialog('Save this purchase request?', `<p><b>${p.quantity} × ${esc(p.product_id)}</b> from <b>${esc(s.scope.vendor_names[p.supplier_id])}</b> at ${inr(p.unit_price_minor)} = <b>${inr(p.total_minor)}</b>, saved to ${esc(s.scope.destination_label)}.</p><p class="muted small">Synthetic SupplierLab record. This approval works once.</p>`, 'Approve and save');
      if (ok) act(() => api('POST', `/api/approvals/${pending.id}/decision`, { decision: 'approve', payload_hash: pending.payload_hash }), 'Approved');
    });
    document.getElementById('apv-reject')?.addEventListener('click', async () => {
      const ok = await confirmDialog('Reject this request?', '<p>Nothing will be submitted. The comparison and draft stay available.</p>', 'Reject request', true);
      if (ok) act(() => api('POST', `/api/approvals/${pending.id}/decision`, { decision: 'reject', payload_hash: pending.payload_hash }), 'Rejected');
    });
    document.getElementById('apv-revise')?.addEventListener('click', () => act(() => api('POST', `/api/sessions/${s.id}/draft`, { quantity: Number(document.getElementById('apv-qty').value) }), 'Draft revised; a new decision is needed'));
  }
  document.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => act(() => api('POST', `/api/sessions/${s.id}/submissions/${b.dataset.id}/${b.dataset.sub}`))));
}

// ---------------------------------------------------------------- Usage & stop tab
function meter(label, used, prog, unc, limit, unit = '') {
  const pct = (n) => (limit ? Math.min(100, (n / limit) * 100) : 0);
  const remaining = Math.max(0, limit - used - prog);
  return `<div class="meter"><div class="label"><span>${esc(label)}</span><span><b>${used}</b>${prog ? ` + ${prog} in progress` : ''} of ${limit}${unit} · <b>${remaining}</b> left</span></div>
    <div class="bar" role="img" aria-label="${esc(label)}: ${used} used, ${prog} in progress, ${remaining} remaining of ${limit}"><span class="used" style="width:${pct(used - unc)}%"></span><span class="unc" style="width:${pct(unc)}%"></span><span class="prog" style="width:${pct(prog)}%"></span></div></div>`;
}
function tabUsage() {
  const { budget: b, session: s, events } = state.snap;
  const t = b.tokens;
  const stopEv = events.find((e) => e.kind === 'stop.confirmed');
  return `<div class="grid two">
    <section class="card"><h2>Shared allowance</h2><p class="muted small">Both workers, the coordinator and retries draw from the same allowance. Work cannot start unless enough remains.</p>
      ${meter('Model calls (whole task)', b.model_calls.used, b.model_calls.in_progress, b.model_calls.uncertain, b.model_calls.limit)}
      <div class="legend"><span><i style="background:var(--brand)"></i>Used</span><span><i style="background:var(--warn)"></i>In progress (reserved)</span><span><i style="background:var(--bad)"></i>Outcome uncertain (still counted)</span></div>
      <p class="small">By actor: ${Object.entries(b.model_calls.by_actor).map(([k, v]) => `${esc(labelActor(k))} <b>${v}</b>`).join(' · ') || '—'}</p>
      ${b.steps.map((w) => meter(`${w.label} execution steps`, w.used, 0, 0, w.limit)).join('')}
      ${meter('Elapsed time (seconds)', b.time.elapsed_seconds, 0, 0, b.time.limit_seconds, 's')}
      <dl class="kv" style="margin-top:12px"><dt>Retries used</dt><dd>${b.retries.used} (max ${b.retries.per_call_limit} per failed call)</dd>
      <dt>Tokens — reported</dt><dd>${t.reported.toLocaleString()}</dd><dt>Tokens — estimated</dt><dd>${t.estimated.toLocaleString()}</dd>
      <dt>Calls with unknown usage</dt><dd>${t.unknown_calls}</dd><dt>Calls with no inference</dt><dd>${t.no_inference_calls} <span class="muted small">(local rules)</span></dd>
      <dt>Token ceiling</dt><dd>${t.ceiling ? `${t.ceiling.toLocaleString()} · ${t.remaining.toLocaleString()} left` : 'none'}</dd></dl>
      <hr><dl class="kv"><dt>Actual payable usage</dt><dd>${b.payable_cost.paid ? '<span class="chip warn" data-icon="$">PAID provider</span> ' : ''}${esc(b.payable_cost.display)} <span class="muted small">${esc(b.payable_cost.note)}</span></dd>
      <dt>Simulated cost example</dt><dd><span class="chip warn" data-icon="⚠">SIMULATED</span> ${inr(b.simulated_cost.amount_minor)} <span class="muted small">tariff ${esc(b.simulated_cost.tariff.version)} — illustrative only, not a charge</span></dd></dl>
    </section>
    <section class="card"><h2>Stop control</h2>
      <p>Stop applies to the whole task: both workers, the coordinator and any pending approval.</p>
      <dl class="kv"><dt>Status</dt><dd>${chip(SESSION_CHIP, s.status)}</dd>
      <dt>Stop requested</dt><dd>${s.stop_requested_at ? dateTime(s.stop_requested_at) : '—'}</dd>
      <dt>Shutdown confirmed</dt><dd>${s.stop_confirmed_at ? dateTime(s.stop_confirmed_at) : s.stop_requested_at ? 'Waiting for workers…' : '—'}</dd>
      ${stopEv?.data?.stop_latency_ms !== undefined ? `<dt>Stop latency</dt><dd>${stopEv.data.stop_latency_ms} ms</dd>` : ''}
      <dt>Workers</dt><dd>${state.snap.workers.map((w) => `${esc(w.label)}: ${chip(WORKER_CHIP, w.status)}`).join(' ')}</dd></dl>
      ${!s.stop_requested_at && !TERMINAL.has(s.status) && !['DRAFT', 'READY'].includes(s.status) ? `<p><button class="danger big" id="btn-stop-2">■ Stop task</button> <span class="muted small">Keyboard: Tab to the button, then Enter.</span></p>` : ''}
      ${stopEv ? `<div class="banner info"><span class="icon">■</span><div><b>After the stop</b><p>${esc(stopEv.summary)}</p></div></div>` : ''}
      <h3>Reservations</h3><div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Time</th><th>Actor</th><th>Purpose</th><th>State</th><th>Usage</th></tr></thead><tbody>
      ${b.reservations.slice().reverse().map((r) => `<tr><td class="small">${time(r.created_at)}</td><td>${esc(labelActor(r.actor))}</td><td class="small">${esc(r.purpose)}${r.retry_of ? ' <span class="chip outline" data-icon="↻">retry</span>' : ''}</td><td>${esc(r.status)}</td><td class="small">${r.usage_source === 'none' ? 'no inference' : r.usage_source ? `${r.tokens_used ?? '?'} tok (${esc(r.usage_source)})` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No calls yet.</td></tr>'}
      </tbody></table></div></section></div>`;
}
function wireUsage() {
  document.getElementById('btn-stop-2')?.addEventListener('click', () => document.getElementById('btn-stop')?.click());
}

// ---------------------------------------------------------------- Results & evidence tab
async function artifactText(id) {
  if (state.artifactCache.has(id)) return state.artifactCache.get(id);
  const t = await api('GET', `/api/sessions/${state.sid}/artifacts/${id}`);
  const v = typeof t === 'string' ? t : JSON.stringify(t, null, 2);
  state.artifactCache.set(id, v);
  return v;
}
function tabResults() {
  const { verification: v, artifacts, session: s, submissions, findings, replay } = state.snap;
  const deliver = [['comparison', 'Supplier comparison'], ...(s.scope.expected_result !== 'comparison' ? [['draft', 'Purchase-request draft']] : []), ...(s.scope.expected_result === 'submission' ? [['submission', 'Saved request and receipt']] : [])];
  const latest = (kind) => artifacts.filter((a) => a.kind === kind).slice(-1)[0];
  const sub = submissions[submissions.length - 1];
  return `
  <section class="card"><div class="row between"><h2>Verification summary</h2><div class="row"><button id="reverify">Re-run verification</button><a class="btn primary" href="/api/sessions/${esc(s.id)}/evidence" download>Export evidence bundle</a></div></div>
    <p class="muted small">Checked independently against saved files and SupplierLab records — not against what the agents said.</p>
    ${deliver.map(([k, label]) => { const r = v[k]; return `<details ${r && r.status !== 'verified' ? 'open' : ''} style="padding:10px 0;border-bottom:1px solid var(--line)"><summary><span class="row" style="display:inline-flex"><b>${label}</b> ${chip(VERIFY_CHIP, r?.status || 'missing')} <span class="muted small">${esc(r?.summary || 'Not checked yet')}</span></span></summary>
      ${r ? `<ul class="checks">${r.checks.map((c) => `<li>${c.status === 'pass' ? chip({ p: ['ok', '✓', 'Pass'] }, 'p') : c.status === 'fail' ? chip({ f: ['bad', '✕', 'Fail'] }, 'f') : chip({ u: ['warn', '?', 'Needs review'] }, 'u')}<span><code>${esc(c.name)}</code> ${esc(c.detail)}</span></li>`).join('')}</ul>` : ''}</details>`; }).join('')}
  </section>
  <div id="cmp-slot" class="card"><h2>Supplier comparison</h2>${latest('comparison') ? '<p class="muted">Loading…</p>' : '<p class="muted">Not produced.</p>'}</div>
  ${s.scope.expected_result !== 'comparison' ? `<div id="draft-slot" class="card"><h2>Purchase-request draft</h2>${latest('draft') ? '<p class="muted">Loading…</p>' : '<p class="muted">Not produced.</p>'}</div>` : ''}
  ${sub ? `<section class="card"><h2>Saved request and receipt</h2><dl class="kv"><dt>Status</dt><dd>${chip(SUB_CHIP, sub.status)}</dd><dt>Receipt</dt><dd>${esc(sub.receipt_id || '—')}</dd><dt>SupplierLab request</dt><dd>${esc(sub.request_id || '—')}</dd>
     ${sub.detail?.recorded ? `<dt>Recorded</dt><dd>${sub.detail.recorded.quantity} × ${esc(sub.detail.recorded.product_id)} at ${inr(sub.detail.recorded.unit_price_minor)} = ${inr(sub.detail.recorded.total_minor)} → ${esc(sub.detail.recorded.destination)}</dd>` : ''}</dl></section>` : ''}
  <section class="card"><h2>Findings by worker</h2><p class="muted small">What each agent reported (agent statements). The verifier checks these against SupplierLab.</p>
    <div class="grid two">${[...new Set(findings.map((f) => f.author_agent))].map((w) => `<div><h3>${esc(labelActor(w))}</h3>${findings.filter((f) => f.author_agent === w).map(findingLine).join('')}</div>`).join('') || '<p class="muted">No findings.</p>'}</div></section>
  <section class="card"><h2>Files</h2><div class="table-wrap"><table><thead><tr><th>File</th><th>Owner</th><th>State</th><th>SHA-256</th></tr></thead><tbody>
    ${artifacts.map((a) => `<tr><td><a href="/api/sessions/${esc(s.id)}/artifacts/${esc(a.id)}" target="_blank" rel="noopener">${esc(a.label)}</a></td><td>${esc(labelActor(a.owner))}</td><td>${a.committed ? chip({ c: ['ok', '🔒', 'Committed'] }, 'c') : chip({ c: ['neutral', '✎', 'Candidate'] }, 'c')}</td><td><code class="small">${short(a.sha256, 16)}</code></td></tr>`).join('') || '<tr><td colspan="4" class="muted">None.</td></tr>'}
  </tbody></table></div></section>
  <section class="card"><div class="row between"><h2>Private replay</h2><div class="row"><label style="margin:0;font-weight:500"><input type="checkbox" id="rec-toggle" ${replay.recording ? 'checked' : ''}> Record screenshots</label><button id="del-replay" ${replay.frames.length ? '' : 'disabled'}>Delete replay</button></div></div>
    <p class="muted small">Screenshots are served only to you, never cached, and are not included in the evidence bundle. ${replay.frames.length} frame(s).</p>
    <div class="frames">${replay.frames.slice(-24).map((f) => `<figure><img loading="lazy" alt="${esc(f.worker)} at ${time(f.at)}" src="/api/sessions/${esc(s.id)}/screens/${esc(f.file)}"><figcaption>${esc(labelActor(f.worker))} · ${time(f.at)}</figcaption></figure>`).join('')}</div></section>`;
}
function comparisonTable(c) {
  return `<p class="muted small">Quantity ${c.request.quantity} · generated ${dateTime(c.generated_at)} · ${c.complete ? 'all approved sources covered' : '<b>incomplete — see unresolved sources</b>'}</p>
  <div class="table-wrap"><table><thead><tr><th>Vendor / product</th><th>Unit price</th><th>Stock</th><th>Sources</th><th>Flags</th></tr></thead><tbody>
  ${c.rows.map((r) => `<tr><td><b>${esc(r.vendor_name)}</b>${c.recommendation?.vendor_id === r.vendor_id ? ' <span class="chip ok" data-icon="★">Recommended</span>' : ''}<div class="muted small">${esc(r.product_id)} · ${esc(r.product_title || '')}</div></td>
    <td>${r.price_status === 'conflict' ? `<span class="chip warn" data-icon="⚠">Conflict</span>${r.conflicting_prices.map((p) => `<div class="small">${inr(p.unit_price_minor)} <code class="muted">${esc(p.source_id)}</code> (${esc(labelActor(p.found_by))})</div>`).join('')}` : `<b>${inr(r.unit_price_minor)}</b> <span class="muted small">${esc(r.currency || '')}${r.tax_included ? ' incl. tax' : ''}</span>`}</td>
    <td>${r.stock_status === 'unknown' ? '<span class="chip warn" data-icon="?">Stock unknown</span>' : `${r.stock_qty} units ${r.meets_quantity ? '<span class="chip ok" data-icon="✓">enough</span>' : '<span class="chip bad" data-icon="✕">not enough</span>'}`}</td>
    <td class="small">${r.source_refs.map((x) => `<div><code>${esc(x.source_id)}</code> v${esc(x.source_version)} · ${time(x.captured_at)} · ${esc(labelActor(x.found_by))}</div>`).join('')}</td>
    <td class="small">${r.flags.map(esc).join('<br>') || '—'}</td></tr>`).join('')}
  ${c.unresolved.map((u) => `<tr><td><b>${esc(u.vendor_id)}</b><div class="muted small"><code>${esc(u.source_id)}</code></div></td><td colspan="3"><span class="chip warn" data-icon="?">Unresolved</span> ${esc(u.reason)}</td><td class="small">Assigned to ${esc(labelActor(u.assigned_to))}</td></tr>`).join('')}
  </tbody></table></div>
  <p><b>Recommendation:</b> ${c.recommendation ? esc(c.recommendation.reason) : 'None — not enough verified evidence.'}</p>
  ${c.untrusted_content.length ? `<div class="banner warn"><span class="icon">⚠</span><div><b>Untrusted page content (quoted, not followed)</b>${c.untrusted_content.map((u) => `<p><q>${esc(u.quoted_text)}</q> — <code>${esc(u.source_id)}</code></p>`).join('')}</div></div>` : ''}`;
}
function draftCard(d) {
  return `<dl class="kv"><dt>Status</dt><dd><span class="chip neutral" data-icon="✎">Draft — not a submission</span></dd><dt>Supplier</dt><dd>${esc(d.supplier_name)}</dd><dt>Item</dt><dd>${esc(d.product_id)}</dd><dt>Quantity</dt><dd>${d.quantity}</dd>
    <dt>Unit price</dt><dd>${inr(d.unit_price_minor)}${d.tax_included ? ' (tax included)' : ''}</dd><dt>Shipping</dt><dd>${inr(d.shipping_minor)}</dd><dt>Total</dt><dd>${inr(d.total_minor)}</dd>
    <dt>Destination</dt><dd>${esc(d.destination)}</dd><dt>Based on</dt><dd>comparison <code>${esc(d.based_on.comparison_id)}</code>, sha256 <code>${short(d.based_on.comparison_sha256, 16)}</code></dd>
    ${d.warnings?.length ? `<dt>Warnings</dt><dd>${d.warnings.map(esc).join('<br>')}</dd>` : ''}</dl>`;
}
function wireResults() {
  const s = state.snap.session;
  const latest = (kind) => state.snap.artifacts.filter((a) => a.kind === kind).slice(-1)[0];
  const cmp = latest('comparison'); const dr = latest('draft');
  if (cmp) artifactText(cmp.id).then((t) => { const el = document.getElementById('cmp-slot'); if (el) el.innerHTML = `<h2>Supplier comparison</h2>${comparisonTable(JSON.parse(t))}`; }).catch(() => {});
  if (dr) artifactText(dr.id).then((t) => { const el = document.getElementById('draft-slot'); if (el) el.innerHTML = `<h2>Purchase-request draft</h2>${draftCard(JSON.parse(t))}`; }).catch(() => {});
  document.getElementById('reverify')?.addEventListener('click', () => act(() => api('POST', `/api/sessions/${s.id}/verify`), 'Verification re-run'));
  document.getElementById('rec-toggle')?.addEventListener('change', (e) => act(() => api('POST', `/api/sessions/${s.id}/recording`, { recording: e.target.checked })));
  document.getElementById('del-replay')?.addEventListener('click', async () => {
    if (await confirmDialog('Delete the private replay?', '<p>All screenshots for this task are deleted from disk. Findings, files and the history are kept.</p>', 'Delete screenshots', true)) act(() => api('DELETE', `/api/sessions/${s.id}/replay`), 'Replay deleted');
  });
}

// ---------------------------------------------------------------- History tab
function timeline(events) {
  return `<ul class="timeline">${events.map((e) => `<li><span class="t">${time(e.at)}</span><span>${chip(PROV_CHIP, e.provenance)}</span><span><b>${esc(labelActor(e.actor))}</b> · ${esc(e.summary)}${e.data?.reason && e.kind === 'policy.decision' && e.data.decision !== 'ALLOW' ? `<div class="muted small">Reason: ${esc(e.data.reason)} <code>${esc(e.data.reason_code)}</code></div>` : ''}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
}
function tabHistory() {
  const { events, chain } = state.snap;
  const f = state.historyFilter;
  const shown = events.filter((e) => f === 'all' || (f === 'blocked' ? e.kind === 'policy.decision' && e.data?.decision === 'DENY' : e.provenance === f));
  return `<section class="card"><div class="row between"><h2>Chronological history</h2>
    <div class="row"><label for="hf" style="margin:0">Show</label><select id="hf" style="width:auto">${[['all', 'Everything'], ['operator_decision', 'Your decisions'], ['policy_decision', 'Policy decisions'], ['blocked', 'Blocked actions'], ['observed', 'TaskLatch observations'], ['agent_statement', 'Agent statements']].map(([k, l]) => `<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <p class="small muted">${events.length} events · hash chain ${chain.ok ? chip({ o: ['ok', '✓', 'intact'] }, 'o') : chip({ b: ['bad', '✕', `broken at #${chain.broken_at}`] }, 'b')}. The chain detects later edits to stored history; it is not proof against a compromised computer.</p>
    ${timeline(shown)}</section>`;
}
function wireHistory() {
  document.getElementById('hf')?.addEventListener('change', (e) => { state.historyFilter = e.target.value; renderSession(); });
}


// ================================================================ Live desktops (container runtime)
const isDesktop = () => state.snap?.session.scope.runtime === 'desktop';
const isWeb = () => state.snap?.session.scope.mode === 'web';
const W_LETTER = (w) => w.replace('worker-', '').toUpperCase();
const FEED_KINDS = /^(agent\.intent|agent\.done|agent\.gave_up|worker\.activity|worker\.stuck|worker\.error|desktop\.|whiteboard\.post|session\.(started|outcome)|stop\.|budget\.|approval\.|verification\.result|plan\.proposed)/;

function tabsFor(s) {
  if (s.scope.runtime !== 'desktop') return TABS;
  return [['live', 'Live'], ['board', 'Board'], ['scope', s.scope.mode === 'web' ? 'Plan' : 'Scope'],
    ...(s.scope.mode === 'web' ? [] : [['approval', 'Approval']]), ['usage', 'Usage & stop'], ['results', 'Results & evidence'], ['history', 'History']];
}

function tileScreen(w, live) {
  const s = state.snap.session;
  if (live?.live_url) {
    const src = `${live.live_url}&view_only=${live.paused ? 0 : 1}`;
    return `<iframe title="${esc(w.label)} live desktop" src="${esc(src)}" data-src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe>`;
  }
  if (w.last_screenshot) return `<img alt="Last screen from ${esc(w.label)}" src="/api/sessions/${esc(s.id)}/screens/${esc(w.last_screenshot)}">`;
  return `<div class="tile-empty">${['DRAFT', 'READY'].includes(s.status) ? 'Desktop starts when you start the task' : w.status === 'starting' ? 'Starting Linux desktop…' : 'No screen'}</div>`;
}

function tabLive() {
  const { workers, live, session: s } = state.snap;
  if (!workers.length) return `<div class="card empty">No agents planned yet.</div>`;
  const view = state.liveView || 'grid';
  const focusW = state.focusWorker && workers.find((w) => w.worker_id === state.focusWorker) ? state.focusWorker : workers[0].worker_id;
  const shown = view === 'focus' ? workers.filter((w) => w.worker_id === focusW) : workers;
  const cols = view === 'focus' || shown.length === 1 ? 1 : 2;
  return `<div class="live-wrap">
    <div class="live-main">
      <div class="row between" style="margin-bottom:10px">
        <div class="seg" role="group" aria-label="Layout"><button data-view="grid" aria-pressed="${view === 'grid'}">▦ Grid</button><button data-view="focus" aria-pressed="${view === 'focus'}">▣ Focus</button></div>
        ${view === 'focus' ? `<div class="seg" role="group" aria-label="Agent">${workers.map((w) => `<button data-focus="${esc(w.worker_id)}" aria-pressed="${w.worker_id === focusW}">${esc(w.label)}</button>`).join('')}</div>` : ''}
        <span class="muted small">Linux desktops in Docker · live view · ${live.length} running</span>
      </div>
      <div id="live-grid" class="live-grid cols-${cols}" data-shape="${esc(shown.map((w) => w.worker_id + ':' + (live.find((l) => l.worker_id === w.worker_id)?.live_url ? 'L' + (live.find((l) => l.worker_id === w.worker_id).paused ? 'P' : '') : 'S')).join(','))}">
        ${shown.map((w) => {
          const lv = live.find((l) => l.worker_id === w.worker_id);
          const task = state.snap.tasks.find((t) => t.assignee === w.worker_id && t.kind === 'research');
          return `<article class="tile" data-w="${esc(w.worker_id)}">
            <header class="tile-head"><span class="avatar">${esc(W_LETTER(w.worker_id))}</span><div class="grow"><b>${esc(w.label)}</b><div class="muted small tile-task">${esc(task?.title || '')}</div></div>
              <span class="tile-status">${chip(WORKER_CHIP, w.status)}</span></header>
            <div class="tile-url mono">${esc(w.current_url || 'about:blank')}</div>
            <div class="tile-screen">${tileScreen(w, lv)}</div>
            <footer class="tile-foot"><span class="tile-activity">${esc(w.activity || '')}</span>
              ${lv?.live_url ? `<button data-takeover="${esc(w.worker_id)}" data-on="${lv.paused ? 0 : 1}" class="${lv.paused ? 'primary' : ''}">${lv.paused ? '↩ Hand back' : '✋ Take over'}</button>` : ''}
              ${lv ? `<span class="muted small tile-proxy">proxy ${lv.proxy.allowed} allowed · ${lv.proxy.blocked} blocked</span>` : ''}</footer>
          </article>`;
        }).join('')}
      </div>
    </div>
    <aside class="live-side">
      <section class="card tight"><h2>Activity</h2><ul id="live-feed" class="feed live-feed">${feedItems()}</ul></section>
      <section class="card tight"><h2>Whiteboard</h2><p class="muted small">Findings agents shared. Agent statements: TaskLatch checks each quote against the page it captured.</p><ul id="live-board" class="wb">${whiteboardItems()}</ul></section>
    </aside>
  </div>`;
}

function feedItems() {
  const ev = state.snap.events.filter((e) => FEED_KINDS.test(e.kind) || (e.kind === 'policy.decision' && e.data?.decision === 'DENY')).slice(-60).reverse();
  return ev.map((e) => {
    const deny = e.kind === 'policy.decision';
    const who = e.actor.startsWith('worker') ? `<span class="avatar sm">${esc(W_LETTER(e.actor))}</span>` : `<span class="avatar sm sys">${esc(e.actor.slice(0, 1).toUpperCase())}</span>`;
    return `<li class="${deny ? 'deny' : ''}"><span class="t">${time(e.at)}</span>${who}<span>${deny ? chip(DECISION_CHIP, 'DENY') + ' ' : ''}${esc(e.summary.replace(/^Worker [A-D]( →|:)\s*/, ''))}</span></li>`;
  }).join('') || '<li class="muted">Nothing yet.</li>';
}

function whiteboardItems() {
  return (state.snap.whiteboard || []).slice().reverse().map((w) => `<li><div class="row" style="gap:6px"><span class="avatar sm">${esc(W_LETTER(w.actor))}</span>
    ${w.quote_found ? chip({ k: ['ok', '✓', 'Quote on page'] }, 'k') : chip({ k: ['warn', '?', 'Quote not found'] }, 'k')}${w.injected ? ' ' + chip({ k: ['bad', '⚠', 'Page had injected instructions'] }, 'k') : ''}</div>
    <div class="wb-claim">${esc(w.claim || '')}</div>${w.quote ? `<div class="wb-quote">“${esc(w.quote)}”</div>` : ''}<div class="muted small mono">${esc(w.url || '')}</div></li>`).join('') || '<li class="muted">No findings yet.</li>';
}

/** Update the Live tab in place so the embedded desktops are not reloaded on every poll. */
function updateLive() {
  const grid = document.getElementById('live-grid');
  if (!grid) return false;
  const { workers, live } = state.snap;
  const view = state.liveView || 'grid';
  const focusW = state.focusWorker || workers[0]?.worker_id;
  const shown = view === 'focus' ? workers.filter((w) => w.worker_id === focusW) : workers;
  const shape = shown.map((w) => w.worker_id + ':' + (live.find((l) => l.worker_id === w.worker_id)?.live_url ? 'L' + (live.find((l) => l.worker_id === w.worker_id).paused ? 'P' : '') : 'S')).join(',');
  if (grid.dataset.shape !== shape) return false;
  for (const w of shown) {
    const t = grid.querySelector(`.tile[data-w="${w.worker_id}"]`);
    if (!t) return false;
    t.querySelector('.tile-status').innerHTML = chip(WORKER_CHIP, w.status);
    t.querySelector('.tile-url').textContent = w.current_url || 'about:blank';
    t.querySelector('.tile-activity').textContent = w.activity || '';
    const lv = live.find((l) => l.worker_id === w.worker_id);
    const px = t.querySelector('.tile-proxy'); if (px && lv) px.textContent = `proxy ${lv.proxy.allowed} allowed · ${lv.proxy.blocked} blocked`;
    const img = t.querySelector('.tile-screen img');
    if (img && w.last_screenshot && !img.src.endsWith(w.last_screenshot)) img.src = `/api/sessions/${state.snap.session.id}/screens/${w.last_screenshot}`;
  }
  const feed = document.getElementById('live-feed'); if (feed) feed.innerHTML = feedItems();
  const board = document.getElementById('live-board'); if (board) board.innerHTML = whiteboardItems();
  const hs = document.getElementById('hdr-status'); if (hs) hs.innerHTML = chip(SESSION_CHIP, state.snap.session.status);
  return true;
}

function wireLive() {
  const s = state.snap.session;
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.liveView = b.dataset.view; renderSession(); }));
  document.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => { state.focusWorker = b.dataset.focus; state.liveView = 'focus'; renderSession(); }));
  document.querySelectorAll('[data-takeover]').forEach((b) => b.addEventListener('click', async () => {
    const on = b.dataset.on === '1';
    if (on && !(await confirmDialog(`Take over ${b.dataset.takeover.replace('worker-', 'Worker ').toUpperCase().replace('WORKER ', 'Worker ')}?`, '<p>The agent pauses and the live view becomes interactive: your clicks and typing go to that desktop. Its traffic still goes through TaskLatch’s proxy. Hand it back when you are done.</p>', 'Take over'))) return;
    await api('POST', `/api/sessions/${s.id}/workers/${b.dataset.takeover}/takeover`, { on });
    state.snap = await api('GET', `/api/sessions/${s.id}`); renderSession();
  }));
}

// ================================================================ Board (kanban)
const BOARD_COLS = [
  ['Queued', ['ready']], ['Running', ['running']], ['Waiting', ['waiting', 'awaiting_approval', 'blocked', 'interrupted', 'invalidated']],
  ['Submitted', ['submitted', 'partial', 'uncertain']], ['Verified', ['verified']], ['Ended', ['failed', 'cancelled', 'out_of_budget', 'rejected', 'expired', 'done']],
];
function tabBoard() {
  const { tasks, workers } = state.snap;
  return `<div class="board">${BOARD_COLS.map(([name, sts]) => {
    const items = tasks.filter((t) => sts.includes(t.status));
    return `<section class="board-col" aria-label="${name}"><h3>${name} <span class="muted small">${items.length}</span></h3>
      ${items.map((t) => { const w = workers.find((x) => x.worker_id === t.assignee);
        return `<article class="board-card"><div class="row between"><b>${esc(t.title)}</b>${chip(TASK_CHIP, t.status)}</div>
          <div class="muted small">${t.assignee.startsWith('worker') ? `<span class="avatar sm">${esc(W_LETTER(t.assignee))}</span> ` : ''}${esc(labelActor(t.assignee))}</div>
          ${t.detail ? `<div class="small">${esc(t.detail)}</div>` : ''}${w && ['running', 'waiting'].includes(t.status) ? `<div class="small muted">${esc(w.activity || '')}</div>` : ''}</article>`; }).join('') || '<div class="muted small empty-col">—</div>'}
    </section>`;
  }).join('')}</div>`;
}

// ================================================================ Web tasks: plan and report
function tabScopeWeb() {
  const { session: s } = state.snap;
  const editable = ['DRAFT', 'READY'].includes(s.status);
  const sc = s.scope; const L = sc.limits;
  return `<div class="banner info"><span class="icon">ⓘ</span><div><b>Web research with ${s.plan.subtasks.length} agent${s.plan.subtasks.length > 1 ? 's' : ''}.</b><p>Each agent gets its own Linux desktop. They may only open the sites listed here; every page, redirect and asset request is checked at TaskLatch’s proxy. No purchases or form submissions. Findings must quote the page, and TaskLatch checks every quote.</p></div></div>
  <div class="grid three">
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'ALLOW')}</h3><ul>${sc.actions.allowed.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'REQUIRE_APPROVAL')}</h3><ul><li>Nothing: this task has no consequential action to approve. You can take over any desktop.</li></ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'DENY')}</h3><ul>${sc.actions.blocked.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul></section>
  </div>
  <section class="card"><h2>Sites agents may open</h2>
    ${editable ? `<label for="ws-sites" class="sr-only">Allowed sites</label><input id="ws-sites" type="text" value="${esc(sc.allowed_sites.join(', '))}"><p class="muted small">Comma-separated hosts. Use *.example.org for subdomains. Sites that pages load assets from (images, scripts) must be listed too, or those requests are blocked.</p>`
      : `<p>${sc.allowed_sites.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>`}
    <p class="muted small">Allowance: ${L.workers} desktops · ${L.steps_per_worker} steps each · ${L.model_calls} model calls · ${L.token_ceiling ? L.token_ceiling.toLocaleString() + ' tokens' : 'no token ceiling'} · ${Math.round(L.time_seconds / 60)} min</p></section>
  <section class="card"><h2>Coordinator’s plan</h2><p class="muted">${esc(s.plan.rationale || '')}</p>
    <div class="subtasks">${s.plan.subtasks.map((t, i) => `<div class="subtask"><div class="row"><span class="avatar">${esc(W_LETTER(t.worker_id))}</span><b>${esc(t.label)}</b></div>
      ${editable ? `<label>Title<input type="text" data-st="${i}" data-f="title" value="${esc(t.title)}"></label>
        <label>Instructions<textarea data-st="${i}" data-f="instructions">${esc(t.instructions)}</textarea></label>
        <label>Start page<input type="text" data-st="${i}" data-f="start_url" value="${esc(t.start_url)}"></label>`
      : `<p><b>${esc(t.title)}</b></p><p class="small">${esc(t.instructions)}</p><p class="muted small mono">${esc(t.start_url)}</p>`}</div>`).join('')}</div>
    ${editable ? `<div class="row" style="margin-top:12px"><button id="ws-save">Save plan</button><button class="primary big" id="ws-start">Accept plan and start ${s.plan.subtasks.length} agent${s.plan.subtasks.length > 1 ? 's' : ''}</button></div>` : '<p class="muted small">The plan is locked once the task starts.</p>'}
  </section>`;
}
function wireScopeWeb() {
  const s = state.snap.session;
  const collect = () => ({
    allowed_sites: document.getElementById('ws-sites').value.split(/[\s,]+/).filter(Boolean),
    subtasks: s.plan.subtasks.map((t, i) => ({ ...t, ...Object.fromEntries([...document.querySelectorAll(`[data-st="${i}"]`)].map((el) => [el.dataset.f, el.value])) })),
  });
  document.getElementById('ws-save')?.addEventListener('click', () => act(() => api('PATCH', `/api/sessions/${s.id}/scope`, collect()), 'Plan saved'));
  document.getElementById('ws-start')?.addEventListener('click', async () => {
    await api('PATCH', `/api/sessions/${s.id}/scope`, collect()).catch(() => {});
    await act(() => api('POST', `/api/sessions/${s.id}/start`)); location.hash = `#/s/${s.id}/live`;
  });
}

function tabResultsWeb() {
  const { verification: v, session: s, artifacts, replay } = state.snap;
  const r = v.report;
  const rep = artifacts.filter((a) => a.kind === 'report').slice(-1)[0];
  return `<section class="card"><div class="row between"><h2>Source check</h2><div class="row"><button id="reverify">Re-run check</button><a class="btn primary" href="/api/sessions/${esc(s.id)}/evidence" download>Export evidence bundle</a></div></div>
    <p class="muted small">Each finding’s quote is checked against the page text TaskLatch captured from that agent’s browser at the moment it was recorded. Verified means source-checked — the text was on that approved page — not that the claim is true.</p>
    <p>${chip(VERIFY_CHIP, r?.status || 'missing')} ${esc(r?.summary || 'Not checked yet')}</p></section>
  <div id="report-slot" class="card"><h2>Report</h2>${rep ? '<p class="muted">Loading…</p>' : '<p class="muted">Not produced yet.</p>'}</div>
  <section class="card"><div class="row between"><h2>Private replay</h2><div class="row"><label style="margin:0;font-weight:500"><input type="checkbox" id="rec-toggle" ${replay.recording ? 'checked' : ''}> Record screens</label><button id="del-replay" ${replay.frames.length ? '' : 'disabled'}>Delete replay</button></div></div>
    <p class="muted small">${replay.frames.length} frame(s), one per agent step. Served only to you; not in the evidence bundle.</p>
    <div class="frames">${replay.frames.slice(-32).map((f) => `<figure><img loading="lazy" alt="${esc(f.worker)} at ${time(f.at)}" src="/api/sessions/${esc(s.id)}/screens/${esc(f.file)}"><figcaption>${esc(labelActor(f.worker))} · ${time(f.at)}</figcaption></figure>`).join('')}</div></section>`;
}
function reportHtml(rep) {
  const checks = Object.fromEntries((state.snap.verification.report?.checks || []).map((c) => [c.name, c]));
  return `<div class="banner info"><span class="icon">💬</span><div><b>Coordinator summary — agent statement, not verified</b><p style="white-space:pre-wrap">${esc(rep.coordinator_summary || '—')}</p></div></div>
    ${rep.sections.map((sec) => `<h3 class="row"><span class="avatar">${esc(W_LETTER(sec.worker))}</span> ${esc(sec.title)} ${chip(TASK_CHIP, state.snap.tasks.find((t) => t.kind === 'research' && t.assignee === sec.worker)?.status || sec.task_status)}</h3>
      ${sec.agent_summary ? `<p class="small muted">Agent said: ${esc(sec.agent_summary)}</p>` : ''}
      <ul class="checks">${sec.findings.map((f) => { const ref = `${W_LETTER(sec.worker)}${f.n}`; const c = checks[`finding:${ref}`]; if (f.superseded_by) return `<li class="muted">${chip({ s: ['neutral', '↻', 'Superseded'] }, 's')}<span><b>[${ref}]</b> ${esc(f.claim)}<br><span class="small">Quote rejected; replaced by [${W_LETTER(sec.worker)}${f.superseded_by}].</span></span></li>`;
        return `<li>${c?.status === 'pass' ? chip({ p: ['ok', '✓', 'Source-checked'] }, 'p') : chip({ f: ['bad', '✕', 'Not supported'] }, 'f')}<span><b>[${ref}]</b> ${esc(f.claim)}<br><span class="muted small">“${esc(f.quote)}” — <span class="mono">${esc(f.url || '')}</span>${f.snapshot_artifact ? ` · <a href="/api/sessions/${esc(state.snap.session.id)}/artifacts/${esc(f.snapshot_artifact)}" target="_blank" rel="noopener">captured page</a>` : ''}</span></span></li>`; }).join('') || '<li class="muted">No findings recorded.</li>'}</ul>`).join('')}`;
}
function wireResultsWeb() {
  const s = state.snap.session;
  const rep = state.snap.artifacts.filter((a) => a.kind === 'report').slice(-1)[0];
  if (rep) artifactText(rep.id).then((t) => { const el = document.getElementById('report-slot'); if (el) el.innerHTML = `<h2>Report</h2>${reportHtml(JSON.parse(t))}`; }).catch(() => {});
  document.getElementById('reverify')?.addEventListener('click', () => act(() => api('POST', `/api/sessions/${s.id}/verify`), 'Check re-run'));
  document.getElementById('rec-toggle')?.addEventListener('change', (e) => act(() => api('POST', `/api/sessions/${s.id}/recording`, { recording: e.target.checked })));
  document.getElementById('del-replay')?.addEventListener('click', async () => {
    if (await confirmDialog('Delete the private replay?', '<p>All screens for this task are deleted from disk. Findings, files and history are kept.</p>', 'Delete screens', true)) act(() => api('DELETE', `/api/sessions/${s.id}/replay`), 'Replay deleted');
  });
}

// ================================================================ New task composer
async function renderNew() {
  if (!state.catalog) state.catalog = await api('GET', '/api/catalog');
  const ready = state.readyCache || (state.readyCache = await api('GET', '/api/readiness').catch(() => null));
  const desktopsOk = ready?.items.find((i) => i.id === 'desktops')?.status === 'ready';
  const c = state.catalog;
  const mode = state.newMode || 'web';
  const agents = state.newAgents || 2;
  $app.innerHTML = `<form id="newtask" class="composer">
    <h1>What should your agents do?</h1>
    <p class="muted">Each agent gets its own Linux desktop you can watch live. You approve the plan before anything runs; TaskLatch enforces the sites, the shared allowance and checks the results.</p>
    ${desktopsOk ? '' : `<div class="banner warn"><span class="icon">!</span><div><b>Agent desktops are not available.</b><p>${esc(ready?.items.find((i) => i.id === 'desktops')?.detail || '')}</p></div></div>`}
    <div class="seg big" role="group" aria-label="Task type">
      <button type="button" data-mode="web" aria-pressed="${mode === 'web'}">🌐 Any task on the web</button>
      <button type="button" data-mode="supplier" aria-pressed="${mode === 'supplier'}">🧾 Supplier comparison (SupplierLab, verified)</button>
    </div>
    <label for="desc" class="sr-only">Task</label>
    <textarea id="desc" class="prompt" placeholder="${mode === 'web' ? 'e.g. Find when the Eiffel Tower and the Statue of Liberty were completed and who designed each.' : ''}">${mode === 'web' ? esc(state.newDesc || '') : 'Compare two office-supply vendors for 20 USB-C adapters. Use the approved supplier pages, capture price and stock evidence, and prepare a purchase request for review.'}</textarea>
    <div class="row composer-opts">
      <div><span class="lbl">Agents</span><div class="seg" role="group" aria-label="Number of agents">${[1, 2, 3, 4].map((n) => `<button type="button" data-agents="${n}" aria-pressed="${agents === n}">${n}</button>`).join('')}</div></div>
      ${mode === 'web' ? `<div class="grow"><label for="sites" class="lbl">Sites agents may open</label><input id="sites" type="text" value="${esc(state.newSites || 'en.wikipedia.org, upload.wikimedia.org')}">
        <div class="row small" style="margin-top:6px;gap:6px">${['en.wikipedia.org', '*.wikipedia.org', 'upload.wikimedia.org', 'news.ycombinator.com', 'github.com', '127.0.0.1:4100'].map((x) => `<button type="button" class="pill" data-site="${esc(x)}">+ ${esc(x)}</button>`).join('')}</div></div>` : ''}
    </div>
    ${mode === 'supplier' ? `<div class="form-grid">
        <div><label for="qty">Quantity</label><input id="qty" type="number" min="1" value="20"></div>
        <div><label for="scenario">SupplierLab scenario <span class="muted small">(synthetic)</span></label><select id="scenario">${c.scenarios.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')}</select></div>
        <div><label for="expected">Expected result</label><select id="expected"><option value="comparison">Comparison only</option><option value="draft" selected>Comparison + draft</option><option value="submission">Approved submission</option></select></div>
        <div><label for="runtime">Agents run on</label><select id="runtime"><option value="desktop" ${desktopsOk ? 'selected' : 'disabled'}>Linux desktops (live)</option><option value="browser" ${desktopsOk ? '' : 'selected'}>Headless browser (fast)</option></select></div>
      </div><p id="scen-desc" class="muted small"></p><fieldset><legend>Approved sources</legend><div id="sources"></div></fieldset>` : ''}
    <details><summary>Shared allowance</summary><div class="form-grid" style="margin-top:10px">
      ${[['time_seconds', 'Time limit (s)', 900], ['steps_per_worker', 'Steps per agent', 25], ['model_calls', 'Model calls (whole task)', 120], ['token_ceiling', 'Token ceiling', 200000]].map(([k, l, v]) => `<div><label for="lim-${k}">${l}</label><input id="lim-${k}" type="number" min="1" value="${v}"></div>`).join('')}
      <div><label><input type="checkbox" id="recording" checked> Record private screens</label></div></div></details>
    <div class="row"><button class="primary big" type="submit">Plan with ${agents} agent${agents > 1 ? 's' : ''}</button><span id="new-err" role="alert" class="muted"></span></div>
  </form>`;
  const keep = () => { const d = document.getElementById('desc'); if (d && mode === 'web') state.newDesc = d.value; const si = document.getElementById('sites'); if (si) state.newSites = si.value; };
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { keep(); state.newMode = b.dataset.mode; renderNew(); }));
  document.querySelectorAll('[data-agents]').forEach((b) => b.addEventListener('click', () => { keep(); state.newAgents = Number(b.dataset.agents); renderNew(); }));
  document.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => { const si = document.getElementById('sites'); const cur = si.value.split(/[\s,]+/).filter(Boolean); if (!cur.includes(b.dataset.site)) si.value = [...cur, b.dataset.site].join(', '); }));
  if (mode === 'supplier') {
    const renderSources = () => {
      const sc = document.getElementById('scenario').value;
      document.getElementById('scen-desc').textContent = c.scenarios.find((x) => x.id === sc).description;
      document.getElementById('sources').innerHTML = c.sources.filter((x) => x.scenario === sc).map((x) => `<label class="choice"><input type="checkbox" name="src" value="${esc(x.source_id)}" checked><span><b>${esc(x.vendor_name)} — ${x.kind === 'price_list' ? 'trade price list' : 'product page'}</b><span class="muted small"><code>${esc(x.path)}</code></span></span></label>`).join('');
    };
    document.getElementById('scenario').addEventListener('change', renderSources); renderSources();
  }
  document.getElementById('newtask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (k) => Number(document.getElementById('lim-' + k).value);
    const limits = { workers: agents, time_seconds: v('time_seconds'), steps_per_worker: v('steps_per_worker'), model_calls: v('model_calls'), token_ceiling: v('token_ceiling') };
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Coordinator is planning…';
    try {
      const body = mode === 'web'
        ? { mode: 'web', runtime: 'desktop', description: document.getElementById('desc').value, allowed_sites: document.getElementById('sites').value.split(/[\s,]+/).filter(Boolean), limits, recording: document.getElementById('recording').checked }
        : { mode: 'supplier', runtime: document.getElementById('runtime').value, description: document.getElementById('desc').value, item_id: c.item.item_id, quantity: Number(document.getElementById('qty').value),
            source_ids: [...document.querySelectorAll('input[name=src]:checked')].map((i) => i.value), expected_result: document.getElementById('expected').value, limits, recording: document.getElementById('recording').checked };
      const snap = await api('POST', '/api/sessions', body);
      state.newDesc = '';
      location.hash = `#/s/${snap.session.id}/scope`;
    } catch (err) { document.getElementById('new-err').textContent = err.message; btn.disabled = false; btn.textContent = `Plan with ${agents} agent${agents > 1 ? 's' : ''}`; }
  });
}

boot();
