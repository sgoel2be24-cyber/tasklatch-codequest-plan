import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNTIME_DIR = path.resolve(process.env.TASKLATCH_RUNTIME_DIR || path.join(REPO_ROOT, '.runtime'));

export const PORTS = {
  controller: Number(process.env.TASKLATCH_PORT || 4000),
  supplierlab: Number(process.env.SUPPLIERLAB_PORT || 4100),
};
export const HOST = '127.0.0.1';
export const SUPPLIERLAB_ORIGIN = process.env.SUPPLIERLAB_ORIGIN || `http://${HOST}:${PORTS.supplierlab}`;
export const CONTROLLER_ORIGIN = `http://${HOST}:${PORTS.controller}`;

/**
 * Local secrets live in .runtime/secrets (git-ignored, mode 0600). The broker secret is the only
 * credential SupplierLab accepts for writes; it is held by the controller and never given to workers.
 */
export function secret(name: 'broker' | 'supplierlab-admin' | 'cookie'): string {
  const dir = path.join(RUNTIME_DIR, 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.secret`);
  try {
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
  }
  return fs.readFileSync(file, 'utf8').trim();
}
