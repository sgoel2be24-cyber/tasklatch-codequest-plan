/**
 * Model provider configuration (read once at startup from environment variables).
 *
 *  local-rules  default. No inference, no cost. Clearly labelled stand-in.
 *  nvidia       free hosted endpoint. Selected when NVIDIA_API_KEY is set, or TASKLATCH_PROVIDER=nvidia.
 *  fireworks    PAID, per token. Never picked automatically: requires TASKLATCH_PROVIDER=fireworks,
 *               FIREWORKS_API_KEY and an explicit TASKLATCH_MODEL. A per-session token ceiling is
 *               always enforced, and TASKLATCH_MAX_SPEND_USD (with a configured rate) lowers it further.
 */
export type ProviderId = 'local-rules' | 'nvidia' | 'fireworks';

type Config = {
  provider: ProviderId; model: string; baseUrl: string; apiKey: string | null; paid: boolean;
  usdPer1MTokens: number | null; maxSpendUsd: number | null; timeoutMs: number;
  /** Sent as reasoning_effort when set. 'none' stops reasoning models spending the output limit on thinking. */
  reasoningEffort: string | null;
  /** Constrained JSON output: 'schema' = OpenAI-style json_schema, 'object' = json_object with schema, 'off'. */
  jsonMode: 'off' | 'schema' | 'object';
  /** The configured model accepts screenshots (required for desktop agents). Set TASKLATCH_VISION=1. */
  supportsImages: boolean;
  requested: string; configError: string | null;
};

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolve(): Config {
  const env = process.env;
  const requested = (env.TASKLATCH_PROVIDER || '').trim().toLowerCase();
  const effort = (env.TASKLATCH_REASONING_EFFORT || '').trim().toLowerCase();
  const base = { usdPer1MTokens: null, maxSpendUsd: null, timeoutMs: Number(env.TASKLATCH_MODEL_TIMEOUT_MS || 30000), configError: null,
    reasoningEffort: ['none', 'low', 'medium', 'high'].includes(effort) ? effort : null,
    supportsImages: env.TASKLATCH_VISION === '1',
    jsonMode: (['schema', 'object'].includes((env.TASKLATCH_JSON_MODE || '').trim().toLowerCase()) ? (env.TASKLATCH_JSON_MODE || '').trim().toLowerCase() : 'off') as 'off' | 'schema' | 'object' };
  const local: Config = { ...base, provider: 'local-rules', model: 'local-rules', baseUrl: '', apiKey: null, paid: false, requested: requested || 'auto' };

  if (requested === 'fireworks') {
    const problems: string[] = [];
    if (!env.FIREWORKS_API_KEY) problems.push('FIREWORKS_API_KEY is not set');
    if (!env.TASKLATCH_MODEL) problems.push('TASKLATCH_MODEL is not set (for example accounts/fireworks/models/<model>)');
    if (problems.length) return { ...local, requested, configError: `Fireworks was requested but ${problems.join(' and ')}. Using local rules instead.` };
    return {
      ...base, provider: 'fireworks', requested, paid: true,
      model: env.TASKLATCH_MODEL!, apiKey: env.FIREWORKS_API_KEY!,
      baseUrl: (env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, ''),
      usdPer1MTokens: num(env.FIREWORKS_USD_PER_1M_TOKENS), maxSpendUsd: num(env.TASKLATCH_MAX_SPEND_USD),
    };
  }
  if (requested === 'local-rules') return local;
  if (requested === 'nvidia' || (!requested && env.NVIDIA_API_KEY)) {
    if (!env.NVIDIA_API_KEY) return { ...local, requested, configError: 'NVIDIA was requested but NVIDIA_API_KEY is not set. Using local rules instead.' };
    return {
      ...base, provider: 'nvidia', requested: requested || 'auto', paid: false,
      model: env.TASKLATCH_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', apiKey: env.NVIDIA_API_KEY,
      baseUrl: (env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
    };
  }
  if (requested && requested !== 'auto') return { ...local, requested, configError: `Unknown TASKLATCH_PROVIDER “${requested}”. Using local rules instead.` };
  return local;
}

export const PROVIDER = resolve();

export function providerLabel(p: { provider: string; model: string } = PROVIDER): string {
  if (p.provider === 'fireworks') return `Fireworks AI · ${p.model} (paid, per token)`;
  if (p.provider === 'nvidia') return `NVIDIA hosted · ${p.model} (free endpoint)`;
  return 'Local rules (no model inference)';
}

/** What the session records about its provider, so evidence stays accurate if settings change later. */
export function providerRecord() {
  return { provider: PROVIDER.provider, model: PROVIDER.model, paid: PROVIDER.paid, label: providerLabel(),
    usd_per_1m_tokens: PROVIDER.usdPer1MTokens, max_spend_usd: PROVIDER.maxSpendUsd, reasoning_effort: PROVIDER.reasoningEffort, json_mode: PROVIDER.jsonMode, vision: PROVIDER.supportsImages };
}

/** Token ceiling a paid provider must respect: the configured ceiling, lowered by the spend cap if a rate is known. */
/** Tokens the per-task spend cap pays for (null when no cap or no rate is configured). */
export function capTokens(): number | null {
  return PROVIDER.maxSpendUsd !== null && PROVIDER.usdPer1MTokens ? Math.floor((PROVIDER.maxSpendUsd / PROVIDER.usdPer1MTokens) * 1_000_000) : null;
}

export function paidTokenCeiling(requested: number | null): number {
  const fallback = requested ?? 60000;
  if (PROVIDER.maxSpendUsd !== null && PROVIDER.usdPer1MTokens) {
    return Math.min(fallback, Math.floor((PROVIDER.maxSpendUsd / PROVIDER.usdPer1MTokens) * 1_000_000));
  }
  return fallback;
}
