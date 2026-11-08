/**
 * Quote checking shared by the desktop agent (immediate feedback) and the verifier (independent re-check).
 * A quote may join several verbatim fragments with "—", "–", "…", "...", or "|"; every fragment must appear
 * in the captured page text. Matching ignores case, curly quotes and runs of whitespace — nothing else.
 */
export const normText = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export function quoteFragments(quote: string): string[] {
  return String(quote ?? '')
    .split(/\s+[—–|]\s+|\s*(?:\.\.\.|…)\s*|\n+/)
    .map(f => f.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim())
    .filter(f => f.length > 0);
}

export function checkQuote(pageText: string, quote: string): { ok: boolean; missing: string[]; fragments: string[] } {
  const page = normText(pageText);
  const fragments = quoteFragments(quote);
  if (!fragments.length || fragments.every(f => f.length < 3)) return { ok: false, missing: [String(quote ?? '')], fragments };
  const missing = fragments.filter(f => f.length >= 3 && !page.includes(normText(f)));
  return { ok: missing.length === 0, missing, fragments };
}

/** The page line (or sentence) most similar to a fragment, so the agent can copy it exactly. */
export function closestPassage(pageText: string, fragment: string): string | null {
  const words = (x: string) => new Set(normText(x).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(w => w.length > 2));
  const want = words(fragment);
  if (want.size < 2) return null;
  let best: { s: string; score: number } | null = null;
  const pieces = pageText.split(/\n+/).flatMap(line => line.length > 240 ? line.split(/(?<=[.!?])\s+/) : [line]);
  for (const p of pieces) {
    const t = p.trim(); if (t.length < 8 || t.length > 400) continue;
    const have = words(t); let hit = 0; for (const w of want) if (have.has(w)) hit++;
    const score = hit / want.size;
    if (!best || score > best.score) best = { s: t, score };
  }
  return best && best.score >= 0.5 ? best.s : null;
}
