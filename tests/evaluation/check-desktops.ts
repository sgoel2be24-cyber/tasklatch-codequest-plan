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
async function runTask(body: any) {
  const c = await api('POST', '/api/sessions', body);
  if (!c.session) { console.log('create failed', c); return null; }
  const id = c.session.id; console.log('\n==', body.mode || 'supplier', id, '| plan:', c.session.plan.subtasks.map((t: any) => `${t.worker_id}: ${t.title} @ ${t.start_url}`).join(' ; '));
  await api('POST', `/api/sessions/${id}/start`);
  const t0 = Date.now(); let d: any;
  for (let i = 0; i < 240; i++) { d = await api('GET', `/api/sessions/${id}`); if (d.session.outcome) break;
    if (i === 8) { const lv = await api('GET', `/api/sessions/${id}/live`); console.log('live desktops:', lv.desktops.map((x: any) => `${x.worker_id} ${x.live_url ? 'vnc ok' : 'no vnc'} proxy ${x.proxy.allowed}/${x.proxy.blocked}`).join(', ')); }
    await new Promise(r => setTimeout(r, 500)); }
  console.log('outcome', d.session.status, '-', d.session.outcome?.summary, `(${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const [k, v] of Object.entries<any>(d.verification)) console.log('  verify', k, v.status, '-', v.summary);
  console.log('  events:', d.events.filter((e: any) => /desktop\.|whiteboard|agent\.done|agent\.intent|worker\.error|session\.error/.test(e.kind)).slice(0, 14).map((e: any) => e.summary.slice(0, 110)).join('\n          '));
  console.log('  frames', d.replay.frames.length, '| decisions', JSON.stringify(d.decision_counts));
  results.push(d.session.status);
  return d;
}
await runTask({ mode: 'web', runtime: 'desktop', description: 'Find what SupplierLab says about the BrightOffice UC-301 adapter page and record it.', allowed_sites: ['127.0.0.1:4630'], limits: { workers: 2 } });
await runTask({ runtime: 'desktop', description: 'Desktop supplier comparison', item_id: 'item-usbc-adapter', quantity: 20, source_ids: ['src-normal-bo-page', 'src-normal-ke-page'], expected_result: 'draft' });
const left = await new Promise<string>(r => { const p = spawn('docker', ['ps', '-a', '--filter', 'label=tasklatch=1', '--format', '{{.Names}}'], { env: { ...process.env, DOCKER_HOST: 'unix://' + process.env.HOME + '/.colima/tasklatch/docker.sock', DOCKER_CONFIG: ROOT + '/.runtime/docker-config' } }); let o = ''; p.stdout.on('data', x => o += x); p.on('close', () => r(o.trim())); });
console.log('\ncontainers left:', left || '(none)');
if (errs.trim()) console.log('controller stderr:', errs.slice(-800));
ctl.kill(); slab.kill();
const ok = !left && results.every(r => r === 'SUCCEEDED');
console.log(ok ? '\nPASS desktop runtime check' : '\nFAIL desktop runtime check'); process.exit(ok ? 0 : 1);
