/**
 * Controller-side SupplierLab access.
 *  - read*: independent reads used by the verifier and approval re-checks (no credential needed).
 *  - brokerSubmit: the only code path holding the broker credential. Workers never see it.
 */
import { SUPPLIERLAB_ORIGIN, secret } from '../../packages/contracts/runtime.ts';

const BROKER = secret('broker');

async function getJson(path: string, timeoutMs = 6000) {
  const r = await fetch(SUPPLIERLAB_ORIGIN + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`supplierlab_http_${r.status}`);
  return r.json();
}

export const readCatalog = () => getJson('/api/catalog');
export const readSource = (id: string, version?: number) =>
  getJson(`/api/sources/${encodeURIComponent(id)}${version ? `/versions/${version}` : ''}`);
export const readRequest = (id: string) => getJson(`/api/purchase-requests/${encodeURIComponent(id)}`);
export const readReceipt = (id: string) => getJson(`/api/receipts/${encodeURIComponent(id)}`);
export const findByIdempotencyKey = async (key: string) =>
  ((await getJson(`/api/purchase-requests?idempotency_key=${encodeURIComponent(key)}`)) as any).requests[0] ?? null;

export async function brokerSubmit(payload: unknown, idempotencyKey: string, timeoutMs = 8000) {
  const r = await fetch(SUPPLIERLAB_ORIGIN + '/api/purchase-requests', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BROKER}`, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}

export async function supplierLabHealth(): Promise<boolean> {
  try { return !!(await getJson('/health', 2000)); } catch { return false; }
}
