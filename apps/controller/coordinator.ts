/**
 * Coordinator: proposes a division of work and assembles findings into a comparison and draft.
 * It has no approval authority. Text inside findings is carried as quoted, untrusted context.
 * Numbers in the comparison are computed deterministically from findings; nothing is invented.
 */
import { newId, nowIso, sha256, formatMinor } from '../../packages/contracts/canonical.ts';
import { modelCall } from './model.ts';
import type { Finding } from './agent.ts';

export type PlanSubtask = { task_id: string; worker_id: string; label: string; vendor_id: string; source_ids: string[]; title: string };

/** Deterministic plan: one vendor per worker, round-robin if there are more vendors than workers. */
export function localPlan(scope: any): { subtasks: PlanSubtask[]; rationale: string } {
  const byVendor = new Map<string, string[]>();
  for (const s of scope.approved_sources) byVendor.set(s.vendor_id, [...(byVendor.get(s.vendor_id) || []), s.source_id]);
  const workers = Array.from({ length: Math.max(1, Math.min(scope.limits.workers, 4)) }, (_, i) => `worker-${String.fromCharCode(97 + i)}`);
  const subtasks: PlanSubtask[] = [];
  let i = 0;
  for (const [vendor, ids] of byVendor) {
    const w = workers[i % workers.length];
    const existing = subtasks.find(t => t.worker_id === w);
    const vname = scope.vendor_names?.[vendor] || vendor;
    if (existing) { existing.source_ids.push(...ids); existing.title += ` and ${vname}`; }
    else subtasks.push({ task_id: newId('tsk'), worker_id: w, label: `Worker ${w.slice(-1).toUpperCase()}`, vendor_id: vendor, source_ids: [...ids], title: `Research ${vname}` });
    i++;
  }
  return { subtasks, rationale: `Each worker researches one vendor in parallel (${byVendor.size} vendors, ${subtasks.length} workers). Work is split by vendor so every finding has one clear author.` };
}

export async function proposePlan(sessionId: string, scope: any) {
  const r = await modelCall({
    sessionId, actor: 'coordinator', purpose: 'propose plan', retries: scope.limits.retries_per_call,
    system: 'You plan supplier research. Reply with JSON {"rationale": string}.',
    user: `Vendors: ${[...new Set(scope.approved_sources.map((s: any) => s.vendor_id))].join(', ')}; workers: ${scope.limits.workers}`,
    maxTokens: 200,
    local: () => localPlan(scope),
    parse: () => localPlan(scope), // the split itself stays deterministic; model text is not trusted to assign work
  });
  return r.ok ? r.value : localPlan(scope);
}

export type ComparisonRow = {
  vendor_id: string; vendor_name: string; product_id: string | null; product_title: string | null;
  unit_price_minor: number | null; price_status: 'confirmed' | 'conflict' | 'unknown'; conflicting_prices: { source_id: string; unit_price_minor: number; found_by: string }[];
  currency: string | null; stock_qty: number | null; stock_status: string; meets_quantity: boolean | null;
  tax_included: boolean | null; shipping_minor: number | null;
  source_refs: { source_id: string; source_version: number | null; captured_at: string; found_by: string; url: string }[];
  found_by: string[]; flags: string[];
};

export function buildComparison(scope: any, request: any, candidates: { worker_id: string; findings: Finding[] }[]) {
  const all = candidates.flatMap(c => c.findings);
  const observed = all.filter(f => f.status === 'observed');
  const rows: ComparisonRow[] = [];
  for (const vendor of [...new Set(scope.approved_sources.map((s: any) => s.vendor_id))] as string[]) {
    const fs = observed.filter(f => f.vendor_id === vendor);
    if (!fs.length) continue;
    const prices = fs.filter(f => f.unit_price_minor !== null);
    const distinct = [...new Set(prices.map(f => f.unit_price_minor))];
    const stockF = fs.find(f => f.stock_qty !== null);
    const primary = fs.find(f => f.product_id) || fs[0];
    const flags: string[] = [];
    if (distinct.length > 1) flags.push(`Conflicting prices: ${prices.map(f => `${formatMinor(f.unit_price_minor)} (${f.source_id})`).join(' vs ')}`);
    if (!prices.length) flags.push('Price unknown');
    if (!stockF) flags.push('Stock unknown');
    if (fs.some(f => f.untrusted_page_text)) flags.push('Page contained instructions addressed to AI agents (quoted, not followed)');
    const stockQty = stockF?.stock_qty ?? null;
    rows.push({
      vendor_id: vendor, vendor_name: scope.vendor_names?.[vendor] || vendor,
      product_id: primary.product_id, product_title: primary.product_title,
      unit_price_minor: distinct.length === 1 ? distinct[0] : null,
      price_status: distinct.length === 1 ? 'confirmed' : distinct.length > 1 ? 'conflict' : 'unknown',
      conflicting_prices: distinct.length > 1 ? prices.map(f => ({ source_id: f.source_id, unit_price_minor: f.unit_price_minor!, found_by: f.author_agent })) : [],
      currency: prices[0]?.currency ?? null, stock_qty: stockQty, stock_status: stockF ? stockF.stock_status : 'unknown',
      meets_quantity: stockQty === null ? null : stockQty >= request.quantity,
      tax_included: fs.find(f => f.tax_included !== null)?.tax_included ?? null,
      shipping_minor: fs.find(f => f.shipping_minor !== null)?.shipping_minor ?? null,
      source_refs: fs.map(f => ({ source_id: f.source_id, source_version: f.source_version, captured_at: f.captured_at, found_by: f.author_agent, url: f.source_url })),
      found_by: [...new Set(fs.map(f => f.author_agent))], flags,
    });
  }
  const unresolved = scope.approved_sources
    .filter((s: any) => !observed.some(f => f.source_id === s.source_id))
    .map((s: any) => {
      const f = all.find(x => x.source_id === s.source_id);
      return { source_id: s.source_id, vendor_id: s.vendor_id, assigned_to: f?.author_agent ?? scope.source_owner?.[s.source_id] ?? null,
        reason: f ? f.limitations.join(' ') || f.status : 'No finding was produced for this source.' };
    });
  const eligible = rows.filter(r => r.price_status === 'confirmed' && r.meets_quantity === true).sort((a, b) => a.unit_price_minor! - b.unit_price_minor!);
  const fallback = rows.filter(r => r.price_status === 'confirmed' && r.meets_quantity === null).sort((a, b) => a.unit_price_minor! - b.unit_price_minor!);
  const pick = eligible[0] || fallback[0] || null;
  const recommendation = pick ? {
    vendor_id: pick.vendor_id,
    reason: eligible[0]
      ? `Lowest confirmed unit price (${formatMinor(pick.unit_price_minor)}) among vendors with at least ${request.quantity} units in stock.`
      : `Lowest confirmed price, but stock is unknown — confirm availability before ordering.`,
    warnings: eligible[0] ? [] : ['Stock unknown for the recommended vendor.'],
  } : null;
  const warnings = [
    ...rows.flatMap(r => r.flags.map(f => `${r.vendor_name}: ${f}`)),
    ...unresolved.map((u: any) => `Unresolved source ${u.source_id}: ${u.reason}`),
  ];
  const untrusted = observed.filter(f => f.untrusted_page_text).map(f => ({ source_id: f.source_id, found_by: f.author_agent, quoted_text: f.untrusted_page_text }));
  return {
    schema_version: '1.0', comparison_id: newId('cmp'), generated_at: nowIso(), generated_by: 'coordinator',
    request: { item_id: request.item_id, item_name: request.item_name, quantity: request.quantity },
    currency: 'INR', rows, unresolved, recommendation, warnings, untrusted_content: untrusted,
    complete: unresolved.length === 0,
  };
}

export function comparisonMarkdown(c: any): string {
  const lines = [`# Supplier comparison — ${c.request.item_name}`, '', `Requested quantity: **${c.request.quantity}** · Generated ${c.generated_at} · ${c.complete ? 'All approved sources covered' : '**Incomplete: some sources unresolved**'}`, '',
    '| Vendor | Product | Unit price | Stock | Sources (version, captured, by) | Flags |', '|---|---|---|---|---|---|'];
  for (const r of c.rows) {
    const price = r.price_status === 'conflict' ? `CONFLICT: ${r.conflicting_prices.map((p: any) => `${formatMinor(p.unit_price_minor)} (${p.source_id})`).join(' vs ')}` : formatMinor(r.unit_price_minor);
    const stock = r.stock_status === 'unknown' ? 'stock unknown' : `${r.stock_qty} units`;
    const refs = r.source_refs.map((s: any) => `${s.source_id} v${s.source_version}, ${s.captured_at}, ${s.found_by}`).join('<br>');
    lines.push(`| ${r.vendor_name} | ${r.product_id ?? '?'} | ${price} | ${stock} | ${refs} | ${r.flags.join('; ') || '—'} |`);
  }
  if (c.unresolved.length) { lines.push('', '## Unresolved'); for (const u of c.unresolved) lines.push(`- ${u.source_id} (${u.assigned_to ?? 'unassigned'}): ${u.reason}`); }
  lines.push('', '## Recommendation', c.recommendation ? `${c.recommendation.vendor_id}: ${c.recommendation.reason}` : 'No vendor can be recommended with the evidence collected.');
  if (c.untrusted_content.length) { lines.push('', '## Untrusted page content (quoted, not followed)'); for (const u of c.untrusted_content) lines.push(`> ${u.quoted_text} — ${u.source_id}`); }
  return lines.join('\n') + '\n';
}

export function buildDraft(scope: any, request: any, comparison: any, comparisonArtifact: { id: string; sha256: string }, requester: string) {
  const rec = comparison.recommendation;
  if (!rec) return null;
  const row = comparison.rows.find((r: any) => r.vendor_id === rec.vendor_id);
  const ref = row.source_refs.find((s: any) => s.source_version !== null) || row.source_refs[0];
  const shipping = row.shipping_minor ?? 0;
  return {
    schema_version: '1.0', draft_id: newId('drf'), created_at: nowIso(), status: 'draft — not submitted',
    based_on: { comparison_id: comparison.comparison_id, comparison_artifact_id: comparisonArtifact.id, comparison_sha256: comparisonArtifact.sha256 },
    supplier_id: row.vendor_id, supplier_name: row.vendor_name, product_id: row.product_id, item_id: request.item_id,
    quantity: request.quantity, unit_price_minor: row.unit_price_minor, currency: row.currency || 'INR',
    tax_included: row.tax_included ?? true, shipping_minor: shipping,
    total_minor: request.quantity * row.unit_price_minor + shipping,
    destination: scope.submission_destination, requester,
    source_id: ref.source_id, source_version: ref.source_version,
    warnings: [...rec.warnings, ...(comparison.complete ? [] : ['Based on an incomplete comparison: some sources were unresolved.'])],
  };
}

export function draftMarkdown(d: any): string {
  return [`# Purchase-request draft (not submitted)`, '',
    `- Supplier: **${d.supplier_name}** (${d.supplier_id})`, `- Item: ${d.product_id} (${d.item_id})`, `- Quantity: **${d.quantity}**`,
    `- Unit price: ${formatMinor(d.unit_price_minor, d.currency)} ${d.tax_included ? '(tax included)' : ''}`, `- Shipping: ${formatMinor(d.shipping_minor, d.currency)}`,
    `- **Total: ${formatMinor(d.total_minor, d.currency)}**`, `- Destination: ${d.destination}`, `- Requester: ${d.requester}`,
    `- Based on comparison ${d.based_on.comparison_id} (sha256 ${d.based_on.comparison_sha256.slice(0, 16)}…), source ${d.source_id} v${d.source_version}`,
    ...(d.warnings.length ? ['', '**Warnings:**', ...d.warnings.map((w: string) => `- ${w}`)] : []), ''].join('\n');
}

/** The exact request details an approval binds to. Changing any of these needs a new decision. */
export function requestDetails(draft: any) {
  return {
    supplier_id: draft.supplier_id, product_id: draft.product_id, item_id: draft.item_id, quantity: draft.quantity,
    unit_price_minor: draft.unit_price_minor, currency: draft.currency, total_minor: draft.total_minor,
    tax_included: draft.tax_included, shipping_minor: draft.shipping_minor, requester: draft.requester,
    destination: draft.destination, source_id: draft.source_id, source_version: draft.source_version,
  };
}

export const hashOf = (s: string) => sha256(s);
