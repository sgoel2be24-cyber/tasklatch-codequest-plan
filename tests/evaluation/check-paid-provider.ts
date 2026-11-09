/**
 * Checks the paid-provider path (Fireworks) end to end WITHOUT contacting Fireworks: a local mock
 * OpenAI-compatible server stands in for the API. Nothing is billed.
 *
 *  1. Fireworks is not selected unless TASKLATCH_PROVIDER=fireworks (a key alone is not enough).
 *  2. With opt-in, the controller sends the key and model to the configured endpoint, labels the
 *     provider as paid, and reports an estimated cost instead of ₹0.
 *  3. A small TASKLATCH_MAX_SPEND_USD becomes a token ceiling and stops the task (Budget exhausted).
 *
 * Run: node tests/evaluation/check-paid-provider.ts
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK_PORT = 4950;
const seen: { auth: string | undefined; model: string; path: string; rf: string | null; schemaKeys: number }[] = [];

// ---- mock OpenAI-compatible endpoint
const mock = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"accounts/fireworks/models/mock"}]}'); }
  const j = JSON.parse(body || '{}');
  seen.push({ auth: req.headers.authorization, model: j.model, path: req.url || '', rf: j.response_format?.type ?? null,
    schemaKeys: Object.keys(j.response_format?.json_schema?.schema?.properties ?? {}).length });
  const user: string = j.messages?.[1]?.content ?? '';
  const price = /"price":\{"text":"[^"]*","attrs":\{"field":"price","minor":"(\d+)"/.exec(user)?.[1];
  const stock = /"stock":\{"text":"[^"]*","attrs":\{"field":"stock","qty":"(\d*)"/.exec(user)?.[1];
  const vendor = /"vendor-id":"([^"]+)"/.exec(user)?.[1] ?? null;
  const product = /"product-id":\{"text":"([^"]+)"/.exec(user)?.[1] ?? null;
  const content = price
    ? JSON.stringify({ vendor_id: vendor, product_id: product, product_title: null, unit_price_minor: Number(price), currency: 'INR',
        stock_qty: stock ? Number(stock) : null, stock_status: stock ? 'in_stock' : 'unknown', tax_included: true, shipping_minor: 0, limitations: [] })
    : '{"summary":"ok","rationale":"ok"}';
  const tokens = Math.ceil(user.length / 4) + 60;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: tokens - 60, completion_tokens: 60, total_tokens: tokens } }));
});
await new Promise<void>(r => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));

async function startStack(name: string, extraEnv: Record<string, string>, ports: [number, number]) {
  const runtime = path.join(ROOT, '.runtime', 'eval', `paid-${name}-${Date.now()}`);
  fs.mkdirSync(runtime, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, TASKLATCH_RUNTIME_DIR: runtime, TASKLATCH_PORT: String(ports[0]), SUPPLIERLAB_PORT: String(ports[1]) };
  delete env.NVIDIA_API_KEY; delete env.TASKLATCH_PROVIDER; delete env.FIREWORKS_API_KEY; delete env.TASKLATCH_MODEL;
  Object.assign(env, extraEnv);
  const procs: ChildProcess[] = [spawn(process.execPath, [path.join(ROOT, 'fixtures/supplierlab/server.ts')], { env, stdio: 'ignore' })];
  await new Promise(r => setTimeout(r, 700));
  procs.push(spawn(process.execPath, [path.join(ROOT, 'apps/controller/server.ts')], { env, stdio: 'ignore' }));
  const tokFile = path.join(runtime, 'secrets', 'operator-op_local.token');
  for (let i = 0; i < 80 && !fs.existsSync(path.join(runtime, 'secrets', 'login-link.txt')); i++) await new Promise(r => setTimeout(r, 150));
  const token = fs.readFileSync(tokFile, 'utf8').trim();
  const base = `http://127.0.0.1:${ports[0]}`;
  const api = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return r.json() as any;
  };
  return { api, stop: () => procs.forEach(p => p.kill('SIGTERM')) };
}
async function runTask(api: any) {
  const snap = await api('POST', '/api/sessions', { description: 'paid provider check', item_id: 'item-usbc-adapter', quantity: 20,
    source_ids: ['src-normal-bo-page', 'src-normal-ke-page'], expected_result: 'draft', recording: false });
  const id = snap.session.id;
  await api('POST', `/api/sessions/${id}/start`);
  for (let i = 0; i < 200; i++) { const s = await api('GET', `/api/sessions/${id}`); if (s.session.outcome) return s; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('task did not finish');
}

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };

// 1) key without opt-in → still local rules
{
  const s = await startStack('nooptin', { FIREWORKS_API_KEY: 'fw-test-key', TASKLATCH_MODEL: 'accounts/fireworks/models/mock', FIREWORKS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` }, [4910, 4920]);
  const before = seen.length;
  const r = await runTask(s.api);
  check('No opt-in, no Fireworks', r.model.provider === 'local-rules' && seen.length === before, `provider ${r.model.provider}; mock calls ${seen.length - before}; payable ${r.budget.payable_cost.display}`);
  s.stop();
}
// 2) explicit opt-in with a rate and a generous cap
{
  const s = await startStack('optin', { TASKLATCH_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'fw-test-key', TASKLATCH_MODEL: 'accounts/fireworks/models/mock',
    FIREWORKS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, FIREWORKS_USD_PER_1M_TOKENS: '0.9', TASKLATCH_MAX_SPEND_USD: '0.05', TASKLATCH_JSON_MODE: 'schema' }, [4911, 4921]);
  const ready = await s.api('GET', '/api/readiness');
  const m = ready.items.find((i: any) => i.id === 'model');
  check('Readiness flags paid provider', m.status === 'ready' && m.paid === true && /PAID/.test(m.detail), `${m.status}: ${m.detail}`);
  const before = seen.length;
  const r = await runTask(s.api);
  const calls = seen.slice(before);
  check('Calls go to the configured endpoint with key and model', calls.length > 0 && calls.every(c => c.auth === 'Bearer fw-test-key' && c.model === 'accounts/fireworks/models/mock'), `${calls.length} calls to ${calls[0]?.path}`);
  const extract = calls.filter(c => c.schemaKeys > 0);
  check('Extraction calls request schema-constrained JSON', extract.length === 2 && extract.every(c => c.rf === 'json_schema' && c.schemaKeys === 10) && calls.filter(c => c.rf === null).length === calls.length - 2,
    `${extract.length} extraction calls with json_schema (${extract[0]?.schemaKeys} fields); ${calls.length - extract.length} other calls unconstrained`);
  check('Task completes and is verified', r.session.status === 'SUCCEEDED', `outcome ${r.session.status}`);
  check('Labelled as paid in the task', r.model.paid === true && /Fireworks/.test(r.model.label), r.model.label);
  const pc = r.budget.payable_cost;
  const expected = ((r.budget.tokens.reported + r.budget.tokens.estimated) * 0.9) / 1e6;
  check('Cost shown as an estimate, not ₹0', pc.paid && pc.basis === 'estimated' && Math.abs(pc.amount_usd - expected) < 1e-9 && pc.display.startsWith('≈ $'), `${pc.display} for ${r.budget.tokens.reported} reported tokens`);
  check('Spend cap became the token ceiling', r.budget.tokens.ceiling === Math.min(60000, Math.floor(0.05 / 0.9 * 1e6)), `ceiling ${r.budget.tokens.ceiling}`);
  const ev = await s.api('GET', `/api/sessions/${r.session.id}/evidence`);
  check('Evidence states payable estimate and provider', ev.manifest.disclosures.some((d: string) => /estimate; the provider invoice is authoritative/.test(d)) && ev.manifest.model.provider === 'fireworks' && !JSON.stringify(ev).includes('fw-test-key'), ev.manifest.disclosures[1] + ' / ' + ev.manifest.disclosures[2]);
  s.stop();
}
// 3) tiny spend cap → budget exhausted, not overspent
{
  const s = await startStack('cap', { TASKLATCH_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'fw-test-key', TASKLATCH_MODEL: 'accounts/fireworks/models/mock',
    FIREWORKS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, FIREWORKS_USD_PER_1M_TOKENS: '0.9', TASKLATCH_MAX_SPEND_USD: '0.0005' }, [4912, 4922]);
  const r = await runTask(s.api);
  const used = r.budget.tokens.reported + r.budget.tokens.estimated;
  check('Small spend cap stops the task within the ceiling', r.session.status === 'BUDGET_EXHAUSTED' && used <= r.budget.tokens.ceiling, `outcome ${r.session.status}; tokens ${used} of ceiling ${r.budget.tokens.ceiling}; ${r.budget.payable_cost.display}`);
  s.stop();
}
// 4) opt-in without a model id → refuses to guess
{
  const s = await startStack('nomodel', { TASKLATCH_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'fw-test-key', FIREWORKS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` }, [4913, 4923]);
  const ready = await s.api('GET', '/api/readiness');
  const m = ready.items.find((i: any) => i.id === 'model');
  check('Missing model id is reported, not guessed', m.status === 'unavailable' && /TASKLATCH_MODEL is not set/.test(m.detail), m.detail);
  s.stop();
}

mock.close();
const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (mock endpoint; no Fireworks request was made).`);
process.exit(failed ? 1 : 0);
