/**
 * Model client. Every call, real or local, reserves from the shared allowance first.
 * Providers are configured in provider.ts: local-rules (default, no inference), nvidia (free
 * endpoint), fireworks (paid, explicit opt-in). Both hosted providers use the OpenAI-compatible
 * chat-completions format.
 */
import { reserveCall, commitCall, failCall, releaseCall, markUncertain } from './budget.ts';
import { emit } from './events.ts';
import { PROVIDER, providerLabel as label } from './provider.ts';

/** Kept for existing callers: provider id and model of this controller process. */
export const MODEL_CONFIG = { provider: PROVIDER.provider, model: PROVIDER.model, baseUrl: PROVIDER.baseUrl, timeoutMs: PROVIDER.timeoutMs };

export function providerLabel() { return label(); }

/** Thinking models spend output tokens reasoning before they answer; leave room unless reasoning is off. */
export function outputCap(requested: number) {
  return PROVIDER.reasoningEffort === 'none' ? requested : Math.max(requested * 6, 3000);
}

export type CallSpec<T> = {
  sessionId: string; actor: string; purpose: string; signal?: AbortSignal; retries: number;
  system: string; user: string; maxTokens: number;
  /** If set and TASKLATCH_JSON_MODE is on, the provider is asked to constrain output to this schema. */
  jsonSchema?: object;
  /** Optional screenshot (data: URL) sent with the user message to vision-capable models. */
  image?: string;
  /** Deterministic stand-in used by the local-rules provider. */
  local: () => T;
  /** Parse and validate the model's text output. Throw to reject. */
  parse: (text: string) => T;
};

export type CallResult<T> = { ok: true; value: T; provider: string } | { ok: false; error: 'budget' | 'stopped' | 'failed'; detail: string };

/** Test hook: replace the provider transport. */
type TransportSpec = { system: string; user: string; maxTokens: number; signal?: AbortSignal; jsonSchema?: object; image?: string };
let transport: ((spec: TransportSpec) => Promise<{ text: string; tokens: number | null; finish?: string | null; reasoningTokens?: number | null }>) | null = null;
export function setTransportForTests(t: typeof transport) { transport = t; }

function responseFormat(schema?: object) {
  if (!schema || PROVIDER.jsonMode === 'off') return {};
  return PROVIDER.jsonMode === 'object'
    ? { response_format: { type: 'json_object', schema } }
    : { response_format: { type: 'json_schema', json_schema: { name: 'tasklatch_output', schema, strict: true } } };
}

export async function hostedTransport(spec: TransportSpec) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), PROVIDER.timeoutMs);
  spec.signal?.addEventListener('abort', () => ctl.abort(spec.signal!.reason), { once: true });
  try {
    const r = await fetch(`${PROVIDER.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVIDER.apiKey}` },
      // Thinking models spend output tokens reasoning before answering; leave room unless reasoning is off.
      body: JSON.stringify({ model: PROVIDER.model, max_tokens: outputCap(spec.maxTokens), temperature: 0.1,
        ...(PROVIDER.reasoningEffort ? { reasoning_effort: PROVIDER.reasoningEffort } : {}),
        ...responseFormat(spec.jsonSchema),
        messages: [{ role: 'system', content: spec.system }, { role: 'user', content: spec.image
          ? [{ type: 'text', text: spec.user }, { type: 'image_url', image_url: { url: spec.image } }]
          : spec.user }] }),
    });
    if (r.status === 429) throw Object.assign(new Error('rate_limited'), { retryAfter: Number(r.headers.get('retry-after') || 2) });
    if (!r.ok) {
      const body: any = await r.json().catch(() => null);
      const msg = String(body?.error?.message ?? body?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(`provider_http_${r.status}${msg ? `: ${msg}` : ''}`);
    }
    const j: any = await r.json();
    const total = j.usage?.total_tokens ?? null;
    const reasoningTokens = j.usage?.completion_tokens_details?.reasoning_tokens ?? null;
    return { text: j.choices?.[0]?.message?.content ?? '', tokens: total, finish: j.choices?.[0]?.finish_reason ?? null, reasoningTokens };
  } finally { clearTimeout(timer); }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true });
});

export async function modelCall<T>(spec: CallSpec<T>): Promise<CallResult<T>> {
  const useTransport = transport ?? (PROVIDER.provider !== 'local-rules' ? hostedTransport : null);
  // Upper bound for the reservation; a 768px screenshot is budgeted at 1,200 tokens.
  const outCap = outputCap(spec.maxTokens);
  const estimate = useTransport ? Math.ceil((spec.system.length + spec.user.length) / 3.5) + outCap + (spec.image ? 1200 : 0) : 0;
  let retryOf: string | undefined;
  for (let attempt = 0; attempt <= spec.retries; attempt++) {
    if (spec.signal?.aborted) return { ok: false, error: 'stopped', detail: 'Stop requested before the call.' };
    const res = reserveCall(spec.sessionId, spec.actor, spec.purpose + (attempt ? ` (retry ${attempt})` : ''), estimate, retryOf);
    if (!res.ok) return { ok: false, error: res.reason === 'session_not_accepting' ? 'stopped' : 'budget', detail: res.reason };
    if (!useTransport) {
      // local-rules: deterministic, no inference, no tokens.
      try {
        const value = spec.local();
        commitCall(res.id, 0, 'none', 'local-rules decision (no inference)');
        return { ok: true, value, provider: 'local-rules' };
      } catch (e: any) {
        failCall(res.id, `local-rules error: ${e.message}`);
        return { ok: false, error: 'failed', detail: e.message };
      }
    }
    try {
      const out = await useTransport({ system: spec.system, user: spec.user, maxTokens: spec.maxTokens, signal: spec.signal, jsonSchema: spec.jsonSchema, image: spec.image });
      commitCall(res.id, out.tokens ?? Math.ceil(estimate), out.tokens == null ? 'estimated' : 'reported');
      try {
        return { ok: true, value: spec.parse(out.text), provider: PROVIDER.provider };
      } catch (e: any) {
        emit(spec.sessionId, { actor: spec.actor, kind: 'model.invalid_output', provenance: 'observed',
          summary: `Model output for “${spec.purpose}” was rejected by schema validation${!out.text && out.finish === 'length' ? ` — the output limit (${outputCap(spec.maxTokens)} tokens) was used up${out.reasoningTokens ? ` by ${out.reasoningTokens} reasoning tokens` : ''} before an answer (raise the limit, or lower TASKLATCH_REASONING_EFFORT if the model allows)` : ''}`,
          data: { attempt, error: e.message, finish_reason: out.finish ?? null, reasoning_tokens: out.reasoningTokens ?? null,
            // Kept for diagnosis only: untrusted model text, truncated, never interpreted.
            untrusted_output_excerpt: out.text ? out.text.slice(0, 600) : null } });
        retryOf = res.id;
        continue;
      }
    } catch (e: any) {
      if (spec.signal?.aborted) { markUncertain(res.id, 'stopped while the call was in flight'); return { ok: false, error: 'stopped', detail: 'Stopped during a model call.' }; }
      if (e.message === 'timeout' || e.name === 'TimeoutError' || e.name === 'AbortError') markUncertain(res.id, 'timed out; provider may have processed it');
      else failCall(res.id, e.message);
      emit(spec.sessionId, { actor: spec.actor, kind: 'model.error', provenance: 'observed',
        summary: `Model call for “${spec.purpose}” failed (${e.message}); ${attempt < spec.retries ? 'retrying' : 'no retries left'}`, data: { attempt } });
      retryOf = res.id;
      if (attempt < spec.retries) {
        try { await sleep(Math.min(8000, (e.retryAfter ? e.retryAfter * 1000 : 500 * 2 ** attempt) + Math.random() * 250), spec.signal); }
        catch { return { ok: false, error: 'stopped', detail: 'Stopped during backoff.' }; }
      }
    }
  }
  return { ok: false, error: 'failed', detail: 'Model call failed after the allowed retries.' };
}

/** Pull the first JSON object out of model text. */
export function extractJson(text: string): any {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in output');
  // Models sometimes put raw newlines or tabs inside string values, which strict JSON rejects.
  // Control characters are never meaningful in these fields, so replace them with spaces.
  return JSON.parse(text.slice(start, end + 1).replace(/[\u0000-\u001f]+/g, ' '));
}

export async function probeModel(): Promise<{ status: 'available' | 'not_configured' | 'error'; detail: string }> {
  if (PROVIDER.configError) return { status: 'error', detail: PROVIDER.configError };
  if (PROVIDER.provider === 'local-rules') return { status: 'not_configured', detail: 'No model provider configured. Agents use the labelled local-rules stand-in (set NVIDIA_API_KEY, or opt in to Fireworks).' };
  const name = PROVIDER.provider === 'fireworks' ? 'Fireworks' : 'NVIDIA';
  const cost = PROVIDER.paid
    ? ` PAID: billed per token${PROVIDER.usdPer1MTokens !== null ? `, estimated at the configured $${PROVIDER.usdPer1MTokens} per 1M tokens` : ' (no rate configured, so cost shows as unknown)'}${PROVIDER.maxSpendUsd !== null ? `; spend cap $${PROVIDER.maxSpendUsd} per task` : ''}.`
    : '';
  // Listing models costs nothing; no completion is requested here.
  try {
    const r = await fetch(`${PROVIDER.baseUrl}/models`, { headers: { authorization: `Bearer ${PROVIDER.apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { status: 'available', detail: `Authenticated to ${name}; model ${PROVIDER.model} configured (no completion probed yet).${cost}` };
    if (r.status === 401 || r.status === 403) return { status: 'error', detail: `${name} rejected the API key (HTTP ${r.status}).` };
    return { status: 'error', detail: `${name} answered HTTP ${r.status} to a model listing, so the key could not be confirmed.${cost}` };
  } catch (e: any) { return { status: 'error', detail: `${name} not reachable: ${e.message}` }; }
}

export { releaseCall };
