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
  clearInterval(state.poll); state.poll = null; clearInterval(state.rpTimer); state.rpTimer = null; if (state.rp) state.rp.playing = false;
  document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
  if (!state.me) return renderLogin();
  if (parts[0] === 'new') { document.querySelector('[data-nav=new]').setAttribute('aria-current', 'page'); return renderNew(); }
  if (parts[0] === 's' && parts[1]) { if (state.sid !== parts[1]) { state.rp = null; state.feedFilter = 'all'; state.fuAgents = null; } state.sid = parts[1]; state.tab = parts[2] || null; return openSession(); }
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
  $app.innerHTML = `<section class="card" id="running-card" hidden aria-labelledby="running-h"></section>
    <div class="grid two"><section class="card" aria-labelledby="ready-h"><h2 id="ready-h">Readiness</h2><p class="muted small">Checking local desktops, storage, SupplierLab and model access…</p></section>
    <section class="card" aria-labelledby="tasks-h"><div class="row between"><h2 id="tasks-h">Tasks</h2><a class="btn primary" href="#/new">New task</a></div><div id="tasklist" class="muted">Loading…</div></section></div>`;
  const [ready, list] = await Promise.all([api('GET', '/api/readiness').catch((e) => ({ error: e.message })), api('GET', '/api/sessions')]);
  const readyEl = $app.querySelector('[aria-labelledby=ready-h]');
  readyEl.innerHTML = ready.error ? `<h2 id="ready-h">Readiness</h2><p>${esc(ready.error)}</p>` : `<h2 id="ready-h">Readiness</h2>
    <p class="muted small">Checked ${time(ready.checked_at)}. ${ready.items.find((i) => i.id === 'model')?.paid ? 'Desktops, storage and SupplierLab run locally; model calls go to a paid provider.' : 'Everything runs locally; no paid services are used.'}</p>
    <ul class="ready-list">${ready.items.map((i) => `<li><div><b>${esc(i.label)}</b><br>${chip(READY_CHIP, i.status)}</div><div class="small">${esc(i.detail)}</div></li>`).join('')}</ul>
    ${ready.items.find((i) => i.id === 'model')?.paid ? `<div class="banner warn" style="margin:12px 0 0"><span class="icon">$</span><div><b>Paid model provider in use.</b><p>${esc(ready.items.find((i) => i.id === 'model').provider)}. Every task runs under a token ceiling from the shared allowance; check your Fireworks balance and limits before starting.</p></div></div>` : ''}
    ${ready.items.find((i) => i.id === 'model')?.status !== 'ready' && !ready.items.find((i) => i.id === 'model')?.paid ? `<div class="banner warn" style="margin:12px 0 0"><span class="icon">!</span><div><b>No model access configured.</b><p>Agents use a deterministic <em>local-rules</em> stand-in. Its decisions still go through the same permissions, allowance and verification, and every record is labelled. Set <code>NVIDIA_API_KEY</code> to use a hosted model.</p></div></div>` : ''}`;
  drawHomeLists(list.sessions);
  // While anything runs, keep the dashboard's thumbnails and progress current.
  if (list.sessions.some((s) => ACTIVE.has(s.status))) state.poll = setInterval(async () => {
    if (location.hash.replace(/^#\/?/, '') !== '') return;
    try { drawHomeLists((await api('GET', '/api/sessions')).sessions); } catch { /* transient */ }
  }, 3000);
}

function drawHomeLists(sessions) {
  const run = document.getElementById('running-card');
  const running = sessions.filter((s) => ACTIVE.has(s.status));
  run.hidden = !running.length;
  if (running.length) run.innerHTML = `<div class="row between"><h2 id="running-h">Running now</h2><span class="muted small">Latest screen from each agent, refreshed every few seconds</span></div>
    <div class="dash">${running.map((s) => `<a class="dash-card" href="#/s/${esc(s.id)}">
      <div class="row between"><b class="dash-title">${esc(s.title)}</b>${chip(SESSION_CHIP, s.status)}</div>
      <div class="thumbs cols-${Math.min(2, Math.max(1, s.agents.length))}">${s.agents.map((a) => `<figure>${a.last_screenshot ? `<img alt="Latest screen from ${esc(a.label)}" src="/api/sessions/${esc(s.id)}/screens/${esc(a.last_screenshot)}">` : `<div class="thumb-empty">${a.status === 'starting' ? 'Starting…' : 'No screen yet'}</div>`}
        <figcaption><span class="avatar sm">${esc(W_LETTER(a.worker_id))}</span> ${esc(WORKER_CHIP[a.status]?.[2] || a.status)}</figcaption></figure>`).join('')}</div>
      <div class="muted small">${s.progress.done} of ${s.progress.total} subtask${s.progress.total === 1 ? '' : 's'} done${s.deadline_at ? ` · time left ${fmtDur(Math.max(0, Math.round((Date.parse(s.deadline_at) - Date.now()) / 1000)))}` : ''}</div></a>`).join('')}</div>`;
  const el = document.getElementById('tasklist');
  if (!sessions.length) { el.innerHTML = `<div class="empty">No tasks yet. Create one to put agents to work.</div>`; return; }
  const day = (iso) => { const d = new Date(iso); const t = new Date(); const y = new Date(Date.now() - 864e5); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : 'Earlier'; };
  const groups = ['Today', 'Yesterday', 'Earlier'].map((g) => [g, sessions.filter((s) => day(s.created_at) === g)]).filter(([, l]) => l.length);
  const kind = (s) => s.mode === 'web' ? `Web research · ${s.agents.length} agent${s.agents.length === 1 ? '' : 's'}` : `${esc(s.scenario.replace(/_/g, ' '))} scenario · ${esc({ comparison: 'comparison', draft: 'comparison + draft', submission: 'approved submission' }[s.expected_result] || '')}`;
  el.innerHTML = groups.map(([g, l]) => `<h3 class="group-h">${g}</h3><ul class="task-rows">${l.map((s) => `<li><div class="grow"><a href="#/s/${esc(s.id)}">${esc(s.title)}</a>
      <div class="muted small">${s.parent_session_id ? '↳ follow-up · ' : ''}${kind(s)} · ${time(s.created_at)}</div></div>${chip(SESSION_CHIP, s.status)}</li>`).join('')}</ul>`).join('');
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
    sn.submissions.map((x) => x.status).join(), Object.values(sn.verification).map((v) => v.created_at).join(), state.tab === 'results' && state.rp?.playing ? 0 : sn.replay.frames.length, sn.budget.time.elapsed_seconds >> 3,
    (sn.blocked_sites || []).map((b) => b.host + b.count).join(), sn.session.policy_version, (sn.children || []).map((c) => c.status).join(),
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
      <h1>${esc(s.title)}</h1>${state.snap.parent ? `<p class="small" style="margin:-2px 0 6px">↳ Follow-up to <a href="#/s/${esc(state.snap.parent.id)}">${esc(state.snap.parent.title)}</a></p>` : ''}
      <div class="row"><span id="hdr-status">${chip(SESSION_CHIP, s.status)}</span> <span class="chip outline" data-icon="${s.scope.mode === 'web' ? '🌐' : '🧪'}">${s.scope.mode === 'web' ? 'web research' : esc(s.scope.scenario.replace(/_/g, ' ')) + ' scenario'}</span>${s.scope.runtime === 'desktop' ? ' <span class="chip outline" data-icon="🖥">' + agentsOf(s).length + ' Linux desktop' + (agentsOf(s).length > 1 ? 's' : '') + '</span>' : ''}${s.scope.mode === 'web' && s.scope.allowed_sites.includes('*') ? ' <span class="chip warn" data-icon="🌐">any public website</span>' : ''}
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
const W_LETTER = (w) => String(w).replace('worker-', '').toUpperCase();
const agentsOf = (s) => [...new Set((s.plan?.subtasks || []).map((t) => t.worker_id))].sort();
const siteLabel = (x) => (x === '*' ? 'any public website' : x);
const splitSites = (v) => String(v || '').split(/[\s,]+/).filter(Boolean);
const fmtDur = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);
const FEED_KINDS = /^(agent\.intent|agent\.done|agent\.gave_up|agent\.file|worker\.activity|worker\.stuck|worker\.error|worker\.next_task|desktop\.|whiteboard\.post|session\.(started|outcome)|stop\.|budget\.|approval\.|verification\.result|plan\.proposed|operator\.message|scope\.sites_changed)/;

function tabsFor(s) {
  if (s.scope.runtime !== 'desktop') return TABS;
  return [['live', 'Live'], ['board', 'Board'], ['scope', s.scope.mode === 'web' ? 'Plan' : 'Scope'],
    ...(s.scope.mode === 'web' ? [] : [['approval', 'Approval']]), ['usage', 'Usage & stop'], ['results', 'Results & evidence'], ['history', 'History']];
}

// Site presets: each adds every host the site needs (pages and the hosts its assets come from).
const SITE_PRESETS = [
  ['Wikipedia', ['*.wikipedia.org', '*.wikimedia.org']],
  ['Web search (Bing)', ['www.bing.com', '*.bing.com', '*.bing.net']],
  ['Brave Search', ['search.brave.com', '*.search.brave.com']],
  ['GitHub', ['github.com', '*.github.com', '*.githubusercontent.com', '*.githubassets.com']],
  ['Stack Overflow', ['stackoverflow.com', '*.stackexchange.com', '*.sstatic.net']],
  ['Hacker News', ['news.ycombinator.com']],
  ['MDN docs', ['developer.mozilla.org']],
  ['Python docs', ['docs.python.org']],
  ['SupplierLab (local)', ['127.0.0.1:4100']],
  ['Any public website', ['*']],
];
function presetChips(forId) {
  return `<div class="row small presets" data-for="${forId}">${SITE_PRESETS.map(([name, hosts], i) => `<button type="button" class="pill${hosts[0] === '*' ? ' pill-warn' : ''}" data-preset="${i}" title="Adds ${esc(hosts.join(', '))}">+ ${esc(name)}</button>`).join('')}</div>`;
}
function wirePresets(onChange) {
  document.querySelectorAll('.presets [data-preset]').forEach((b) => b.addEventListener('click', () => {
    const input = document.getElementById(b.closest('.presets').dataset.for);
    const cur = splitSites(input.value);
    for (const h of SITE_PRESETS[Number(b.dataset.preset)][1]) if (!cur.includes(h)) cur.push(h);
    input.value = cur.join(', ');
    onChange?.();
  }));
}
function anySiteNote(sites) {
  return sites.includes('*') ? `<div class="banner warn compact"><span class="icon">!</span><div><b>Any public website.</b><p>Agents may open any public site. Private and local network addresses and TaskLatch itself stay blocked, form posts stay blocked, and every finding is still source-checked against the page TaskLatch captured.</p></div></div>` : '';
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

const lastIntent = (worker) => state.snap.events.findLast?.((e) => e.kind === 'agent.intent' && e.actor === worker) ?? [...state.snap.events].reverse().find((e) => e.kind === 'agent.intent' && e.actor === worker);
function queueInfo(worker) {
  const queue = state.snap.tasks.filter((t) => t.assignee === worker && t.kind === 'research');
  const cur = queue.find((t) => t.status === 'running') || queue.find((t) => t.status === 'ready') || queue[queue.length - 1];
  return `${cur?.title || ''}${queue.length > 1 ? ` · subtask ${queue.indexOf(cur) + 1} of ${queue.length}` : ''}`;
}
const isRunning = () => !!state.snap.session.live && ['RUNNING', 'VERIFYING', 'AWAITING_APPROVAL'].includes(state.snap.session.status);

function tileHtml(w, live, running) {
  const lv = live.find((l) => l.worker_id === w.worker_id);
  const thought = lastIntent(w.worker_id)?.data?.action?.thought || '';
  return `<article class="tile" data-w="${esc(w.worker_id)}">
    <header class="tile-head"><button type="button" class="avatar-btn" data-focus="${esc(w.worker_id)}" title="Focus on ${esc(w.label)}"><span class="avatar">${esc(W_LETTER(w.worker_id))}</span></button><div class="grow"><b>${esc(w.label)}</b><div class="muted small tile-task">${esc(queueInfo(w.worker_id))}</div></div>
      <span class="tile-status">${chip(WORKER_CHIP, w.status)}</span></header>
    <div class="tile-url mono">${esc(w.current_url || 'about:blank')}</div>
    <div class="tile-screen">${tileScreen(w, lv)}</div>
    <div class="tile-thought small"${thought ? '' : ' hidden'}><span aria-hidden="true">💭</span> <span class="tt">${esc(thought)}</span></div>
    <footer class="tile-foot"><span class="tile-activity">${esc(w.activity || '')}</span>
      ${lv?.live_url ? `<button data-takeover="${esc(w.worker_id)}" data-on="${lv.paused ? 0 : 1}" class="${lv.paused ? 'primary' : ''}">${lv.paused ? '↩ Hand back' : '✋ Take over'}</button>` : ''}
      ${lv ? `<span class="muted small tile-proxy">proxy ${lv.proxy.allowed} allowed · ${lv.proxy.blocked} blocked</span>` : ''}</footer>
    ${running && lv ? `<form class="tile-msg" data-msg="${esc(w.worker_id)}"><label class="sr-only" for="msg-${esc(w.worker_id)}">Message to ${esc(w.label)}</label><input id="msg-${esc(w.worker_id)}" type="text" maxlength="500" placeholder="Tell ${esc(w.label)} something…" autocomplete="off"><button type="submit">Send</button></form>` : ''}
  </article>`;
}

function tabLive() {
  const { workers, live, session: s } = state.snap;
  if (!workers.length) return `<div class="card empty">No agents planned yet.</div>`;
  const view = state.liveView || 'grid';
  const focusW = state.focusWorker && workers.find((w) => w.worker_id === state.focusWorker) ? state.focusWorker : workers[0].worker_id;
  const shown = view === 'focus' ? workers.filter((w) => w.worker_id === focusW) : workers;
  const cols = view === 'focus' || shown.length === 1 ? 1 : 2;
  const running = isRunning();
  const filter = state.feedFilter || 'all';
  return `${TERMINAL.has(s.status) && isWeb() ? `<section class="card summary">${summaryCard()}</section>` : ''}
  <div class="live-wrap">
    <div class="live-main">
      <div class="row between" style="margin-bottom:10px">
        <div class="seg" role="group" aria-label="Layout"><button data-view="grid" aria-pressed="${view === 'grid'}">▦ Grid</button><button data-view="focus" aria-pressed="${view === 'focus'}">▣ Focus</button></div>
        ${view === 'focus' ? `<div class="seg" role="group" aria-label="Agent">${workers.map((w) => `<button data-focus="${esc(w.worker_id)}" aria-pressed="${w.worker_id === focusW}">${esc(w.label)}</button>`).join('')}</div>` : ''}
        <span class="muted small">Linux desktops in Docker · live view · ${live.length} running</span>
      </div>
      <div id="live-grid" class="live-grid cols-${cols}" data-shape="${esc(liveShape(shown, live, running))}">
        ${shown.map((w) => tileHtml(w, live, running)).join('')}
      </div>
    </div>
    <aside class="live-side">
      ${isWeb() ? `<section class="card tight sites-card" id="sites-card">${sitesPanel()}</section>` : ''}
      <section class="card tight feed-card"><div class="row between"><h2>Agent reasoning</h2>
        <div class="seg small-seg" role="group" aria-label="Show reasoning from">${['all', ...workers.map((w) => w.worker_id)].map((w) => `<button data-feed="${esc(w)}" aria-pressed="${filter === w}">${w === 'all' ? 'All' : esc(W_LETTER(w))}</button>`).join('')}</div></div>
        <ul id="live-feed" class="feed live-feed">${feedItems()}</ul>
        ${running ? `<form id="msg-all" class="tile-msg flat"><label class="sr-only" for="msg-all-text">Message to all agents</label><input id="msg-all-text" type="text" maxlength="500" placeholder="Message all agents…" autocomplete="off"><button type="submit">Send</button></form>` : ''}
      </section>
      <section class="card tight wb-card"><h2>Whiteboard</h2><p class="muted small">Findings agents shared. Agent statements: TaskLatch checks each quote against the page it captured.</p><ul id="live-board" class="wb">${whiteboardItems()}</ul></section>
    </aside>
  </div>`;
}
const liveShape = (shown, live, running) => shown.map((w) => { const l = live.find((x) => x.worker_id === w.worker_id); return w.worker_id + ':' + (l?.live_url ? 'L' + (l.paused ? 'P' : '') : 'S') + (running && l ? 'M' : ''); }).join(',');

function actionLabel(a) {
  switch (a.action) {
    case 'click': return `click #${a.element}`;
    case 'type': return `type “${String(a.text ?? '').slice(0, 40)}” into #${a.element}${a.submit ? ' + Enter' : ''}`;
    case 'key': return `press ${a.keys}`;
    case 'scroll': return `scroll ${a.direction || 'down'}`;
    case 'navigate': return `open ${a.url}`;
    case 'search': return `search “${String(a.text ?? '').slice(0, 60)}”`;
    case 'record_finding': return `record finding: ${String(a.claim ?? '').slice(0, 90)}`;
    case 'save_file': return `save file ${a.filename}`;
    case 'give_up': return 'give up';
    default: return a.action;
  }
}

function feedItems() {
  const f = state.feedFilter || 'all';
  const ev = state.snap.events.filter((e) => (FEED_KINDS.test(e.kind) || (e.kind === 'policy.decision' && e.data?.decision === 'DENY'))
    && (f === 'all' || e.actor === f || (e.kind === 'operator.message' && (e.data?.to === f || e.data?.to === 'all')))).slice(-80).reverse();
  return ev.map((e) => {
    const who = e.actor.startsWith('worker') ? `<span class="avatar sm">${esc(W_LETTER(e.actor))}</span>` : e.actor === 'operator' ? '<span class="avatar sm you">You</span>' : `<span class="avatar sm sys">${esc(e.actor.slice(0, 1).toUpperCase())}</span>`;
    if (e.kind === 'agent.intent' && e.data?.action) {
      const a = e.data.action;
      return `<li class="intent"><span class="t">${time(e.at)}</span>${who}<div class="grow">${a.thought ? `<div class="thought">${esc(a.thought)}</div>` : ''}<div class="act"><code>${esc(actionLabel(a))}</code>${e.data.step ? ` <span class="muted small">step ${e.data.step}</span>` : ''}</div></div></li>`;
    }
    if (e.kind === 'operator.message') return `<li class="op"><span class="t">${time(e.at)}</span>${who}<span><b>To ${esc(e.data?.to === 'all' ? 'all agents' : labelActor(e.data?.to))}:</b> ${esc(e.data?.text || '')}</span></li>`;
    const deny = e.kind === 'policy.decision';
    const outcome = e.kind === 'worker.activity';
    return `<li class="${deny ? 'deny' : outcome ? 'outcome' : ''}"><span class="t">${time(e.at)}</span>${who}<span>${deny ? chip(DECISION_CHIP, 'DENY') + ' ' : ''}${outcome ? '↳ ' : ''}${esc(e.summary.replace(/^Worker [A-D]( →|:)\s*/, ''))}</span></li>`;
  }).join('') || '<li class="muted">Nothing yet.</li>';
}

function whiteboardItems() {
  return (state.snap.whiteboard || []).slice().reverse().map((w) => `<li><div class="row" style="gap:6px"><span class="avatar sm">${esc(W_LETTER(w.actor))}</span>
    ${w.quote_found ? chip({ k: ['ok', '✓', 'Quote on page'] }, 'k') : chip({ k: ['warn', '?', 'Quote not found'] }, 'k')}${w.injected ? ' ' + chip({ k: ['bad', '⚠', 'Page had injected instructions'] }, 'k') : ''}</div>
    <div class="wb-claim">${esc(w.claim || '')}</div>${w.quote ? `<div class="wb-quote">“${esc(w.quote)}”</div>` : ''}<div class="muted small mono">${esc(w.url || '')}</div></li>`).join('') || '<li class="muted">No findings yet.</li>';
}

const sitesOpen = () => { const s = state.snap.session; return !TERMINAL.has(s.status) && !s.stop_requested_at; };
function sitesPanel() {
  return `<h2>Sites</h2>
    <p class="small" id="approved-sites">${approvedSites()}</p>
    <div id="blocked-list">${blockedList()}</div>
    ${sitesOpen() ? `<form id="add-site" class="row add-site"><label for="add-site-host" class="sr-only">Allow another site</label><input id="add-site-host" type="text" placeholder="Allow another site, e.g. example.org" autocomplete="off"><button type="submit">Allow</button></form>` : ''}`;
}
const approvedSites = () => `<span class="muted">Approved:</span> ${state.snap.session.scope.allowed_sites.map((x) => `<code>${esc(siteLabel(x))}</code>`).join(' ')}`;
function blockedList() {
  const b = state.snap.blocked_sites || [];
  if (!b.length) return '<p class="muted small">No blocked sites waiting for you.</p>';
  return `<p class="muted small">Blocked in this task. Allowing one applies to every agent from its next request and is recorded as your decision.</p>
    <ul class="blocked">${b.map((x) => `<li><div class="grow"><b class="mono">${esc(x.host)}</b><div class="muted small">${x.agent_asked ? 'An agent tried to open it' : 'Requested by a page'} · ${x.workers.map((w) => esc(W_LETTER(w))).join(', ')} · ${x.count}×</div></div>${sitesOpen() ? `<button type="button" data-allow="${esc(x.host)}">Allow</button>` : ''}</li>`).join('')}</ul>`;
}

function summaryCard() {
  const sn = state.snap; const s = sn.session;
  const checks = (sn.verification.report?.checks || []).filter((c) => c.name.startsWith('finding:'));
  const ok = checks.filter((c) => c.status === 'pass').length;
  const dur = s.started_at && s.ended_at ? Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000)) : null;
  return `<div class="row between"><h2>Session complete</h2>${chip(SESSION_CHIP, s.status)}</div>
    <div class="stats">
      <div><b>${ok} of ${checks.length}</b><span>findings source-checked</span></div>
      <div><b>${agentsOf(s).length}</b><span>agent${agentsOf(s).length > 1 ? 's' : ''}</span></div>
      <div><b>${sn.tasks.filter((t) => t.kind === 'research').length}</b><span>subtasks</span></div>
      <div><b>${dur === null ? '—' : fmtDur(dur)}</b><span>run time</span></div>
      <div><b>${esc(sn.budget.payable_cost?.display ?? '—')}</b><span>model cost</span></div>
      <div><b>${sn.files.length}</b><span>file${sn.files.length === 1 ? '' : 's'} made</span></div>
    </div>
    <div class="row"><a class="btn" href="#/s/${esc(s.id)}/results">Report, files and replay</a><a class="btn" href="/api/sessions/${esc(s.id)}/report.csv" download>Spreadsheet (CSV)</a><a class="btn" href="/api/sessions/${esc(s.id)}/evidence" download>Evidence bundle</a></div>
    ${followUpForm()}`;
}

function followUpForm() {
  const kids = state.snap.children || [];
  const n = state.fuAgents || agentsOf(state.snap.session).length || 1;
  return `<form id="followup" class="followup">
    <label for="fu-text"><b>Follow up</b> <span class="muted small">A new task with the same sites and fresh desktops. It gets this task’s source-checked findings as context, and you review its plan first.</span></label>
    <div class="row"><input id="fu-text" type="text" maxlength="2000" placeholder="Give follow-up instructions…" autocomplete="off">
      <div class="seg" role="group" aria-label="Agents for the follow-up">${[1, 2, 3, 4].map((k) => `<button type="button" data-fu-agents="${k}" aria-pressed="${n === k}">${k}</button>`).join('')}</div>
      <button class="primary" type="submit">Plan follow-up</button></div>
    ${kids.length ? `<p class="small" style="margin:8px 0 0">Follow-ups: ${kids.map((k) => `<a href="#/s/${esc(k.id)}">${esc(k.title)}</a> ${chip(SESSION_CHIP, k.status)}`).join(' · ')}</p>` : ''}</form>`;
}
function wireFollowUp() {
  const s = state.snap.session;
  document.querySelectorAll('[data-fu-agents]').forEach((b) => b.addEventListener('click', () => {
    state.fuAgents = Number(b.dataset.fuAgents);
    document.querySelectorAll('[data-fu-agents]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  document.getElementById('followup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('fu-text').value.trim();
    if (text.length < 8) { document.getElementById('fu-text').focus(); announce('Describe the follow-up in a few words'); return; }
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Coordinator is planning…';
    try {
      const snap = await api('POST', `/api/sessions/${s.id}/followup`, { description: text, agents: state.fuAgents || agentsOf(s).length });
      location.hash = `#/s/${snap.session.id}/scope`;
    } catch (err) { btn.disabled = false; btn.textContent = 'Plan follow-up'; await confirmDialog('Could not plan the follow-up', `<p>${esc(err.message)}</p>`, 'OK'); }
  });
}

function wireSites() {
  const s = state.snap.session;
  const allow = async (hosts) => {
    const any = hosts.includes('*');
    const ok = await confirmDialog(any ? 'Allow any public website?' : `Allow ${hosts.join(', ')}?`,
      `<p>${any ? 'Every agent in this task may open any public website' : `Every agent in this task may open <b>${esc(hosts.join(', '))}</b>`} from its next request. Private and local addresses and TaskLatch itself stay blocked, form posts stay blocked, and findings are still source-checked. This is recorded as your decision.</p>`,
      any ? 'Allow any public website' : 'Allow site');
    if (ok) await act(() => api('POST', `/api/sessions/${s.id}/sites`, { add: hosts }), 'Site allowed');
  };
  document.getElementById('add-site')?.addEventListener('submit', (e) => { e.preventDefault(); const v = splitSites(document.getElementById('add-site-host').value); if (v.length) allow(v); });
  // Delegated: the blocked list is refreshed in place while the task runs.
  document.querySelectorAll('#sites-card, #plan-sites').forEach((el) => el.addEventListener('click', (e) => { const b = e.target.closest('[data-allow]'); if (b) allow([b.dataset.allow]); }));
}

/** Update the Live tab in place so the embedded desktops are not reloaded on every poll. */
function updateLive() {
  const grid = document.getElementById('live-grid');
  if (!grid) return false;
  const { workers, live } = state.snap;
  const view = state.liveView || 'grid';
  const focusW = state.focusWorker || workers[0]?.worker_id;
  const shown = view === 'focus' ? workers.filter((w) => w.worker_id === focusW) : workers;
  if (grid.dataset.shape !== liveShape(shown, live, isRunning())) return false;
  for (const w of shown) {
    const t = grid.querySelector(`.tile[data-w="${w.worker_id}"]`);
    if (!t) return false;
    t.querySelector('.tile-status').innerHTML = chip(WORKER_CHIP, w.status);
    t.querySelector('.tile-url').textContent = w.current_url || 'about:blank';
    t.querySelector('.tile-activity').textContent = w.activity || '';
    t.querySelector('.tile-task').textContent = queueInfo(w.worker_id);
    const thought = lastIntent(w.worker_id)?.data?.action?.thought || '';
    const th = t.querySelector('.tile-thought'); th.hidden = !thought; th.querySelector('.tt').textContent = thought;
    const lv = live.find((l) => l.worker_id === w.worker_id);
    const px = t.querySelector('.tile-proxy'); if (px && lv) px.textContent = `proxy ${lv.proxy.allowed} allowed · ${lv.proxy.blocked} blocked`;
    const img = t.querySelector('.tile-screen img');
    if (img && w.last_screenshot && !img.src.endsWith(w.last_screenshot)) img.src = `/api/sessions/${state.snap.session.id}/screens/${w.last_screenshot}`;
  }
  const feed = document.getElementById('live-feed'); if (feed) feed.innerHTML = feedItems();
  const board = document.getElementById('live-board'); if (board) board.innerHTML = whiteboardItems();
  const bl = document.getElementById('blocked-list'); if (bl) bl.innerHTML = blockedList();
  const ap = document.getElementById('approved-sites'); if (ap) ap.innerHTML = approvedSites();
  const hs = document.getElementById('hdr-status'); if (hs) hs.innerHTML = chip(SESSION_CHIP, state.snap.session.status);
  return true;
}

function wireLive() {
  const s = state.snap.session;
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.liveView = b.dataset.view; renderSession(); }));
  document.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => { state.focusWorker = b.dataset.focus; state.liveView = 'focus'; renderSession(); }));
  document.querySelectorAll('[data-feed]').forEach((b) => b.addEventListener('click', () => {
    state.feedFilter = b.dataset.feed;
    document.querySelectorAll('[data-feed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.getElementById('live-feed').innerHTML = feedItems();
  }));
  document.querySelectorAll('[data-takeover]').forEach((b) => b.addEventListener('click', async () => {
    const on = b.dataset.on === '1';
    if (on && !(await confirmDialog(`Take over ${labelActor(b.dataset.takeover)}?`, '<p>The agent pauses and the live view becomes interactive: your clicks and typing go to that desktop. Its traffic still goes through TaskLatch’s proxy. Hand it back when you are done.</p>', 'Take over'))) return;
    await api('POST', `/api/sessions/${s.id}/workers/${b.dataset.takeover}/takeover`, { on });
    state.snap = await api('GET', `/api/sessions/${s.id}`); renderSession();
  }));
  const send = async (form, to) => {
    const input = form.querySelector('input'); const text = input.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/sessions/${s.id}/messages`, { to, text });
      input.value = ''; input.blur();
      announce(`Message sent to ${to === 'all' ? 'all agents' : labelActor(to)}`);
      state.snap = await api('GET', `/api/sessions/${s.id}`);
      if (!updateLive()) renderSession();
    } catch (err) { await confirmDialog('Message not sent', `<p>${esc(err.message)}</p>`, 'OK'); }
  };
  document.querySelectorAll('form.tile-msg[data-msg]').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); send(f, f.dataset.msg); }));
  document.getElementById('msg-all')?.addEventListener('submit', (e) => { e.preventDefault(); send(e.target, 'all'); });
  wireSites();
  wireFollowUp();
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
        const q = tasks.filter((x) => x.kind === 'research' && x.assignee === t.assignee);
        return `<article class="board-card"><div class="row between"><b>${esc(t.title)}</b>${chip(TASK_CHIP, t.status)}</div>
          <div class="muted small">${t.assignee.startsWith('worker') ? `<span class="avatar sm">${esc(W_LETTER(t.assignee))}</span> ` : ''}${esc(labelActor(t.assignee))}${t.kind === 'research' && q.length > 1 ? ` · ${q.indexOf(t) + 1} of ${q.length} in its queue` : ''}</div>
          ${t.detail ? `<div class="small">${esc(t.detail)}</div>` : ''}${w && ['running', 'waiting'].includes(t.status) ? `<div class="small muted">${esc(w.activity || '')}</div>` : ''}</article>`; }).join('') || '<div class="muted small empty-col">—</div>'}
    </section>`;
  }).join('')}</div>`;
}

// ================================================================ Web tasks: plan and report
const MAX_SUBTASKS = 8;
function subtaskCard(t, i, editable, n) {
  if (!editable) return `<div class="subtask"><div class="row"><span class="avatar">${esc(W_LETTER(t.worker_id))}</span><b>${esc(t.title)}</b></div><p class="small">${esc(t.instructions)}</p><p class="muted small mono">${esc(t.start_url)}</p></div>`;
  const ws = Array.from({ length: n }, (_, k) => `worker-${'abcd'[k]}`);
  return `<div class="subtask" data-st-card="${i}">
    <div class="row between"><label class="inline">Agent <select data-f="worker_id">${ws.map((w) => `<option value="${w}" ${w === t.worker_id ? 'selected' : ''}>${labelActor(w)}</option>`).join('')}</select></label>
      <button type="button" class="linklike" data-st-remove="${i}" aria-label="Remove subtask ${i + 1}">Remove</button></div>
    <label>Title<input type="text" data-f="title" value="${esc(t.title)}" maxlength="120"></label>
    <label>Instructions<textarea data-f="instructions" maxlength="1500">${esc(t.instructions)}</textarea></label>
    <label>Start page<input type="text" data-f="start_url" value="${esc(t.start_url)}" placeholder="https://…"></label></div>`;
}

function tabScopeWeb() {
  const { session: s } = state.snap;
  const editable = ['DRAFT', 'READY'].includes(s.status);
  const sc = s.scope; const L = sc.limits;
  const nAgents = agentsOf(s).length; const nSub = s.plan.subtasks.length;
  return `<div class="banner info"><span class="icon">ⓘ</span><div><b>Web research with ${nAgents} agent${nAgents > 1 ? 's' : ''} and ${nSub} subtask${nSub > 1 ? 's' : ''}.</b><p>Each agent gets its own Linux desktop and works through its subtasks in order. They may only open the sites listed here; every page, redirect and asset request is checked at TaskLatch’s proxy. No purchases or form posts. Findings must quote the page, and TaskLatch checks every quote.</p></div></div>
  <div class="grid three">
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'ALLOW')}</h3><ul>${sc.actions.allowed.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'REQUIRE_APPROVAL')}</h3><ul><li>Opening a site that is not on the list: it is blocked, and you can allow it for this task while the agents work.</li><li>You can message any agent, or take over its desktop.</li></ul></section>
    <section class="card scope-col"><h3>${chip(DECISION_CHIP, 'DENY')}</h3><ul>${sc.actions.blocked.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul></section>
  </div>
  <section class="card" id="plan-sites"><h2>Sites agents may open</h2>
    ${editable ? `<label for="ws-sites" class="sr-only">Allowed sites</label><input id="ws-sites" type="text" value="${esc(sc.allowed_sites.join(', '))}">${presetChips('ws-sites')}<div id="any-note">${anySiteNote(sc.allowed_sites)}</div>
      <p class="muted small">Comma-separated hosts. Use *.example.org for subdomains, or * for any public website. Sites that pages load images and scripts from must be allowed too; you can allow them while the task runs.</p>`
      : `<p>${sc.allowed_sites.map((x) => `<code>${esc(siteLabel(x))}</code>`).join(' ')}</p>${sitesOpen() ? `<div id="blocked-list">${blockedList()}</div><form id="add-site" class="row add-site"><label for="add-site-host" class="sr-only">Allow another site</label><input id="add-site-host" type="text" placeholder="Allow another site, e.g. example.org" autocomplete="off"><button type="submit">Allow</button></form>` : ''}`}
    <p class="muted small">Allowance: ${L.workers} desktop${L.workers > 1 ? 's' : ''} · ${L.steps_per_worker} steps each · ${L.model_calls} model calls · ${L.token_ceiling ? L.token_ceiling.toLocaleString() + ' tokens' : 'no token ceiling'} · ${Math.round(L.time_seconds / 60)} min</p></section>
  <section class="card"><h2>Coordinator’s plan</h2><p class="muted">${esc(s.plan.rationale || '')}</p>
    ${state.snap.parent ? `<p class="small">Follow-up to <a href="#/s/${esc(state.snap.parent.id)}">${esc(state.snap.parent.title)}</a>; its ${s.request.context?.findings?.length || 0} source-checked finding(s) are given to the coordinator and the agents as context.</p>` : ''}
    ${editable ? `<form id="ws-refine" class="refine"><label for="ws-refine-text">Ask the coordinator to change the plan</label><div class="row"><input id="ws-refine-text" type="text" maxlength="1000" placeholder="e.g. Add a subtask that checks the official website; give Worker B the second half" autocomplete="off"><button type="submit">Revise plan</button></div>
      <p class="muted small">Uses one model call from the shared allowance. Unsaved edits below are replaced.</p></form>` : ''}
    <div class="subtasks" id="subtasks">${s.plan.subtasks.map((t, i) => subtaskCard(t, i, editable, L.workers)).join('')}</div>
    ${editable ? `<p id="plan-err" class="muted" role="alert"></p><div class="row"><button id="ws-add" ${nSub >= MAX_SUBTASKS ? 'disabled' : ''}>+ Add subtask</button><button id="ws-save">Save plan</button><button class="primary big" id="ws-start">Accept plan and start ${nAgents} agent${nAgents > 1 ? 's' : ''}</button></div>` : '<p class="muted small">The plan is locked once the task starts. You can still allow sites and message agents.</p>'}
  </section>`;
}
function wireScopeWeb() {
  const s = state.snap.session;
  const note = () => { const el = document.getElementById('any-note'); if (el) el.innerHTML = anySiteNote(splitSites(document.getElementById('ws-sites').value)); };
  wirePresets(note);
  document.getElementById('ws-sites')?.addEventListener('input', note);
  const collect = () => ({
    allowed_sites: splitSites(document.getElementById('ws-sites').value),
    subtasks: [...document.querySelectorAll('[data-st-card]')].map((card) => Object.fromEntries([...card.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value.trim()]))),
  });
  const invalid = (p) => !p.allowed_sites.length ? 'List at least one site.' : !p.subtasks.length ? 'Keep at least one subtask.'
    : p.subtasks.some((t) => !t.title || !t.instructions) ? 'Every subtask needs a title and instructions (or remove it).' : '';
  const redraw = (subs) => {
    document.getElementById('subtasks').innerHTML = subs.map((t, i) => subtaskCard(t, i, true, s.scope.limits.workers)).join('');
    document.getElementById('ws-add').disabled = subs.length >= MAX_SUBTASKS;
    wireRemove();
  };
  const wireRemove = () => document.querySelectorAll('[data-st-remove]').forEach((b) => b.addEventListener('click', () => {
    const subs = collect().subtasks; subs.splice(Number(b.dataset.stRemove), 1); redraw(subs);
    document.getElementById('ws-add')?.focus(); announce(`Subtask removed; ${subs.length} left`);
  }));
  wireRemove();
  document.getElementById('ws-add')?.addEventListener('click', () => {
    const subs = collect().subtasks; const n = s.scope.limits.workers;
    const load = Array.from({ length: n }, (_, k) => subs.filter((t) => t.worker_id === `worker-${'abcd'[k]}`).length);
    subs.push({ worker_id: `worker-${'abcd'[load.indexOf(Math.min(...load))]}`, title: '', instructions: '', start_url: '' });
    redraw(subs);
    document.querySelector(`[data-st-card="${subs.length - 1}"] [data-f="title"]`)?.focus();
  });
  const save = async () => {
    const p = collect(); const err = invalid(p);
    if (err) { document.getElementById('plan-err').textContent = err; return false; }
    try { state.snap = await api('PATCH', `/api/sessions/${s.id}/scope`, p); return true; }
    catch (e) { document.getElementById('plan-err').textContent = e.message; return false; }
  };
  document.getElementById('ws-save')?.addEventListener('click', async () => { if (await save()) { announce('Plan saved'); renderSession(); } });
  document.getElementById('ws-start')?.addEventListener('click', async () => {
    if (!(await save())) return;
    await act(() => api('POST', `/api/sessions/${s.id}/start`)); location.hash = `#/s/${s.id}/live`;
  });
  document.getElementById('ws-refine')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('ws-refine-text').value.trim();
    if (!text) return;
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Coordinator is revising…';
    await act(() => api('POST', `/api/sessions/${s.id}/plan/refine`, { instruction: text }), 'Plan revised');
  });
  wireSites();
}

function tabResultsWeb() {
  const { verification: v, session: s, artifacts, files } = state.snap;
  const r = v.report;
  const rep = artifacts.filter((a) => a.kind === 'report').slice(-1)[0];
  const md = artifacts.filter((a) => a.kind === 'report_md').slice(-1)[0];
  return `<section class="card"><div class="row between"><h2>Source check</h2><div class="row"><button id="reverify" ${rep ? '' : 'disabled'}>Re-run check</button>
      ${rep ? `<a class="btn" href="/api/sessions/${esc(s.id)}/report.csv" download>Spreadsheet (CSV)</a>` : ''}${md ? `<a class="btn" href="/api/sessions/${esc(s.id)}/artifacts/${esc(md.id)}?download=1">Report (Markdown)</a>` : ''}
      <a class="btn primary" href="/api/sessions/${esc(s.id)}/evidence" download>Export evidence bundle</a></div></div>
    <p class="muted small">Each finding’s quote is checked against the page text TaskLatch captured from that agent’s browser at the moment it was recorded. Verified means source-checked — the text was on that approved page — not that the claim is true.</p>
    <p>${chip(VERIFY_CHIP, r?.status || 'missing')} ${esc(r?.summary || 'Not checked yet')}</p></section>
  <div id="report-slot" class="card"><h2>Report</h2>${rep ? '<p class="muted">Loading…</p>' : '<p class="muted">Not produced yet.</p>'}</div>
  ${files.length ? `<section class="card"><h2>Files the agents made</h2><p class="muted small">Agent statements. TaskLatch records each file’s hash and checks it has not changed since it was saved; it does not check what the file says.</p>
    <ul class="files">${files.map((f) => `<li><span class="avatar sm">${esc(W_LETTER(f.owner))}</span> <b class="mono">${esc(f.name)}</b> <span class="muted small">${esc(f.media_type)} · sha256 ${esc(short(f.sha256))}</span>
      <span class="grow"></span><a href="/api/sessions/${esc(s.id)}/artifacts/${esc(f.id)}" target="_blank" rel="noopener">View</a><a href="/api/sessions/${esc(s.id)}/artifacts/${esc(f.id)}?download=1">Download</a></li>`).join('')}</ul></section>` : ''}
  <section class="card" id="replay-card">${replayHtml()}</section>
  ${TERMINAL.has(s.status) ? `<section class="card">${followUpForm()}</section>` : ''}`;
}
function reportHtml(rep) {
  const checks = Object.fromEntries((state.snap.verification.report?.checks || []).map((c) => [c.name, c]));
  const taskOf = (sec) => state.snap.tasks.find((t) => t.id === sec.task_id) || state.snap.tasks.find((t) => t.kind === 'research' && t.assignee === sec.worker);
  return `<div class="banner info"><span class="icon">💬</span><div><b>Coordinator summary — agent statement, not verified</b><p style="white-space:pre-wrap">${esc(rep.coordinator_summary || '—')}</p></div></div>
    ${rep.sections.map((sec) => `<h3 class="row"><span class="avatar">${esc(W_LETTER(sec.worker))}</span> ${esc(sec.title)} ${chip(TASK_CHIP, taskOf(sec)?.status || sec.task_status)}</h3>
      ${sec.agent_summary ? `<p class="small muted">Agent said: ${esc(sec.agent_summary)}</p>` : ''}
      <ul class="checks">${sec.findings.map((f) => { const ref = `${W_LETTER(sec.worker)}${f.n}`; const c = checks[`finding:${ref}`]; if (f.superseded_by) return `<li class="muted">${chip({ s: ['neutral', '↻', 'Superseded'] }, 's')}<span><b>[${ref}]</b> ${esc(f.claim)}<br><span class="small">Quote rejected; replaced by [${W_LETTER(sec.worker)}${f.superseded_by}].</span></span></li>`;
        return `<li>${c?.status === 'pass' ? chip({ p: ['ok', '✓', 'Source-checked'] }, 'p') : chip({ f: ['bad', '✕', 'Not supported'] }, 'f')}<span><b>[${ref}]</b> ${esc(f.claim)}<br><span class="muted small">“${esc(f.quote)}” — <span class="mono">${esc(f.url || '')}</span>${f.snapshot_artifact ? ` · <a href="/api/sessions/${esc(state.snap.session.id)}/artifacts/${esc(f.snapshot_artifact)}" target="_blank" rel="noopener">captured page</a>` : ''}</span></span></li>`; }).join('') || '<li class="muted">No findings recorded.</li>'}</ul>`).join('')}`;
}
function wireResultsWeb() {
  const s = state.snap.session;
  const rep = state.snap.artifacts.filter((a) => a.kind === 'report').slice(-1)[0];
  if (rep) artifactText(rep.id).then((t) => { const el = document.getElementById('report-slot'); if (el) el.innerHTML = `<h2>Report</h2>${reportHtml(JSON.parse(t))}`; }).catch(() => {});
  document.getElementById('reverify')?.addEventListener('click', () => act(() => api('POST', `/api/sessions/${s.id}/verify`), 'Check re-run'));
  wireReplay();
  wireFollowUp();
}

// ================================================================ Replay player and timelapse
const rpState = () => state.rp || (state.rp = { worker: 'all', idx: null, playing: false });
function replayFrames() {
  const w = rpState().worker;
  return state.snap.replay.frames.filter((f) => w === 'all' || f.worker === w);
}
/** What the agent decided right after this screen was captured (the next intent event from that agent). */
function frameCaption(f) {
  if (!f) return '';
  const e = state.snap.events.find((x) => x.kind === 'agent.intent' && x.actor === f.worker && x.at >= f.at);
  const a = e?.data?.action;
  return `${labelActor(f.worker)} · ${time(f.at)}${e?.data?.step ? ` · step ${e.data.step}` : ''}${a ? ` — ${a.thought ? a.thought + ' → ' : ''}${actionLabel(a)}` : ''}`;
}
function replayHtml() {
  const { replay, workers, session: s } = state.snap;
  const rp = rpState(); const frames = replayFrames();
  const idx = rp.idx === null || rp.idx >= frames.length ? frames.length - 1 : rp.idx;
  const f = frames[idx];
  return `<div class="row between"><h2>Replay</h2><div class="row"><label class="inline"><input type="checkbox" id="rec-toggle" ${replay.recording ? 'checked' : ''}> Record screens</label>
      <button id="rp-export" ${frames.length > 1 && canRecordVideo() ? '' : 'disabled'} title="${canRecordVideo() ? 'Make a video of these frames in your browser' : 'This browser cannot record video'}">Download timelapse</button>
      <button id="del-replay" ${replay.frames.length ? '' : 'disabled'}>Delete replay</button></div></div>
    <p class="muted small">${replay.frames.length} frame(s), one per agent step. Private: served only to you and not in the evidence bundle. The timelapse is made in this browser; nothing is uploaded.</p>
    ${replay.frames.length ? `<div class="seg" role="group" aria-label="Replay agent">${['all', ...workers.map((w) => w.worker_id)].map((w) => `<button data-rp-worker="${esc(w)}" aria-pressed="${rp.worker === w}">${w === 'all' ? 'All agents' : esc(labelActor(w))}</button>`).join('')}</div>` : ''}
    ${f ? `<div class="player" id="rp" tabindex="0" aria-label="Replay player. Left and right arrows step, space plays or pauses.">
      <figure><img id="rp-img" alt="Screen from ${esc(labelActor(f.worker))} at ${time(f.at)}" src="/api/sessions/${esc(s.id)}/screens/${esc(f.file)}"><figcaption id="rp-cap">${esc(frameCaption(f))}</figcaption></figure>
      <div class="player-bar"><button id="rp-prev" aria-label="Previous frame">◀</button><button id="rp-play" aria-label="${rp.playing ? 'Pause' : 'Play'}">${rp.playing ? '❚❚' : '▶'}</button><button id="rp-next" aria-label="Next frame">▶▶</button>
        <input id="rp-range" type="range" min="0" max="${frames.length - 1}" value="${idx}" aria-label="Frame"><span id="rp-pos" class="mono small">${idx + 1}/${frames.length}</span><button id="rp-latest">Latest</button></div></div>` : '<p class="muted">No frames yet.</p>'}`;
}
function showFrame(i) {
  const frames = replayFrames(); if (!frames.length) return;
  const rp = rpState(); rp.idx = Math.max(0, Math.min(frames.length - 1, i));
  const f = frames[rp.idx];
  const img = document.getElementById('rp-img'); if (!img) return;
  img.src = `/api/sessions/${state.snap.session.id}/screens/${f.file}`; img.alt = `Screen from ${labelActor(f.worker)} at ${time(f.at)}`;
  document.getElementById('rp-cap').textContent = frameCaption(f);
  document.getElementById('rp-range').value = rp.idx; document.getElementById('rp-range').max = frames.length - 1;
  document.getElementById('rp-pos').textContent = `${rp.idx + 1}/${frames.length}`;
}
function setPlaying(on) {
  const rp = rpState(); rp.playing = on;
  clearInterval(state.rpTimer); state.rpTimer = null;
  const b = document.getElementById('rp-play'); if (b) { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); }
  if (!on) return;
  if ((rp.idx ?? 0) >= replayFrames().length - 1) showFrame(0);
  state.rpTimer = setInterval(() => {
    if (!document.getElementById('rp-img')) { clearInterval(state.rpTimer); state.rpTimer = null; rpState().playing = false; return; }
    const n = replayFrames().length;
    if ((rpState().idx ?? 0) >= n - 1) return setPlaying(false);
    showFrame((rpState().idx ?? 0) + 1);
  }, 700);
}
function wireReplay() {
  const s = state.snap.session;
  const rp = rpState();
  if (rp.idx === null) rp.idx = replayFrames().length - 1;
  document.querySelectorAll('[data-rp-worker]').forEach((b) => b.addEventListener('click', () => {
    rp.worker = b.dataset.rpWorker; rp.idx = null; setPlaying(false);
    document.getElementById('replay-card').innerHTML = replayHtml(); wireReplay();
  }));
  document.getElementById('rp-prev')?.addEventListener('click', () => { setPlaying(false); showFrame(rp.idx - 1); });
  document.getElementById('rp-next')?.addEventListener('click', () => { setPlaying(false); showFrame(rp.idx + 1); });
  document.getElementById('rp-latest')?.addEventListener('click', () => { setPlaying(false); showFrame(replayFrames().length - 1); });
  document.getElementById('rp-play')?.addEventListener('click', () => setPlaying(!rp.playing));
  document.getElementById('rp-range')?.addEventListener('input', (e) => { setPlaying(false); showFrame(Number(e.target.value)); });
  document.getElementById('rp')?.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=range]') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); showFrame(rp.idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); showFrame(rp.idx + 1); }
    else if (e.key === ' ' && !e.target.matches('button')) { e.preventDefault(); setPlaying(!rp.playing); }
  });
  if (rp.playing) setPlaying(true);
  document.getElementById('rec-toggle')?.addEventListener('change', (e) => act(() => api('POST', `/api/sessions/${s.id}/recording`, { recording: e.target.checked })));
  document.getElementById('del-replay')?.addEventListener('click', async () => {
    if (await confirmDialog('Delete the private replay?', '<p>All screens for this task are deleted from disk. Findings, files and history are kept.</p>', 'Delete screens', true)) act(() => api('DELETE', `/api/sessions/${s.id}/replay`), 'Replay deleted');
  });
  document.getElementById('rp-export')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent;
    try { await exportTimelapse(replayFrames(), (p) => { btn.textContent = `Recording… ${Math.round(p * 100)}%`; }); announce('Timelapse downloaded'); }
    catch (err) { await confirmDialog('Timelapse not made', `<p>${esc(err.message)}</p>`, 'OK'); }
    finally { btn.disabled = false; btn.textContent = label; }
  });
}

const canRecordVideo = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
/** Draw each frame (with its caption) onto a canvas and record it with MediaRecorder; runs entirely in this browser. */
async function exportTimelapse(frames, onProgress) {
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('This browser cannot record video.');
  const sid = state.snap.session.id;
  const load = (f) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('A frame could not be loaded.')); im.src = `/api/sessions/${sid}/screens/${f.file}`; });
  const imgs = [];
  for (const f of frames) imgs.push(await load(f));
  const W = imgs[0].naturalWidth; const H = imgs[0].naturalHeight; const BAR = 34;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H + BAR });
  const ctx = canvas.getContext('2d');
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 3_000_000 });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  const draw = (i) => {
    ctx.fillStyle = '#0b0e0d'; ctx.fillRect(0, 0, W, H + BAR);
    ctx.drawImage(imgs[i], 0, 0, W, H);
    ctx.fillStyle = '#111614'; ctx.fillRect(0, H, W, BAR);
    ctx.fillStyle = '#e8ece9'; ctx.font = '14px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const cap = `${i + 1}/${imgs.length} · ${frameCaption(frames[i])}`;
    ctx.fillText(cap.length > 110 ? cap.slice(0, 109) + '…' : cap, 10, H + BAR / 2);
  };
  draw(0); rec.start();
  for (let i = 0; i < imgs.length; i++) { draw(i); onProgress?.((i + 1) / imgs.length); await new Promise((r) => setTimeout(r, 450)); }
  rec.stop(); await stopped;
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `tasklatch-timelapse-${sid}${rpState().worker === 'all' ? '' : '-' + rpState().worker}.${type.includes('mp4') ? 'mp4' : 'webm'}` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ================================================================ New task composer
/** With a paid model, say how many agent steps the per-task spend cap covers (about 3,000 tokens per desktop step with a screenshot). */
function capNote(ready, agents) {
  const m = ready?.items.find((i) => i.id === 'model');
  if (!m?.paid || !m.paid_token_ceiling) return '';
  const steps = Math.floor(m.paid_token_ceiling / 3000); const per = Math.floor(steps / agents);
  const tight = per < 12;
  return `<div class="banner ${tight ? 'warn' : 'info'} compact"><span class="icon">$</span><div><b>Spend cap: $${m.max_spend_usd} per task (about ${m.paid_token_ceiling.toLocaleString()} tokens).</b>
    <p>That covers roughly ${steps} agent steps in total, about ${per} per agent with ${agents} agent${agents > 1 ? 's' : ''}; each step sends a screenshot (about 3,000 tokens).${tight ? ' That is tight for research: use fewer agents, or raise <code>TASKLATCH_MAX_SPEND_USD</code> in <code>.env</code> and restart.' : ''} When the cap is reached the agents stop and TaskLatch assembles and checks what they found.</p></div></div>`;
}
async function renderNew() {
  if (!state.catalog) state.catalog = await api('GET', '/api/catalog');
  const ready = state.readyCache || (state.readyCache = await api('GET', '/api/readiness').catch(() => null));
  const desktopsOk = ready?.items.find((i) => i.id === 'desktops')?.status === 'ready';
  const c = state.catalog;
  const mode = state.newMode || 'web';
  const agents = state.newAgents || 2;
  const sites = state.newSites ?? '*.wikipedia.org, *.wikimedia.org';
  $app.innerHTML = `<form id="newtask" class="composer">
    <h1>What should your agents do?</h1>
    <p class="muted">Each agent gets its own Linux desktop you can watch live. You approve the plan before anything runs; TaskLatch enforces the sites, the shared allowance and checks the results.</p>
    ${desktopsOk ? '' : `<div class="banner warn"><span class="icon">!</span><div><b>Agent desktops are not available.</b><p>${esc(ready?.items.find((i) => i.id === 'desktops')?.detail || '')}</p></div></div>`}
    <div class="seg big" role="group" aria-label="Task type">
      <button type="button" data-mode="web" aria-pressed="${mode === 'web'}">🌐 Any task on the web</button>
      <button type="button" data-mode="supplier" aria-pressed="${mode === 'supplier'}">🧾 Supplier comparison (SupplierLab, verified)</button>
    </div>
    <label for="desc" class="sr-only">Task</label>
    <textarea id="desc" class="prompt" placeholder="${mode === 'web' ? 'e.g. Find when the Eiffel Tower and the Statue of Liberty were completed and who designed each, and save a comparison table.' : ''}">${mode === 'web' ? esc(state.newDesc || '') : 'Compare two office-supply vendors for 20 USB-C adapters. Use the approved supplier pages, capture price and stock evidence, and prepare a purchase request for review.'}</textarea>
    <div class="row composer-opts">
      <div><span class="lbl">Agents</span><div class="seg" role="group" aria-label="Number of agents">${[1, 2, 3, 4].map((n) => `<button type="button" data-agents="${n}" aria-pressed="${agents === n}">${n}</button>`).join('')}</div></div>
      ${mode === 'web' ? `<div class="grow"><label for="sites" class="lbl">Sites agents may open</label><input id="sites" type="text" value="${esc(sites)}">
        ${presetChips('sites')}<div id="any-note">${anySiteNote(splitSites(sites))}</div>
        <p class="muted small" style="margin:4px 0 0">Add sites while the task runs too: anything an agent is refused shows up with an Allow button.</p></div>` : ''}
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
    ${capNote(ready, agents)}
    <div class="row"><button class="primary big" type="submit">Plan with ${agents} agent${agents > 1 ? 's' : ''}</button><span id="new-err" role="alert" class="muted"></span></div>
  </form>`;
  const keep = () => { const d = document.getElementById('desc'); if (d && mode === 'web') state.newDesc = d.value; const si = document.getElementById('sites'); if (si) state.newSites = si.value; };
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { keep(); state.newMode = b.dataset.mode; renderNew(); }));
  document.querySelectorAll('[data-agents]').forEach((b) => b.addEventListener('click', () => { keep(); state.newAgents = Number(b.dataset.agents); renderNew(); }));
  const note = () => { const el = document.getElementById('any-note'); if (el) el.innerHTML = anySiteNote(splitSites(document.getElementById('sites').value)); keep(); };
  wirePresets(note);
  document.getElementById('sites')?.addEventListener('input', note);
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
        ? { mode: 'web', runtime: 'desktop', description: document.getElementById('desc').value, allowed_sites: splitSites(document.getElementById('sites').value), limits, recording: document.getElementById('recording').checked }
        : { mode: 'supplier', runtime: document.getElementById('runtime').value, description: document.getElementById('desc').value, item_id: c.item.item_id, quantity: Number(document.getElementById('qty').value),
            source_ids: [...document.querySelectorAll('input[name=src]:checked')].map((i) => i.value), expected_result: document.getElementById('expected').value, limits, recording: document.getElementById('recording').checked };
      const snap = await api('POST', '/api/sessions', body);
      state.newDesc = '';
      location.hash = `#/s/${snap.session.id}/scope`;
    } catch (err) { document.getElementById('new-err').textContent = err.message; btn.disabled = false; btn.textContent = `Plan with ${agents} agent${agents > 1 ? 's' : ''}`; }
  });
}

boot();
