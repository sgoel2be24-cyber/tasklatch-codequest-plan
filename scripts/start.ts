/** Start SupplierLab and the TaskLatch controller together. Ctrl+C stops both. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, secret } from '../packages/contracts/runtime.ts';

// Optional provider settings (see .env.example). Values already in the environment take precedence.
const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Create local secrets before either process starts so they agree on them.
secret('broker'); secret('supplierlab-admin'); secret('cookie');

const procs = [
  spawn(process.execPath, [path.join(REPO_ROOT, 'fixtures/supplierlab/server.ts')], { stdio: 'inherit', env: process.env }),
];
setTimeout(() => {
  procs.push(spawn(process.execPath, [path.join(REPO_ROOT, 'apps/controller/server.ts')], { stdio: 'inherit', env: process.env }));
}, 600);
const stop = () => { for (const p of procs) p.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
