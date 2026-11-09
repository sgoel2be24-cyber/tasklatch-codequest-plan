/**
 * Policy engine. Every agent action passes through decide() before any side effect.
 * Default is DENY. Text from pages, findings or agent messages never changes a decision:
 * the only inputs are the action, the authenticated actor, and the operator-approved scope.
 */
import path from 'node:path';
import { Decision, DECISION_LABEL, ACTION_TYPES } from '../../packages/contracts/states.ts';
import { newId, nowIso, canonicalJson } from '../../packages/contracts/canonical.ts';
import { SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { run } from './db.ts';
import { emit } from './events.ts';
import { containedPath, actorDir, sessionDir } from './storage.ts';
import { isPrivateHost, isControllerAddress } from './netguard.ts';

export type Action = { type: string; resource?: string; payload?: any; task_id?: string };
export type PolicyResult = { decision: Decision; reason_code: string; reason: string; action_id: string };

const ACCEPTING = new Set(['RUNNING', 'AWAITING_APPROVAL', 'VERIFYING']);
const isWorker = (actor: string) => /^worker-[a-z]$/.test(actor);

function deny(reason_code: string, reason: string) { return { decision: Decision.DENY, reason_code, reason }; }
function allow(reason_code: string, reason: string) { return { decision: Decision.ALLOW, reason_code, reason }; }

export function approvedPaths(scope: any): Set<string> {
  return new Set((scope.approved_sources || []).map((s: any) => s.path));
}

/** Normalise one operator-entered site pattern: "example.org", "*.example.org", "host:port" or "*" (any public site). */
export function normalizeSite(raw: string): string | null {
  let x = String(raw ?? '').trim().toLowerCase();
  if (x === '*' || x === 'any' || x === '*.*') return '*';
  x = x.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(x) ? x : null;
}

/** Does one pattern match host[:port]? A pattern with a port matches only that port. */
function patternMatches(pat: string, hostname: string, port: number | null): boolean {
  const [ph, pp] = pat.split(':');
  if (pp && Number(pp) !== port) return false;
  if (ph.startsWith('*.')) return hostname === ph.slice(2) || hostname.endsWith(ph.slice(1));
  return hostname === ph || hostname === 'www.' + ph;
}

/**
 * Host patterns the operator approved for open-web tasks. "*" means any PUBLIC host: private, loopback and
 * local names only match when listed explicitly, and the TaskLatch controller never matches.
 */
export function hostAllowed(scope: any, host: string, port: number | null = null): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (isControllerAddress(h, port ?? -1)) return false;
  return (scope.allowed_sites || []).some((p: string) => {
    const pat = normalizeSite(p);
    if (!pat) return false;
    if (pat === '*') return !isPrivateHost(h);
    return patternMatches(pat, h, port);
  });
}

/** Listed by name (not only through "*"): the operator chose this host deliberately, so a private address is acceptable. */
export function hostListedExplicitly(scope: any, host: string, port: number | null = null): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (isControllerAddress(h, port ?? -1)) return false;
  return (scope.allowed_sites || []).some((p: string) => { const pat = normalizeSite(p); return !!pat && pat !== '*' && patternMatches(pat, h, port); });
}

const defaultPort = (u: URL) => Number(u.port || (u.protocol === 'https:' ? 443 : 80));

export function assessDestination(scope: any, actor: string, rawUrl: string) {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return deny('malformed_destination', 'The destination is not a valid URL.'); }
  if (u.protocol === 'about:') return allow('blank_page', 'Blank page.');
  if (isControllerAddress(u.hostname, defaultPort(u))) return deny('controller_unreachable', 'TaskLatch itself is never reachable from an agent desktop.');
  if (u.origin !== new URL(SUPPLIERLAB_ORIGIN).origin) {
    if (scope.mode === 'web' && (u.protocol === 'https:' || u.protocol === 'http:') && hostAllowed(scope, u.hostname, defaultPort(u))) {
      return allow('approved_site', `${u.hostname} is an approved site for this task.`);
    }
    if (scope.mode === 'web' && isPrivateHost(u.hostname) && (scope.allowed_sites || []).includes('*')) {
      return deny('private_network', `${u.host} is a private or local address; “any public website” does not include it.`);
    }
    return deny('destination_not_approved', `${u.host} is not an approved site for this task.`);
  }
  if (u.pathname === '/favicon.ico') return allow('static_asset', 'Site icon.');
  if (scope.mode === 'web' && hostListedExplicitly(scope, u.hostname, defaultPort(u))) return allow('approved_site', 'SupplierLab is an approved site for this task.');
  const mine = (scope.plan_assignments?.[actor] as string[] | undefined);
  const paths = approvedPaths(scope);
  if (!paths.has(u.pathname)) return deny('source_not_in_scope', `${u.pathname} is not one of the approved supplier pages.`);
  if (mine && !mine.some(id => scope.approved_sources.find((s: any) => s.source_id === id)?.path === u.pathname)) {
    return deny('source_not_assigned', `${u.pathname} is approved for this task but assigned to another worker.`);
  }
  return allow('approved_source', 'Approved supplier page within this task’s scope.');
}

export function evaluate(session: any, actor: string, action: Action) {
  const scope = session.scope;
  if (!(ACTION_TYPES as readonly string[]).includes(action.type)) return deny('unknown_action', `“${action.type}” is not a supported action.`);
  if (session.stop_requested_at) return deny('session_stopped', 'A stop was requested for this task; no new actions are accepted.');
  if (session.status === 'BUDGET_EXHAUSTED') return deny('budget_exhausted', 'The shared allowance is exhausted.');
  if (!ACCEPTING.has(session.status)) return deny('session_not_active', `The task is ${session.status.toLowerCase()}, so it cannot take new actions.`);
  if (session.deadline_at && Date.now() > Date.parse(session.deadline_at)) return deny('time_limit_reached', 'The task’s time limit has passed.');

  switch (action.type) {
    case 'browser.navigate':
    case 'browser.read':
      if (!isWorker(actor)) return deny('actor_not_permitted', 'Only research workers browse supplier pages.');
      return assessDestination(scope, actor, action.resource || '');
    case 'browser.click':
      if (!isWorker(actor)) return deny('actor_not_permitted', 'Only research workers use a browser desktop.');
      // Input on the worker's own desktop. Any page it leads to is checked again at the egress proxy.
      return allow('desktop_input', 'Clicking or typing on the worker’s own desktop; resulting requests are checked by the proxy.');
    case 'browser.submit_form': {
      let p = '';
      try { p = new URL(action.resource || '').pathname; } catch { /* malformed */ }
      if (p.startsWith('/api/purchase-requests')) {
        return deny('submission_requires_broker', 'Purchase requests cannot be submitted from a browser. Only the TaskLatch controller can submit, after your approval.');
      }
      return deny('form_submission_not_in_scope', 'Submitting forms is outside the Research and Draft scope.');
    }
    case 'finding.record':
      return isWorker(actor) ? allow('in_scope', 'Recording a structured finding is part of research.') : deny('actor_not_permitted', 'Only workers record findings.');
    case 'artifact.write_candidate': {
      if (!isWorker(actor) && actor !== 'coordinator') return deny('actor_not_permitted', 'This actor cannot write task files.');
      const c = containedPath(actorDir(session.id, actor), action.resource || '');
      if (!c.ok) return deny(c.reason, 'Task files can only be written inside this worker’s own task folder.');
      return allow('own_task_folder', 'Saving a candidate result in the worker’s own task folder.');
    }
    case 'artifact.overwrite':
      if (action.payload?.committed) return deny('committed_artifact_immutable', 'Committed work cannot be changed. Save a new version instead.');
      return deny('overwrite_not_in_scope', 'Overwriting files is outside this task’s scope.');
    case 'artifact.publish_local':
      return actor === 'coordinator' ? allow('coordinator_publish', 'The coordinator publishes the comparison and draft for this task.') : deny('actor_not_permitted', 'Only the coordinator publishes task deliverables.');
    case 'file.read': {
      const root = sessionDir(session.id);
      const requested = action.resource || '';
      const target = path.isAbsolute(requested) ? requested : path.join(actorDir(session.id, actor), requested);
      const c = containedPath(root, path.relative(root, target));
      if (!c.ok) return deny('other_session_or_host_files', 'Agents can only read files that belong to this task session.');
      return allow('session_file', 'Reading a file inside this task session.');
    }
    case 'upload.send':
      return deny('arbitrary_upload_blocked', 'Uploading files to other destinations is not allowed in this task.');
    case 'request.prepare':
      if (actor !== 'coordinator') return deny('actor_not_permitted', 'Only the coordinator prepares the purchase-request draft.');
      if (scope.expected_result === 'comparison') return deny('draft_not_in_scope', 'This task only asked for a comparison.');
      return allow('draft_in_scope', 'Preparing a draft is allowed. A draft is not a submission.');
    case 'request.submit':
      if (isWorker(actor)) return deny('workers_cannot_submit', 'Workers cannot submit purchase requests. Submission is a separate action that needs your approval.');
      if (actor !== 'coordinator') return deny('actor_not_permitted', 'Only the coordinator can propose a submission.');
      if (scope.expected_result !== 'submission') return deny('submission_not_in_scope', 'This task asked for a draft only; submitting a purchase request is not in scope.');
      if (action.payload?.destination !== scope.submission_destination) return deny('destination_not_approved', 'The request targets a destination outside the approved scope.');
      return { decision: Decision.REQUIRE_APPROVAL, reason_code: 'consequential_action', reason: 'Submitting a purchase request saves a real record in SupplierLab. It needs your approval for this exact request.' };
  }
  return deny('unknown_action', 'Unsupported action.');
}

/** Evaluate, then record the decision as an action row and a history event. */
export function decide(session: any, actor: string, action: Action, summary?: string): PolicyResult {
  const r = evaluate(session, actor, action);
  const action_id = newId('act');
  run('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', action_id, session.id, actor, action.task_id ?? null,
    action.type, action.resource ?? null, action.payload === undefined ? null : canonicalJson(action.payload),
    r.decision, r.reason_code, r.reason, session.policy_version, nowIso(), null);
  emit(session.id, {
    actor, kind: 'policy.decision', provenance: 'policy_decision',
    summary: `${DECISION_LABEL[r.decision]}: ${summary || action.type}${action.resource ? ' → ' + action.resource : ''}`,
    data: { action_id, action_type: action.type, resource: action.resource, decision: r.decision, reason_code: r.reason_code, reason: r.reason },
  });
  return { ...r, action_id };
}

export function setActionOutcome(actionId: string, outcome: string) {
  run('UPDATE actions SET outcome=? WHERE id=?', outcome, actionId);
}
