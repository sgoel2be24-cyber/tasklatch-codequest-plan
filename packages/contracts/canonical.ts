import { createHash, randomBytes } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, no whitespace. Used for hashing payloads. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashPayload(value: unknown): string {
  return 'sha256:' + sha256(canonicalJson(value));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Format integer minor units (paise) as a rupee string. */
export function formatMinor(minor: number | null | undefined, currency = 'INR'): string {
  if (minor === null || minor === undefined) return 'unknown';
  const major = minor / 100;
  const sym = currency === 'INR' ? '₹' : currency + ' ';
  return sym + major.toLocaleString('en-IN', { minimumFractionDigits: major % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
