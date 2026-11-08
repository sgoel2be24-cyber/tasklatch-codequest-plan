import { db, get, all } from './db.ts';
import { sha256, canonicalJson, nowIso } from '../../packages/contracts/canonical.ts';

/**
 * Provenance separates what TaskLatch itself observed or decided from what an agent claimed.
 *  observed           - TaskLatch read it from SupplierLab, the browser, or its own state
 *  agent_statement    - an agent said or proposed it (untrusted)
 *  policy_decision    - the policy engine decided it
 *  operator_decision  - the human operator decided it
 */
export type Provenance = 'observed' | 'agent_statement' | 'policy_decision' | 'operator_decision';

export type EventInput = {
  actor: string; kind: string; provenance: Provenance; summary: string; data?: unknown;
};

const listeners = new Set<(sessionId: string) => void>();
export function onEvent(fn: (sessionId: string) => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Append to the session's hash-chained, append-only history. Only the controller calls this. */
export function emit(sessionId: string, e: EventInput) {
  const last = get('SELECT seq, hash FROM audit_events WHERE session_id=? ORDER BY seq DESC LIMIT 1', sessionId);
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? 'genesis';
  const at = nowIso();
  const data = e.data === undefined ? null : canonicalJson(e.data);
  const hash = sha256([sessionId, seq, at, e.actor, e.kind, e.provenance, e.summary, data ?? '', prev].join('|'));
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(sessionId, seq, at, e.actor, e.kind, e.provenance, e.summary, data, prev, hash);
  for (const l of listeners) { try { l(sessionId); } catch { /* ignore */ } }
  return seq;
}

export function listEvents(sessionId: string, sinceSeq = 0) {
  return all('SELECT * FROM audit_events WHERE session_id=? AND seq>? ORDER BY seq', sessionId, sinceSeq)
    .map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}

/** Recompute the chain. Detects later edits to stored rows; it is not proof against a compromised host. */
export function verifyChain(sessionId: string): { ok: boolean; count: number; broken_at: number | null } {
  const rows = all('SELECT * FROM audit_events WHERE session_id=? ORDER BY seq', sessionId);
  let prev = 'genesis';
  for (const r of rows) {
    const h = sha256([r.session_id, r.seq, r.at, r.actor, r.kind, r.provenance, r.summary, r.data ?? '', prev].join('|'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, count: rows.length, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, count: rows.length, broken_at: null };
}
