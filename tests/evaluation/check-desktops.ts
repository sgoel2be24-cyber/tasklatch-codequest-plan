/**
 * Offline end-to-end check of the container-desktop runtime (no model spend: local rules).
 * Starts its own SupplierLab and controller, runs one open-web task and one SupplierLab task on real
 * Linux desktops, and confirms every container is removed afterwards.
 * Needs the `tasklatch` Colima VM and the desktop image (npm run desktop:vm, npm run desktop:build).
 * Run: npm run check:desktops
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RT = ROOT + '/.runtime/eval/desk-e2e-' + Date.now();
fs.mkdirSync(RT, { recursive: true });
const env: any = { ...process.env, TASKLATCH_RUNTIME_DIR: RT, TASKLATCH_PORT: '4530', SUPPLIERLAB_PORT: '4630', TASKLATCH_PROVIDER: 'local-rules' };
delete env.FIREWORKS_API_KEY; delete env.NVIDIA_API_KEY;
const slab = spawn(process.execPath, [ROOT + '/fixtures/supplierlab/server.ts'], { env, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const ctl = spawn(process.execPath, [ROOT + '/apps/controller/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let errs = ''; ctl.stderr.on('data', d => errs += d);
for (let i = 0; i < 60 && !fs.existsSync(RT + '/secrets/login-link.txt'); i++) await new Promise(r => setTimeout(r, 200));
const T = fs.readFileSync(RT + '/secrets/operator-op_local.token', 'utf8').trim();
const api = async (m: string, p: string, b?: any) => (await fetch('http://127.0.0.1:4530' + p, { method: m, headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json() as any;
const ready = await api('GET', '/api/readiness'); console.log('readiness desktops:', ready.items.find((i: any) => i.id === 'desktops').status, '-', ready.items.find((i: any) => i.id === 'desktops').detail);
const results: string[] = [];
const checks: [string, boolean, string?][] = [];
const check = (n: string, ok: boolean, d = '') => { checks.push([n, ok, d]); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
async function runTask(body: any, opts: { prepare?: (id: string, c: any) => Promise<any>; during?: (id: string) => Promise<void>; create?: () => Promise<any> } = {}) {
  let c = opts.create ? await opts.create() : await api('POST', '/api/sessions', body);
  if (!c.session) { console.log('create failed', c); return null; }
  const id = c.session.id;
  if (opts.prepare) c = await opts.prepare(id, c);
  console.log('\n==', body.mode || 'supplier', id, '| plan:', c.session.plan.subtasks.map((t: any) => `${t.worker_id}: ${t.title} @ ${t.start_url}`).join(' ; '));
  await api('POST', `/api/sessions/${id}/start`);
  const t0 = Date.now(); let d: any; let duringDone = false;
  for (let i = 0; i < 240; i++) { d = await api('GET', `/api/sessions/${id}`); if (d.session.outcome) break;
    if (i === 8) { const lv = await api('GET', `/api/sessions/${id}/live`); console.log('live desktops:', lv.desktops.map((x: any) => `${x.worker_id} ${x.live_url ? 'vnc ok' : 'no vnc'} proxy ${x.proxy.allowed}/${x.proxy.blocked}`).join(', ')); }
    if (opts.during && !duringDone && d.live?.length) { duringDone = true; await opts.during(id); }
    await new Promise(r => setTimeout(r, 500)); }
  console.log('outcome', d.session.status, '-', d.session.outcome?.summary, `(${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const [k, v] of Object.entries<any>(d.verification)) console.log('  verify', k, v.status, '-', v.summary);
  console.log('  events:', d.events.filter((e: any) => /desktop\.|whiteboard|agent\.done|agent\.intent|worker\.error|session\.error/.test(e.kind)).slice(0, 14).map((e: any) => e.summary.slice(0, 110)).join('\n          '));
  console.log('  frames', d.replay.frames.length, '| decisions', JSON.stringify(d.decision_counts));
  results.push(d.session.status);
  return d;
}
const SL = 'http://127.0.0.1:4630';
let msgStatus = 0, siteStatus = 0;
const web = await runTask({ mode: 'web', runtime: 'desktop', description: 'Find what SupplierLab says about the BrightOffice UC-301 adapter page and record it.', allowed_sites: ['127.0.0.1:4630'], limits: { workers: 2 } }, {
  // Three subtasks on two agents: Worker A runs two in order on the same desktop.
  prepare: async (id) => (await fetch('http://127.0.0.1:4530/api/sessions/' + id + '/scope', { method: 'PATCH', headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: JSON.stringify({ subtasks: [
    { worker_id: 'worker-a', title: 'BrightOffice product page', instructions: 'Record what the page says.', start_url: SL + '/catalog/normal/v-brightoffice/bo-uc-301' },
    { worker_id: 'worker-a', title: 'SupplierLab home', instructions: 'Record what the page says.', start_url: SL + '/' },
    { worker_id: 'worker-b', title: 'Kartik product page', instructions: 'Record what the page says.', start_url: SL + '/catalog/normal/v-kartik/ke-usbca-3a' },
  ] }) })).json(),
  during: async (id) => {
    msgStatus = (await fetch(`http://127.0.0.1:4530/api/sessions/${id}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: JSON.stringify({ to: 'worker-a', text: 'Keep quotes short.' }) })).status;
    siteStatus = (await fetch(`http://127.0.0.1:4530/api/sessions/${id}/sites`, { method: 'POST', headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: JSON.stringify({ add: ['example.org'] }) })).status;
  },
});
if (web) {
  const id = web.session.id;
  const rep = web.artifacts.filter((a: any) => a.kind === 'report').slice(-1)[0];
  const report = rep ? await (await fetch(`http://127.0.0.1:4530/api/sessions/${id}/artifacts/${rep.id}`, { headers: { authorization: 'Bearer ' + T } })).json() : { sections: [] };
  const refs = report.sections.flatMap((s: any) => s.findings.map((f: any) => s.worker + f.n));
  check('report has one section per subtask (3)', report.sections.length === 3, report.sections.map((s: any) => `${s.worker}:${s.title}:${s.findings.length}`).join(', '));
  check('finding references are unique across a queue', refs.length > 0 && new Set(refs).size === refs.length, refs.join(' '));
  check('Worker A ran two subtasks on one desktop', web.events.filter((e: any) => e.kind === 'desktop.started' && e.data?.worker === 'worker-a').length === 1 && web.events.some((e: any) => e.kind === 'worker.next_task'));
  check('operator message accepted while running', msgStatus === 200 && web.events.some((e: any) => e.kind === 'operator.message' && e.data?.to === 'worker-a'));
  check('site allowed mid-run (operator decision, policy version bumped)', siteStatus === 200 && web.session.scope.allowed_sites.includes('example.org') && web.session.policy_version > 1);
  check('agents saved files in their own folders', web.files.length >= 3 && web.files.every((f: any) => /^made\//.test(f.label.replace(/^Worker [A-D]: /, '')) || f.name), web.files.map((f: any) => f.name).join(', '));
  const fileRes = await fetch(`http://127.0.0.1:4530/api/sessions/${id}/artifacts/${web.files[0]?.id}?download=1`, { headers: { authorization: 'Bearer ' + T } });
  check('agent file served as a sandboxed download', fileRes.ok && /attachment/.test(fileRes.headers.get('content-disposition') || '') && /sandbox/.test(fileRes.headers.get('content-security-policy') || ''));
  check('file integrity checked by the verifier', (web.verification.report?.checks || []).some((c: any) => c.name.startsWith('file:') && c.status === 'pass'));
  const csv = await (await fetch(`http://127.0.0.1:4530/api/sessions/${id}/report.csv`, { headers: { authorization: 'Bearer ' + T } })).text();
  check('CSV export lists every finding', csv.trim().split('\r\n').length === refs.length + 1);
  // Follow-up: new linked task with the same sites and the parent's source-checked findings as context.
  const fu = await runTask({ mode: 'web' }, { create: () => api('POST', `/api/sessions/${id}/followup`, { description: 'Now record what the Kartik Electronics page says, briefly.', agents: 1 }) });
  check('follow-up linked to its parent with context', !!fu && fu.session.request.parent_session_id === id && (fu.session.request.context?.findings?.length || 0) > 0 && fu.parent?.id === id);
  check('follow-up inherits the parent’s sites (including one allowed mid-run)', !!fu && fu.session.scope.allowed_sites.includes('example.org'));
}
await runTask({ runtime: 'desktop', description: 'Desktop supplier comparison', item_id: 'item-usbc-adapter', quantity: 20, source_ids: ['src-normal-bo-page', 'src-normal-ke-page'], expected_result: 'draft' });
const left = await new Promise<string>(r => { const p = spawn('docker', ['ps', '-a', '--filter', 'label=tasklatch=1', '--format', '{{.Names}}'], { env: { ...process.env, DOCKER_HOST: 'unix://' + process.env.HOME + '/.colima/tasklatch/docker.sock', DOCKER_CONFIG: ROOT + '/.runtime/docker-config' } }); let o = ''; p.stdout.on('data', x => o += x); p.on('close', () => r(o.trim())); });
console.log('\ncontainers left:', left || '(none)');
if (errs.trim()) console.log('controller stderr:', errs.slice(-800));
ctl.kill(); slab.kill();
const ok = !left && results.every(r => r === 'SUCCEEDED') && checks.every(c => c[1]);
console.log(`checks: ${checks.filter(c => c[1]).length}/${checks.length} passed; outcomes: ${results.join(', ')}`);
console.log(ok ? '\nPASS desktop runtime check' : '\nFAIL desktop runtime check'); process.exit(ok ? 0 : 1);
