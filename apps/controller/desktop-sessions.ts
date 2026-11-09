/**
 * Container-desktop research phase: plan → start desktops → run agents in parallel → hand results to
 * the existing comparison/approval path (SupplierLab tasks) or assemble a cited report (open-web tasks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, formatMinor } from '../../packages/contracts/canonical.ts';
import { SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { emit } from './events.ts';
import { decide, assessDestination, hostListedExplicitly } from './policy.ts';
import { modelCall, extractJson } from './model.ts';
import { PROVIDER } from './provider.ts';
import { ContainerDesktop } from './desktops.ts';
import { runDesktopWorker, structuredFromSnapshot, contextLines, type DesktopFinding, type DesktopOutcome } from './desktop-agent.ts';
import { saveArtifact, readArtifact, replayDir } from './storage.ts';
import { loadSession, setWorker, setTask, tasksFor } from './state.ts';
import { all, get } from './db.ts';
import type { Finding } from './agent.ts';

// Chromium's own background services; blocked quietly and counted, not reported as agent actions.
const BACKGROUND = /(^|\.)(googleapis\.com|gvt1\.com|gstatic\.com|google\.com|googleusercontent\.com|chromium\.org|doubleclick\.net)$/i;

export function makeDesktopGate(sessionId: string, workerId: string) {
  const reported = new Set<string>();
  return (r: { kind: string; method: string; url: string; host: string; port: number; isPage: boolean }) => {
    const s = loadSession(sessionId);
    if (!s) return { allowed: false, reason: 'unknown session' };
    if (s.stop_requested_at || !['RUNNING', 'VERIFYING', 'AWAITING_APPROVAL'].includes(s.status)) return { allowed: false, reason: 'The task is not running.' };
    const supplierHost = new URL(SUPPLIERLAB_ORIGIN).hostname;
    if (BACKGROUND.test(r.host) && r.host !== supplierHost) return { allowed: false, reason: 'Browser background service (not part of the task).' };
    if (r.kind === 'http' && !['GET', 'HEAD'].includes(r.method)) {
      // Recorded once per host and method per desktop; every attempt is still refused and counted.
      const key = `${r.method} ${r.host}`;
      if (reported.has(key)) return { allowed: false, reason: 'Submitting forms is outside this task’s scope.' };
      reported.add(key);
      const d = decide(s, workerId, { type: 'browser.submit_form', resource: r.url }, 'Browser form submission');
      return { allowed: d.decision === 'ALLOW', reason: d.reason };
    }
    const a = assessDestination(s.scope, workerId, r.url);
    if (a.decision === 'ALLOW') return { allowed: true, reason: '', privateOk: hostListedExplicitly(s.scope, r.host, r.port) || `${r.host}:${r.port}` === new URL(SUPPLIERLAB_ORIGIN).host };
    if (BACKGROUND.test(r.host) && r.host !== supplierHost) return { allowed: false, reason: 'Browser background service (not part of the task).' };
    // Record each blocked destination host once per desktop; repeats are still blocked and counted by the proxy.
    if (r.isPage && !reported.has(r.host)) { reported.add(r.host); decide(s, workerId, { type: 'browser.navigate', resource: r.url }, r.kind === 'connect' ? 'Desktop opens a site' : 'Desktop navigation or redirect'); }
    return { allowed: false, reason: a.reason };
  };
}

// ---------------------------------------------------------------- planning

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string' },
    subtasks: { type: 'array', items: { type: 'object', properties: { agent: { type: 'integer' }, title: { type: 'string' }, instructions: { type: 'string' }, start_url: { type: 'string' } }, required: ['agent', 'title', 'instructions', 'start_url'], additionalProperties: false } },
  },
  required: ['rationale', 'subtasks'], additionalProperties: false,
} as const;

const workerIds = (n: number) => Array.from({ length: Math.max(1, Math.min(n, 4)) }, (_, i) => `worker-${String.fromCharCode(97 + i)}`);
/** Most subtasks one web task may queue across its agents (each agent runs its own queue in order). */
export const MAX_SUBTASKS = 8;
const firstSiteUrl = (p: string) => p === '*' ? 'https://www.bing.com/' : p.includes('://') ? p : p === new URL(SUPPLIERLAB_ORIGIN).host ? `${SUPPLIERLAB_ORIGIN}/` : `https://${p.replace(/^\*\./, '')}/`;

/** Normalise a proposed or edited web plan: valid agents, approved start pages, at most MAX_SUBTASKS. */
export function normalizeWebPlan(scope: any, raw: any[]): any[] {
  const n = Math.max(1, Math.min(scope.limits.workers, 4));
  const ws = workerIds(n);
  const sites: string[] = scope.allowed_sites;
  return raw.slice(0, MAX_SUBTASKS).map((t: any, i: number) => {
    const w = typeof t.worker_id === 'string' && ws.includes(t.worker_id) ? t.worker_id
      : Number.isInteger(t.agent) && t.agent >= 0 ? ws[t.agent % n] : ws[i % n];
    let start = String(t.start_url || '').trim();
    if (start && !/^[a-z]+:\/\//i.test(start)) start = 'https://' + start;
    if (!start || assessDestination(scope, w, start).decision !== 'ALLOW') start = firstSiteUrl(sites[0]);
    return { task_id: newId('tsk'), worker_id: w, label: `Worker ${w.slice(-1).toUpperCase()}`, vendor_id: '', source_ids: [],
      title: String(t.title || '').trim().slice(0, 120), instructions: String(t.instructions || '').trim().slice(0, 1500), start_url: start, urls: [] };
  }).filter((t: any) => t.title && t.instructions);
}


export function supplierDesktopPlan(scope: any) {
  const byVendor = new Map<string, any[]>();
  for (const s of scope.approved_sources) byVendor.set(s.vendor_id, [...(byVendor.get(s.vendor_id) || []), s]);
  const ws = workerIds(scope.limits.workers);
  const subtasks: any[] = [];
  let i = 0;
  for (const [vendor, srcs] of byVendor) {
    const w = ws[i % ws.length]; i++;
    const vname = scope.vendor_names?.[vendor] || vendor;
    const urls = srcs.map((s: any) => SUPPLIERLAB_ORIGIN + s.path);
    const existing = subtasks.find(t => t.worker_id === w);
    if (existing) { existing.source_ids.push(...srcs.map((s: any) => s.source_id)); existing.urls.push(...urls); existing.title += ` and ${vname}`; continue; }
    subtasks.push({ task_id: newId('tsk'), worker_id: w, label: `Worker ${w.slice(-1).toUpperCase()}`, vendor_id: vendor, source_ids: srcs.map((s: any) => s.source_id),
      title: `Research ${vname}`, start_url: urls[0], urls,
      instructions: `Open each of these supplier pages: ${urls.join(' , ')}. On each page record ONE finding stating the unit price and the stock or availability, quoting the price text exactly. Do not use any purchase form. Then call done.` });
  }
  return { subtasks, rationale: `One vendor per desktop (${byVendor.size} vendor(s), ${subtasks.length} desktop(s)), so every finding has one clear author.` };
}

export async function proposeDesktopPlan(sessionId: string, scope: any, request: any) {
  if (scope.mode !== 'web') return supplierDesktopPlan(scope);
  const n = Math.max(1, Math.min(scope.limits.workers, 4));
  const sites: string[] = scope.allowed_sites;
  const fallback = () => ({
    rationale: 'Split by approved site (local rules: no model planning).',
    subtasks: Array.from({ length: Math.min(n, Math.max(1, sites.length)) }, (_, i) => ({ agent: i, title: `Research on ${sites[i % sites.length] === '*' ? 'the web' : sites[i % sites.length]}`, instructions: request.description, start_url: firstSiteUrl(sites[i % sites.length]) })),
  });
  const r = await modelCall<any>({
    sessionId, actor: 'coordinator', purpose: 'plan subtasks', retries: scope.limits.retries_per_call, maxTokens: 1200, jsonSchema: PLAN_SCHEMA,
    system: planSystem(n, sites),
    user: `Operator task: ${request.description}${contextLines(request) ? '\n\n' + contextLines(request) : ''}`,
    local: fallback,
    parse: parsePlan,
  });
  const plan = r.ok ? r.value : fallback();
  return { subtasks: normalizeWebPlan(scope, plan.subtasks), rationale: String(plan.rationale || '').slice(0, 600) };
}

function planSystem(n: number, sites: string[]) {
  return `You are the coordinator of ${n} browser agent(s); each agent has its own Linux desktop with a Chromium browser. Split the operator's task into subtasks (at most ${MAX_SUBTASKS} in total) and give each an "agent" number from 0 to ${n - 1}. Subtasks for the same agent run one after another on the same desktop, so put dependent steps on the same agent; different agents run in parallel, so give them independent work. Use fewer subtasks and agents when the task is small. Each subtask needs a short title, concrete instructions saying exactly which facts to record (agents record facts with exact quotes from pages), and a start_url on an approved site. Approved sites: ${sites.includes('*') ? 'any public website' + (sites.length > 1 ? ` (and ${sites.filter(x => x !== '*').join(', ')})` : '') : sites.join(', ')}.${sites.includes('*') || sites.some(x => /bing\.com|brave\.com/.test(x)) ? ' Agents can search the web with their search action.' : ''} Reply with JSON.`;
}

function parsePlan(t: string) { const j = extractJson(t); if (!Array.isArray(j.subtasks) || !j.subtasks.length) throw new Error('no subtasks'); return j; }

/** Operator asks for plan changes in plain language before starting; the coordinator rewrites the plan. */
export async function refineDesktopPlan(sessionId: string, scope: any, request: any, current: any[], instruction: string) {
  const n = Math.max(1, Math.min(scope.limits.workers, 4));
  const cur = current.map((t: any) => ({ agent: t.worker_id.charCodeAt(t.worker_id.length - 1) - 97, title: t.title, instructions: t.instructions, start_url: t.start_url }));
  const r = await modelCall<any>({
    sessionId, actor: 'coordinator', purpose: 'revise plan', retries: scope.limits.retries_per_call, maxTokens: 1200, jsonSchema: PLAN_SCHEMA,
    system: planSystem(n, scope.allowed_sites) + ' You are revising an existing plan: apply the operator\'s change and keep everything else as it is.',
    user: `Operator task: ${request.description}\nCurrent plan (JSON): ${JSON.stringify(cur)}\nOperator's change: ${instruction}`,
    // Local rules cannot rewrite plans; they add the instruction as a new subtask on the least-loaded agent.
    local: () => {
      const load = Array.from({ length: n }, (_, i) => cur.filter(t => t.agent === i).length);
      const agent = load.indexOf(Math.min(...load));
      return { rationale: 'Operator change added as a new subtask (local rules: no model planning).', subtasks: [...cur, { agent, title: instruction.slice(0, 80), instructions: instruction, start_url: cur[0]?.start_url || firstSiteUrl(scope.allowed_sites[0]) }] };
    },
    parse: parsePlan,
  });
  if (!r.ok) return null;
  return { subtasks: normalizeWebPlan(scope, r.value.subtasks), rationale: String(r.value.rationale || 'Revised at your request.').slice(0, 600) };
}

// ---------------------------------------------------------------- research phase

export type DesktopLive = { abort: AbortController; containers: Map<string, ContainerDesktop>; paused: Set<string>; workers: Promise<any>[] };

export async function researchOnDesktops(id: string, L: DesktopLive, onBudget: (dimension: string) => void) {
  const s0 = loadSession(id)!;
  const research = tasksFor(id).filter(t => t.kind === 'research');
  const subFor = (t: any) => (s0.plan.subtasks || []).find((x: any) => x.task_id === t.id) || (s0.plan.subtasks || []).find((x: any) => x.worker_id === t.assignee)
    || { title: t.title, instructions: s0.request.description, start_url: 'about:blank' };
  const findingsByWorker = new Map<string, DesktopFinding[]>();
  const outcomes = new Map<string, DesktopOutcome>();
  const recording = () => !!loadSession(id)?.recording;
  // One desktop per agent; an agent with several subtasks works through them in order on the same desktop.
  const queues = new Map<string, any[]>();
  for (const t of research) queues.set(t.assignee, [...(queues.get(t.assignee) || []), t]);

  await Promise.allSettled([...queues].map(async ([worker, queue]) => {
    const first = subFor(queue[0]);
    const d = new ContainerDesktop(id, worker, makeDesktopGate(id, worker));
    L.containers.set(worker, d);
    setWorker(id, worker, { status: 'starting', activity: 'Starting Linux desktop…' });
    try {
      await d.start(first.start_url || 'about:blank', L.abort.signal);
      emit(id, { actor: 'controller', kind: 'desktop.started', provenance: 'observed', summary: `${worker} desktop started (container ${d.name})`, data: { worker, container: d.name } });
    } catch (e: any) {
      emit(id, { actor: 'controller', kind: 'desktop.error', provenance: 'observed', summary: `${worker} desktop failed to start: ${e.message}` });
      setWorker(id, worker, { status: 'failed', activity: `Desktop failed to start: ${e.message}` });
      for (const t of queue) setTask(t.id, 'failed', `Desktop failed to start: ${e.message}`);
      outcomes.set(worker, 'failed');
      return;
    }
    // Save a frame for the replay after each observation.
    const origObserve = d.observe.bind(d);
    d.observe = async () => {
      const o = await origObserve();
      if (o.screenshot && recording()) {
        const name = `${Date.now()}-${worker}-step.jpg`;
        fs.writeFileSync(path.join(replayDir(id), name), Buffer.from(o.screenshot, 'base64'));
        setWorker(id, worker, { last_screenshot: name });
      }
      return o;
    };
    findingsByWorker.set(worker, []);
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i]; const sub = subFor(t);
      if (i > 0) {
        emit(id, { actor: 'controller', kind: 'worker.next_task', provenance: 'observed', summary: `${worker} moves to its next subtask: ${sub.title}`, data: { worker, task: t.id } });
        if (sub.start_url) await d.act({ type: 'navigate', url: sub.start_url }).catch(() => {});
      }
      const p = runDesktopWorker(id, worker, t.id, sub, d, L.abort.signal, {
        paused: () => L.paused.has(worker),
        onFinding: (f) => findingsByWorker.get(worker)!.push(f),
        final: i === queue.length - 1,
        position: queue.length > 1 ? `${i + 1} of ${queue.length}` : null,
        onBudget,
      });
      L.workers.push(p);
      const o = await p;
      outcomes.set(worker, o);
      // Stopping, the shared allowance or this agent's step limit end its whole queue.
      if (['stopped', 'budget', 'steps'].includes(o)) {
        const why = o === 'stopped' ? ['cancelled', 'Cancelled by stop'] : o === 'budget' ? ['out_of_budget', 'Not started: allowance exhausted'] : ['failed', 'Not started: the agent’s step limit was reached'];
        for (const rest of queue.slice(i + 1)) setTask(rest.id, why[0], why[1]);
        break;
      }
    }
  }));
  return { findingsByWorker, outcomes };
}

export async function stopDesktops(id: string, L: DesktopLive | undefined) {
  if (!L) return [];
  const results = await Promise.all([...L.containers.values()].map(async d => ({ worker: d.workerId, container: d.name, removed: await d.stop() })));
  for (const r of results) emit(id, { actor: 'controller', kind: 'desktop.stopped', provenance: 'observed', summary: `${r.worker} desktop ${r.removed ? 'removed (container confirmed gone)' : 'removal NOT confirmed'}`, data: r });
  return results;
}

// ---------------------------------------------------------------- SupplierLab: structured findings for the verified comparison

export async function supplierCandidatesFromDesktops(id: string, findingsByWorker: Map<string, DesktopFinding[]>, signal: AbortSignal) {
  const s = loadSession(id)!;
  for (const t of tasksFor(id).filter(x => x.kind === 'research')) {
    const out: Finding[] = [];
    for (const sid of t.source_ids as string[]) {
      const src = s.scope.approved_sources.find((x: any) => x.source_id === sid);
      const df = [...(findingsByWorker.get(t.assignee) || [])].reverse().find(f => f.source_id === sid);
      const base: any = { finding_id: newId('fnd'), author_agent: t.assignee, task_id: t.id, source_id: sid, source_version: null, source_url: SUPPLIERLAB_ORIGIN + src.path,
        captured_at: df?.captured_at ?? nowIso(), vendor_id: src.vendor_id, product_id: src.product_id, product_title: null, unit_price_minor: null, currency: null,
        stock_qty: null, stock_status: 'unknown', tax_included: null, shipping_minor: null, limitations: [], untrusted_page_text: null, screenshot: null, extracted_by: PROVIDER.provider };
      if (!df) { out.push({ ...base, status: 'unavailable', limitations: ['The desktop agent did not record a finding on this page.'] }); continue; }
      const snap = df.snapshot_artifact ? readArtifact(id, df.snapshot_artifact) : null;
      const text = snap ? snap.content.toString('utf8') : '';
      if (/503 Service Unavailable/.test(text)) { out.push({ ...base, status: 'unavailable', limitations: ['Source unavailable: HTTP 503 when the agent visited.'] }); continue; }
      const { r } = await structuredFromSnapshot(id, t.assignee, t.id, sid, base.source_url, text, signal);
      if (!r.ok) { out.push({ ...base, status: 'unavailable', limitations: [`Could not extract a finding: ${r.detail}`] }); continue; }
      const v = /version\s+(\d+)/i.exec(text);
      const claimed = r.value as any;
      out.push({ ...base, ...claimed, vendor_id: src.vendor_id, product_id: src.product_id, status: 'observed', source_version: v ? Number(v[1]) : null,
        limitations: [...(claimed.limitations || []), ...(df.quote_found ? [] : ['The agent’s quote was not found on the page.'])] });
    }
    const art = saveArtifact(id, t.assignee, 'candidate_findings', `${t.assignee} candidate findings`, 'candidate-findings.json',
      JSON.stringify({ schema_version: '1.0', author_agent: t.assignee, task_id: t.id, findings: out }, null, 2), 'application/json');
    emit(id, { actor: t.assignee, kind: 'artifact.saved', provenance: 'observed', summary: `${t.assignee} structured findings (${out.filter(f => f.status === 'observed').length}/${out.length} sources)`, data: art });
    const ok = out.filter(f => f.status === 'observed').length;
    setTask(t.id, ok === out.length ? 'submitted' : ok ? 'partial' : 'failed', `${ok} of ${out.length} sources observed`);
  }
}

// ---------------------------------------------------------------- open-web: cited report

export async function buildWebReport(id: string, findingsByWorker: Map<string, DesktopFinding[]>, signal: AbortSignal) {
  const s = loadSession(id)!;
  const done = new Map<string, number>();
  const findingArts = all("SELECT id FROM artifacts WHERE session_id=? AND kind='desktop_findings' ORDER BY created_at DESC, rowid DESC", id)
    .map(a => { try { return JSON.parse(readArtifact(id, a.id)!.content.toString('utf8')); } catch { return null; } }).filter(Boolean);
  const sections = tasksFor(id).filter(t => t.kind === 'research').map(t => {
    const sub = (s.plan.subtasks || []).find((x: any) => x.task_id === t.id) || (s.plan.subtasks || []).find((x: any) => x.worker_id === t.assignee) || {};
    const saved = findingArts.find((x: any) => x.task_id === t.id) || { findings: [], summary: null };
    const offset = done.get(t.assignee) || 0;
    done.set(t.assignee, offset + saved.findings.length);
    return { worker: t.assignee, task_id: t.id, title: sub.title || t.title, instructions: sub.instructions || '', task_status: t.status,
      agent_summary: saved.summary,
      // Numbers continue across one agent's subtasks so every reference ([A1], [A2], …) is unique.
      // A rejected finding immediately followed by an accepted one is the agent correcting its quote: kept, marked superseded.
      findings: saved.findings.map((f: DesktopFinding, i: number, arr: DesktopFinding[]) => ({ n: offset + i + 1, ...f,
        superseded_by: !f.quote_found && arr[i + 1]?.quote_found ? offset + i + 2 : null })) };
  });
  const files = all("SELECT id, owner, label, rel_path, media_type, sha256, created_at FROM artifacts WHERE session_id=? AND kind='agent_file' ORDER BY created_at", id)
    .map(a => ({ artifact: a.id, author: a.owner, name: path.basename(a.rel_path), media_type: a.media_type, sha256: a.sha256, created_at: a.created_at }));
  const cite = sections.flatMap(sec => sec.findings.map((f: any) => `[${sec.worker.slice(-1).toUpperCase()}${f.n}] ${f.claim} (${f.url})`)).join('\n');
  const summary = await modelCall<string>({
    sessionId: id, actor: 'coordinator', purpose: 'summarise report', signal, retries: s.scope.limits.retries_per_call, maxTokens: 500,
    system: 'Write a short answer to the operator task using ONLY the cited findings. Cite like [A1]. If findings are missing, say what is missing. Plain text, under 150 words.',
    user: `Task: ${s.request.description}\nFindings:\n${cite || '(none)'}${files.length ? `\nFiles the agents saved: ${files.map(f => f.name).join(', ')}` : ''}`,
    local: () => listFindings(),
    parse: (t) => t.trim().slice(0, 2000),
  });
  function listFindings() { return sections.map(sec => `${sec.title}: ${sec.findings.length ? sec.findings.map((f: any) => `${f.claim} [${sec.worker.slice(-1).toUpperCase()}${f.n}]`).join('; ') : 'no findings recorded'}`).join('\n'); }
  const report = { schema_version: '1.0', report_id: newId('rpt'), generated_at: nowIso(), request: { description: s.request.description },
    allowed_sites: s.scope.allowed_sites,
    // Without a model summary (for example when the allowance ran out) the report lists the agents' findings instead.
    coordinator_summary: summary.ok ? summary.value : `No model summary (${summary.error === 'budget' ? 'the shared allowance ran out' : 'the summary call failed'}). Findings as the agents recorded them:\n${listFindings()}`,
    coordinator_summary_note: summary.ok ? 'Agent statement: written by the coordinator model from the findings; not itself verified.' : 'Listed by TaskLatch from the agents’ findings; the claims are agent statements, not verified.', sections,
    files, files_note: 'Files the agents wrote are agent statements: TaskLatch records their hashes but does not check their contents.',
    parent_session_id: s.request.parent_session_id ?? null };
  const md = [`# ${s.request.description}`, '', `Generated ${report.generated_at}`, '', '## Summary (coordinator, unverified)', report.coordinator_summary || '_No summary._', '',
    ...sections.flatMap(sec => [`## ${sec.worker.replace('worker-', 'Worker ').toUpperCase().replace('WORKER ', 'Worker ')} — ${sec.title}`, sec.agent_summary ? `> ${sec.agent_summary}` : '', '',
      ...(sec.findings.length ? sec.findings.map((f: any) => `- **[${sec.worker.slice(-1).toUpperCase()}${f.n}]** ${f.claim}\n  - Quote: “${f.quote}” — ${f.url}`) : ['- _No findings recorded._']), '']),
    ...(files.length ? ['## Files the agents made (agent statements, contents not checked)', ...files.map(f => `- ${f.name} — by ${f.author}, sha256 ${f.sha256.slice(0, 12)}…`), ''] : [])].join('\n');
  const art = saveArtifact(id, 'coordinator', 'report', 'Research report (structured)', 'report.json', JSON.stringify(report, null, 2), 'application/json', true);
  saveArtifact(id, 'coordinator', 'report_md', 'Research report (readable)', 'report.md', md, 'text/markdown', true);
  emit(id, { actor: 'coordinator', kind: 'artifact.published', provenance: 'observed', summary: `Report published: ${sections.length} section(s), ${sections.reduce((a, x) => a + x.findings.length, 0)} finding(s)`, data: { artifact: art } });
  return report;
}

export function desktopLiveInfo(L: DesktopLive | undefined) {
  if (!L) return [];
  return [...L.containers.values()].map(d => ({ worker_id: d.workerId, live_url: d.stoppedAt ? null : d.liveUrl, paused: L.paused.has(d.workerId), container: d.name,
    proxy: { allowed: d.proxy.stats.allowed, blocked: d.proxy.stats.blocked } }));
}

export { formatMinor };
