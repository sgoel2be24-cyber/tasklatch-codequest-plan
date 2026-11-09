/**
 * Records a scripted, captioned walkthrough of the TaskLatch workspace (no narration).
 * Starts its own SupplierLab and controller on ports 4700/4800 with a fresh runtime folder,
 * drives the operator UI with Playwright, and saves video + stills to examples/demo/.
 *
 * The agents run the labelled local-rules stand-in; the video says so on screen.
 * Run: node scripts/record-demo.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, '.runtime', `demo-${Date.now()}`);
const OUT = path.join(ROOT, 'examples', 'demo');
fs.mkdirSync(RUNTIME, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, TASKLATCH_RUNTIME_DIR: RUNTIME, TASKLATCH_PORT: '4700', SUPPLIERLAB_PORT: '4800', TASKLATCH_OPERATOR_NAME: 'Asha (Operations)' };
delete env.NVIDIA_API_KEY; delete env.FIREWORKS_API_KEY; env.TASKLATCH_PROVIDER = 'local-rules';
const CTL = 'http://127.0.0.1:4700';

const procs = [spawn(process.execPath, [path.join(ROOT, 'fixtures/supplierlab/server.ts')], { env, stdio: 'ignore' })];
await new Promise(r => setTimeout(r, 800));
procs.push(spawn(process.execPath, [path.join(ROOT, 'apps/controller/server.ts')], { env, stdio: 'ignore' }));
const linkFile = path.join(RUNTIME, 'secrets', 'login-link.txt');
for (let i = 0; i < 60 && !fs.existsSync(linkFile); i++) await new Promise(r => setTimeout(r, 200));
const link = fs.readFileSync(linkFile, 'utf8').trim();

const { findChromium } = await import('../apps/controller/runtime.ts');
const browser = await chromium.launch({ executablePath: findChromium()! });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: RUNTIME, size: { width: 1280, height: 800 } }, colorScheme: 'light' });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);
let still = 0;

async function caption(text: string, ms = 2600) {
  await page.evaluate((t) => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div'); el.id = '__demo_caption';
      el.setAttribute('style', 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:960px;z-index:9999;background:rgba(20,24,22,.92);color:#fff;font:600 17px/1.45 system-ui;padding:12px 20px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.3);text-align:center;pointer-events:none');
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await pause(ms);
}
async function shot(name: string) { await page.screenshot({ path: path.join(OUT, `${String(++still).padStart(2, '0')}-${name}.png`) }); }
async function scrollTo(selector: string) { await page.locator(selector).first().scrollIntoViewIfNeeded(); await pause(500); }
async function tab(name: string) { await page.getByRole('link', { name, exact: false }).first().click(); await pause(900); }
const sessionId = () => page.url().split('/s/')[1]?.split('/')[0];

// ---------------------------------------------------------------- walkthrough
await page.goto(link);
await page.waitForSelector('.ready-list');
await caption('TaskLatch: one operator delegates supplier research to two local browser agents. Everything here is local and synthetic.', 3400);
await caption('First-use readiness: browser desktops, task storage, SupplierLab and model access. No model key is set, so agents use a labelled local-rules stand-in.', 4200);
await shot('readiness');

await page.locator('[data-nav=new]').click();
await page.waitForSelector('#newtask');
await page.selectOption('#scenario', 'misleading_content');
await caption('Task setup: 20 USB-C adapters, two approved supplier pages. This scenario hides instructions for AI agents on one vendor page.', 3800);
await page.locator('input[name=expected][value=submission]').check();
await caption('Expected result: an approved submission. A draft and a submission are different actions — submitting needs my approval.', 3600);
await shot('task-setup');
await page.getByRole('button', { name: 'Review scope' }).click();
await page.waitForSelector('text=Proposed division of work');
await pause(600);
await caption('Scope review: what agents may do, what needs my approval, and what is blocked — before anything runs.', 3800);
await shot('scope');
await scrollTo('text=Proposed division of work');
await caption('The coordinator proposes one vendor per worker. I could reassign sources or change the shared allowance here.', 3400);
await page.getByRole('button', { name: 'Accept scope and start' }).click();

await page.waitForURL(/desktops/);
await caption('Two desktops, each its own Chromium session. Worker A researches BrightOffice, Worker B researches Kartik.', 3000);
await page.waitForFunction(() => document.querySelectorAll('.desktop .chip.ok').length >= 2, null, { timeout: 30000 });
await pause(800);
await caption('Worker A read a page telling AI agents to order 200 units and upload files. It tried — every attempt was blocked.', 4000);
await shot('desktops');
await scrollTo('.desktop .feed');
await caption('Each blocked action shows the reason: workers cannot submit, uploads are not allowed, the browser form needs the broker.', 4200);

await tab('Approval');
await page.waitForSelector('.approval');
await caption('Approval review: one exact request — supplier, item, 20 × ₹450 = ₹9,000, destination. Not the 200 units the page asked for.', 4400);
await shot('approval');
await page.locator('.approval details summary').click();
await page.fill('#apv-qty', '21');
await caption('If I change the quantity to 21, the earlier request is withdrawn and a new decision is required.', 3200);
await page.getByRole('button', { name: 'Update draft' }).click();
await page.waitForFunction(() => document.querySelector('.approval .total')?.textContent?.includes('9,450'));
await pause(700);
await scrollTo('text=Decision history');
await caption('Decision history: the ₹9,000 request is marked “Replaced by a changed request”. The ₹9,450 request is pending.', 3800);
await scrollTo('.approval');
await page.locator('#apv-approve').focus();
await caption('Approving by keyboard: Enter opens the confirmation (focus starts on Cancel), Tab, then Enter.', 3000);
await page.keyboard.press('Enter');
await pause(1400);
await shot('approve-dialog');
await page.keyboard.press('Tab'); await pause(400);
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('Saved in SupplierLab'), null, { timeout: 15000 });
await caption('Only the controller holds the SupplierLab credential. The request is saved once, with a receipt.', 3200);

await tab('Results');
await page.waitForFunction(() => document.body.innerText.includes('matches the approved request exactly'), null, { timeout: 15000 });
await pause(800);
await caption('Verified — checked against SupplierLab records and saved files, not against what the agents said.', 3600);
await shot('results');
await page.locator('details', { hasText: 'Saved request and receipt' }).locator('summary').click();
await pause(400);
await caption('The saved request matches the approval field by field, and the receipt points to that exact request.', 3600);
await scrollTo('#cmp-slot');
await caption('The comparison keeps sources, versions, capture times and which worker found each price. The page’s instructions are quoted, not followed.', 4600);
await shot('comparison');

await tab('Usage');
await caption('One shared allowance for both workers, the coordinator and retries. Payable usage is ₹0; any simulated cost is labelled SIMULATED.', 4200);
await shot('usage');
await tab('History');
await page.selectOption('#hf', 'blocked');
await pause(600);
await caption('History separates what agents said, what TaskLatch observed, policy decisions and my decisions. Here: every blocked action.', 4200);
await shot('history');

// Second task: partial result and an honest outcome
await page.locator('[data-nav=new]').click();
await page.waitForSelector('#newtask');
await page.selectOption('#scenario', 'source_unavailable');
await caption('Second task: Kartik’s page is down (HTTP 503). A draft only — no submission in scope.', 3000);
await page.getByRole('button', { name: 'Review scope' }).click();
await page.waitForSelector('#btn-start');
await page.locator('#btn-start').click();
await page.waitForURL(/desktops/);
await caption('Worker B waits and retries; the shared allowance still applies.', 2600);
await page.waitForFunction(() => /Partly verified/.test(document.body.innerText), null, { timeout: 40000 });
await tab('Results');
await page.waitForSelector('#cmp-slot table');
await pause(700);
await caption('Outcome: Partly verified. BrightOffice’s finding is verified; Kartik’s source is shown as unresolved — not hidden, not invented.', 4800);
await shot('partial');

await tab('Status');
await caption('TaskLatch: permissions the operator sets, one shared allowance, and results checked before anything is called done.', 4200);

const sid = sessionId();
await context.close();
const video = fs.readdirSync(RUNTIME).find(f => f.endsWith('.webm'));
if (video) fs.copyFileSync(path.join(RUNTIME, video), path.join(OUT, 'tasklatch-demo.webm'));
await browser.close();
for (const p of procs) p.kill('SIGTERM');
console.log(`Recorded ${video ? 'examples/demo/tasklatch-demo.webm' : '(no video!)'} + ${still} stills · last session ${sid}`);
process.exit(0);
