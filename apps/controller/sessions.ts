/**
 * Session orchestration: scope, start, worker lifecycle, merge, approval hand-off, verification,
 * stop, budget exhaustion and interruption recovery. Outcomes are set here, never by an agent.
 */
import { randomBytes } from 'node:crypto';
import { newId, nowIso, sha256, formatMinor } from '../../packages/contracts/canonical.ts';
import { SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { STATUS_LABEL, TERMINAL_STATES } from '../../packages/contracts/states.ts';
import { tx, get, all, run } from './db.ts';
import { emit } from './events.ts';
import { decide } from './policy.ts';
import { DEFAULT_LIMITS, type Limits } from './budget.ts';
import { modelCall } from './model.ts';
import { Desktop } from './runtime.ts';
import { runWorker, makeGate, type WorkerOutcome } from './agent.ts';
import { proposePlan, localPlan, buildComparison, comparisonMarkdown, buildDraft, draftMarkdown } from './coordinator.ts';
import { proposeSubmission, cancelPendingApprovals, setOnSubmissionResolved, expireApprovals } from './approvals.ts';
import { verifyComparison, verifyDraft, verifySubmission, latestVerifications } from './verifier.ts';
import { saveArtifact, readArtifact, latestArtifact } from './storage.ts';
import { loadSession, setTask, setWorker, tasksFor } from './state.ts';
import { readCatalog } from './supplierlab-client.ts';
import { PROVIDER, providerRecord, paidTokenCeiling } from './provider.ts';
import { proposeDesktopPlan, researchOnDesktops, stopDesktops, supplierCandidatesFromDesktops, buildWebReport, desktopLiveInfo } from './desktop-sessions.ts';
import type { ContainerDesktop } from './desktops.ts';
import { verifyReport } from './verifier.ts';

type Live = { abort: AbortController; desktops: Map<string, Desktop>; containers: Map<string, ContainerDesktop>; paused: Set<string>; workers: Promise<any>[]; done: Promise<void> | null };
const live = new Map<string, Live>();

export class UserError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code; }
}

const clampLimits = (l: Partial<Limits> = {}): Limits => {
  const n = (v: any, d: number, min: number, max: number) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : d);
  return {
    workers: n(l.workers, DEFAULT_LIMITS.workers, 1, 4),
    time_seconds: n(l.time_seconds, DEFAULT_LIMITS.time_seconds, 30, 3600),
    steps_per_worker: n(l.steps_per_worker, DEFAULT_LIMITS.steps_per_worker, 1, 500),
    model_calls: n(l.model_calls, DEFAULT_LIMITS.model_calls, 1, 1000),
    retries_per_call: n(l.retries_per_call, DEFAULT_LIMITS.retries_per_call, 0, 5),
    token_ceiling: l.token_ceiling === null ? null : n(l.token_ceiling, DEFAULT_LIMITS.token_ceiling!, 1000, 2_000_000),
  };
};

export const ACTION_SCOPE = {
  allowed: [
    { type: 'browser.navigate', label: 'Open approved supplier pages' },
    { type: 'browser.read', label: 'Read page content and capture screenshots' },
    { type: 'finding.record', label: 'Record structured findings (vendor, price, stock, source, time)' },
    { type: 'artifact.write_candidate', label: 'Save candidate results in the worker’s own task folder' },
    { type: 'artifact.publish_local', label: 'Coordinator publishes the comparison (and draft)' },
    { type: 'request.prepare', label: 'Prepare a purchase-request draft (not a submission)' },
  ],
  approval: [{ type: 'request.submit', label: 'Submit the purchase request to SupplierLab (only when you chose “approved submission”)' }],
  blocked: [
    { type: 'request.submit', label: 'Submitting from a worker or a browser form' },
    { type: 'upload.send', label: 'Uploading files anywhere' },
    { type: 'browser.navigate', label: 'Any site or page outside the approved sources (including redirects)' },
    { type: 'file.read', label: 'Reading files from other sessions or the host' },
    { type: 'artifact.overwrite', label: 'Changing committed work' },
  ],
};


/** Desktop agents act step by step, so their defaults are larger than one-shot extraction's. */
function desktopLimitDefaults(input: any) {
  const l = { ...(input.limits || {}) };
  if (l.steps_per_worker === undefined) l.steps_per_worker = 25;
  if (l.model_calls === undefined) l.model_calls = 120;
  if (l.token_ceiling === undefined) l.token_ceiling = 200000;
  if (l.time_seconds === undefined) l.time_seconds = 900;
  return l;
}

export async function createSession(operator: any, input: any) {
  const runtime = input.runtime === 'desktop' ? 'desktop' : 'browser';
  if (runtime === 'desktop' && PROVIDER.provider !== 'local-rules' && !PROVIDER.supportsImages) {
    throw new UserError(422, 'model_cannot_see', `Desktop agents need a model that accepts screenshots. ${PROVIDER.model} is not marked as vision-capable (set TASKLATCH_VISION=1 for a model that is).`);
  }
  if (runtime === 'desktop') input = { ...input, limits: desktopLimitDefaults(input) };
  if (input.mode === 'web') return createWebSession(operator, input);
  const catalog: any = await readCatalog().catch(() => null);
  if (!catalog) throw new UserError(503, 'supplierlab_unavailable', 'SupplierLab is not reachable. Start it and try again.');
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new UserError(422, 'invalid_quantity', 'Quantity must be a whole number between 1 and 100,000.');
  if (input.item_id !== catalog.item.item_id) throw new UserError(422, 'unknown_item', 'Unknown product.');
  const expected = ['comparison', 'draft', 'submission'].includes(input.expected_result) ? input.expected_result : 'draft';
  const ids: string[] = Array.isArray(input.source_ids) ? input.source_ids : [];
  const sources = ids.map(id => catalog.sources.find((s: any) => s.source_id === id)).filter(Boolean);
  if (!sources.length) throw new UserError(422, 'no_sources', 'Choose at least one approved source.');
  if (new Set(sources.map((s: any) => s.scenario)).size > 1) throw new UserError(422, 'mixed_scenarios', 'All sources must come from one test scenario.');
  const limits = clampLimits(input.limits);
  // A paid provider always runs under a token ceiling, lowered further by TASKLATCH_MAX_SPEND_USD.
  if (PROVIDER.paid) limits.token_ceiling = paidTokenCeiling(limits.token_ceiling);
  const id = 'ses_' + randomBytes(6).toString('hex');
  const vendor_names = Object.fromEntries(catalog.vendors.map((v: any) => [v.vendor_id, v.name]));
  const scope = {
    preset: 'research_and_draft', preset_label: 'Research and Draft', expected_result: expected, mode: 'supplier', runtime,
    scenario: sources[0].scenario, allowed_sites: [SUPPLIERLAB_ORIGIN],
    approved_sources: sources.map((s: any) => ({ source_id: s.source_id, path: s.path, vendor_id: s.vendor_id, product_id: s.product_id, kind: s.kind })),
    vendor_names, file_location: `.runtime/sessions/${id}/files/<worker>/`, limits,
    approval_ttl_seconds: Math.max(30, Math.min(3600, Number(input.approval_ttl_seconds) || 600)),
    submission_destination: 'pr-queue-ops', destination_label: catalog.destinations[0].label,
    model: providerRecord(), actions: ACTION_SCOPE, plan_assignments: {} as Record<string, string[]>, source_owner: {} as Record<string, string>,
  };
  const request = {
    description: String(input.description || '').slice(0, 2000) || `Compare suppliers for ${quantity} × ${catalog.item.name}`,
    item_id: catalog.item.item_id, item_name: catalog.item.name, quantity, expected_result: expected,
  };
  run('INSERT INTO sessions (id, operator_id, title, request, scope, plan, status, policy_version, recording, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, operator.id, request.description.length > 90 ? request.description.slice(0, 89).trimEnd() + '…' : request.description, JSON.stringify(request), JSON.stringify(scope), '{}', 'DRAFT', 1, input.recording === false ? 0 : 1, nowIso());
  emit(id, { actor: 'operator', kind: 'session.created', provenance: 'operator_decision', summary: `Task created: ${request.description}`, data: { request, expected_result: expected } });
  const plan = runtime === 'desktop' ? await proposeDesktopPlan(id, scope, request) : await proposePlan(id, scope);
  applyPlan(id, plan, false);
  emit(id, { actor: 'coordinator', kind: 'plan.proposed', provenance: 'agent_statement', summary: `Coordinator proposed ${plan.subtasks.length} research subtask(s): ${plan.subtasks.map(t => `${t.label} → ${t.title}`).join('; ')}`, data: plan });
  return loadSession(id);
}

function applyPlan(id: string, plan: { subtasks: any[]; rationale: string }, bump: boolean) {
  tx(() => {
    const s = loadSession(id)!;
    run('DELETE FROM tasks WHERE session_id=?', id);
    run('DELETE FROM workers WHERE session_id=?', id);
    const assignments: Record<string, string[]> = {}; const owner: Record<string, string> = {};
    let ord = 0;
    for (const t of plan.subtasks) {
      assignments[t.worker_id] = t.source_ids;
      for (const sid of t.source_ids) owner[sid] = t.worker_id;
      run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', t.task_id, id, 'research', t.worker_id, t.title, 'ready', null, JSON.stringify(t.source_ids), nowIso(), ord++);
      run('INSERT INTO workers (session_id, worker_id, label, status, activity, updated_at) VALUES (?,?,?,?,?,?)', id, t.worker_id, t.label, 'idle', 'Waiting to start', nowIso());
    }
    if (s.scope.mode === 'web') {
      run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'report', 'coordinator', 'Assemble a cited report', 'ready', null, null, nowIso(), ord++);
      run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'verify', 'verifier', 'Source-check every finding', 'ready', null, null, nowIso(), ord++);
      const scope = { ...s.scope, plan_assignments: {}, source_owner: {} };
      run('UPDATE sessions SET plan=?, scope=?, policy_version=policy_version+? WHERE id=?', JSON.stringify(plan), JSON.stringify(scope), bump ? 1 : 0, id);
      return;
    }
    run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'compare', 'coordinator', 'Merge findings into a comparison', 'ready', null, null, nowIso(), ord++);
    if (s.scope.expected_result !== 'comparison') run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'draft', 'coordinator', 'Prepare purchase-request draft', 'ready', null, null, nowIso(), ord++);
    if (s.scope.expected_result === 'submission') run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'submit', 'controller', 'Submit approved request to SupplierLab', 'ready', 'Needs your approval', null, nowIso(), ord++);
    run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)', newId('tsk'), id, 'verify', 'verifier', 'Verify deliverables independently', 'ready', null, null, nowIso(), ord++);
    const scope = { ...s.scope, plan_assignments: assignments, source_owner: owner };
    run('UPDATE sessions SET plan=?, scope=?, policy_version=policy_version+? WHERE id=?', JSON.stringify(plan), JSON.stringify(scope), bump ? 1 : 0, id);
  });
}

function ownSession(operator: any, id: string) {
  const s = loadSession(id);
  if (!s || s.operator_id !== operator.id) throw new UserError(404, 'not_found', 'Task not found.');
  return s;
}

/** Operator revises the plan before starting: reassign sources, change limits or expected result. */
export function revisePlan(operator: any, id: string, patch: any) {
  const s = ownSession(operator, id);
  if (!['DRAFT', 'READY'].includes(s.status)) throw new UserError(409, 'already_started', 'The scope can only be changed before the task starts.');
  const scope = { ...s.scope };
  if (patch.limits) {
    scope.limits = clampLimits({ ...scope.limits, ...patch.limits });
    if (scope.model?.paid) scope.limits.token_ceiling = paidTokenCeiling(scope.limits.token_ceiling);
  }
  if (patch.expected_result && ['comparison', 'draft', 'submission'].includes(patch.expected_result)) scope.expected_result = patch.expected_result;
  if (patch.approval_ttl_seconds) scope.approval_ttl_seconds = Math.max(30, Math.min(3600, Number(patch.approval_ttl_seconds)));
  run('UPDATE sessions SET scope=?, recording=COALESCE(?, recording) WHERE id=?', JSON.stringify(scope), patch.recording === undefined ? null : patch.recording ? 1 : 0, id);
  if (patch.expected_result) { const r = { ...s.request, expected_result: scope.expected_result }; run('UPDATE sessions SET request=? WHERE id=?', JSON.stringify(r), id); }
  let plan = s.plan;
  if (patch.assignments && typeof patch.assignments === 'object') {
    const valid = new Set(scope.approved_sources.map((x: any) => x.source_id));
    const seen = new Set<string>();
    const workers = Object.keys(patch.assignments).filter(w => /^worker-[a-d]$/.test(w)).slice(0, scope.limits.workers);
    const subtasks = workers.map(w => {
      const ids = (patch.assignments[w] as string[]).filter(x => valid.has(x) && !seen.has(x));
      ids.forEach(x => seen.add(x));
      const vendors = [...new Set(ids.map(x => scope.approved_sources.find((a: any) => a.source_id === x).vendor_id))];
      return { task_id: newId('tsk'), worker_id: w, label: `Worker ${w.slice(-1).toUpperCase()}`, vendor_id: vendors[0] ?? '', source_ids: ids, title: `Research ${vendors.map(v => scope.vendor_names[v] || v).join(' and ') || '(nothing assigned)'}` };
    }).filter(t => t.source_ids.length);
    const unassigned = [...valid].filter(x => !seen.has(x));
    if (unassigned.length) throw new UserError(422, 'unassigned_sources', `Every approved source needs a worker. Unassigned: ${unassigned.join(', ')}`);
    plan = { subtasks, rationale: 'Revised by the operator.' };
  } else if (patch.limits?.workers || patch.expected_result) {
    plan = null;
  }
  if (plan === null) {
    plan = localPlan(loadSession(id)!.scope);
  }
  applyPlan(id, plan, true);
  emit(id, { actor: 'operator', kind: 'scope.revised', provenance: 'operator_decision', summary: 'You revised the task scope', data: patch });
  return loadSession(id);
}

export function start(operator: any, id: string) {
  const s = ownSession(operator, id);
  if (!['DRAFT', 'READY'].includes(s.status)) throw new UserError(409, 'invalid_state', `Task is ${STATUS_LABEL[s.status]}; it cannot be started.`);
  const deadline = new Date(Date.now() + s.scope.limits.time_seconds * 1000).toISOString();
  tx(() => {
    run("UPDATE sessions SET status='RUNNING', started_at=?, deadline_at=? WHERE id=?", nowIso(), deadline, id);
    for (const w of all('SELECT worker_id FROM workers WHERE session_id=?', id)) {
      const cred = randomBytes(24).toString('hex');
      run('UPDATE workers SET credential_hash=?, lease_expires_at=?, status=?, activity=? WHERE session_id=? AND worker_id=?', sha256(cred), deadline, 'starting', 'Starting', id, w.worker_id);
    }
  });
  emit(id, { actor: 'operator', kind: 'session.started', provenance: 'operator_decision', summary: `You started the task with ${s.plan.subtasks.length} worker(s); deadline ${deadline}`, data: { scope_policy_version: s.policy_version } });
  launch(id);
  return loadSession(id);
}

function launch(id: string) {
  const L: Live = { abort: new AbortController(), desktops: new Map(), containers: new Map(), paused: new Set(), workers: [], done: null };
  live.set(id, L);
  L.done = orchestrate(id, L).catch(e => {
    console.error('[controller] orchestrate error', e);
    emit(id, { actor: 'controller', kind: 'session.error', provenance: 'observed', summary: `Controller error: ${e.message}` });
    const s = loadSession(id);
    if (s && !TERMINAL_STATES.has(s.status) && !s.stop_requested_at) finalize(id, `Controller error: ${e.message}`);
  }).finally(() => { if (live.get(id) === L) live.delete(id); });
}

async function orchestrate(id: string, L: Live) {
  const s0 = loadSession(id)!;
  if (s0.scope.runtime === 'desktop') return orchestrateDesktops(id, L);
  return orchestrateBrowser(id, L);
}

async function orchestrateDesktops(id: string, L: Live) {
  const s0 = loadSession(id)!;
  const { findingsByWorker } = await researchOnDesktops(id, L, () => markBudgetExhausted(id, 'model calls'));
  // Free the desktops once research is over; the last frames stay in the private replay.
  await stopDesktops(id, L);
  let s = loadSession(id)!;
  if (s.stop_requested_at || s.status !== 'RUNNING') return;
  if (s0.scope.mode === 'web') {
    const reportTask = tasksFor(id).find(t => t.kind === 'report')!;
    setTask(reportTask.id, 'running');
    await buildWebReport(id, findingsByWorker, L.abort.signal);
    setTask(reportTask.id, 'submitted', 'Report assembled; source-checking');
    run("UPDATE sessions SET status='VERIFYING' WHERE id=? AND status='RUNNING'", id);
    const verifyTask = tasksFor(id).find(t => t.kind === 'verify')!;
    setTask(verifyTask.id, 'running');
    const v = await verifyReport(id);
    setTask(reportTask.id, v.status === 'verified' ? 'verified' : v.status === 'partial' ? 'partial' : 'failed', v.summary);
    for (const t of tasksFor(id).filter(x => x.kind === 'research' && x.status === 'submitted')) setTask(t.id, v.status === 'failed' ? 'failed' : 'verified');
    return finalize(id);
  }
  await supplierCandidatesFromDesktops(id, findingsByWorker, L.abort.signal);
  s = loadSession(id)!;
  if (s.stop_requested_at || s.status !== 'RUNNING') return;
  return coordinate(id, L);
}

async function orchestrateBrowser(id: string, L: Live) {
  const s0 = loadSession(id)!;
  const research = tasksFor(id).filter(t => t.kind === 'research' && !['submitted', 'partial'].includes(t.status));
  for (const t of research) {
    const d = new Desktop(id, t.assignee, makeGate(id, t.assignee), () => !!loadSession(id)?.recording);
    L.desktops.set(t.assignee, d);
    L.workers.push(runWorker(id, t.assignee, t.id, t.source_ids, d, L.abort.signal).then(o => {
      if (o === 'budget') markBudgetExhausted(id, 'model calls');
      return o;
    }));
  }
  await Promise.allSettled(L.workers);
  const s1 = loadSession(id)!;
  if (s1.stop_requested_at || s1.status !== 'RUNNING') return;
  return coordinate(id, L);
}

async function coordinate(id: string, L: Live) {
  let s = loadSession(id)!;

  // ---- Coordinator: merge findings into a comparison
  const compareTask = tasksFor(id).find(t => t.kind === 'compare')!;
  setTask(compareTask.id, 'running');
  const candidates = all("SELECT * FROM artifacts WHERE session_id=? AND kind='candidate_findings' ORDER BY created_at", id)
    .map(a => JSON.parse(readArtifact(id, a.id)!.content.toString('utf8')))
    .map(c => ({ worker_id: c.author_agent, findings: c.findings }));
  const merged = await modelCall({
    sessionId: id, actor: 'coordinator', purpose: 'merge findings into comparison', signal: L.abort.signal, retries: s.scope.limits.retries_per_call,
    system: 'Summarise supplier findings in one sentence. Reply with JSON {"summary": string}.',
    user: JSON.stringify(candidates).slice(0, 4000), maxTokens: 200,
    local: () => buildComparison(s.scope, s.request, candidates),
    parse: () => buildComparison(s.scope, s.request, candidates), // numbers are always computed, never generated
  });
  if (!merged.ok) {
    if (merged.error === 'budget') { markBudgetExhausted(id, 'model calls'); return; }
    if (merged.error === 'stopped') return;
    setTask(compareTask.id, 'failed', merged.detail);
    return finalize(id);
  }
  const comparison: any = merged.value;
  s = loadSession(id)!;
  const pub = decide(s, 'coordinator', { type: 'artifact.publish_local', resource: 'comparison.json' }, 'Coordinator publishes the comparison');
  if (pub.decision !== 'ALLOW') return;
  const cmpArt = saveArtifact(id, 'coordinator', 'comparison', 'Supplier comparison (structured)', 'comparison.json', JSON.stringify(comparison, null, 2), 'application/json', true);
  saveArtifact(id, 'coordinator', 'comparison_md', 'Supplier comparison (readable)', 'comparison.md', comparisonMarkdown(comparison), 'text/markdown', true);
  setTask(compareTask.id, comparison.complete ? 'submitted' : 'partial', comparison.complete ? `${comparison.rows.length} vendors compared` : `${comparison.rows.length} vendor(s) compared, ${comparison.unresolved.length} source(s) unresolved`);
  emit(id, { actor: 'coordinator', kind: 'artifact.published', provenance: 'observed', summary: `Comparison published (${comparison.rows.length} vendor rows, ${comparison.unresolved.length} unresolved, ${comparison.warnings.length} warnings)`, data: { artifact: cmpArt } });

  // ---- Draft
  if (s.scope.expected_result !== 'comparison') {
    const draftTask = tasksFor(id).find(t => t.kind === 'draft')!;
    const prep = decide(s, 'coordinator', { type: 'request.prepare', resource: 'draft.json' }, 'Coordinator prepares a purchase-request draft');
    if (prep.decision === 'ALLOW') {
      const operatorName = get('SELECT name FROM operators WHERE id=?', s.operator_id)?.name ?? s.operator_id;
      const draft = buildDraft(s.scope, s.request, comparison, cmpArt, operatorName);
      if (!draft) setTask(draftTask.id, 'failed', 'No vendor has a confirmed price; no draft could be prepared');
      else {
        const dArt = saveArtifact(id, 'coordinator', 'draft', 'Purchase-request draft', 'draft.json', JSON.stringify(draft, null, 2), 'application/json', true);
        saveArtifact(id, 'coordinator', 'draft_md', 'Purchase-request draft (readable)', 'draft.md', draftMarkdown(draft), 'text/markdown', true);
        setTask(draftTask.id, 'submitted', `${draft.quantity} × ${draft.product_id} from ${draft.supplier_name} = ${formatMinor(draft.total_minor)}`);
        emit(id, { actor: 'coordinator', kind: 'artifact.published', provenance: 'observed', summary: `Draft prepared: ${draft.supplier_name}, ${draft.quantity} × ${formatMinor(draft.unit_price_minor)} = ${formatMinor(draft.total_minor)} (not submitted)`, data: { artifact: dArt } });
      }
    }
  }

  // ---- Verify deliverables, then hand the submission to the operator if requested
  run("UPDATE sessions SET status='VERIFYING' WHERE id=? AND status='RUNNING'", id);
  const verifyTask = tasksFor(id).find(t => t.kind === 'verify')!;
  setTask(verifyTask.id, 'running');
  const vc = await verifyComparison(id);
  const vd = s.scope.expected_result !== 'comparison' ? await verifyDraft(id) : null;
  markResearchVerified(id, vc.status);
  s = loadSession(id)!;
  if (s.stop_requested_at) return;
  if (s.scope.expected_result === 'submission' && vd?.status === 'verified') {
    const draft = JSON.parse(readArtifact(id, latestArtifact(id, 'draft').id)!.content.toString('utf8'));
    const p = proposeSubmission(id, draft);
    if (p.status === 'pending') { setTask(verifyTask.id, 'waiting', 'Waiting for your decision on the submission'); return; }
  } else if (s.scope.expected_result === 'submission') {
    const t = tasksFor(id).find(x => x.kind === 'submit');
    if (t) setTask(t.id, 'blocked', 'No verified draft, so nothing was proposed for submission');
  }
  finalize(id);
}

function markResearchVerified(id: string, status: string) {
  for (const t of tasksFor(id).filter(x => x.kind === 'research')) {
    if (t.status === 'submitted' && (status === 'verified' || status === 'partial')) setTask(t.id, 'verified');
  }
}

/** Revise the draft quantity (operator). Creates a new draft version; any pending approval is superseded. */
export function reviseDraft(operator: any, id: string, quantity: number) {
  const s = ownSession(operator, id);
  if (!Number.isInteger(quantity) || quantity < 1) throw new UserError(422, 'invalid_quantity', 'Quantity must be a positive whole number.');
  if (s.status !== 'AWAITING_APPROVAL') throw new UserError(409, 'invalid_state', 'The draft can only be revised while a submission is awaiting your decision.');
  const prev = JSON.parse(readArtifact(id, latestArtifact(id, 'draft').id)!.content.toString('utf8'));
  const draft = { ...prev, draft_id: newId('drf'), created_at: nowIso(), quantity, total_minor: quantity * prev.unit_price_minor + prev.shipping_minor, revised_from: prev.draft_id };
  const req = { ...s.request, revised_quantity: quantity };
  run('UPDATE sessions SET request=? WHERE id=?', JSON.stringify(req), id);
  saveArtifact(id, 'coordinator', 'draft', `Purchase-request draft (revised to ${quantity})`, `draft-${draft.draft_id}.json`, JSON.stringify(draft, null, 2), 'application/json', true);
  saveArtifact(id, 'coordinator', 'draft_md', `Purchase-request draft (revised to ${quantity}, readable)`, `draft-${draft.draft_id}.md`, draftMarkdown(draft), 'text/markdown', true);
  emit(id, { actor: 'operator', kind: 'draft.revised', provenance: 'operator_decision', summary: `You changed the quantity from ${prev.quantity} to ${quantity}; the earlier approval request no longer applies` });
  return proposeSubmission(id, draft);
}

/** Called whenever an approval or submission changes state. */
async function onResolved(id: string) {
  const s = loadSession(id);
  if (!s) return;
  if (s.stop_requested_at) return;
  const sub = get('SELECT status FROM submissions WHERE session_id=? ORDER BY created_at DESC LIMIT 1', id);
  const pending = get("SELECT id FROM approvals WHERE session_id=? AND status='pending'", id);
  if (pending) return;
  if (sub?.status === 'submitting') return;
  if (s.scope.expected_result !== 'comparison' && latestArtifact(id, 'draft')) await verifyDraft(id);
  if (s.scope.expected_result === 'submission') await verifySubmission(id);
  finalize(id);
}
setOnSubmissionResolved((id) => { onResolved(id).catch(e => console.error('[controller] onResolved', e)); });

/** Compute the outcome from independent verification results. */
export function finalize(id: string, note?: string) {
  const s = loadSession(id)!;
  const v = latestVerifications(id);
  const required = s.scope.mode === 'web' ? ['report']
    : ['comparison', ...(s.scope.expected_result !== 'comparison' ? ['draft'] : []), ...(s.scope.expected_result === 'submission' ? ['submission'] : [])];
  const deliverables = Object.fromEntries(required.map(d => [d, v[d]?.status ?? 'missing']));
  const approval = get('SELECT status, note FROM approvals WHERE session_id=? ORDER BY created_at DESC LIMIT 1', id);
  const sub = get('SELECT status FROM submissions WHERE session_id=? ORDER BY created_at DESC LIMIT 1', id);
  let status: string; let summary: string;
  const vals = Object.values(deliverables);
  if (s.stop_requested_at) { status = 'CANCELLED'; summary = 'Stopped by you. Completed work is preserved below.'; }
  else if (s.status === 'BUDGET_EXHAUSTED') { status = 'BUDGET_EXHAUSTED'; summary = 'The shared allowance ran out. Completed work is preserved; remaining deliverables are incomplete.'; }
  else if (sub && (sub.status === 'uncertain' || sub.status === 'submitting')) { status = 'NEEDS_VERIFICATION'; summary = 'The submission may have been saved, but SupplierLab has not confirmed it yet.'; }
  else if (vals.every(x => x === 'verified')) { status = 'SUCCEEDED'; summary = 'All required deliverables passed independent verification.'; }
  else if (vals.includes('failed')) { status = 'FAILED'; summary = 'At least one deliverable failed verification.'; }
  else if (vals.some(x => x === 'verified' || x === 'partial')) {
    status = 'PARTIAL';
    summary = s.scope.expected_result === 'submission' && approval && ['rejected', 'expired', 'invalidated', 'cancelled', 'superseded'].includes(approval.status)
      ? `Comparison and draft are available; the submission was ${approval.status}, so nothing was saved in SupplierLab.`
      : 'Some deliverables are verified; others are unresolved or incomplete.';
  } else if (vals.includes('could_not_verify')) { status = 'NEEDS_VERIFICATION'; summary = 'The result could not be verified.'; }
  else { status = 'FAILED'; summary = 'Required deliverables are missing.'; }
  if (note) summary += ` ${note}`;
  const outcome = { status, label: STATUS_LABEL[status], summary, deliverables, decided_at: nowIso(), decided_by: 'controller (from verification results)' };
  run('UPDATE sessions SET status=?, outcome=?, ended_at=COALESCE(ended_at, ?) WHERE id=?', status, JSON.stringify(outcome), nowIso(), id);
  const verifyTask = tasksFor(id).find(t => t.kind === 'verify');
  if (verifyTask) setTask(verifyTask.id, status === 'SUCCEEDED' ? 'verified' : status === 'NEEDS_VERIFICATION' ? 'uncertain' : status === 'CANCELLED' ? 'cancelled' : 'done', summary);
  for (const w of all("SELECT worker_id FROM workers WHERE session_id=? AND lease_expires_at > ?", id, nowIso())) run('UPDATE workers SET lease_expires_at=? WHERE session_id=? AND worker_id=?', nowIso(), id, w.worker_id);
  emit(id, { actor: 'controller', kind: 'session.outcome', provenance: 'observed', summary: `Outcome: ${STATUS_LABEL[status]} — ${summary}`, data: outcome });
}

export function markBudgetExhausted(id: string, dimension: string) {
  const s = loadSession(id)!;
  if (s.stop_requested_at || TERMINAL_STATES.has(s.status) || s.status === 'BUDGET_EXHAUSTED') return;
  run("UPDATE sessions SET status='BUDGET_EXHAUSTED', status_reason=? WHERE id=?", dimension, id);
  emit(id, { actor: 'controller', kind: 'budget.exhausted', provenance: 'observed', summary: `Budget exhausted (${dimension}). No new work is accepted.` });
  cancelPendingApprovals(id, 'budget exhausted');
  const L = live.get(id);
  L?.abort.abort(new Error('budget'));
  for (const t of tasksFor(id)) if (['ready', 'running'].includes(t.status)) setTask(t.id, 'out_of_budget', 'Not completed: allowance exhausted');
  const settle = L ? Promise.allSettled(L.workers) : Promise.resolve([]);
  settle.then(async () => {
    if (latestArtifact(id, 'comparison')) await verifyComparison(id);
    if (latestArtifact(id, 'draft')) await verifyDraft(id);
    finalize(id, `Exhausted: ${dimension}.`);
  });
}

/** Independent stop path: persist the stop first, then revoke, cancel, and confirm shutdown. */
export async function stop(operator: any, id: string) {
  const s = ownSession(operator, id);
  if (s.stop_requested_at) return loadSession(id);
  if (TERMINAL_STATES.has(s.status)) throw new UserError(409, 'already_finished', 'This task has already finished.');
  const requestedAt = Date.now();
  tx(() => {
    run("UPDATE sessions SET stop_requested_at=?, status='STOP_REQUESTED' WHERE id=?", new Date(requestedAt).toISOString(), id);
    run('UPDATE workers SET lease_expires_at=? WHERE session_id=?', nowIso(), id);
    run("UPDATE reservations SET status='released', settled_at=?, note='cancelled by stop before use' WHERE session_id=? AND status='reserved' AND actor NOT LIKE 'worker-%' AND actor != 'coordinator'", nowIso(), id);
  });
  emit(id, { actor: 'operator', kind: 'stop.requested', provenance: 'operator_decision', summary: 'You requested a stop. New actions are refused from now on.' });
  const cancelled = cancelPendingApprovals(id, 'task stopped');
  for (const t of tasksFor(id)) if (['ready', 'running', 'awaiting_approval', 'waiting'].includes(t.status)) setTask(t.id, 'cancelled', 'Cancelled by stop');
  const L = live.get(id);
  if (L) {
    L.abort.abort(new Error('stopped'));
    const timeout = new Promise(r => setTimeout(r, 5000, 'timeout'));
    const r = await Promise.race([Promise.allSettled(L.workers).then(() => 'ok'), timeout]);
    if (r === 'timeout') for (const d of L.desktops.values()) await d.close();
    await stopDesktops(id, L);
  }
  for (const w of all('SELECT worker_id, status FROM workers WHERE session_id=?', id)) {
    const cur = get('SELECT status, stopped_at FROM workers WHERE session_id=? AND worker_id=?', id, w.worker_id);
    if (!['done', 'failed', 'out_of_budget', 'out_of_steps'].includes(cur.status)) setWorker(id, w.worker_id, { status: 'stopped', activity: 'Stopped (browser desktop closed)' });
    if (!cur.stopped_at) run('UPDATE workers SET stopped_at=? WHERE session_id=? AND worker_id=?', nowIso(), id, w.worker_id);
  }
  const confirmedAt = Date.now();
  run('UPDATE sessions SET stop_confirmed_at=? WHERE id=?', new Date(confirmedAt).toISOString(), id);
  const inflight = all("SELECT id, actor, purpose FROM reservations WHERE session_id=? AND status IN ('reserved','uncertain')", id);
  const sub = get("SELECT status, receipt_id FROM submissions WHERE session_id=? ORDER BY created_at DESC LIMIT 1", id);
  emit(id, { actor: 'controller', kind: 'stop.confirmed', provenance: 'observed',
    summary: `Stop confirmed: all workers stopped ${confirmedAt - requestedAt} ms after the request. ${cancelled} pending approval(s) cancelled.${sub?.status === 'saved' ? ` A previously approved request (receipt ${sub.receipt_id}) remains saved in SupplierLab.` : ''}`,
    data: { stop_latency_ms: confirmedAt - requestedAt, approvals_cancelled: cancelled, uncertain_model_calls: inflight, submission: sub ?? null } });
  // Read-only verification of whatever already exists.
  if (latestArtifact(id, 'comparison')) await verifyComparison(id);
  if (latestArtifact(id, 'draft')) await verifyDraft(id);
  if (sub) await verifySubmission(id);
  finalize(id);
  return loadSession(id);
}

/** After a restart: anything that was active is interrupted; nothing resumes on its own. */
export function recoverInterrupted() {
  const rows = all("SELECT id, status, stop_requested_at FROM sessions WHERE status IN ('RUNNING','AWAITING_APPROVAL','VERIFYING','STOP_REQUESTED')");
  for (const r of rows) {
    run("UPDATE submissions SET status='uncertain', updated_at=? WHERE session_id=? AND status='submitting'", nowIso(), r.id);
    run("UPDATE reservations SET status='uncertain', settled_at=?, note='controller restarted while reserved' WHERE session_id=? AND status='reserved'", nowIso(), r.id);
    for (const w of all("SELECT worker_id, status FROM workers WHERE session_id=?", r.id)) {
      if (!['done', 'failed', 'out_of_budget', 'out_of_steps', 'stopped'].includes(w.status)) setWorker(r.id, w.worker_id, { status: 'disconnected', activity: 'Disconnected: controller restarted' });
    }
    for (const t of all("SELECT id FROM tasks WHERE session_id=? AND status='running'", r.id)) setTask(t.id, 'interrupted', 'Interrupted by a restart');
    if (r.stop_requested_at) {
      run('UPDATE sessions SET stop_confirmed_at=COALESCE(stop_confirmed_at, ?) WHERE id=?', nowIso(), r.id);
      emit(r.id, { actor: 'controller', kind: 'stop.confirmed', provenance: 'observed', summary: 'Stop confirmed after controller restart: no worker processes survive a restart.' });
      finalize(r.id);
      continue;
    }
    run("UPDATE sessions SET status='INTERRUPTED', interrupted_at=?, status_reason=? WHERE id=?", nowIso(), `was ${r.status}`, r.id);
    emit(r.id, { actor: 'controller', kind: 'session.interrupted', provenance: 'observed', summary: `Interrupted: the controller restarted while the task was ${STATUS_LABEL[r.status].toLowerCase()}. Nothing will resume until you choose Resume.` });
  }
  return rows.length;
}

export function resume(operator: any, id: string) {
  const s = ownSession(operator, id);
  if (s.status !== 'INTERRUPTED') throw new UserError(409, 'invalid_state', 'Only interrupted tasks can be resumed.');
  const gap = Date.now() - Date.parse(s.interrupted_at);
  const deadline = new Date(Date.parse(s.deadline_at) + gap).toISOString();
  const pending = get("SELECT id FROM approvals WHERE session_id=? AND status='pending'", id);
  const before = String(s.status_reason || '');
  run('UPDATE sessions SET status=?, deadline_at=?, interrupted_at=NULL WHERE id=?', pending ? 'AWAITING_APPROVAL' : 'RUNNING', deadline, id);
  run('UPDATE workers SET lease_expires_at=? WHERE session_id=?', deadline, id);
  emit(id, { actor: 'operator', kind: 'session.resumed', provenance: 'operator_decision', summary: `You resumed the task${pending ? '; the pending approval is still waiting for your decision' : ''}.` });
  const uncertain = get("SELECT id FROM submissions WHERE session_id=? AND status='uncertain'", id);
  if (pending) return loadSession(id);
  if (uncertain || before.includes('AWAITING_APPROVAL') || before.includes('VERIFYING') || latestArtifact(id, 'comparison')) {
    onResolved(id);
    return loadSession(id);
  }
  for (const t of tasksFor(id)) if (['interrupted', 'running'].includes(t.status)) setTask(t.id, 'ready', 'Resumed');
  launch(id);
  return loadSession(id);
}

/** Periodic housekeeping: deadlines and approval expiry. */
export function tick() {
  expireApprovals();
  for (const s of all("SELECT id FROM sessions WHERE status IN ('RUNNING','VERIFYING') AND deadline_at < ?", nowIso())) {
    markBudgetExhausted(s.id, 'time limit');
  }
}

export function isLive(id: string) { return live.has(id); }
export function liveSessions() { return [...live.keys()]; }


/** Open-web task: any prompt, approved sites chosen by the operator, container desktops. */
async function createWebSession(operator: any, input: any) {
  const description = String(input.description || '').trim().slice(0, 2000);
  if (description.length < 8) throw new UserError(422, 'missing_task', 'Describe what the agents should do.');
  input = { ...input, limits: desktopLimitDefaults(input) };
  const sites = (Array.isArray(input.allowed_sites) ? input.allowed_sites : String(input.allowed_sites || '').split(/[\s,]+/))
    .map((x: string) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((x: string) => /^(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(x));
  if (!sites.length) throw new UserError(422, 'no_sites', 'List at least one site the agents may open (for example en.wikipedia.org).');
  const limits = clampLimits(input.limits);
  if (PROVIDER.paid) limits.token_ceiling = paidTokenCeiling(limits.token_ceiling);
  const id = 'ses_' + randomBytes(6).toString('hex');
  const scope = {
    preset: 'web_research', preset_label: 'Web research', expected_result: 'report', mode: 'web', runtime: 'desktop', scenario: 'web',
    allowed_sites: [...new Set(sites)], approved_sources: [], vendor_names: {}, file_location: `.runtime/sessions/${id}/files/<worker>/`, limits,
    approval_ttl_seconds: 600, submission_destination: null, destination_label: null, model: providerRecord(),
    actions: {
      allowed: [
        { type: 'browser.navigate', label: 'Open pages on the approved sites (checked at the proxy, including redirects)' },
        { type: 'browser.click', label: 'Click, type and scroll on the agent’s own desktop' },
        { type: 'finding.record', label: 'Record findings with an exact quote (TaskLatch captures the page)' },
        { type: 'artifact.publish_local', label: 'Coordinator assembles the cited report' },
      ],
      approval: [],
      blocked: [
        { type: 'browser.navigate', label: 'Any site not on the approved list (including redirects and page assets)' },
        { type: 'browser.submit_form', label: 'Submitting forms (POST) from the desktop' },
        { type: 'upload.send', label: 'Uploading files' },
        { type: 'file.read', label: 'Reading files from other sessions or the host' },
        { type: 'request.submit', label: 'Purchases or other consequential submissions' },
      ],
    },
    plan_assignments: {}, source_owner: {},
  };
  const request = { description, expected_result: 'report' };
  run('INSERT INTO sessions (id, operator_id, title, request, scope, plan, status, policy_version, recording, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, operator.id, description.length > 90 ? description.slice(0, 89).trimEnd() + '…' : description, JSON.stringify(request), JSON.stringify(scope), '{}', 'DRAFT', 1, input.recording === false ? 0 : 1, nowIso());
  emit(id, { actor: 'operator', kind: 'session.created', provenance: 'operator_decision', summary: `Task created: ${description}`, data: { request, allowed_sites: scope.allowed_sites } });
  const plan = await proposeDesktopPlan(id, scope, request);
  applyPlan(id, plan, false);
  emit(id, { actor: 'coordinator', kind: 'plan.proposed', provenance: 'agent_statement', summary: `Coordinator split the task into ${plan.subtasks.length} subtask(s): ${plan.subtasks.map((t: any) => `${t.label} → ${t.title}`).join('; ')}`, data: plan });
  return loadSession(id);
}

/** Operator edits open-web subtasks before starting. */
export function reviseWebPlan(operator: any, id: string, patch: { subtasks?: any[]; allowed_sites?: string[] }) {
  const s = ownSession(operator, id);
  if (!['DRAFT', 'READY'].includes(s.status)) throw new UserError(409, 'already_started', 'The plan can only be changed before the task starts.');
  if (s.scope.mode !== 'web') throw new UserError(422, 'not_web', 'Only web tasks have editable subtasks.');
  const scope = { ...s.scope };
  if (patch.allowed_sites) scope.allowed_sites = patch.allowed_sites.map(x => String(x).trim().toLowerCase()).filter(Boolean);
  run('UPDATE sessions SET scope=? WHERE id=?', JSON.stringify(scope), id);
  const subtasks = (patch.subtasks || s.plan.subtasks).slice(0, 4).map((t: any, i: number) => ({
    task_id: newId('tsk'), worker_id: `worker-${String.fromCharCode(97 + i)}`, label: `Worker ${String.fromCharCode(65 + i)}`, vendor_id: '', source_ids: [],
    title: String(t.title || '').slice(0, 120), instructions: String(t.instructions || '').slice(0, 1500), start_url: String(t.start_url || ''), urls: [],
  })).filter((t: any) => t.title && t.instructions);
  if (!subtasks.length) throw new UserError(422, 'no_subtasks', 'Keep at least one subtask.');
  applyPlan(id, { subtasks, rationale: 'Revised by the operator.' }, true);
  emit(id, { actor: 'operator', kind: 'scope.revised', provenance: 'operator_decision', summary: `You revised the plan (${subtasks.length} subtask(s))`, data: patch });
  return loadSession(id);
}

/** Operator takes over (or hands back) one agent's desktop. The agent pauses while the operator has it. */
export function setTakeover(operator: any, id: string, workerId: string, on: boolean) {
  ownSession(operator, id);
  const L = live.get(id);
  if (!L || !L.containers.has(workerId)) throw new UserError(409, 'no_desktop', 'That desktop is not running.');
  if (on) L.paused.add(workerId); else L.paused.delete(workerId);
  emit(id, { actor: 'operator', kind: on ? 'desktop.takeover' : 'desktop.handback', provenance: 'operator_decision',
    summary: on ? `You took over ${workerId}’s desktop; the agent is paused` : `You handed ${workerId}’s desktop back to the agent` });
  return desktopLiveInfo(L);
}

export function liveDesktops(id: string) { return desktopLiveInfo(live.get(id)); }
