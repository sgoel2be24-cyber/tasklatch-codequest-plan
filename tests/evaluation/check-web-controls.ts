/**
 * Offline checks for the open-web controls (no desktops, no model spend: local rules).
 * - Site patterns: "*" means public sites only; private networks need an explicit listing; TaskLatch itself is never reachable.
 * - Egress proxy: a public-looking name that resolves to a private address is refused unless listed by name.
 * - Blocked sites surface for the operator, and allowing one takes effect on the next request.
 * - Plans: several subtasks per agent, plain-language revision, operator messages only while running, CSV export.
 * Run: npm run check:web
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RT = ROOT + '/.runtime/eval/web-controls-' + Date.now();
fs.mkdirSync(RT, { recursive: true });
process.env.TASKLATCH_RUNTIME_DIR = RT;
process.env.TASKLATCH_PROVIDER = 'local-rules';
process.env.TASKLATCH_PORT = '4531';
delete process.env.FIREWORKS_API_KEY; delete process.env.NVIDIA_API_KEY;

const { hostAllowed, assessDestination, normalizeSite, hostListedExplicitly } = await import('../../apps/controller/policy.ts');
const { EgressProxy } = await import('../../apps/controller/egress.ts');
const { ensureOperator } = await import('../../apps/controller/auth.ts');
const S = await import('../../apps/controller/sessions.ts');
const { makeDesktopGate } = await import('../../apps/controller/desktop-sessions.ts');
const { snapshot, reportCsv } = await import('../../apps/controller/view.ts');
const { run, get } = await import('../../apps/controller/db.ts');
const { saveArtifact } = await import('../../apps/controller/storage.ts');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

// ---------------------------------------------------------------- site patterns
const any = { mode: 'web', allowed_sites: ['*'] };
check('"*" allows a public site', hostAllowed(any, 'example.org', 443));
check('"*" excludes loopback', !hostAllowed(any, '127.0.0.1', 4100));
check('"*" excludes private ranges', !hostAllowed(any, '10.1.2.3', 80) && !hostAllowed(any, '192.168.0.4', 80) && !hostAllowed(any, '172.20.0.1', 80));
check('"*" excludes local names', !hostAllowed(any, 'localhost', 80) && !hostAllowed(any, 'host.docker.internal', 80) && !hostAllowed(any, 'printer.local', 80));
check('"*" excludes link-local metadata address', !hostAllowed(any, '169.254.169.254', 80));
check('"*" excludes IPv6 loopback and unique-local', !hostAllowed(any, '[::1]', 80) && !hostAllowed(any, 'fd00::1', 80));
const explicit = { mode: 'web', allowed_sites: ['127.0.0.1:4100', '127.0.0.1', 'en.wikipedia.org'] };
check('explicit host:port listing allows a private address', hostAllowed(explicit, '127.0.0.1', 4100) && hostListedExplicitly(explicit, '127.0.0.1', 4100));
check('TaskLatch controller is never allowed, even when listed', !hostAllowed(explicit, '127.0.0.1', 4531) && assessDestination(explicit, 'worker-a', 'http://127.0.0.1:4531/api/me').reason_code === 'controller_unreachable');
check('controller blocked through localhost too', assessDestination(explicit, 'worker-a', 'http://localhost:4531/').decision === 'DENY');
check('"*" denial for private address says why', assessDestination(any, 'worker-a', 'http://192.168.1.1/').reason_code === 'private_network');
check('port-specific pattern does not match another port', !hostAllowed({ allowed_sites: ['example.org:8443'] }, 'example.org', 443));
check('wildcard subdomain pattern', hostAllowed({ allowed_sites: ['*.wikipedia.org'] }, 'fr.wikipedia.org', 443) && hostAllowed({ allowed_sites: ['*.wikipedia.org'] }, 'wikipedia.org', 443) && !hostAllowed({ allowed_sites: ['*.wikipedia.org'] }, 'evilwikipedia.org', 443));
check('site normalisation', normalizeSite('https://Example.org/path?q=1') === 'example.org' && normalizeSite('any') === '*' && normalizeSite('bad host!') === null);

// ---------------------------------------------------------------- egress proxy: resolve once, refuse private targets unless listed by name
const target = http.createServer((_q, r) => { r.end('private service'); });
await new Promise<void>(r => target.listen(0, '127.0.0.1', () => r()));
const tport = (target.address() as any).port;
const viaProxy = (proxyPort: number, url: string) => new Promise<number>((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: u.host, accept: 'text/html' } }, (res) => { res.resume(); resolve(res.statusCode || 0); });
  req.on('error', () => resolve(-1)); req.end();
});
const pOpen = new EgressProxy(() => ({ allowed: true, reason: '', privateOk: false }));
const pListed = new EgressProxy(() => ({ allowed: true, reason: '', privateOk: true }));
const [po, pl] = [await pOpen.listen(0), await pListed.listen(0)];
check('proxy refuses a private address the operator did not list', await viaProxy(po, `http://127.0.0.1:${tport}/`) === 403);
check('proxy reaches a private address listed by name', await viaProxy(pl, `http://127.0.0.1:${tport}/`) === 200);
const rebind = await viaProxy(po, `http://localtest.me:${tport}/`);
check('proxy refuses a public name that resolves to loopback (DNS rebinding)', rebind === 403, rebind === 403 ? 'localtest.me → 127.0.0.1 refused' : `status ${rebind}`);
await pOpen.close(); await pListed.close(); target.close();

// ---------------------------------------------------------------- sessions: plan queues, refine, sites, messages, CSV
const opId = 'op_local'; ensureOperator(opId, 'Local operator');
const op = { id: opId };
const ses = await S.createSession(op, { mode: 'web', runtime: 'desktop', description: 'Compare two encyclopedia articles and save a table.', allowed_sites: ['*.wikipedia.org', 'https://news.ycombinator.com/'], limits: { workers: 2 } });
const id = ses!.id;
check('web session created with normalised sites', JSON.stringify(ses!.scope.allowed_sites) === JSON.stringify(['*.wikipedia.org', 'news.ycombinator.com']));
S.reviseWebPlan(op, id, { subtasks: [
  { worker_id: 'worker-a', title: 'First article', instructions: 'Record the opening line.', start_url: 'https://en.wikipedia.org/wiki/Eiffel_Tower' },
  { worker_id: 'worker-a', title: 'Second article', instructions: 'Record the opening line.', start_url: 'https://evil.example/' },
  { worker_id: 'worker-b', title: 'Third article', instructions: 'Record the opening line.', start_url: 'en.wikipedia.org/wiki/Statue_of_Liberty' },
] });
let snap: any = snapshot(id);
check('two subtasks queue on one agent', snap.tasks.filter((t: any) => t.kind === 'research' && t.assignee === 'worker-a').length === 2 && snap.workers.length === 2);
check('unapproved start page replaced by an approved one', snap.session.plan.subtasks[1].start_url.startsWith('https://') && !snap.session.plan.subtasks[1].start_url.includes('evil.example'));
check('bare start page gets https://', snap.session.plan.subtasks[2].start_url === 'https://en.wikipedia.org/wiki/Statue_of_Liberty');
await S.refineWebPlan(op, id, 'Also check the Wikipedia article on the Louvre');
snap = snapshot(id);
check('plain-language revision changes the plan (local rules: adds a subtask)', snap.session.plan.subtasks.length === 4 && snap.events.some((e: any) => e.kind === 'plan.change_requested'));
let threw = '';
try { S.messageWorker(op, id, 'worker-a', 'hello'); } catch (e: any) { threw = e.code; }
check('messages are refused before the task runs', threw === 'not_running');
S.changeSites(op, id, { add: ['docs.python.org'] });
check('sites can be added before start', snapshot(id).session.scope.allowed_sites.includes('docs.python.org'));

// Simulate a running task (no desktops) to exercise the gate and the operator's allow decision.
run("UPDATE sessions SET status='RUNNING', started_at=?, deadline_at=? WHERE id=?", new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), id);
const gate = makeDesktopGate(id, 'worker-a');
const req = (host: string) => gate({ kind: 'connect', method: 'CONNECT', url: `https://${host}/`, host, port: 443, isPage: true });
check('unapproved site blocked at the gate', !req('example.org').allowed);
req('example.org'); req('example.org');
const pv = get('SELECT policy_version v FROM sessions WHERE id=?', id).v;
snap = snapshot(id);
const b = snap.blocked_sites.find((x: any) => x.host === 'example.org');
check('blocked site listed once for the operator (repeats deduplicated)', !!b && b.count === 1 && b.workers.includes('worker-a'));
check('approved site passes, wildcard subdomain', req('fr.wikipedia.org').allowed);
const pvt = gate({ kind: 'http', method: 'GET', url: 'http://10.0.0.5/', host: '10.0.0.5', port: 80, isPage: true });
check('private address blocked at the gate', !pvt.allowed);
const post = gate({ kind: 'http', method: 'POST', url: 'http://fr.wikipedia.org/w/api.php', host: 'fr.wikipedia.org', port: 80, isPage: false });
check('form post blocked even on an approved site', !post.allowed);
S.changeSites(op, id, { add: ['example.org'] });
snap = snapshot(id);
check('operator allows a blocked site mid-run (new policy version, decision recorded)', req('example.org').allowed && snap.session.policy_version === pv + 1 && snap.events.some((e: any) => e.kind === 'scope.sites_changed' && e.provenance === 'operator_decision'));
check('allowed site leaves the blocked list', !snapshot(id).blocked_sites.some((x: any) => x.host === 'example.org'));
check('allowing "*" never opens TaskLatch itself', (() => { S.changeSites(op, id, { add: ['*'] }); return !gate({ kind: 'http', method: 'GET', url: 'http://127.0.0.1:4531/api/me', host: '127.0.0.1', port: 4531, isPage: true }).allowed; })());

// CSV export: formula-looking cells are neutralised for spreadsheets.
const tA = snap.tasks.find((t: any) => t.kind === 'research');
saveArtifact(id, 'coordinator', 'report', 'Research report (structured)', 'report.json', JSON.stringify({ sections: [{ worker: 'worker-a', task_id: tA.id, title: 'T', findings: [{ n: 1, claim: '=HYPERLINK("http://x")', quote: 'a, "quoted" line', url: 'https://en.wikipedia.org/wiki/X', captured_at: 'now' }] }] }), 'application/json', true);
const csv = reportCsv(id);
check('CSV export has a header and one row', csv.split('\r\n').filter(Boolean).length === 2);
check('CSV neutralises formulas and quotes commas', csv.includes(`"'=HYPERLINK(""http://x"")"`) && csv.includes('"a, ""quoted"" line"'));

// Allowance exhausted mid-run: findings already recorded are still assembled into a report and source-checked.
const s2 = await S.createSession(op, { mode: 'web', runtime: 'desktop', description: 'Record the opening line of one article.', allowed_sites: ['*.wikipedia.org'], limits: { workers: 1 } });
const id2 = s2!.id;
run("UPDATE sessions SET status='RUNNING', started_at=?, deadline_at=? WHERE id=?", new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), id2);
const t2 = snapshot(id2).tasks.find((t: any) => t.kind === 'research');
const page = 'The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris.';
const snapArt = saveArtifact(id2, 'worker-a', 'page_snapshot', 'snapshot', 'snapshot-1.txt', `URL: https://en.wikipedia.org/wiki/Eiffel_Tower\nTitle: Eiffel Tower\nCaptured by TaskLatch: now\n\n${page}`, 'text/plain');
saveArtifact(id2, 'worker-a', 'desktop_findings', 'findings', `desktop-findings-${t2.id}.json`, JSON.stringify({ task_id: t2.id, summary: null, findings: [
  { finding_id: 'fnd_x', author_agent: 'worker-a', task_id: t2.id, claim: 'It is a wrought-iron lattice tower.', quote: 'wrought-iron lattice tower on the Champ de Mars', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', title: 'Eiffel Tower', captured_at: 'now', quote_found: true, page_text_sha256: '', snapshot_artifact: snapArt.id, source_id: null },
] }), 'application/json');
S.markBudgetExhausted(id2, 'token ceiling');
let out: any = null;
for (let i = 0; i < 40 && !(out = snapshot(id2)).session.outcome; i++) await new Promise(r => setTimeout(r, 100));
check('allowance exhausted: outcome says which limit ran out', out.session.status === 'BUDGET_EXHAUSTED' && out.session.status_reason === 'token ceiling' && /token ceiling/.test(out.session.outcome?.summary || ''));
check('allowance exhausted: recorded findings are still reported and source-checked', out.verification.report?.status === 'verified' && out.artifacts.some((a: any) => a.kind === 'report'));

console.log(`\n${fail ? 'FAIL' : 'PASS'} web controls: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
