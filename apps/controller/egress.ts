/**
 * Egress proxy: every request from an agent desktop's browser passes through here, on a port that
 * identifies the desktop. Plain HTTP requests are checked by method and full URL (so a browser form
 * post to a protected endpoint is refused). HTTPS is checked by destination host (CONNECT); the proxy
 * does not decrypt it. Each hop of a redirect arrives as a new request and is checked again.
 *
 * Disclosure: enforcement is at the browser's proxy setting, which is fixed by launch flags and
 * managed policy in the desktop image. The container's network is not firewalled separately.
 */
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateIp } from './netguard.ts';

export type EgressRequest = { kind: 'http' | 'connect'; method: string; url: string; host: string; port: number; isPage: boolean };
/** privateOk: the operator listed this host by name, so it may resolve to a private address (for example SupplierLab on loopback). */
export type EgressGate = (r: EgressRequest) => { allowed: boolean; reason: string; privateOk?: boolean };

/**
 * Resolve once and connect to that address, so a public-looking name cannot be re-pointed at a private
 * address (DNS rebinding) between the check and the connection.
 */
async function resolveChecked(host: string, privateOk: boolean): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  try {
    const bare = host.replace(/^\[|\]$/g, '');
    const address = net.isIP(bare) ? bare : (await dns.lookup(bare)).address;
    if (isPrivateIp(address) && !privateOk) return { ok: false, reason: `${host} resolves to a private network address (${address}); only sites you list by name may do that.` };
    return { ok: true, address };
  } catch (e: any) {
    return { ok: false, reason: `Could not resolve ${host}: ${e.code || e.message}` };
  }
}

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

function blockedHtml(url: string, reason: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blocked by TaskLatch</title></head>
<body style="font:16px system-ui;background:#2b1b1b;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:640px;padding:24px;border:2px solid #e57373;border-radius:12px"><h2 style="margin-top:0">Blocked by TaskLatch</h2>
<p><b>Destination:</b> ${esc(url)}</p><p><b>Reason:</b> ${esc(reason)}</p></div></body></html>`;
}

export class EgressProxy {
  server: http.Server;
  port = 0;
  sockets = new Set<net.Socket>();
  stats = { allowed: 0, blocked: 0, lastPage: null as string | null };

  constructor(gate: EgressGate) {
    this.server = http.createServer(async (req, res) => {
      let target: URL;
      try { target = new URL(req.url || ''); } catch { res.writeHead(400); return res.end('absolute URL required'); }
      const isPage = (req.headers['accept'] || '').includes('text/html');
      const g = gate({ kind: 'http', method: req.method || 'GET', url: target.toString(), host: target.hostname, port: Number(target.port || 80), isPage });
      if (!g.allowed) {
        this.stats.blocked++;
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(blockedHtml(target.toString(), g.reason));
      }
      const r = await resolveChecked(target.hostname, !!g.privateOk);
      if (!r.ok) {
        this.stats.blocked++;
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(blockedHtml(target.toString(), r.reason));
      }
      this.stats.allowed++;
      if (isPage && req.method === 'GET') this.stats.lastPage = target.toString();
      const headers: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
      headers.host = target.host;
      const up = http.request({ host: r.address, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers, timeout: 20000 }, (ur) => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(ur.statusCode || 502, out);
        ur.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
      up.on('timeout', () => up.destroy());
      req.pipe(up);
    });

    this.server.on('connect', async (req, client: net.Socket, head) => {
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(req.url || '');
      const host = m?.[1] ?? ''; const port = Number(m?.[2] || 443);
      client.on('error', () => client.destroy());
      const g = gate({ kind: 'connect', method: 'CONNECT', url: `https://${host}${port === 443 ? '' : ':' + port}/`, host, port, isPage: true });
      if (!g.allowed) {
        this.stats.blocked++;
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by TaskLatch: ${g.reason}\r\n`);
        return;
      }
      const r = await resolveChecked(host, !!g.privateOk);
      if (!r.ok) {
        this.stats.blocked++;
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by TaskLatch: ${r.reason}\r\n`);
        return;
      }
      this.stats.allowed++;
      const upstream = net.connect(port, r.address, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      const kill = () => { upstream.destroy(); client.destroy(); };
      upstream.on('error', kill); client.on('error', kill);
      this.sockets.add(client); client.on('close', () => this.sockets.delete(client));
    });
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }

  /** Listens on loopback; Lima forwards host.docker.internal:<port> from containers to it. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = (this.server.address() as net.AddressInfo).port; resolve(this.port); });
    });
  }

  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise<void>(r => this.server.close(() => r()));
  }
}
