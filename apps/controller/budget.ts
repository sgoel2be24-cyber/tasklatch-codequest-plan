/**
 * Shared allowance ledger. One ledger per session covers both workers, the coordinator and retries.
 * Reservations are taken inside a write transaction before work starts, so two workers can never
 * both reserve the last remaining call.
 */
import { newId, nowIso } from '../../packages/contracts/canonical.ts';
import { tx, get, all, run } from './db.ts';
import { emit } from './events.ts';

export type Limits = {
  workers: number; time_seconds: number; steps_per_worker: number; model_calls: number;
  retries_per_call: number; token_ceiling: number | null;
};

export const DEFAULT_LIMITS: Limits = {
  workers: 2, time_seconds: 600, steps_per_worker: 40, model_calls: 40, retries_per_call: 2, token_ceiling: 60000,
};

const OPEN = "('reserved','committed','uncertain')";

export type Reservation = { ok: true; id: string } | { ok: false; reason: 'calls_exhausted' | 'tokens_exhausted' | 'session_not_accepting' };

const ACCEPTING = new Set(['DRAFT', 'READY', 'RUNNING', 'AWAITING_APPROVAL', 'VERIFYING']);

/** Atomically reserve one model call (and an upper bound of tokens) against the session allowance. */
export function reserveCall(sessionId: string, actor: string, purpose: string, tokensEstimate: number, retryOf?: string): Reservation {
  const result = tx((): Reservation => {
    const s = get('SELECT status, scope, stop_requested_at FROM sessions WHERE id=?', sessionId);
    if (!s || s.stop_requested_at || !ACCEPTING.has(s.status)) return { ok: false, reason: 'session_not_accepting' };
    const limits: Limits = JSON.parse(s.scope).limits;
    const used = get(`SELECT COUNT(*) c FROM reservations WHERE session_id=? AND kind='model_call' AND status IN ${OPEN}`, sessionId).c;
    if (used + 1 > limits.model_calls) return { ok: false, reason: 'calls_exhausted' };
    if (limits.token_ceiling) {
      const t = get(`SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN tokens_reserved ELSE COALESCE(tokens_used, 0) END),0) t
                     FROM reservations WHERE session_id=? AND kind='model_call' AND status IN ${OPEN}`, sessionId).t;
      if (t + tokensEstimate > limits.token_ceiling) return { ok: false, reason: 'tokens_exhausted' };
    }
    const id = newId('res');
    run('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, sessionId, actor, 'model_call', purpose, 1,
      tokensEstimate, 'reserved', null, null, retryOf ?? null, nowIso(), null, null);
    return { ok: true, id };
  });
  if (!result.ok && result.reason !== 'session_not_accepting') {
    emit(sessionId, { actor: 'controller', kind: 'budget.refused', provenance: 'observed',
      summary: `Allowance refused a model call for ${actor} (${purpose}): ${result.reason === 'calls_exhausted' ? 'no model calls left' : 'token ceiling reached'}`,
      data: { actor, purpose, reason: result.reason } });
  }
  return result;
}

/** Settle a reservation with actual usage. usage_source: reported | estimated | unknown | none */
export function commitCall(resId: string, tokensUsed: number | null, usageSource: string, note?: string) {
  run("UPDATE reservations SET status='committed', tokens_used=?, usage_source=?, settled_at=?, note=? WHERE id=? AND status='reserved'",
    tokensUsed, usageSource, nowIso(), note ?? null, resId);
}
/** The call failed after it was sent: it still counts against the allowance. */
export function failCall(resId: string, note: string) {
  run("UPDATE reservations SET status='committed', usage_source='unknown', settled_at=?, note=? WHERE id=? AND status='reserved'", nowIso(), note, resId);
}
/** The call never went out (e.g. cancelled before sending): return the reservation. */
export function releaseCall(resId: string, note: string) {
  run("UPDATE reservations SET status='released', settled_at=?, note=? WHERE id=? AND status='reserved'", nowIso(), note, resId);
}
/** The call may or may not have been processed (timeout, stop while in flight). Keep it counted. */
export function markUncertain(resId: string, note: string) {
  run("UPDATE reservations SET status='uncertain', usage_source='unknown', settled_at=?, note=? WHERE id=? AND status='reserved'", nowIso(), note, resId);
}

/** Per-worker execution steps. Returns false when that worker has used all its steps. */
export function takeStep(sessionId: string, workerId: string): boolean {
  return tx(() => {
    const s = get('SELECT scope FROM sessions WHERE id=?', sessionId);
    const limits: Limits = JSON.parse(s.scope).limits;
    const w = get('SELECT steps_used FROM workers WHERE session_id=? AND worker_id=?', sessionId, workerId);
    if (!w || w.steps_used >= limits.steps_per_worker) return false;
    run('UPDATE workers SET steps_used=steps_used+1 WHERE session_id=? AND worker_id=?', sessionId, workerId);
    return true;
  });
}

export function budgetSummary(sessionId: string) {
  const s = get('SELECT scope, started_at, ended_at, stop_confirmed_at, status, deadline_at FROM sessions WHERE id=?', sessionId);
  const limits: Limits = JSON.parse(s.scope).limits;
  const rows = all("SELECT * FROM reservations WHERE session_id=? AND kind='model_call' ORDER BY created_at", sessionId);
  const by = (st: string) => rows.filter(r => r.status === st);
  const committed = by('committed'), reserved = by('reserved'), uncertain = by('uncertain'), released = by('released');
  const callsUsed = committed.length + uncertain.length;
  const tokens = {
    reported: committed.filter(r => r.usage_source === 'reported').reduce((a, r) => a + (r.tokens_used || 0), 0),
    estimated: committed.filter(r => r.usage_source === 'estimated').reduce((a, r) => a + (r.tokens_used || 0), 0),
    unknown_calls: committed.filter(r => r.usage_source === 'unknown').length + uncertain.length,
    no_inference_calls: committed.filter(r => r.usage_source === 'none').length,
    reserved: reserved.reduce((a, r) => a + r.tokens_reserved, 0),
  };
  const workers = all('SELECT worker_id, label, steps_used, status FROM workers WHERE session_id=? ORDER BY worker_id', sessionId);
  // Elapsed active time: the deadline is shifted forward on resume, so downtime is not counted.
  const endMs = s.ended_at ? Date.parse(s.ended_at) : Date.now();
  const elapsed = s.deadline_at ? Math.max(0, Math.min(limits.time_seconds, Math.round(limits.time_seconds - (Date.parse(s.deadline_at) - endMs) / 1000))) : 0;
  const retries = rows.filter(r => r.retry_of).length;
  const byActor: Record<string, number> = {};
  for (const r of rows) if (r.status !== 'released') byActor[r.actor] = (byActor[r.actor] || 0) + 1;
  return {
    limits,
    model_calls: { limit: limits.model_calls, used: callsUsed, in_progress: reserved.length, uncertain: uncertain.length,
      released: released.length, remaining: Math.max(0, limits.model_calls - callsUsed - reserved.length), by_actor: byActor },
    tokens: { ceiling: limits.token_ceiling, ...tokens,
      remaining: limits.token_ceiling ? Math.max(0, limits.token_ceiling - tokens.reported - tokens.estimated - tokens.reserved) : null },
    steps: workers.map(w => ({ worker_id: w.worker_id, label: w.label, used: w.steps_used, limit: limits.steps_per_worker,
      remaining: Math.max(0, limits.steps_per_worker - w.steps_used) })),
    time: { limit_seconds: limits.time_seconds, elapsed_seconds: elapsed, deadline_at: s.deadline_at },
    retries: { per_call_limit: limits.retries_per_call, used: retries },
    workers: { limit: limits.workers, count: workers.length },
    reservations: rows,
    payable_cost: payable(JSON.parse(s.scope).model, tokens.reported + tokens.estimated, tokens.reserved, tokens.unknown_calls),
    simulated_cost: simulate(callsUsed, tokens.reported + tokens.estimated),
  };
}

/** Actual payable usage. Free providers are ₹0; a paid provider is an estimate from tokens × configured rate. */
function payable(model: any, tokens: number, reservedTokens: number, unknownCalls: number) {
  if (!model?.paid) {
    return { paid: false, display: '₹0', basis: 'none', note: model?.provider === 'nvidia' ? 'NVIDIA free endpoint: no payable cost for this prototype.' : 'No paid inference is used: local-rules decisions have no cost.' };
  }
  const rate = model.usd_per_1m_tokens;
  if (rate === null || rate === undefined) {
    return { paid: true, display: 'unknown', basis: 'no_rate', tokens, note: `${model.label}. Billed by Fireworks per token; no rate is configured (FIREWORKS_USD_PER_1M_TOKENS), so TaskLatch cannot estimate the charge. Tokens used: ${tokens.toLocaleString()}.` };
  }
  const usd = (tokens * rate) / 1_000_000;
  const inFlight = (reservedTokens * rate) / 1_000_000;
  return { paid: true, display: `≈ $${usd.toFixed(4)}`, basis: 'estimated', amount_usd: usd, in_flight_usd: inFlight, rate_usd_per_1m: rate,
    note: `${model.label}. Estimate = reported/estimated tokens × $${rate}/1M. Fireworks' invoice is authoritative.${unknownCalls ? ` ${unknownCalls} call(s) have unknown usage and are not included.` : ''}${model.max_spend_usd !== null && model.max_spend_usd !== undefined ? ` Spend cap $${model.max_spend_usd} enforced through the token ceiling.` : ''}` };
}

/** SIMULATED tariff for illustration only. Not an invoice and not actual payable usage. */
export const SIMULATED_TARIFF = { version: 'sim-2026-11-v1', per_call_minor: 50, per_1k_tokens_minor: 20 };
function simulate(calls: number, tokens: number) {
  const minor = calls * SIMULATED_TARIFF.per_call_minor + Math.ceil(tokens / 1000) * SIMULATED_TARIFF.per_1k_tokens_minor;
  return { label: 'SIMULATED — not a real charge', tariff: SIMULATED_TARIFF, amount_minor: minor };
}
