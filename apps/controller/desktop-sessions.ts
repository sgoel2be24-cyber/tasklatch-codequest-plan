/**
 * Container-desktop research phase: plan → start desktops → run agents in parallel → hand results to
 * the existing comparison/approval path (SupplierLab tasks) or assemble a cited report (open-web tasks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, formatMinor } from '../../packages/contracts/canonical.ts';
import { SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { emit } from './events.ts';
import { decide, assessDestination } from './policy.ts';
import { modelCall, extractJson } from './model.ts';
import { PROVIDER } from './provider.ts';
import { ContainerDesktop } from './desktops.ts';
import { runDesktopWorker, structuredFromSnapshot, type DesktopFinding, type DesktopOutcome } from './desktop-agent.ts';
import { saveArtifact, readArtifact, replayDir } from './storage.ts';
import { loadSession, setWorker, setTask, tasksFor } from './state.ts';
import { all, get } from './db.ts';
import type { Finding } from './agent.ts';

// Chromium's own background services; blocked quietly and counted, not reported as agent actions.
const BACKGROUND = /(^|\.)(googleapis\.com|gvt1\.com|gstatic\.com|google\.com|googleusercontent\.com|chromium\.org|doubleclick\.net)$/i;

export function makeDesktopGate(sessionId: string, workerId: string) {
  const reported = new Set<string>();
  return (r: { kind: string; method: string; url: string; host: string; isPage: boolean }) => {
    const s = loadSession(sessionId);
    if (!s) return { allowed: false, reason: 'unknown session' };
    if (s.stop_requested_at || !['RUNNING', 'VERIFYING', 'AWAITING_APPROVAL'].includes(s.status)) return { allowed: false, reason: 'The task is not running.' };
    const supplierHost = new URL(SUPPLIERLAB_ORIGIN).hostname;
    if (BACKGROUND.test(r.host) && r.host !== supplierHost) return { allowed: false, reason: 'Browser background service (not part of the task).' };
    if (r.kind === 'http' && !['GET', 'HEAD'].includes(r.method)) {
      const d = decide(s, workerId, { type: 'browser.submit_form', resource: r.url }, 'Browser form submission');
      return { allowed: d.decision === 'ALLOW', reason: d.reason };
    }
    const a = assessDestination(s.scope, workerId, r.url);
    if (a.decision === 'ALLOW') return { allowed: true, reason: '' };
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
    subtasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, instructions: { type: 'string' }, start_url: { type: 'string' } }, required: ['title', 'instructions', 'start_url'], additionalProperties: false } },
  },
  required: ['rationale', 'subtasks'], additionalProperties: false,
} as const;

const workerIds = (n: number) => Array.from({ length: Math.max(1, Math.min(n, 4)) }, (_, i) => `worker-${String.fromCharCode(97 + i)}`);

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
  const firstSite = (p: string) => p.includes('://') ? p : p === new URL(SUPPLIERLAB_ORIGIN).host ? `${SUPPLIERLAB_ORIGIN}/` : `https://${p.replace(/^\*\./, '')}/`;
  const fallback = () => ({
    rationale: 'Split by approved site (local rules: no model planning).',
    subtasks: Array.from({ length: Math.min(n, Math.max(1, sites.length)) }, (_, i) => ({ title: `Research on ${sites[i % sites.length]}`, instructions: request.description, start_url: firstSite(sites[i % sites.length]) })),
  });
  const r = await modelCall<any>({
    sessionId, actor: 'coordinator', purpose: 'plan subtasks', retries: scope.limits.retries_per_call, maxTokens: 900, jsonSchema: PLAN_SCHEMA,
    system: `You are the coordinator of up to ${n} browser agents, each with its own desktop. Split the operator's task into at most ${n} INDEPENDENT subtasks that can run in parallel (fewer if the task is small). Each subtask needs a short title, concrete instructions saying exactly which facts to record, and a start_url on one of the approved sites. Agents can only open these approved sites: ${sites.join(', ')}. Reply with JSON.`,
    user: `Operator task: ${request.description}`,
    local: fallback,
    parse: (t) => { const j = extractJson(t); if (!Array.isArray(j.subtasks) || !j.subtasks.length) throw new Error('no subtasks'); return j; },
  });
  const plan = r.ok ? r.value : fallback();
  const ws = workerIds(n);
  const subtasks = plan.subtasks.slice(0, n).map((t: any, i: number) => {
    let start = String(t.start_url || '');
    if (assessDestination(scope, ws[i], start).decision !== 'ALLOW') start = firstSite(sites[0]);
    return { task_id: newId('tsk'), worker_id: ws[i], label: `Worker ${ws[i].slice(-1).toUpperCase()}`, vendor_id: '', source_ids: [],
      title: String(t.title).slice(0, 120), instructions: String(t.instructions).slice(0, 1500), start_url: start, urls: [] };
  });
  return { subtasks, rationale: String(plan.rationale || '').slice(0, 600) };
}

// ---------------------------------------------------------------- research phase

export type DesktopLive = { abort: AbortController; containers: Map<string, ContainerDesktop>; paused: Set<string>; workers: Promise<any>[] };

export async function researchOnDesktops(id: string, L: DesktopLive, onBudget: () => void) {
  const s0 = loadSession(id)!;
  const research = tasksFor(id).filter(t => t.kind === 'research');
  const subs = new Map<string, any>((s0.plan.subtasks || []).map((t: any) => [t.worker_id, t]));
  const findingsByWorker = new Map<string, DesktopFinding[]>();
  const outcomes = new Map<string, DesktopOutcome>();
  const recording = () => !!loadSession(id)?.recording;

  await Promise.allSettled(research.map(async (t) => {
    const sub = subs.get(t.assignee) || { title: t.title, instructions: s0.request.description, start_url: 'about:blank' };
    const d = new ContainerDesktop(id, t.assignee, makeDesktopGate(id, t.assignee));
    L.containers.set(t.assignee, d);
    setWorker(id, t.assignee, { status: 'starting', activity: 'Starting Linux desktop…' });
    try {
      await d.start(sub.start_url || 'about:blank', L.abort.signal);
      emit(id, { actor: 'controller', kind: 'desktop.started', provenance: 'observed', summary: `${t.assignee} desktop started (container ${d.name})`, data: { worker: t.assignee, container: d.name } });
    } catch (e: any) {
      emit(id, { actor: 'controller', kind: 'desktop.error', provenance: 'observed', summary: `${t.assignee} desktop failed to start: ${e.message}` });
      setWorker(id, t.assignee, { status: 'failed', activity: `Desktop failed to start: ${e.message}` });
      setTask(t.id, 'failed', `Desktop failed to start: ${e.message}`);
      outcomes.set(t.assignee, 'failed');
      return;
    }
    // Save a frame for the replay after each observation.
    const origObserve = d.observe.bind(d);
    d.observe = async () => {
      const o = await origObserve();
      if (o.screenshot && recording()) {
        const name = `${Date.now()}-${t.assignee}-step.jpg`;
        fs.writeFileSync(path.join(replayDir(id), name), Buffer.from(o.screenshot, 'base64'));
        setWorker(id, t.assignee, { last_screenshot: name });
      }
      return o;
    };
    findingsByWorker.set(t.assignee, []);
    const p = runDesktopWorker(id, t.assignee, t.id, sub, d, L.abort.signal, {
      paused: () => L.paused.has(t.assignee),
      onFinding: (f) => findingsByWorker.get(t.assignee)!.push(f),
    });
    L.workers.push(p);
    const o = await p;
    outcomes.set(t.assignee, o);
    if (o === 'budget') onBudget();
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
  const sections = tasksFor(id).filter(t => t.kind === 'research').map(t => {
    const sub = (s.plan.subtasks || []).find((x: any) => x.worker_id === t.assignee) || {};
    const df = get("SELECT * FROM artifacts WHERE session_id=? AND owner=? AND kind='desktop_findings' ORDER BY created_at DESC LIMIT 1", id, t.assignee);
    const saved = df ? JSON.parse(readArtifact(id, df.id)!.content.toString('utf8')) : { findings: [], summary: null };
    return { worker: t.assignee, title: sub.title || t.title, instructions: sub.instructions || '', task_status: t.status,
      agent_summary: saved.summary,
      // A rejected finding immediately followed by an accepted one is the agent correcting its quote: kept, marked superseded.
      findings: saved.findings.map((f: DesktopFinding, i: number, arr: DesktopFinding[]) => ({ n: i + 1, ...f,
        superseded_by: !f.quote_found && arr[i + 1]?.quote_found ? i + 2 : null })) };
  });
  const cite = sections.flatMap(sec => sec.findings.map((f: any) => `[${sec.worker.slice(-1).toUpperCase()}${f.n}] ${f.claim} (${f.url})`)).join('\n');
  const summary = await modelCall<string>({
    sessionId: id, actor: 'coordinator', purpose: 'summarise report', signal, retries: s.scope.limits.retries_per_call, maxTokens: 500,
    system: 'Write a short answer to the operator task using ONLY the cited findings. Cite like [A1]. If findings are missing, say what is missing. Plain text, under 150 words.',
    user: `Task: ${s.request.description}\nFindings:\n${cite || '(none)'}`,
    local: () => sections.map(sec => `${sec.title}: ${sec.findings.length ? sec.findings.map((f: any) => `${f.claim} [${sec.worker.slice(-1).toUpperCase()}${f.n}]`).join('; ') : 'no findings recorded'}`).join('\n'),
    parse: (t) => t.trim().slice(0, 2000),
  });
  const report = { schema_version: '1.0', report_id: newId('rpt'), generated_at: nowIso(), request: { description: s.request.description },
    allowed_sites: s.scope.allowed_sites, coordinator_summary: summary.ok ? summary.value : null, coordinator_summary_note: 'Agent statement: written by the coordinator model from the findings; not itself verified.', sections };
  const md = [`# ${s.request.description}`, '', `Generated ${report.generated_at}`, '', '## Summary (coordinator, unverified)', report.coordinator_summary || '_No summary._', '',
    ...sections.flatMap(sec => [`## ${sec.worker.replace('worker-', 'Worker ').toUpperCase().replace('WORKER ', 'Worker ')} — ${sec.title}`, sec.agent_summary ? `> ${sec.agent_summary}` : '', '',
      ...(sec.findings.length ? sec.findings.map((f: any) => `- **[${sec.worker.slice(-1).toUpperCase()}${f.n}]** ${f.claim}\n  - Quote: “${f.quote}” — ${f.url}`) : ['- _No findings recorded._']), ''])].join('\n');
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
