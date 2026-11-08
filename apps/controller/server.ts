/**
 * TaskLatch controller: loopback HTTP API + operator UI.
 * Run: node apps/controller/server.ts  (SupplierLab must be running; see scripts/start.ts)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, RUNTIME_DIR, PORTS, HOST, CONTROLLER_ORIGIN, SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { get, DB_PATH } from './db.ts';
import { emit } from './events.ts';
import { ensureOperator, bootstrapCode, redeemBootstrap, operatorByToken, operatorFromRequest, sessionCookie, clearCookie } from './auth.ts';
import { createSession, revisePlan, reviseWebPlan, refineWebPlan, changeSites, messageWorker, followUp, start, stop, resume, reviseDraft, recoverInterrupted, tick, UserError, finalize, setTakeover, liveDesktops } from './sessions.ts';
import { probeDesktops, removeOrphanDesktops } from './desktops.ts';
import { operatorDecision, reconcileSubmission, retryUncertain } from './approvals.ts';
import { verifyComparison, verifyDraft, verifySubmission, verifyReport } from './verifier.ts';
import { snapshot, sessionList, evidenceBundle, deleteReplay, reportCsv } from './view.ts';
import { readArtifact, replayDir, containedPath, SESSIONS_DIR } from './storage.ts';
import { probeBrowser, shutdownBrowser } from './runtime.ts';
import { probeModel, providerLabel } from './model.ts';
import { PROVIDER, capTokens } from './provider.ts';
import { readCatalog, supplierLabHealth } from './supplierlab-client.ts';
import { loadSession } from './state.ts';
import { run } from './db.ts';

const WEB_DIR = path.join(REPO_ROOT, 'apps/web');
const ALLOWED_ORIGINS = new Set([CONTROLLER_ORIGIN, `http://localhost:${PORTS.controller}`]);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown' };

const primaryName = process.env.TASKLATCH_OPERATOR_NAME || 'Local operator';
ensureOperator('op_local', primaryName);
if (process.env.TASKLATCH_TEST_OPERATOR === '1') ensureOperator('op_second', 'Second test operator');

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<any> {
  let d = '';
  for await (const c of req) { d += c; if (d.length > 200_000) throw new UserError(413, 'too_large', 'Request too large'); }
  if (!d) return {};
  try { return JSON.parse(d); } catch { throw new UserError(400, 'invalid_json', 'Body must be JSON'); }
}

/** Ownership check before any session data is returned. Unknown and foreign sessions look identical. */
function owned(op: any, id: string) {
  if (!/^ses_[0-9a-f]{12}$/.test(id)) throw new UserError(404, 'not_found', 'Task not found.');
  const s = get('SELECT operator_id FROM sessions WHERE id=?', id);
  if (!s || s.operator_id !== op.id) throw new UserError(404, 'not_found', 'Task not found.');
}

async function readiness() {
  const [browser, model, slab, desktops] = await Promise.all([probeBrowser(), probeModel(), supplierLabHealth(), probeDesktops()]);
  let storage = { ok: false, detail: '' };
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const probe = path.join(SESSIONS_DIR, '.write-probe'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    const st = fs.statfsSync(RUNTIME_DIR);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    storage = { ok: freeGb > 1, detail: `${path.relative(REPO_ROOT, RUNTIME_DIR)}/ is writable; ${freeGb.toFixed(1)} GB free; database ${path.basename(DB_PATH)}` };
  } catch (e: any) { storage = { ok: false, detail: e.message }; }
  return {
    checked_at: new Date().toISOString(),
    items: [
      { id: 'desktops', label: 'Agent desktops (Linux, Docker)', status: desktops.ok ? 'ready' : 'unavailable', detail: desktops.detail },
      { id: 'browser', label: 'Headless browser (offline tests)', status: browser.ok ? 'ready' : 'unavailable', detail: browser.detail },
      { id: 'storage', label: 'Task storage', status: storage.ok ? 'ready' : 'unavailable', detail: storage.detail },
      { id: 'supplierlab', label: 'SupplierLab (synthetic test app)', status: slab ? 'ready' : 'unavailable', detail: slab ? `Reachable at ${SUPPLIERLAB_ORIGIN}` : `Not reachable at ${SUPPLIERLAB_ORIGIN}` },
      { id: 'model', label: 'Model access', status: model.status === 'available' ? 'ready' : model.status === 'not_configured' ? 'limited' : 'unavailable', detail: model.detail + (PROVIDER.provider !== 'local-rules' ? (PROVIDER.supportsImages ? ' Vision: on (desktop agents can see the screen).' : ' Vision: off — desktop agents need a model that accepts screenshots.') : ''), provider: providerLabel(), paid: PROVIDER.paid, vision: PROVIDER.supportsImages,
        max_spend_usd: PROVIDER.paid ? PROVIDER.maxSpendUsd : null, paid_token_ceiling: PROVIDER.paid ? capTokens() : null, usd_per_1m_tokens: PROVIDER.paid ? PROVIDER.usdPer1MTokens : null },
      { id: 'network', label: 'Loopback only', status: 'ready', detail: `Controller on ${CONTROLLER_ORIGIN}; SupplierLab on ${SUPPLIERLAB_ORIGIN}` },
    ],
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', CONTROLLER_ORIGIN);
  const p = url.pathname; const m = req.method || 'GET';
  try {
    // ---------- static UI
    if (m === 'GET' && !p.startsWith('/api/') && !p.startsWith('/auth/')) {
      const rel = p === '/' || !path.extname(p) ? 'index.html' : p.slice(1);
      const c = containedPath(WEB_DIR, rel);
      if (!c.ok || !fs.existsSync(c.path)) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'content-type': (MIME[path.extname(c.path)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-cache',
        // Live desktop views are noVNC pages served by each container on a loopback port.
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff' });
      return fs.createReadStream(c.path).pipe(res);
    }
    if (m === 'GET' && p === '/auth/bootstrap') {
      const op = redeemBootstrap(url.searchParams.get('code') || '');
      if (!op) { res.writeHead(302, { location: '/?login=expired' }); return res.end(); }
      res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(op) }); return res.end();
    }

    // ---------- state-changing requests must come from this origin
    if (m !== 'GET') {
      const origin = req.headers.origin;
      if (origin ? !ALLOWED_ORIGINS.has(origin) : !String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 403, { error: 'origin_rejected', message: 'Cross-origin request refused.' });
      }
    }
    if (m === 'POST' && p === '/api/login') {
      const b = await body(req);
      const op = operatorByToken(b.token || '');
      if (!op) return json(res, 401, { error: 'invalid_token', message: 'That operator token is not valid.' });
      return json(res, 200, { operator: op }, { 'set-cookie': sessionCookie(op.id) });
    }
    if (m === 'POST' && p === '/api/logout') return json(res, 200, { ok: true }, { 'set-cookie': clearCookie });

    const op = operatorFromRequest(req.headers);
    if (!op) return json(res, 401, { error: 'unauthenticated', message: 'Sign in with your local operator link or token.' });

    if (m === 'GET' && p === '/api/me') return json(res, 200, { operator: op });
    if (m === 'GET' && p === '/api/readiness') return json(res, 200, await readiness());
    if (m === 'GET' && p === '/api/catalog') return json(res, 200, await readCatalog());
    if (m === 'GET' && p === '/api/sessions') return json(res, 200, { sessions: sessionList(op.id) });
    if (m === 'POST' && p === '/api/sessions') return json(res, 201, snapshot((await createSession(op, await body(req)))!.id));

    const sm = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(p);
    if (sm) {
      const id = sm[1]; const sub = sm[2] || '';
      owned(op, id);
      if (m === 'GET' && sub === '') return json(res, 200, snapshot(id));
      if (m === 'PATCH' && sub === '/scope') {
        const b = await body(req);
        if (b.subtasks || b.allowed_sites) reviseWebPlan(op, id, b); else revisePlan(op, id, b);
        return json(res, 200, snapshot(id));
      }
      if (m === 'GET' && sub === '/live') return json(res, 200, { desktops: liveDesktops(id) });
      const tk = /^\/workers\/(worker-[a-d])\/takeover$/.exec(sub);
      if (m === 'POST' && tk) { const b = await body(req); return json(res, 200, { desktops: setTakeover(op, id, tk[1], !!b.on) }); }
      if (m === 'POST' && sub === '/plan/refine') { const b = await body(req); await refineWebPlan(op, id, String(b.instruction || '')); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/sites') { const b = await body(req); changeSites(op, id, { add: b.add, remove: b.remove }); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/messages') { const b = await body(req); messageWorker(op, id, String(b.to || 'all'), String(b.text || '')); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/followup') { const b = await body(req); const child = await followUp(op, id, b); return json(res, 201, snapshot(child!.id)); }
      if (m === 'GET' && sub === '/report.csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="tasklatch-report-${id}.csv"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        return res.end(reportCsv(id));
      }
      if (m === 'POST' && sub === '/start') { start(op, id); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/stop') { await stop(op, id); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/resume') { resume(op, id); return json(res, 200, snapshot(id)); }
      if (m === 'POST' && sub === '/draft') { const b = await body(req); const r = reviseDraft(op, id, Number(b.quantity)); return json(res, 200, { result: r, snapshot: snapshot(id) }); }
      if (m === 'POST' && sub === '/verify') {
        const s = loadSession(id)!;
        if (s.scope.mode === 'web') await verifyReport(id);
        else {
          await verifyComparison(id);
          if (s.scope.expected_result !== 'comparison') await verifyDraft(id);
          if (s.scope.expected_result === 'submission') await verifySubmission(id);
        }
        emit(id, { actor: 'operator', kind: 'verification.rerun', provenance: 'operator_decision', summary: 'You re-ran verification' });
        if (['SUCCEEDED', 'PARTIAL', 'FAILED', 'NEEDS_VERIFICATION', 'CANCELLED', 'BUDGET_EXHAUSTED'].includes(s.status)) finalize(id);
        return json(res, 200, snapshot(id));
      }
      const subm = /^\/submissions\/([^/]+)\/(reconcile|retry)$/.exec(sub);
      if (m === 'POST' && subm) {
        if (subm[2] === 'reconcile') await reconcileSubmission(id, subm[1]); else await retryUncertain(id, subm[1]);
        return json(res, 200, snapshot(id));
      }
      if (m === 'POST' && sub === '/recording') {
        const b = await body(req);
        run('UPDATE sessions SET recording=? WHERE id=?', b.recording ? 1 : 0, id);
        emit(id, { actor: 'operator', kind: 'replay.setting', provenance: 'operator_decision', summary: `You turned screenshot recording ${b.recording ? 'on' : 'off'}` });
        return json(res, 200, snapshot(id));
      }
      if (m === 'DELETE' && sub === '/replay') {
        const n = deleteReplay(id);
        emit(id, { actor: 'operator', kind: 'replay.deleted', provenance: 'operator_decision', summary: `You deleted the private replay (${n} screenshots)` });
        return json(res, 200, snapshot(id));
      }
      const am = /^\/artifacts\/(art_[0-9a-f]{12})$/.exec(sub);
      if (m === 'GET' && am) {
        const a = readArtifact(id, am[1]);
        if (!a) return json(res, 404, { error: 'not_found' });
        // Agent-made files are served as data, never as pages: text types only, sandboxed, downloadable.
        const dl = url.searchParams.get('download') === '1';
        res.writeHead(200, { 'content-type': a.meta.media_type + '; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-sha256': a.meta.sha256, 'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox; default-src \'none\'', ...(dl ? { 'content-disposition': `attachment; filename="${path.basename(a.meta.rel_path).replace(/[^A-Za-z0-9._-]/g, '_')}"` } : {}) });
        return res.end(a.content);
      }
      const fm = /^\/screens\/([0-9]+-[a-z0-9-]+\.(png|jpg))$/.exec(sub);
      if (m === 'GET' && fm) {
        const c = containedPath(replayDir(id), fm[1]);
        if (!c.ok || !fs.existsSync(c.path)) return json(res, 404, { error: 'not_found' });
        res.writeHead(200, { 'content-type': fm[2] === 'jpg' ? 'image/jpeg' : 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(c.path).pipe(res);
      }
      if (m === 'GET' && sub === '/evidence') {
        const e = evidenceBundle(id);
        emit(id, { actor: 'operator', kind: 'evidence.exported', provenance: 'operator_decision', summary: `Evidence bundle exported (sha256 ${e.sha256.slice(0, 16)}…)` });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="tasklatch-evidence-${id}.json"`, 'cache-control': 'private, no-store' });
        return res.end(e.text);
      }
    }
    const ap = /^\/api\/approvals\/(apv_[0-9a-f]{12})\/decision$/.exec(p);
    if (m === 'POST' && ap) {
      const b = await body(req);
      if (!['approve', 'reject'].includes(b.decision)) throw new UserError(422, 'invalid_decision', 'Decision must be approve or reject.');
      const r = await operatorDecision(op.id, ap[1], b.decision, String(b.payload_hash || ''), b.note);
      return json(res, r.status, r);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (e: any) {
    if (e instanceof UserError) return json(res, e.status, { error: e.code, message: e.message });
    console.error('[controller]', e);
    return json(res, 500, { error: 'internal_error', message: 'Unexpected controller error.' });
  }
});

const recovered = recoverInterrupted();
removeOrphanDesktops().then(n => { if (n) console.log(`[controller] removed ${n} desktop container(s) left from a previous run`); });
const timer = setInterval(() => { try { tick(); } catch (e) { console.error('[tick]', e); } }, 2000);

server.listen(PORTS.controller, HOST, () => {
  const code = bootstrapCode('op_local');
  const link = `${CONTROLLER_ORIGIN}/auth/bootstrap?code=${code}`;
  fs.writeFileSync(path.join(RUNTIME_DIR, 'secrets', 'login-link.txt'), link + '\n', { mode: 0o600 });
  console.log(`[controller] TaskLatch on ${CONTROLLER_ORIGIN}  (${recovered} interrupted session(s) recovered)`);
  console.log(`[controller] One-time sign-in link (15 min): ${link}`);
  console.log(`[controller] Operator token file: .runtime/secrets/operator-op_local.token`);
});

async function shutdown() {
  clearInterval(timer);
  server.close();
  await shutdownBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
