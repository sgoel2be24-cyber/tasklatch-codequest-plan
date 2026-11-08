/**
 * Local operator authentication. The controller binds to loopback only. An operator signs in with a
 * one-time bootstrap link (printed at startup) or their local token; the browser then holds a signed,
 * HttpOnly, SameSite=Strict cookie. A session ID alone never grants access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RUNTIME_DIR, secret } from '../../packages/contracts/runtime.ts';
import { sha256, nowIso } from '../../packages/contracts/canonical.ts';
import { get, run } from './db.ts';

const COOKIE = 'tl_operator';
const TTL_MS = 12 * 3600 * 1000;
const cookieKey = secret('cookie');

export function ensureOperator(id: string, name: string): string {
  const file = path.join(RUNTIME_DIR, 'secrets', `operator-${id}.token`);
  let token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!token) { token = randomBytes(24).toString('base64url'); fs.writeFileSync(file, token, { mode: 0o600 }); }
  const existing = get('SELECT id FROM operators WHERE id=?', id);
  if (existing) run('UPDATE operators SET token_hash=?, name=? WHERE id=?', sha256(token), name, id);
  else run('INSERT INTO operators VALUES (?,?,?,?)', id, name, sha256(token), nowIso());
  return token;
}

export function bootstrapCode(operatorId: string): string {
  const code = randomBytes(18).toString('base64url');
  run('INSERT INTO bootstrap_codes VALUES (?,?,?,?)', sha256(code), operatorId, new Date(Date.now() + 15 * 60 * 1000).toISOString(), null);
  return code;
}

export function redeemBootstrap(code: string): string | null {
  const row = get('SELECT * FROM bootstrap_codes WHERE code_hash=?', sha256(code));
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  run('UPDATE bootstrap_codes SET used_at=? WHERE code_hash=?', nowIso(), row.code_hash);
  return row.operator_id;
}

export function operatorByToken(token: string): any {
  return get('SELECT id, name FROM operators WHERE token_hash=?', sha256(String(token)));
}

const sign = (v: string) => createHmac('sha256', cookieKey).update(v).digest('base64url');

export function sessionCookie(operatorId: string): string {
  const v = `${operatorId}.${Date.now() + TTL_MS}`;
  return `${COOKIE}=${v}.${sign(v)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}`;
}
export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function operatorFromRequest(headers: Record<string, any>): any {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return operatorByToken(auth.slice(7)) ?? null;
  const raw = String(headers['cookie'] || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const val = raw.slice(COOKIE.length + 1);
  const i = val.lastIndexOf('.');
  if (i < 0) return null;
  const body = val.slice(0, i); const mac = val.slice(i + 1);
  const expected = sign(body);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const [opId, exp] = [body.slice(0, body.lastIndexOf('.')), Number(body.slice(body.lastIndexOf('.') + 1))];
  if (!exp || exp < Date.now()) return null;
  return get('SELECT id, name FROM operators WHERE id=?', opId) ?? null;
}
