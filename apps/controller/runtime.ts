/**
 * Local browser desktops. Each worker gets its own Chromium browser context (separate cookies,
 * storage and cache) bound to one task session. Every top-level navigation, redirect and request
 * is checked against the policy engine before it leaves the browser.
 *
 * Disclosure: these are headless Chromium contexts on this machine, not separate Linux containers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { SUPPLIERLAB_ORIGIN } from '../../packages/contracts/runtime.ts';
import { replayDir } from './storage.ts';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

export function findChromium(): string | null {
  if (process.env.TASKLATCH_CHROMIUM && fs.existsSync(process.env.TASKLATCH_CHROMIUM)) return process.env.TASKLATCH_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const candidates = [
          path.join(base, sub, 'chrome-headless-shell'),
          path.join(base, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
          path.join(base, sub, 'chrome'),
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
      }
    }
  }
  // Playwright's own default location for this platform (covers Windows and Linux installs made with
  // `npx playwright-core install chromium`), then an installed Google Chrome or Chromium.
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* not installed */ }
  const system = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const c of system) if (c && fs.existsSync(c)) return c;
  return null;
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    const exe = findChromium();
    if (!exe) throw new Error('No Chromium executable found. Set TASKLATCH_CHROMIUM or install Playwright browsers.');
    launching = chromium.launch({ executablePath: exe, args: ['--disable-extensions', '--no-first-run'] })
      .then(b => { browser = b; launching = null; b.on('disconnected', () => { browser = null; }); return b; })
      .catch(e => { launching = null; throw e; });
  }
  return launching;
}

export type Gate = (kind: 'navigate' | 'redirect' | 'subrequest' | 'form_post', url: string) => { allowed: boolean; reason: string };

export type PageObservation = {
  url: string; http_status: number | null; title: string; text: string;
  meta: Record<string, string>; fields: Record<string, { text: string; attrs: Record<string, string> }>;
  links: { text: string; href: string }[];
};

export class Desktop {
  context: BrowserContext | null = null;
  page: Page | null = null;
  lastStatus: number | null = null;
  blocked: { url: string; reason: string }[] = [];
  sessionId: string; workerId: string; private gate: Gate; private recording: () => boolean;
  constructor(sessionId: string, workerId: string, gate: Gate, recording: () => boolean) {
    this.sessionId = sessionId; this.workerId = workerId; this.gate = gate; this.recording = recording;
  }

  async open() {
    const b = await getBrowser();
    this.context = await b.newContext({ viewport: { width: 1100, height: 760 }, userAgent: `TaskLatch-Worker/${this.workerId}`, acceptDownloads: false });
    // Every request leaving this desktop is checked. Redirects are resolved manually so each hop is assessed.
    await this.context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      const isDoc = req.isNavigationRequest();
      const isPost = req.method() !== 'GET';
      const g = this.gate(isPost ? 'form_post' : isDoc ? 'navigate' : 'subrequest', url);
      if (!g.allowed) {
        this.blocked.push({ url, reason: g.reason });
        if (isDoc) return route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: blockedPage(url, g.reason) });
        return route.abort('blockedbyclient');
      }
      if (!isDoc) return route.continue();
      try {
        const resp = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        const loc = resp.headers()['location'];
        if (resp.status() >= 300 && resp.status() < 400 && loc) {
          const next = new URL(loc, url).toString();
          const g2 = this.gate('redirect', next);
          if (!g2.allowed) {
            this.blocked.push({ url: next, reason: g2.reason });
            return route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: blockedPage(next, `Redirect blocked: ${g2.reason}`) });
          }
        }
        return route.fulfill({ response: resp });
      } catch (e: any) {
        return route.abort('failed');
      }
    });
    this.page = await this.context.newPage();
  }

  async goto(url: string, signal?: AbortSignal): Promise<{ status: number | null; blocked: boolean }> {
    if (!this.page) throw new Error('desktop not open');
    const before = this.blocked.length;
    const resp = await Promise.race([
      this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      new Promise<null>((_, rej) => signal?.addEventListener('abort', () => rej(new Error('stopped')), { once: true })),
    ]);
    this.lastStatus = resp?.status() ?? null;
    return { status: this.lastStatus, blocked: this.blocked.length > before };
  }

  async observe(): Promise<PageObservation> {
    const p = this.page!;
    const data = await p.evaluate(() => {
      const meta: Record<string, string> = {};
      document.querySelectorAll('meta[name^="supplierlab:"]').forEach(m => { meta[m.getAttribute('name')!] = m.getAttribute('content') || ''; });
      const fields: Record<string, { text: string; attrs: Record<string, string> }> = {};
      document.querySelectorAll('[data-field]').forEach(el => {
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) attrs[a.name.slice(5)] = a.value;
        const key = el.getAttribute('data-field')!;
        if (!fields[key]) fields[key] = { text: (el as HTMLElement).innerText.trim(), attrs };
      });
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({ text: (a as HTMLElement).innerText.trim(), href: (a as HTMLAnchorElement).href }));
      return { title: document.title, text: document.body ? document.body.innerText.slice(0, 6000) : '', meta, fields, links };
    });
    return { url: p.url(), http_status: this.lastStatus, ...data };
  }

  /** Save a screenshot into the session's private replay folder (if recording is on). */
  async screenshot(label: string): Promise<string | null> {
    if (!this.page || !this.recording()) return null;
    const name = `${Date.now()}-${this.workerId}-${label.replace(/[^a-z0-9-]/gi, '').slice(0, 24)}.png`;
    const file = path.join(replayDir(this.sessionId), name);
    await this.page.screenshot({ path: file, type: 'png' });
    return name;
  }

  async clickSubmitForm(signal?: AbortSignal) {
    const p = this.page!;
    const btn = await p.$('#submit-request');
    if (!btn) return { status: null as number | null };
    const respP = p.waitForResponse(r => r.request().method() === 'POST', { timeout: 8000 }).catch(() => null);
    await btn.click({ timeout: 5000 }).catch(() => null);
    const resp = await respP;
    return { status: resp ? resp.status() : null };
  }

  async close() {
    const c = this.context; this.context = null; this.page = null;
    if (c) await c.close().catch(() => {});
  }
}

function blockedPage(url: string, reason: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<!doctype html><html><body style="font:16px system-ui;background:#2b1b1b;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
  <div style="max-width:640px;padding:24px;border:2px solid #e57373;border-radius:12px"><h2 style="margin-top:0">⛔ Blocked by TaskLatch</h2>
  <p><b>Destination:</b> ${esc(url)}</p><p><b>Reason:</b> ${esc(reason)}</p></div></body></html>`;
}

export async function shutdownBrowser() {
  const b = browser; browser = null;
  if (b) await b.close().catch(() => {});
}

export async function probeBrowser(): Promise<{ ok: boolean; detail: string }> {
  const exe = findChromium();
  if (!exe) return { ok: false, detail: 'No Chromium executable found.' };
  try {
    const b = await getBrowser();
    return { ok: true, detail: `Headless Chromium ${b.version()} (${path.basename(exe)}); each worker uses its own browser context.` };
  } catch (e: any) { return { ok: false, detail: e.message }; }
}

export const SUPPLIERLAB = SUPPLIERLAB_ORIGIN;
