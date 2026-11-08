/** Read models for the UI and the evidence export. GET handlers never mutate session state. */
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from './db.ts';
import { listEvents, verifyChain } from './events.ts';
import { budgetSummary } from './budget.ts';
import { latestVerifications } from './verifier.ts';
import { loadSession, tasksFor } from './state.ts';
import { readArtifact, sessionDir, replayDir } from './storage.ts';
import { providerLabel, MODEL_CONFIG } from './model.ts';
import { STATUS_LABEL, DECISION_LABEL } from '../../packages/contracts/states.ts';
import { nowIso, sha256 } from '../../packages/contracts/canonical.ts';
import { isLive, liveDesktops } from './sessions.ts';

export function sessionList(operatorId: string) {
  return all('SELECT id, title, status, created_at, started_at, ended_at, request, scope FROM sessions WHERE operator_id=? ORDER BY created_at DESC', operatorId)
    .map(s => ({ id: s.id, title: s.title, status: s.status, status_label: STATUS_LABEL[s.status], created_at: s.created_at,
      expected_result: JSON.parse(s.request).expected_result, scenario: JSON.parse(s.scope).scenario }));
}

export function snapshot(id: string) {
  const s = loadSession(id)!;
  const actions = all('SELECT * FROM actions WHERE session_id=? ORDER BY created_at', id).map(a => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null, decision_label: DECISION_LABEL[a.decision] }));
  const approvals = all('SELECT * FROM approvals WHERE session_id=? ORDER BY created_at', id).map(a => ({ ...a, payload: JSON.parse(a.payload) }));
  const submissions = all('SELECT * FROM submissions WHERE session_id=? ORDER BY created_at', id).map(x => ({ ...x, detail: x.detail ? JSON.parse(x.detail) : null }));
  const artifacts = all('SELECT id, owner, kind, label, media_type, sha256, committed, created_at FROM artifacts WHERE session_id=? ORDER BY created_at', id);
  const workers = all('SELECT session_id, worker_id, label, status, activity, current_url, last_screenshot, lease_expires_at, steps_used, updated_at, stopped_at FROM workers WHERE session_id=? ORDER BY worker_id', id);
  const findings = all("SELECT id FROM artifacts WHERE session_id=? AND kind='candidate_findings' ORDER BY created_at", id)
    .flatMap(a => { try { return JSON.parse(readArtifact(id, a.id)!.content.toString('utf8')).findings; } catch { return []; } });
  const counts = { allowed: 0, needs_approval: 0, blocked: 0 };
  for (const a of actions) a.decision === 'ALLOW' ? counts.allowed++ : a.decision === 'DENY' ? counts.blocked++ : counts.needs_approval++;
  return {
    session: { ...s, status_label: STATUS_LABEL[s.status], live: isLive(id) },
    tasks: tasksFor(id), workers, actions, decision_counts: counts, approvals, submissions, artifacts, findings,
    budget: budgetSummary(id), verification: latestVerifications(id), events: listEvents(id),
    chain: verifyChain(id), model: s.scope.model ?? { provider: MODEL_CONFIG.provider, label: providerLabel(), paid: false },
    replay: { recording: !!s.recording, frames: listFrames(id) },
    live: liveDesktops(id),
    whiteboard: snapWhiteboard(id),
  };
}

export function listFrames(id: string) {
  const dir = path.join(sessionDir(id), 'replay');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png') || f.endsWith('.jpg')).sort().map(f => ({ file: f, worker: f.split('-').slice(1, 3).join('-'), at: new Date(Number(f.split('-')[0])).toISOString() }));
}

export function deleteReplay(id: string) {
  const dir = replayDir(id);
  let n = 0;
  for (const f of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, f)); n++; }
  return n;
}

/** Evidence bundle. Contains no secrets, cookies, browser profiles or files outside this session. */
export function evidenceBundle(id: string) {
  const snap = snapshot(id);
  const s = snap.session;
  const artifacts = snap.artifacts.map(a => {
    const r = readArtifact(id, a.id);
    const text = r && (a.media_type.startsWith('text/') || a.media_type === 'application/json') ? r.content.toString('utf8') : null;
    return { ...a, intact: r?.intact ?? false, content: text };
  });
  const sourceIndex = s.scope.approved_sources.map((src: any) => ({
    ...src, owner: s.scope.source_owner?.[src.source_id] ?? null,
    observations: snap.findings.filter((f: any) => f.source_id === src.source_id).map((f: any) => ({ finding_id: f.finding_id, by: f.author_agent, status: f.status, source_version: f.source_version, captured_at: f.captured_at })),
  }));
  const events = snap.events;
  const bundle = {
    manifest: {
      schema_version: '1.0', generated_at: nowIso(), generator: 'TaskLatch prototype controller', session_id: id,
      operator_id: s.operator_id, title: s.title, status: s.status, status_label: s.status_label,
      model: snap.model, policy_version: s.policy_version, runtime: 'Headless Chromium browser contexts on the local machine (not containers)',
      disclosures: [
        'All vendors, prices, stock and purchase requests are synthetic SupplierLab fixtures.',
        snap.model.provider === 'local-rules' ? 'No model inference was used: agents ran the labelled local-rules stand-in.' : `Model: ${snap.model.label}.`,
        `Actual payable usage: ${snap.budget.payable_cost.display} (${snap.budget.payable_cost.basis === 'none' ? 'no paid inference' : snap.budget.payable_cost.basis === 'estimated' ? 'estimate; the provider invoice is authoritative' : 'unknown: no rate configured'}). Any amount labelled SIMULATED is illustrative only.`,
        'The event hash chain detects later edits to stored rows; it is not independent proof against a compromised host.',
      ],
      event_chain: snap.chain,
      excluded: ['secrets and credentials', 'browser cookies and profiles', 'files outside this session', 'screenshots (replay is private; export separately)'],
    },
    scope: s.scope, request: s.request, plan: s.plan, outcome: s.outcome,
    source_index: sourceIndex,
    agent_statements: events.filter((e: any) => e.provenance === 'agent_statement'),
    tasklatch_observations: events.filter((e: any) => e.provenance === 'observed'),
    operator_decisions: events.filter((e: any) => e.provenance === 'operator_decision'),
    permissions: snap.actions, approvals: snap.approvals, submissions: snap.submissions,
    budget: snap.budget, verification: snap.verification, tasks: snap.tasks, workers: snap.workers,
    artifacts, events,
  };
  const text = JSON.stringify(bundle, null, 2);
  const dir = path.join(sessionDir(id), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `evidence-${id}.json`);
  fs.writeFileSync(file, text);
  return { text, sha256: sha256(text), file };
}

export function readinessSnapshot() {
  return get('SELECT COUNT(*) n FROM sessions').n;
}

function snapWhiteboard(id: string) {
  return all("SELECT seq, at, actor, summary, data FROM audit_events WHERE session_id=? AND kind='whiteboard.post' ORDER BY seq", id)
    .map(r => { const d = r.data ? JSON.parse(r.data) : {}; return { seq: r.seq, at: r.at, actor: r.actor, claim: d.claim, quote: d.quote, url: d.url, quote_found: d.quote_found, injected: !!d.injected_text }; });
}
