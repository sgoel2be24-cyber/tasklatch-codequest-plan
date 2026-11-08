/**
 * Container desktops: one disposable Linux desktop (Docker, in the dedicated `tasklatch` Colima VM)
 * per agent. The controller holds the control token; the model never talks to the desktop directly.
 * Live view is noVNC, published on host loopback only and protected by a per-desktop password.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_DIR, REPO_ROOT } from '../../packages/contracts/runtime.ts';
import { EgressProxy, type EgressGate } from './egress.ts';

export const DESKTOP_IMAGE = process.env.TASKLATCH_DESKTOP_IMAGE || 'tasklatch-desktop:1';
const DOCKER_HOST = process.env.TASKLATCH_DOCKER_HOST || `unix://${path.join(os.homedir(), '.colima', 'tasklatch', 'docker.sock')}`;
const DOCKER_CONFIG = path.join(RUNTIME_DIR, 'docker-config');

function dockerEnv() {
  fs.mkdirSync(DOCKER_CONFIG, { recursive: true });
  const cfg = path.join(DOCKER_CONFIG, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, '{}');
  return { ...process.env, DOCKER_HOST, DOCKER_CONFIG };
}

export function docker(args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { env: dockerEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout.trim());
    });
  });
}

export async function probeDesktops(): Promise<{ ok: boolean; detail: string }> {
  try {
    const info = await docker(['info', '--format', '{{.Architecture}} {{.NCPU}} {{.MemTotal}}'], 8000);
    const [arch, cpu, mem] = info.split(' ');
    try { await docker(['image', 'inspect', DESKTOP_IMAGE, '--format', '{{.Id}}'], 8000); }
    catch { return { ok: false, detail: `Docker VM is running (${arch}, ${cpu} CPU) but the desktop image ${DESKTOP_IMAGE} is not built. Run: npm run desktop:build` }; }
    return { ok: true, detail: `Linux desktops in Docker (Colima “tasklatch”, ${arch}, ${cpu} CPU, ${(Number(mem) / 2 ** 30).toFixed(1)} GiB). Up to 4 at once, each with its own Chromium, files and proxy port.` };
  } catch (e: any) {
    return { ok: false, detail: `Desktop VM not reachable (${e.message}). Start it with: colima start tasklatch` };
  }
}

export type Observation = {
  url: string | null; title: string | null; text: string; screenshot: string | null; screenshot_scale?: number;
  elements: { id: number; tag: string; type: string; label: string; x: number; y: number; w: number; h: number }[];
  scroll?: { y: number; max: number }; error?: string;
};

export class ContainerDesktop {
  sessionId: string; workerId: string;
  name: string; token = randomBytes(18).toString('hex'); vncPassword = randomBytes(6).toString('hex');
  controlPort = 0; vncPort = 0; proxy: EgressProxy; containerId: string | null = null;
  startedAt: number | null = null; stoppedAt: number | null = null;

  constructor(sessionId: string, workerId: string, gate: EgressGate) {
    this.sessionId = sessionId; this.workerId = workerId;
    this.name = `tl-${sessionId.slice(4)}-${workerId}`;
    this.proxy = new EgressProxy(gate);
  }

  get base() { return `http://127.0.0.1:${this.controlPort}`; }
  get liveUrl() {
    return this.vncPort ? `http://127.0.0.1:${this.vncPort}/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1&password=${this.vncPassword}` : null;
  }

  async start(startUrl = 'about:blank', signal?: AbortSignal) {
    const proxyPort = await this.proxy.listen(0);
    await docker(['rm', '-f', this.name], 15000).catch(() => {});
    this.containerId = await docker(['run', '-d', '--name', this.name,
      '--label', 'tasklatch=1', '--label', `tasklatch.session=${this.sessionId}`, '--label', `tasklatch.worker=${this.workerId}`,
      '-e', `TL_DESKTOP_TOKEN=${this.token}`, '-e', `TL_VNC_PASSWORD=${this.vncPassword}`, '-e', `TL_PROXY_PORT=${proxyPort}`, '-e', `TL_START_URL=${startUrl}`,
      '-p', '127.0.0.1::6080', '-p', '127.0.0.1::8000',
      '--memory', '1536m', '--cpus', '1', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--shm-size', '512m',
      DESKTOP_IMAGE], 60000);
    this.controlPort = Number((await docker(['port', this.containerId, '8000'])).split('\n')[0].split(':').pop());
    this.vncPort = Number((await docker(['port', this.containerId, '6080'])).split('\n')[0].split(':').pop());
    for (let i = 0; i < 80; i++) {
      if (signal?.aborted) throw new Error('stopped');
      try { if ((await fetch(this.base + '/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* booting */ }
      await new Promise(r => setTimeout(r, 250));
    }
    // Give Chromium a moment to open its first page.
    for (let i = 0; i < 40; i++) {
      const p = await this.page().catch(() => null);
      if (p?.url) break;
      await new Promise(r => setTimeout(r, 250));
    }
    this.startedAt = Date.now();
  }

  private async call(pathname: string, init: RequestInit = {}, timeoutMs = 20000) {
    const r = await fetch(this.base + pathname, { ...init, headers: { ...(init.headers || {}), 'X-TL-Token': this.token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`desktop ${pathname} HTTP ${r.status}`);
    return r;
  }
  async observe(): Promise<Observation> { return (await this.call('/observe', {}, 30000)).json() as any; }
  async page(): Promise<{ url: string | null; title: string | null; text: string }> { return (await this.call('/page')).json() as any; }
  async screenshotPng(): Promise<Buffer> { return Buffer.from(await (await this.call('/screenshot')).arrayBuffer()); }
  async act(a: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    return (await this.call('/action', { method: 'POST', body: JSON.stringify(a) }, 60000)).json() as any;
  }

  /** Remove the container and confirm it is gone. Returns true when docker no longer lists it. */
  async stop(): Promise<boolean> {
    await docker(['rm', '-f', this.name], 20000).catch(() => {});
    await this.proxy.close().catch(() => {});
    this.stoppedAt = Date.now();
    const left = await docker(['ps', '-a', '--filter', `name=^${this.name}$`, '--format', '{{.ID}}']).catch(() => '');
    return left === '';
  }
}

/** On controller start: remove desktops left over from a previous run (their sessions are interrupted). */
export async function removeOrphanDesktops(): Promise<number> {
  try {
    const ids = (await docker(['ps', '-a', '--filter', 'label=tasklatch=1', '--format', '{{.ID}}'], 8000)).split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids], 30000);
    return ids.length;
  } catch { return 0; }
}

export const DESKTOP_BUILD_HINT = `docker build -t ${DESKTOP_IMAGE} ${path.relative(process.cwd(), path.join(REPO_ROOT, 'docker/desktop'))}`;
