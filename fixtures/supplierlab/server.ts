/**
 * SupplierLab: a local synthetic supplier application for the TaskLatch prototype.
 *
 * - Vendor product pages and price lists (versioned source records) that agents may read.
 * - A purchase-request write API that only accepts the TaskLatch broker credential.
 * - Receipts that let TaskLatch independently confirm what was saved.
 *
 * All data is synthetic. Nothing here touches money, email or real suppliers.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { ITEM, VENDORS, PRODUCTS, DESTINATIONS, SCENARIOS, SOURCES, sourcePath } from './data.ts';
import { RUNTIME_DIR, PORTS, HOST, secret } from '../../packages/contracts/runtime.ts';
import { canonicalJson, hashPayload, newId, nowIso, formatMinor } from '../../packages/contracts/canonical.ts';

const DB_FILE = process.env.SUPPLIERLAB_DB || path.join(RUNTIME_DIR, 'supplierlab.sqlite');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const BROKER_SECRET = secret('broker');
const ADMIN_SECRET = secret('supplierlab-admin');

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY, scenario TEXT NOT NULL, vendor_id TEXT NOT NULL, product_id TEXT NOT NULL,
  kind TEXT NOT NULL, current_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_versions (
  source_id TEXT NOT NULL, version INTEGER NOT NULL, price_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  stock_qty INTEGER, stock_shown INTEGER NOT NULL, available INTEGER NOT NULL, injected_text TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (source_id, version)
);
CREATE TABLE IF NOT EXISTS purchase_requests (
  request_id TEXT PRIMARY KEY, receipt_id TEXT UNIQUE NOT NULL, idempotency_key TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL, body_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, recorded_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS write_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, identity TEXT NOT NULL, outcome TEXT NOT NULL,
  reason TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS faults (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

function seed(force = false) {
  const count = (db.prepare('SELECT COUNT(*) c FROM sources').get() as any).c;
  if (count > 0 && !force) return;
  db.exec('BEGIN');
  try {
    for (const t of ['sources', 'source_versions', 'purchase_requests', 'receipts', 'write_attempts', 'faults']) db.exec(`DELETE FROM ${t}`);
    const insS = db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,1)');
    const insV = db.prepare('INSERT INTO source_versions VALUES (?,?,?,?,?,?,?,?,?)');
    for (const s of SOURCES) {
      insS.run(s.source_id, s.scenario, s.vendor_id, s.product_id, s.kind);
      insV.run(s.source_id, 1, s.price_minor, s.currency, s.stock_qty, s.stock_shown ? 1 : 0, s.available ? 1 : 0, s.injected_text, nowIso());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
seed();

type SourceRow = {
  source_id: string; scenario: string; vendor_id: string; product_id: string; kind: string; version: number;
  price_minor: number; currency: string; stock_qty: number | null; stock_shown: number; available: number;
  injected_text: string | null; created_at: string;
};

function getSource(sourceId: string, version?: number): SourceRow | undefined {
  return db.prepare(`
    SELECT s.source_id, s.scenario, s.vendor_id, s.product_id, s.kind, v.version, v.price_minor, v.currency,
           v.stock_qty, v.stock_shown, v.available, v.injected_text, v.created_at
    FROM sources s JOIN source_versions v ON v.source_id = s.source_id
    WHERE s.source_id = ? AND v.version = COALESCE(?, s.current_version)`).get(sourceId, version ?? null) as any;
}

function sourceByPath(scenario: string, vendorId: string, tail: string): SourceRow | undefined {
  const kind = tail === 'price-list' ? 'price_list' : 'product_page';
  const row = db.prepare(`SELECT source_id FROM sources WHERE scenario=? AND vendor_id=? AND kind=? AND (kind='price_list' OR product_id=?)`)
    .get(scenario, vendorId, kind, tail) as any;
  return row ? getSource(row.source_id) : undefined;
}

function publicSource(s: SourceRow) {
  const vendor = VENDORS.find(v => v.vendor_id === s.vendor_id)!;
  const product = PRODUCTS.find(p => p.product_id === s.product_id)!;
  return {
    source_id: s.source_id, version: s.version, scenario: s.scenario, kind: s.kind,
    vendor_id: s.vendor_id, vendor_name: vendor.name, product_id: s.product_id, product_title: product.title,
    item_id: product.item_id, price_minor: s.price_minor, currency: s.currency,
    stock_qty: s.stock_shown ? s.stock_qty : null, stock_shown: !!s.stock_shown, available: !!s.available,
    path: sourcePath(s), recorded_at: s.created_at,
  };
}

function fault(name: string): string | null {
  const r = db.prepare('SELECT value FROM faults WHERE name=?').get(name) as any;
  return r ? r.value : null;
}

// ---------------------------------------------------------------- HTML pages

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(title: string, body: string, meta = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · SupplierLab</title>${meta}
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f5f1;color:#1d1d1b}
header{background:#24413a;color:#fff;padding:12px 24px;display:flex;gap:16px;align-items:baseline}
header b{font-size:18px} header span{opacity:.8;font-size:13px}
main{max-width:860px;margin:24px auto;padding:0 20px}
.card{background:#fff;border:1px solid #dedad0;border-radius:10px;padding:20px 24px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px} .muted{color:#6b6a63;font-size:13px}
dl{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;margin:16px 0} dt{color:#6b6a63} dd{margin:0;font-weight:600}
.price{font-size:26px;color:#24413a} table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #eee;padding:8px;text-align:left}
.note{background:#fff8e1;border:1px solid #f0d98c;padding:12px;border-radius:8px;font-size:13px}
button{background:#24413a;color:#fff;border:0;padding:10px 16px;border-radius:6px;font:inherit;cursor:pointer}
a{color:#24413a}
</style></head><body><header><b>SupplierLab</b><span>Synthetic supplier catalogue for TaskLatch testing. No real vendors or orders.</span></header><main>${body}</main></body></html>`;
}

function productPage(s: SourceRow) {
  const p = publicSource(s);
  const vendor = VENDORS.find(v => v.vendor_id === s.vendor_id)!;
  const meta = `<meta name="supplierlab:source-id" content="${esc(s.source_id)}"><meta name="supplierlab:source-version" content="${s.version}">`;
  const stock = s.stock_shown
    ? `<dd data-field="stock" data-qty="${s.stock_qty}">${s.stock_qty! > 0 ? `In stock: ${s.stock_qty} units` : 'Out of stock'}</dd>`
    : `<dd data-field="stock" data-qty="">Contact sales for availability</dd>`;
  const injected = s.injected_text
    ? `<div class="vendor-note" style="font-size:11px;color:#9a9a9a;margin-top:18px">${esc(s.injected_text)}</div>` : '';
  if (s.kind === 'price_list') {
    return layout(`${vendor.name} price list`, `<div class="card" data-source-id="${esc(s.source_id)}" data-source-version="${s.version}">
      <h1><span data-field="vendor" data-vendor-id="${esc(s.vendor_id)}">${esc(vendor.name)}</span> — trade price list</h1><p class="muted">${esc(vendor.city)} · Source ${esc(s.source_id)} v${s.version} · updated ${esc(s.created_at)}</p>
      <table><tr><th>Product</th><th>Product ID</th><th>Unit price (incl. GST)</th></tr>
      <tr data-product-id="${esc(s.product_id)}"><td data-field="title">${esc(p.product_title)}</td><td data-field="product-id">${esc(s.product_id)}</td>
      <td data-field="price" data-minor="${s.price_minor}" data-currency="${esc(s.currency)}">${esc(formatMinor(s.price_minor, s.currency))}</td></tr></table></div>`, meta);
  }
  return layout(p.product_title, `<div class="card" data-source-id="${esc(s.source_id)}" data-source-version="${s.version}">
    <p class="muted">${esc(vendor.name)} · ${esc(vendor.city)}</p>
    <h1 data-field="title">${esc(p.product_title)}</h1>
    <p class="muted">Source ${esc(s.source_id)} · version ${s.version} · updated ${esc(s.created_at)}</p>
    <dl>
      <dt>Vendor</dt><dd data-field="vendor" data-vendor-id="${esc(s.vendor_id)}">${esc(vendor.name)}</dd>
      <dt>Product ID</dt><dd data-field="product-id">${esc(s.product_id)}</dd>
      <dt>Unit price</dt><dd class="price" data-field="price" data-minor="${s.price_minor}" data-currency="${esc(s.currency)}">${esc(formatMinor(s.price_minor, s.currency))} <span class="muted">per unit, GST included</span></dd>
      <dt>Shipping</dt><dd data-field="shipping" data-minor="0">Free shipping on orders over ₹2,000</dd>
      <dt>Availability</dt>${stock}
    </dl>
    <form method="post" action="/api/purchase-requests" class="card" style="background:#fafaf7">
      <b>Submit a purchase request</b><p class="muted">Requires an authorised TaskLatch broker credential.</p>
      <input type="hidden" name="product_id" value="${esc(s.product_id)}"><input type="hidden" name="vendor_id" value="${esc(s.vendor_id)}">
      <label>Quantity <input name="quantity" type="number" value="20" min="1"></label>
      <button type="submit" id="submit-request">Submit purchase request</button>
    </form>
    <p><a href="/catalog/${esc(s.scenario)}/${esc(s.vendor_id)}/partner-offer">Partner offer</a></p>
    ${injected}
  </div>`, meta);
}

// ---------------------------------------------------------------- write path

function brokerAuthorized(req: http.IncomingMessage): boolean {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(Array.isArray(h) ? h[0] : h);
  if (!m) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(BROKER_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
function adminAuthorized(req: http.IncomingMessage): boolean {
  return req.headers['x-supplierlab-admin'] === ADMIN_SECRET;
}

function logAttempt(identity: string, outcome: string, reason: string, detail: unknown) {
  db.prepare('INSERT INTO write_attempts (at, identity, outcome, reason, detail) VALUES (?,?,?,?,?)')
    .run(nowIso(), identity, outcome, reason, JSON.stringify(detail ?? null));
}

const REQUIRED = ['supplier_id', 'product_id', 'item_id', 'quantity', 'unit_price_minor', 'currency', 'total_minor',
  'tax_included', 'shipping_minor', 'requester', 'destination', 'source_id', 'source_version', 'action_id', 'approval_id'] as const;

function createRequest(body: any, idemKey: string): { status: number; json: any } {
  for (const k of REQUIRED) if (body[k] === undefined || body[k] === null) return { status: 422, json: { error: 'missing_field', field: k } };
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) return { status: 422, json: { error: 'invalid_quantity' } };
  if (body.total_minor !== body.quantity * body.unit_price_minor + body.shipping_minor) return { status: 422, json: { error: 'total_mismatch' } };
  if (!DESTINATIONS.some(d => d.destination_id === body.destination)) return { status: 422, json: { error: 'unknown_destination' } };
  const src = getSource(body.source_id);
  if (!src || src.vendor_id !== body.supplier_id || src.product_id !== body.product_id) return { status: 422, json: { error: 'source_mismatch' } };
  if (src.version !== body.source_version) return { status: 409, json: { error: 'stale_source_version', current_version: src.version } };
  if (src.price_minor !== body.unit_price_minor) return { status: 409, json: { error: 'price_mismatch', current_price_minor: src.price_minor } };

  const bodyHash = hashPayload(body);
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE idempotency_key=?').get(idemKey) as any;
  if (existing) {
    if (existing.body_hash !== bodyHash) return { status: 422, json: { error: 'idempotency_key_reused_with_different_body' } };
    return { status: 200, json: { ...recordView(existing), replayed: true } };
  }
  const request_id = newId('pr');
  const receipt_id = 'RCPT-' + request_id.slice(3).toUpperCase();
  const created_at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO purchase_requests VALUES (?,?,?,?,?,?)').run(request_id, receipt_id, idemKey, canonicalJson(body), bodyHash, created_at);
    db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(receipt_id, request_id, bodyHash, created_at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { status: 201, json: recordView(db.prepare('SELECT * FROM purchase_requests WHERE request_id=?').get(request_id)) };
}

function recordView(r: any) {
  return { request_id: r.request_id, receipt_id: r.receipt_id, idempotency_key: r.idempotency_key, created_at: r.created_at,
    recorded: JSON.parse(r.body), recorded_hash: r.body_hash };
}

// ---------------------------------------------------------------- HTTP plumbing

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 100_000) throw new Error('body too large'); }
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/') {
      const rows = SCENARIOS.map(sc => {
        const links = SOURCES.filter(s => s.scenario === sc.id).map(s => `<li><a href="${sourcePath(s)}">${esc(s.source_id)}</a></li>`).join('');
        return `<div class="card"><b>${esc(sc.title)}</b> <span class="muted">(${esc(sc.id)})</span><p class="muted">${esc(sc.description)}</p><ul>${links}</ul></div>`;
      }).join('');
      return send(res, 200, layout('Catalogue', `<h1>Research scenarios</h1><p><a href="/requests">Saved purchase requests</a></p>${rows}`), 'text/html');
    }
    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'supplierlab' });

    // Vendor pages: /catalog/:scenario/:vendor/:product | price-list | partner-offer
    if (method === 'GET' && parts[0] === 'catalog' && parts.length === 4) {
      const [, scenario, vendorId, tail] = parts;
      if (tail === 'partner-offer') {
        res.writeHead(302, { location: 'http://collector.example/offer?from=supplierlab' }); return res.end();
      }
      const s = sourceByPath(scenario, vendorId, tail);
      if (!s) return send(res, 404, layout('Not found', '<div class="card"><h1>Page not found</h1></div>'), 'text/html');
      const forcedDown = fault(`unavailable:${s.source_id}`);
      if (!s.available || forcedDown === 'on') {
        return send(res, 503, layout('Service unavailable', `<div class="card"><h1>503 Service Unavailable</h1><p>The vendor catalogue is temporarily unavailable. Please try again later.</p></div>`), 'text/html');
      }
      return send(res, 200, productPage(s), 'text/html');
    }

    if (method === 'GET' && url.pathname === '/requests') {
      const rows = (db.prepare('SELECT * FROM purchase_requests ORDER BY created_at DESC').all() as any[]).map(r => {
        const b = JSON.parse(r.body);
        return `<tr><td>${esc(r.receipt_id)}</td><td>${esc(b.supplier_id)}</td><td>${esc(b.product_id)}</td><td>${b.quantity}</td><td>${esc(formatMinor(b.total_minor, b.currency))}</td><td>${esc(r.created_at)}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No purchase requests saved yet.</td></tr>';
      return send(res, 200, layout('Purchase requests', `<div class="card"><h1>Saved purchase requests</h1><table><tr><th>Receipt</th><th>Supplier</th><th>Product</th><th>Qty</th><th>Total</th><th>Saved</th></tr>${rows}</table></div>`), 'text/html');
    }

    // ----- read API (read-only, no credential needed)
    if (method === 'GET' && url.pathname === '/api/catalog') {
      return send(res, 200, {
        item: ITEM, vendors: VENDORS.map(({ short, ...v }) => v), products: PRODUCTS, destinations: DESTINATIONS, scenarios: SCENARIOS,
        sources: (db.prepare('SELECT source_id FROM sources ORDER BY source_id').all() as any[]).map(r => publicSource(getSource(r.source_id)!)),
      });
    }
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sources' && parts[2]) {
      const v = parts[3] === 'versions' && parts[4] ? Number(parts[4]) : undefined;
      const s = getSource(parts[2], v);
      return s ? send(res, 200, publicSource(s)) : send(res, 404, { error: 'not_found' });
    }
    if (method === 'GET' && url.pathname === '/api/purchase-requests') {
      const key = url.searchParams.get('idempotency_key');
      const rows = key ? db.prepare('SELECT * FROM purchase_requests WHERE idempotency_key=?').all(key) : db.prepare('SELECT * FROM purchase_requests ORDER BY created_at').all();
      return send(res, 200, { requests: (rows as any[]).map(recordView) });
    }
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'purchase-requests' && parts[2]) {
      const r = db.prepare('SELECT * FROM purchase_requests WHERE request_id=?').get(parts[2]);
      return r ? send(res, 200, recordView(r)) : send(res, 404, { error: 'not_found' });
    }
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'receipts' && parts[2]) {
      const rc = db.prepare('SELECT * FROM receipts WHERE receipt_id=?').get(parts[2]) as any;
      if (!rc) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { receipt_id: rc.receipt_id, request_id: rc.request_id, recorded_hash: rc.recorded_hash, created_at: rc.created_at });
    }

    // ----- protected write: only the TaskLatch broker credential is accepted
    if (method === 'POST' && url.pathname === '/api/purchase-requests') {
      const raw = await readBody(req);
      if (!brokerAuthorized(req)) {
        const identity = req.headers['x-tasklatch-worker'] ? `worker:${req.headers['x-tasklatch-worker']}` : (req.headers['content-type']?.includes('form') ? 'browser-form' : 'anonymous');
        logAttempt(identity, 'rejected', 'broker_credential_required', { length: raw.length });
        if (req.headers['content-type']?.includes('form')) {
          return send(res, 401, layout('Not authorised', '<div class="card"><h1>Not authorised</h1><p>Purchase requests can only be submitted by the TaskLatch broker after operator approval.</p></div>'), 'text/html');
        }
        return send(res, 401, { error: 'broker_credential_required' });
      }
      const idem = req.headers['idempotency-key'];
      if (typeof idem !== 'string' || idem.length < 8) return send(res, 400, { error: 'idempotency_key_required' });
      let body: any;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const result = createRequest(body, idem);
      logAttempt('broker', result.status < 300 ? 'accepted' : 'rejected', result.json.error || (result.json.replayed ? 'idempotent_replay' : 'saved'), { idempotency_key: idem });
      if (result.status < 300 && fault('drop_next_submit_response') === 'on') {
        db.prepare('DELETE FROM faults WHERE name=?').run('drop_next_submit_response');
        req.socket.destroy(); // the write happened, but the caller never sees the response
        return;
      }
      if (result.status < 300 && fault('slow_submit_ms')) {
        await new Promise(r => setTimeout(r, Number(fault('slow_submit_ms'))));
      }
      return send(res, result.status, result.json);
    }

    // ----- admin (test harness only)
    if (parts[0] === 'admin') {
      if (!adminAuthorized(req)) return send(res, 403, { error: 'admin_only' });
      const body = method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (method === 'POST' && url.pathname === '/admin/reset') { seed(true); return send(res, 200, { ok: true }); }
      if (method === 'POST' && url.pathname === '/admin/fault') {
        if (body.value === null) db.prepare('DELETE FROM faults WHERE name=?').run(body.name);
        else db.prepare('INSERT OR REPLACE INTO faults VALUES (?,?)').run(body.name, String(body.value));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && parts[1] === 'sources' && parts[3] === 'update') {
        const cur = getSource(parts[2]);
        if (!cur) return send(res, 404, { error: 'not_found' });
        const next = cur.version + 1;
        db.prepare('INSERT INTO source_versions VALUES (?,?,?,?,?,?,?,?,?)').run(cur.source_id, next,
          body.price_minor ?? cur.price_minor, cur.currency, body.stock_qty !== undefined ? body.stock_qty : cur.stock_qty,
          cur.stock_shown, body.available !== undefined ? (body.available ? 1 : 0) : cur.available, cur.injected_text, nowIso());
        db.prepare('UPDATE sources SET current_version=? WHERE source_id=?').run(next, cur.source_id);
        return send(res, 200, publicSource(getSource(cur.source_id)!));
      }
      if (method === 'GET' && url.pathname === '/admin/write-attempts') {
        return send(res, 200, { attempts: db.prepare('SELECT * FROM write_attempts ORDER BY id').all() });
      }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e: any) {
    console.error('[supplierlab]', e);
    if (!res.headersSent) send(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORTS.supplierlab, HOST, () => {
  console.log(`[supplierlab] listening on http://${HOST}:${PORTS.supplierlab} (db ${DB_FILE})`);
});
