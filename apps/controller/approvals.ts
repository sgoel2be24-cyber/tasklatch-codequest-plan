/**
 * Exact-request approvals and the broker. The broker is the only code that can save a purchase
 * request in SupplierLab, and only with a single-use, unexpired approval whose hash matches the
 * request it is about to send.
 */
import { newId, nowIso, hashPayload, sha256, canonicalJson, formatMinor } from '../../packages/contracts/canonical.ts';
import { tx, get, all, run } from './db.ts';
import { emit } from './events.ts';
import { decide } from './policy.ts';
import { loadSession, setTask } from './state.ts';
import { requestDetails } from './coordinator.ts';
import { brokerSubmit, findByIdempotencyKey, readSource } from './supplierlab-client.ts';

let onResolved: (sessionId: string) => void = () => {};
export function setOnSubmissionResolved(fn: (sessionId: string) => void) { onResolved = fn; }

function recordBrokerAction(sessionId: string, decision: 'ALLOW' | 'DENY', code: string, reason: string, payload: unknown, policyVersion: number) {
  const id = newId('act');
  run('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, sessionId, 'broker', null, 'request.submit', 'supplierlab:purchase-requests',
    canonicalJson(payload), decision, code, reason, policyVersion, nowIso(), null);
  emit(sessionId, { actor: 'broker', kind: 'policy.decision', provenance: 'policy_decision',
    summary: `${decision === 'ALLOW' ? 'Allowed' : 'Blocked'}: broker submission — ${reason}`, data: { action_id: id, decision, reason_code: code } });
  return id;
}

export function approvalView(a: any) {
  return a && { ...a, payload: JSON.parse(a.payload) };
}

/** Coordinator proposes a submission for the current draft. Returns the pending approval, or why not. */
export function proposeSubmission(sessionId: string, draft: any) {
  const s = loadSession(sessionId)!;
  const details = requestDetails(draft);
  const pol = decide(s, 'coordinator', { type: 'request.submit', resource: 'supplierlab:purchase-requests', payload: details },
    `Coordinator proposes submitting ${details.quantity} × ${details.product_id} for ${formatMinor(details.total_minor)}`);
  if (pol.decision === 'DENY') return { status: 'blocked' as const, reason: pol.reason };
  const hash = hashPayload(details);
  const approval = tx(() => {
    const pending = all("SELECT * FROM approvals WHERE session_id=? AND status='pending'", sessionId);
    for (const p of pending) {
      if (p.payload_hash === hash) return p;
      run("UPDATE approvals SET status='superseded', decided_at=?, note=? WHERE id=?", nowIso(), 'Request details changed; a new decision is required.', p.id);
      emit(sessionId, { actor: 'controller', kind: 'approval.superseded', provenance: 'observed', summary: `Earlier approval request ${p.id} withdrawn: the request details changed` });
    }
    const id = newId('apv');
    const ttl = s.scope.approval_ttl_seconds ?? 600;
    run('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, sessionId, pol.action_id, canonicalJson(details), hash,
      s.policy_version, details.source_id, details.source_version, 'pending', nowIso(), new Date(Date.now() + ttl * 1000).toISOString(), null, null, null, null);
    run("UPDATE sessions SET status='AWAITING_APPROVAL' WHERE id=? AND status IN ('RUNNING','VERIFYING')", sessionId);
    return get('SELECT * FROM approvals WHERE id=?', id);
  });
  emit(sessionId, { actor: 'controller', kind: 'approval.requested', provenance: 'observed',
    summary: `Needs your approval: submit ${details.quantity} × ${details.product_id} at ${formatMinor(details.unit_price_minor)} = ${formatMinor(details.total_minor)} to ${details.destination}`,
    data: { approval_id: approval.id, payload_hash: hash, expires_at: approval.expires_at } });
  const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", sessionId);
  if (t) setTask(t.id, 'awaiting_approval', 'Waiting for your decision');
  return { status: 'pending' as const, approval: approvalView(approval) };
}

export function expireApprovals(sessionId?: string) {
  const rows = all(`SELECT * FROM approvals WHERE status='pending' AND expires_at < ? ${sessionId ? 'AND session_id=?' : ''}`, nowIso(), ...(sessionId ? [sessionId] : []));
  for (const a of rows) {
    run("UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND status='pending'", nowIso(), a.id);
    emit(a.session_id, { actor: 'controller', kind: 'approval.expired', provenance: 'observed', summary: `Approval request ${a.id} expired without a decision; nothing was submitted` });
    const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", a.session_id);
    if (t) setTask(t.id, 'expired', 'Approval expired; nothing was submitted');
    onResolved(a.session_id);
  }
  return rows.length;
}

export function cancelPendingApprovals(sessionId: string, why: string) {
  const rows = all("SELECT id FROM approvals WHERE session_id=? AND status IN ('pending','approved') AND consumed_at IS NULL", sessionId);
  for (const a of rows) {
    run("UPDATE approvals SET status='cancelled', decided_at=?, note=? WHERE id=?", nowIso(), why, a.id);
    emit(sessionId, { actor: 'controller', kind: 'approval.cancelled', provenance: 'observed', summary: `Approval request ${a.id} cancelled: ${why}` });
  }
  return rows.length;
}

type DecisionResult = { ok: boolean; status: number; error?: string; message?: string; approval?: any; submission?: any };

/** The operator's decision. shownHash must equal the hash of what the operator was looking at. */
export async function operatorDecision(operatorId: string, approvalId: string, decision: 'approve' | 'reject', shownHash: string, note?: string): Promise<DecisionResult> {
  expireApprovals();
  const a = get('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a) return { ok: false, status: 404, error: 'not_found' };
  const s = loadSession(a.session_id)!;
  if (s.operator_id !== operatorId) return { ok: false, status: 404, error: 'not_found' };
  if (a.status !== 'pending') return { ok: false, status: 409, error: `approval_${a.status}`, message: `This request is ${a.status}; it can no longer be decided.` };
  if (shownHash !== a.payload_hash) return { ok: false, status: 409, error: 'payload_changed', message: 'The request changed since you opened it. Review the current request.' };

  if (decision === 'reject') {
    run("UPDATE approvals SET status='rejected', decided_at=?, decided_by=?, note=? WHERE id=? AND status='pending'", nowIso(), operatorId, note ?? null, approvalId);
    emit(a.session_id, { actor: 'operator', kind: 'approval.rejected', provenance: 'operator_decision', summary: `You rejected the purchase request ${approvalId}. Nothing was submitted.`, data: { approval_id: approvalId, payload_hash: a.payload_hash } });
    const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", a.session_id);
    if (t) setTask(t.id, 'rejected', 'You rejected the request; the draft remains available');
    onResolved(a.session_id);
    return { ok: true, status: 200, approval: approvalView(get('SELECT * FROM approvals WHERE id=?', approvalId)) };
  }

  // Approve: re-check everything that could have changed since the request was shown.
  const details = JSON.parse(a.payload);
  const problems: string[] = [];
  if (s.stop_requested_at) problems.push('A stop was requested.');
  if (!['AWAITING_APPROVAL', 'RUNNING', 'VERIFYING'].includes(s.status)) problems.push(`Task is ${s.status}.`);
  if (s.policy_version !== a.policy_version) problems.push('The task scope changed after this request was proposed.');
  let live: any = null;
  try { live = await readSource(a.resource_id); } catch { problems.push('SupplierLab could not be reached to confirm the source.'); }
  if (live && (live.version !== a.resource_version || live.price_minor !== details.unit_price_minor)) {
    problems.push(`The supplier source changed (now version ${live.version}, ${formatMinor(live.price_minor)}).`);
  }
  if (problems.length) {
    run("UPDATE approvals SET status='invalidated', decided_at=?, decided_by=?, note=? WHERE id=? AND status='pending'", nowIso(), operatorId, problems.join(' '), approvalId);
    emit(a.session_id, { actor: 'controller', kind: 'approval.invalidated', provenance: 'observed', summary: `Approval could not be applied: ${problems.join(' ')} Nothing was submitted.`, data: { approval_id: approvalId } });
    const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", a.session_id);
    if (t) setTask(t.id, 'invalidated', problems.join(' '));
    onResolved(a.session_id);
    return { ok: false, status: 409, error: 'approval_invalidated', message: problems.join(' ') };
  }
  run("UPDATE approvals SET status='approved', decided_at=?, decided_by=?, note=? WHERE id=? AND status='pending'", nowIso(), operatorId, note ?? null, approvalId);
  emit(a.session_id, { actor: 'operator', kind: 'approval.approved', provenance: 'operator_decision',
    summary: `You approved: ${details.quantity} × ${details.product_id} at ${formatMinor(details.unit_price_minor)} = ${formatMinor(details.total_minor)} → ${details.destination}`,
    data: { approval_id: approvalId, payload_hash: a.payload_hash } });
  const sub = await brokerExecute(a.session_id, approvalId, details);
  onResolved(a.session_id);
  return { ok: true, status: 200, approval: approvalView(get('SELECT * FROM approvals WHERE id=?', approvalId)), submission: sub };
}

/**
 * Broker: consume a single-use approval and submit. `details` is what the caller wants to send;
 * it must hash to exactly what was approved.
 */
export async function brokerExecute(sessionId: string, approvalId: string, details: any) {
  const s = loadSession(sessionId)!;
  const hash = hashPayload(details);
  const claim = tx(() => {
    const a = get('SELECT * FROM approvals WHERE id=? AND session_id=?', approvalId, sessionId);
    if (!a) return { ok: false, code: 'no_approval', reason: 'There is no approval for this request.' };
    if (a.payload_hash !== hash) return { ok: false, code: 'payload_changed_after_approval', reason: 'The request differs from what was approved (supplier, quantity, price, destination or details changed).' };
    if (a.consumed_at) return { ok: false, code: 'approval_already_used', reason: 'This approval was already used once; it cannot authorise another submission.' };
    if (a.status !== 'approved') return { ok: false, code: `approval_${a.status}`, reason: `The approval is ${a.status}.` };
    if (Date.parse(a.expires_at) < Date.now()) return { ok: false, code: 'approval_expired', reason: 'The approval has expired.' };
    const cur = get('SELECT stop_requested_at, status FROM sessions WHERE id=?', sessionId);
    if (cur.stop_requested_at) return { ok: false, code: 'session_stopped', reason: 'The task was stopped.' };
    run("UPDATE approvals SET consumed_at=?, status='consumed' WHERE id=?", nowIso(), approvalId);
    const subId = newId('sub');
    const key = 'tl-' + sha256(`${sessionId}:${approvalId}`).slice(0, 32);
    run('INSERT INTO submissions VALUES (?,?,?,?,?,?,?,?,?,?,?)', subId, sessionId, approvalId, key, 'submitting', null, null, null, 0, nowIso(), nowIso());
    return { ok: true, subId, key, actionId: a.action_id };
  });
  if (!claim.ok) {
    recordBrokerAction(sessionId, 'DENY', claim.code!, claim.reason!, details, s.policy_version);
    return { status: 'blocked', reason_code: claim.code, reason: claim.reason };
  }
  recordBrokerAction(sessionId, 'ALLOW', 'exact_approval', 'Single-use approval matches this exact request.', details, s.policy_version);
  const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", sessionId);
  if (t) setTask(t.id, 'running', 'Submitting to SupplierLab');
  return send(sessionId, claim.subId!, claim.key!, { ...details, action_id: claim.actionId, approval_id: approvalId });
}

async function send(sessionId: string, subId: string, key: string, body: any) {
  run('UPDATE submissions SET attempts=attempts+1, updated_at=? WHERE id=?', nowIso(), subId);
  const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", sessionId);
  try {
    const r = await brokerSubmit(body, key);
    if (r.status === 201 || r.status === 200) {
      run("UPDATE submissions SET status='saved', request_id=?, receipt_id=?, detail=?, updated_at=? WHERE id=?", r.body.request_id, r.body.receipt_id, JSON.stringify(r.body), nowIso(), subId);
      emit(sessionId, { actor: 'broker', kind: 'submission.saved', provenance: 'observed', summary: `SupplierLab saved the purchase request (receipt ${r.body.receipt_id})${r.body.replayed ? ' — existing record returned for the same idempotency key' : ''}`, data: r.body });
      if (t) setTask(t.id, 'submitted', `Saved as ${r.body.receipt_id}; awaiting verification`);
    } else {
      run("UPDATE submissions SET status='failed', detail=?, updated_at=? WHERE id=?", JSON.stringify(r.body), nowIso(), subId);
      emit(sessionId, { actor: 'broker', kind: 'submission.failed', provenance: 'observed', summary: `SupplierLab refused the request: ${r.body?.error ?? 'HTTP ' + r.status}`, data: r.body });
      if (t) setTask(t.id, 'failed', `SupplierLab refused: ${r.body?.error ?? r.status}`);
    }
  } catch (e: any) {
    run("UPDATE submissions SET status='uncertain', detail=?, updated_at=? WHERE id=?", JSON.stringify({ error: e.message }), nowIso(), subId);
    emit(sessionId, { actor: 'broker', kind: 'submission.uncertain', provenance: 'observed', summary: `No response from SupplierLab (${e.name === 'TimeoutError' ? 'timed out' : e.message}). The request may or may not have been saved.` });
    if (t) setTask(t.id, 'uncertain', 'Outcome unknown until SupplierLab confirms');
  }
  return get('SELECT * FROM submissions WHERE id=?', subId);
}

/** Read-after-timeout: look the request up by idempotency key. Never blindly resubmits. */
export async function reconcileSubmission(sessionId: string, subId: string) {
  const sub = get('SELECT * FROM submissions WHERE id=? AND session_id=?', subId, sessionId);
  if (!sub) return null;
  let found: any;
  try { found = await findByIdempotencyKey(sub.idempotency_key); }
  catch (e: any) {
    emit(sessionId, { actor: 'controller', kind: 'submission.reconcile', provenance: 'observed', summary: `Could not reach SupplierLab to confirm the submission (${e.message}); still uncertain.` });
    return sub;
  }
  if (found) {
    run("UPDATE submissions SET status='saved', request_id=?, receipt_id=?, detail=?, updated_at=? WHERE id=?", found.request_id, found.receipt_id, JSON.stringify(found), nowIso(), subId);
    emit(sessionId, { actor: 'controller', kind: 'submission.reconcile', provenance: 'observed', summary: `Confirmed in SupplierLab: the request was saved (receipt ${found.receipt_id}).` });
    const t = get("SELECT id FROM tasks WHERE session_id=? AND kind='submit'", sessionId);
    if (t) setTask(t.id, 'submitted', `Saved as ${found.receipt_id}; awaiting verification`);
  } else {
    emit(sessionId, { actor: 'controller', kind: 'submission.reconcile', provenance: 'observed', summary: 'SupplierLab has no record for this idempotency key yet. The request was not saved, or not yet.' });
  }
  onResolved(sessionId);
  return get('SELECT * FROM submissions WHERE id=?', subId);
}

/** Retry an uncertain submission with the same idempotency key: at most one record can exist. */
export async function retryUncertain(sessionId: string, subId: string) {
  const sub = get('SELECT * FROM submissions WHERE id=? AND session_id=?', subId, sessionId);
  if (!sub || sub.status !== 'uncertain') return sub;
  const s = loadSession(sessionId)!;
  if (s.stop_requested_at) return sub;
  const a = get('SELECT * FROM approvals WHERE id=?', sub.approval_id);
  emit(sessionId, { actor: 'operator', kind: 'submission.retry', provenance: 'operator_decision', summary: 'You asked TaskLatch to retry the uncertain submission with the same idempotency key.' });
  const out = await send(sessionId, subId, sub.idempotency_key, { ...JSON.parse(a.payload), action_id: a.action_id, approval_id: a.id });
  onResolved(sessionId);
  return out;
}
