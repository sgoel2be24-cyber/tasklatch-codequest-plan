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
import { hostAllowed } from './policy.ts';

export function sessionList(operatorId: string) {
  return all('SELECT id, title, status, created_at, started_at, ended_at, deadline_at, request, scope FROM sessions WHERE operator_id=? ORDER BY created_at DESC', operatorId)
    .map(s => {
      const request = JSON.parse(s.request); const scope = JSON.parse(s.scope);
      const tasks = all("SELECT status FROM tasks WHERE session_id=? AND kind='research'", s.id);
      return { id: s.id, title: s.title, status: s.status, status_label: STATUS_LABEL[s.status], created_at: s.created_at, started_at: s.started_at, ended_at: s.ended_at,
        deadline_at: s.deadline_at, expected_result: request.expected_result, scenario: scope.scenario, mode: scope.mode ?? 'supplier', runtime: scope.runtime ?? 'browser',
        parent_session_id: request.parent_session_id ?? null, live: isLive(s.id),
        progress: { done: tasks.filter(t => ['submitted', 'verified', 'partial', 'done'].includes(t.status)).length, total: tasks.length },
        // Thumbnails for the dashboard: each agent's most recent private screen (served only to this operator).
        agents: all('SELECT worker_id, label, status, activity, last_screenshot FROM workers WHERE session_id=? ORDER BY worker_id', s.id) };
    });
}

/** Findings as a spreadsheet: one row per finding, with TaskLatch's source check next to the agent's claim. */
export function reportCsv(id: string) {
  const v = latestVerifications(id).report;
  const checks = Object.fromEntries((v?.checks || []).map((c: any) => [c.name, c]));
  const art = all("SELECT id FROM artifacts WHERE session_id=? AND kind='report' ORDER BY created_at DESC, rowid DESC LIMIT 1", id)[0];
  const report = art ? JSON.parse(readArtifact(id, art.id)!.content.toString('utf8')) : { sections: [] };
  const cell = (x: any) => { const t = String(x ?? ''); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };
  const rows = [['ref', 'agent', 'subtask', 'claim (agent statement)', 'quote', 'url', 'captured_at', 'tasklatch_source_check']];
  for (const sec of report.sections || []) for (const f of sec.findings || []) {
    const ref = `${sec.worker.slice(-1).toUpperCase()}${f.n}`;
    const c = checks[`finding:${ref}`];
    rows.push([ref, sec.worker, sec.title, f.claim, f.quote, f.url, f.captured_at, f.superseded_by ? 'superseded' : c?.status === 'pass' ? 'source-checked' : c ? 'not supported' : 'not checked']);
  }
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
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
    blocked_sites: blockedSites(s, actions),
    messages: all("SELECT seq, at, data FROM audit_events WHERE session_id=? AND kind='operator.message' ORDER BY seq", id).map(r => ({ seq: r.seq, at: r.at, ...JSON.parse(r.data || '{}') })),
    files: artifacts.filter((a: any) => a.kind === 'agent_file').map((a: any) => ({ ...a, name: a.label.replace(/^Worker [A-D]: /, '') })),
    children: all("SELECT id, title, status FROM sessions WHERE operator_id=? AND json_extract(request, '$.parent_session_id')=? ORDER BY created_at", s.operator_id, id),
    parent: s.request.parent_session_id ? get('SELECT id, title, status FROM sessions WHERE id=?', s.request.parent_session_id) ?? null : null,
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
      model: snap.model, policy_version: s.policy_version,
      runtime: s.scope.runtime === 'desktop' ? 'Linux desktop containers (Docker in a local Colima VM), one per agent, with traffic through TaskLatch’s egress proxy' : 'Headless Chromium browser contexts on the local machine (not containers)',
      disclosures: [
        s.scope.mode === 'web' ? `Open-web task. Approved sites: ${s.scope.allowed_sites.map((x: string) => x === '*' ? 'any public website (private networks excluded)' : x).join(', ')}. Findings are source-checked against pages TaskLatch captured, not fact-checked.` : 'All vendors, prices, stock and purchase requests are synthetic SupplierLab fixtures.',
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

/** Hosts the desktops were refused (not approved), grouped so the operator can allow one for this task. */
function blockedSites(s: any, actions: any[]) {
  if (s.scope.mode !== 'web') return [];
  const by = new Map<string, any>();
  for (const a of actions) {
    if (a.decision !== 'DENY' || a.action_type !== 'browser.navigate' || !['destination_not_approved'].includes(a.reason_code)) continue;
    let host = ''; try { host = new URL(a.resource).hostname; } catch { continue; }
    const cur = by.get(host) || { host, workers: [] as string[], count: 0, agent_asked: false, first_at: a.created_at, last_at: a.created_at, example: a.resource };
    cur.count++; cur.last_at = a.created_at;
    if (!cur.workers.includes(a.actor)) cur.workers.push(a.actor);
    if (a.task_id) { cur.agent_asked = true; cur.example = a.resource; }
    by.set(host, cur);
  }
  return [...by.values()].filter(b => !hostAllowed(s.scope, b.host)).sort((x, y) => Number(y.agent_asked) - Number(x.agent_asked) || y.count - x.count).slice(0, 30);
}
