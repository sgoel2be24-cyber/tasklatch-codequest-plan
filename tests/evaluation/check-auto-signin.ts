/**
 * Checks automatic local sign-in against two real controller processes (no desktops, no model spend):
 * - default (on): the TaskLatch page on this computer is signed in without a token;
 * - other origins, DNS-rebinding hosts, cross-site fetches and plain GETs are refused;
 * - nothing else becomes reachable without a cookie;
 * - TASKLATCH_AUTO_SIGNIN=0: automatic sign-in is refused and the token still works.
 * Each controller gets its own runtime folder and a Docker socket that does not exist, so it can never
 * touch real desktop containers.
 * Run: npm run check:signin
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

async function startController(port: number, extra: Record<string, string>): Promise<{ proc: ChildProcess; rt: string }> {
  const rt = path.join(ROOT, '.runtime/eval', `signin-${port}-${Date.now()}`);
  fs.mkdirSync(rt, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, TASKLATCH_RUNTIME_DIR: rt, TASKLATCH_PORT: String(port), TASKLATCH_PROVIDER: 'local-rules',
    TASKLATCH_DOCKER_HOST: `unix://${rt}/no-docker.sock`, FIREWORKS_API_KEY: undefined, NVIDIA_API_KEY: undefined, TASKLATCH_AUTO_SIGNIN: undefined, ...extra };
  const proc = spawn(process.execPath, [path.join(ROOT, 'apps/controller/server.ts')], { env: env as any, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return { proc, rt }; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  proc.kill(); throw new Error(`controller on ${port} did not start`);
}

const post = (port: number, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/api/local-session`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

// fetch() does not let a caller set Host, so requests that need a specific Host header use http.request.
const postWithHost = (port: number, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/local-session', headers: { 'content-type': 'application/json', ...headers } },
    (res) => { res.resume(); resolve(res.statusCode || 0); });
  req.on('error', reject); req.end('{}');
});

// ---------------------------------------------------------------- default: on
const on = await startController(4532, {});
const O = 'http://127.0.0.1:4532';
try {
  const ok = await post(4532, { origin: O, 'sec-fetch-site': 'same-origin' });
  const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
  check('TaskLatch page on this computer is signed in automatically', ok.status === 200 && cookie.startsWith('tl_operator='));
  const me = await fetch(`${O}/api/me`, { headers: { cookie } });
  check('the cookie it gets is a normal operator session', me.status === 200 && (await me.json()).operator?.id === 'op_local');
  check('works from localhost too', (await postWithHost(4532, { origin: 'http://localhost:4532', host: 'localhost:4532', 'sec-fetch-site': 'same-origin' })) === 200);
  check('refused without an Origin header', (await post(4532, {})).status === 403);
  check('refused for another site', (await post(4532, { origin: 'https://evil.example' })).status === 403);
  check('refused for a DNS-rebinding Host', (await postWithHost(4532, { origin: O, host: 'evil.example:4532' })) === 403);
  check('refused for a cross-site fetch', (await post(4532, { origin: O, 'sec-fetch-site': 'cross-site' })).status === 403);
  check('a plain GET does not sign in', (await fetch(`${O}/api/local-session`)).status === 401);
  check('other API routes still need the cookie', (await fetch(`${O}/api/sessions`)).status === 401);
} finally { on.proc.kill(); }

// ---------------------------------------------------------------- TASKLATCH_AUTO_SIGNIN=0
const off = await startController(4533, { TASKLATCH_AUTO_SIGNIN: '0' });
try {
  const r = await post(4533, { origin: 'http://127.0.0.1:4533', 'sec-fetch-site': 'same-origin' });
  check('turned off: automatic sign-in is refused', r.status === 403 && (await r.json()).error === 'auto_signin_off');
  const token = fs.readFileSync(path.join(off.rt, 'secrets/operator-op_local.token'), 'utf8').trim();
  const t = await fetch('http://127.0.0.1:4533/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4533' }, body: JSON.stringify({ token }) });
  check('turned off: the operator token still signs in', t.status === 200);
} finally { off.proc.kill(); }

console.log(`\n${fail ? 'FAIL' : 'PASS'} automatic sign-in: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
