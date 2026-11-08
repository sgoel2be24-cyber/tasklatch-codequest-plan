/**
 * Independent result checks. The verifier reads saved files from disk and authoritative records from
 * SupplierLab. It never relies on what an agent said about its own work.
 */
import { newId, nowIso, hashPayload, formatMinor } from '../../packages/contracts/canonical.ts';
import { run, get, all } from './db.ts';
import { emit } from './events.ts';
import { readArtifact, latestArtifact } from './storage.ts';
import { readSource, readReceipt, readRequest } from './supplierlab-client.ts';
import { loadSession } from './state.ts';

export type Check = { name: string; status: 'pass' | 'fail' | 'unverified'; detail: string; ref?: string };
export type VerifyStatus = 'verified' | 'failed' | 'partial' | 'could_not_verify' | 'not_required' | 'missing';

function save(sessionId: string, deliverable: string, status: VerifyStatus, summary: string, checks: Check[]) {
  run('INSERT INTO verification_results VALUES (?,?,?,?,?,?,?)', newId('ver'), sessionId, deliverable, status, summary, JSON.stringify(checks), nowIso());
  emit(sessionId, { actor: 'verifier', kind: 'verification.result', provenance: 'observed',
    summary: `${deliverable}: ${status.replace(/_/g, ' ')} — ${summary}`, data: { deliverable, status, failed: checks.filter(c => c.status !== 'pass') } });
  return { deliverable, status, summary, checks };
}

export async function verifyComparison(sessionId: string) {
  const s = loadSession(sessionId)!;
  const checks: Check[] = [];
  const art = latestArtifact(sessionId, 'comparison');
  if (!art) return save(sessionId, 'comparison', 'missing', 'No comparison file was produced.', [{ name: 'artifact_present', status: 'fail', detail: 'comparison.json not found' }]);
  const read = readArtifact(sessionId, art.id)!;
  if (read.missing) return save(sessionId, 'comparison', 'missing', 'The comparison file recorded for this task is missing from disk.', [{ name: 'artifact_present', status: 'fail', detail: `${art.rel_path} not found`, ref: art.id }]);
  checks.push({ name: 'artifact_intact', status: read.intact ? 'pass' : 'fail', detail: read.intact ? `sha256 ${art.sha256.slice(0, 16)}… matches the saved record` : 'File content no longer matches its recorded hash', ref: art.id });
  let c: any;
  try { c = JSON.parse(read.content.toString('utf8')); } catch { checks.push({ name: 'schema', status: 'fail', detail: 'Not valid JSON' }); return save(sessionId, 'comparison', 'failed', 'Comparison file is not valid JSON.', checks); }
  const schemaOk = c.schema_version === '1.0' && Array.isArray(c.rows) && Array.isArray(c.unresolved) && c.request;
  checks.push({ name: 'schema', status: schemaOk ? 'pass' : 'fail', detail: schemaOk ? 'Required fields present' : 'Missing rows, unresolved or request fields' });
  if (!schemaOk) return save(sessionId, 'comparison', 'failed', 'Comparison is missing required fields.', checks);
  const reqOk = c.request.item_id === s.request.item_id && c.request.quantity === s.request.quantity;
  checks.push({ name: 'matches_request', status: reqOk ? 'pass' : 'fail', detail: reqOk ? `Item ${c.request.item_id}, quantity ${c.request.quantity}` : `Comparison is for ${c.request.item_id} × ${c.request.quantity}, task asked for ${s.request.item_id} × ${s.request.quantity}` });

  let unverifiable = 0;
  for (const row of c.rows) {
    if (!row.source_refs?.length) { checks.push({ name: `sources:${row.vendor_id}`, status: 'fail', detail: `${row.vendor_name}: price asserted without any source reference` }); continue; }
    const authoritative: any[] = [];
    for (const ref of row.source_refs) {
      const approved = s.scope.approved_sources.some((a: any) => a.source_id === ref.source_id);
      if (!approved) { checks.push({ name: `source_approved:${ref.source_id}`, status: 'fail', detail: `${ref.source_id} is not an approved source` }); continue; }
      let src: any = null;
      try { src = ref.source_version ? await readSource(ref.source_id, ref.source_version) : null; } catch { /* unreachable */ }
      if (!src) { unverifiable++; checks.push({ name: `source_exists:${ref.source_id}`, status: 'unverified', detail: `Could not read ${ref.source_id} v${ref.source_version} from SupplierLab`, ref: ref.source_id }); continue; }
      if (src.vendor_id !== row.vendor_id || (row.product_id && src.product_id !== row.product_id)) {
        checks.push({ name: `identity:${ref.source_id}`, status: 'fail', detail: `${ref.source_id} belongs to ${src.vendor_id}/${src.product_id}, but the comparison row is ${row.vendor_id}/${row.product_id}`, ref: ref.source_id });
        continue;
      }
      authoritative.push(src);
      checks.push({ name: `source_exists:${ref.source_id}`, status: 'pass', detail: `${ref.source_id} v${ref.source_version} exists (found by ${ref.found_by} at ${ref.captured_at})`, ref: ref.source_id });
    }
    if (!authoritative.length) continue;
    const truePrices = [...new Set(authoritative.map(a => a.price_minor))];
    if (row.price_status === 'confirmed') {
      const ok = truePrices.length === 1 && truePrices[0] === row.unit_price_minor;
      checks.push({ name: `price:${row.vendor_id}`, status: ok ? 'pass' : 'fail',
        detail: ok ? `${row.vendor_name}: ${formatMinor(row.unit_price_minor)} matches the recorded source` : `${row.vendor_name}: comparison says ${formatMinor(row.unit_price_minor)}, sources say ${truePrices.map(p => formatMinor(p)).join(' / ')}` });
    } else if (row.price_status === 'conflict') {
      const ok = truePrices.length > 1 && row.conflicting_prices.every((p: any) => authoritative.find(a => a.source_id === p.source_id)?.price_minor === p.unit_price_minor);
      checks.push({ name: `price_conflict:${row.vendor_id}`, status: ok ? 'pass' : 'fail', detail: ok ? `${row.vendor_name}: conflict correctly reported with both sources` : `${row.vendor_name}: reported conflict does not match the sources` });
    } else {
      const ok = authoritative.every(a => a.price_minor === null);
      checks.push({ name: `price:${row.vendor_id}`, status: ok ? 'pass' : 'fail', detail: ok ? 'Price unknown in source' : `${row.vendor_name}: price marked unknown but a source shows ${formatMinor(authoritative[0].price_minor)}` });
    }
    if (truePrices.length > 1 && row.price_status !== 'conflict') checks.push({ name: `conflict_warning:${row.vendor_id}`, status: 'fail', detail: `${row.vendor_name}: sources disagree but no conflict warning was recorded` });
    const shown = authoritative.filter(a => a.stock_shown);
    if (shown.length === 0) {
      const ok = row.stock_status === 'unknown' && row.stock_qty === null;
      checks.push({ name: `stock:${row.vendor_id}`, status: ok ? 'pass' : 'fail', detail: ok ? `${row.vendor_name}: stock correctly marked unknown` : `${row.vendor_name}: stock asserted (${row.stock_qty}) but no source shows it` });
    } else {
      const ok = shown.some(a => a.stock_qty === row.stock_qty);
      checks.push({ name: `stock:${row.vendor_id}`, status: ok ? 'pass' : 'fail', detail: ok ? `${row.vendor_name}: ${row.stock_qty} units matches the source` : `${row.vendor_name}: stock ${row.stock_qty} does not match source (${shown.map(a => a.stock_qty).join('/')})` });
    }
  }
  // Every approved source must be either represented or explicitly unresolved.
  const covered = new Set([...c.rows.flatMap((r: any) => r.source_refs.map((x: any) => x.source_id)), ...c.unresolved.map((u: any) => u.source_id)]);
  const missing = s.scope.approved_sources.filter((a: any) => !covered.has(a.source_id));
  checks.push({ name: 'coverage', status: missing.length ? 'fail' : 'pass', detail: missing.length ? `Sources missing without explanation: ${missing.map((m: any) => m.source_id).join(', ')}` : 'Every approved source is covered or explicitly unresolved' });
  if (c.unresolved.length) checks.push({ name: 'unresolved_sources', status: 'unverified', detail: c.unresolved.map((u: any) => `${u.source_id}: ${u.reason}`).join(' · ') });

  const failed = checks.filter(x => x.status === 'fail').length;
  const status: VerifyStatus = failed ? 'failed' : c.unresolved.length ? (c.rows.length ? 'partial' : 'could_not_verify') : unverifiable ? 'could_not_verify' : 'verified';
  const summary = failed ? `${failed} check(s) failed` : status === 'partial' ? `${c.rows.length} vendor(s) verified; ${c.unresolved.length} source(s) unresolved` : status === 'verified' ? `All ${c.rows.length} vendor rows match SupplierLab` : 'Some sources could not be read';
  return save(sessionId, 'comparison', status, summary, checks);
}

export async function verifyDraft(sessionId: string) {
  const checks: Check[] = [];
  const s = loadSession(sessionId)!;
  const art = latestArtifact(sessionId, 'draft');
  if (!art) return save(sessionId, 'draft', 'missing', 'No purchase-request draft was produced.', [{ name: 'artifact_present', status: 'fail', detail: 'draft.json not found' }]);
  const read = readArtifact(sessionId, art.id)!;
  if (read.missing) return save(sessionId, 'draft', 'missing', 'The draft file recorded for this task is missing from disk.', [{ name: 'artifact_present', status: 'fail', detail: `${art.rel_path} not found`, ref: art.id }]);
  let d: any;
  try { d = JSON.parse(read.content.toString('utf8')); } catch { return save(sessionId, 'draft', 'failed', 'Draft file is not valid JSON.', [{ name: 'schema', status: 'fail', detail: 'Not valid JSON' }]); }
  checks.push({ name: 'artifact_intact', status: read.intact ? 'pass' : 'fail', detail: read.intact ? 'Draft file matches its recorded hash' : 'Draft file was modified after saving', ref: art.id });
  const cmpArt = get('SELECT * FROM artifacts WHERE id=? AND session_id=?', d.based_on?.comparison_artifact_id, sessionId);
  const linkOk = !!cmpArt && cmpArt.sha256 === d.based_on.comparison_sha256;
  checks.push({ name: 'linked_to_comparison', status: linkOk ? 'pass' : 'fail', detail: linkOk ? `Refers to comparison ${d.based_on.comparison_id} (hash matches)` : 'Draft does not reference the saved comparison by its hash', ref: d.based_on?.comparison_artifact_id });
  const cmpRead = cmpArt ? readArtifact(sessionId, cmpArt.id) : null;
  let cmpDoc: any = null;
  try { cmpDoc = cmpRead && !cmpRead.missing ? JSON.parse(cmpRead.content.toString('utf8')) : null; } catch { cmpDoc = null; }
  if (cmpArt && !cmpDoc) checks.push({ name: 'comparison_readable', status: 'fail', detail: 'The comparison this draft refers to is missing or unreadable' });
  if (cmpDoc) {
    const c = cmpDoc;
    const row = c.rows?.find((r: any) => r.vendor_id === d.supplier_id);
    const ok = row && row.price_status === 'confirmed' && row.unit_price_minor === d.unit_price_minor && row.product_id === d.product_id;
    checks.push({ name: 'matches_comparison', status: ok ? 'pass' : 'fail', detail: ok ? `${d.supplier_name} at ${formatMinor(d.unit_price_minor)} matches the comparison` : 'Supplier, product or price differs from the comparison' });
  }
  const totalOk = d.total_minor === d.quantity * d.unit_price_minor + d.shipping_minor;
  checks.push({ name: 'total', status: totalOk ? 'pass' : 'fail', detail: totalOk ? `${d.quantity} × ${formatMinor(d.unit_price_minor)} + ${formatMinor(d.shipping_minor)} shipping = ${formatMinor(d.total_minor)}` : `Total ${formatMinor(d.total_minor)} is wrong` });
  const wantQty = s.request.revised_quantity ?? s.request.quantity;
  const qtyOk = d.quantity === wantQty && d.item_id === s.request.item_id;
  checks.push({ name: 'quantity', status: qtyOk ? 'pass' : 'fail', detail: qtyOk ? `Quantity ${d.quantity} as ${s.request.revised_quantity ? `revised by you (comparison was for ${s.request.quantity})` : 'requested'}` : `Draft quantity ${d.quantity}, expected ${wantQty}` });
  if (cmpDoc) {
    const row = cmpDoc.rows?.find((r: any) => r.vendor_id === d.supplier_id);
    if (row && row.stock_qty !== null && row.stock_qty < d.quantity) checks.push({ name: 'stock_covers_quantity', status: 'fail', detail: `Draft asks for ${d.quantity} but the source showed ${row.stock_qty} in stock` });
  }
  const destOk = d.destination === s.scope.submission_destination;
  checks.push({ name: 'destination', status: destOk ? 'pass' : 'fail', detail: destOk ? `Destination ${d.destination}` : `Unexpected destination ${d.destination}` });
  const failed = checks.filter(x => x.status === 'fail').length;
  return save(sessionId, 'draft', failed ? 'failed' : 'verified', failed ? `${failed} check(s) failed` : `Draft for ${formatMinor(d.total_minor)} is consistent`, checks);
}

export async function verifySubmission(sessionId: string) {
  const checks: Check[] = [];
  const sub = get("SELECT * FROM submissions WHERE session_id=? ORDER BY created_at DESC LIMIT 1", sessionId);
  if (!sub) {
    const a = get('SELECT status FROM approvals WHERE session_id=? ORDER BY created_at DESC LIMIT 1', sessionId);
    return save(sessionId, 'submission', 'missing', a ? `No submission: approval ${a.status}.` : 'No submission was made.', [{ name: 'submission_present', status: 'fail', detail: a ? `Approval ${a.status}` : 'No approval was requested' }]);
  }
  if (sub.status === 'uncertain' || sub.status === 'submitting') {
    return save(sessionId, 'submission', 'could_not_verify', 'SupplierLab has not confirmed whether the request was saved.', [{ name: 'receipt', status: 'unverified', detail: 'No receipt yet. Use “Check SupplierLab again”.' }]);
  }
  if (sub.status !== 'saved') return save(sessionId, 'submission', 'failed', `Submission ${sub.status}.`, [{ name: 'saved', status: 'fail', detail: sub.detail || sub.status }]);
  const approval = get('SELECT * FROM approvals WHERE id=?', sub.approval_id);
  const approved = JSON.parse(approval.payload);
  let receipt: any, record: any;
  try { receipt = await readReceipt(sub.receipt_id); record = receipt ? await readRequest(receipt.request_id) : null; }
  catch { return save(sessionId, 'submission', 'could_not_verify', 'SupplierLab could not be reached to read the receipt.', [{ name: 'receipt', status: 'unverified', detail: 'SupplierLab unreachable' }]); }
  checks.push({ name: 'receipt_exists', status: receipt ? 'pass' : 'fail', detail: receipt ? `Receipt ${sub.receipt_id} exists` : `Receipt ${sub.receipt_id} not found`, ref: sub.receipt_id });
  if (!receipt || !record) return save(sessionId, 'submission', 'failed', 'Receipt or saved request missing.', checks);
  const sameReq = receipt.request_id === sub.request_id;
  checks.push({ name: 'receipt_points_to_request', status: sameReq ? 'pass' : 'fail', detail: sameReq ? `Receipt identifies request ${record.request_id}` : `Receipt points to ${receipt.request_id}, expected ${sub.request_id}` });
  checks.push({ name: 'idempotency_key', status: record.idempotency_key === sub.idempotency_key ? 'pass' : 'fail', detail: `Saved with key ${record.idempotency_key.slice(0, 14)}…` });
  const rec = record.recorded;
  for (const k of Object.keys(approved)) {
    const ok = JSON.stringify(rec[k]) === JSON.stringify(approved[k]);
    checks.push({ name: `field:${k}`, status: ok ? 'pass' : 'fail', detail: ok ? `${k} = ${JSON.stringify(rec[k])}` : `${k}: approved ${JSON.stringify(approved[k])}, saved ${JSON.stringify(rec[k])}` });
  }
  checks.push({ name: 'approval_link', status: rec.approval_id === approval.id ? 'pass' : 'fail', detail: `Saved request references approval ${rec.approval_id}` });
  const hashOk = hashPayload(rec) === receipt.recorded_hash;
  checks.push({ name: 'receipt_hash', status: hashOk ? 'pass' : 'fail', detail: hashOk ? 'Receipt hash matches the saved record' : 'Receipt hash does not match the saved record' });
  const dupes = all('SELECT COUNT(*) n FROM submissions WHERE session_id=? AND status=?', sessionId, 'saved')[0].n;
  checks.push({ name: 'single_record', status: dupes <= 1 ? 'pass' : 'fail', detail: `${dupes} saved submission(s) for this task` });
  const failed = checks.filter(x => x.status === 'fail').length;
  return save(sessionId, 'submission', failed ? 'failed' : 'verified', failed ? `${failed} mismatch(es) between approval and saved request` : `Saved request ${record.request_id} matches the approved request exactly`, checks);
}

/**
 * Open-web report: every finding must be backed by the page snapshot TaskLatch itself captured when the
 * agent recorded it. Recomputed here from the stored snapshot, not taken from the agent or the report.
 * "Verified" means source-checked (the quoted text was on that approved page), not that the claim is true.
 */
export async function verifyReport(sessionId: string) {
  const s = loadSession(sessionId)!;
  const art = latestArtifact(sessionId, 'report');
  if (!art) return save(sessionId, 'report', 'missing', 'No report was produced.', [{ name: 'artifact_present', status: 'fail', detail: 'report.json not found' }]);
  const read = readArtifact(sessionId, art.id)!;
  const checks: Check[] = [{ name: 'artifact_intact', status: read.intact ? 'pass' : 'fail', detail: read.intact ? 'Report matches its recorded hash' : 'Report changed after saving', ref: art.id }];
  let report: any;
  try { report = JSON.parse(read.content.toString('utf8')); } catch { return save(sessionId, 'report', 'failed', 'Report is not valid JSON.', checks); }
  const { assessDestination } = await import('./policy.ts');
  const { checkQuote } = await import('./quotes.ts');
  let supported = 0, unsupported = 0, emptySections = 0;
  for (const sec of report.sections || []) {
    let secSupported = 0;
    for (const f of sec.findings || []) {
      const ref = `${sec.worker.slice(-1).toUpperCase()}${f.n}`;
      if (f.superseded_by) { checks.push({ name: `superseded:${ref}`, status: 'pass', detail: `[${ref}] quote was rejected; the agent replaced it with [${sec.worker.slice(-1).toUpperCase()}${f.superseded_by}] (kept for the record, not counted)` }); continue; }
      const snap = f.snapshot_artifact ? readArtifact(sessionId, f.snapshot_artifact) : null;
      if (!snap || snap.missing || !snap.intact) { unsupported++; checks.push({ name: `finding:${ref}`, status: 'fail', detail: `[${ref}] page snapshot missing or altered`, ref: f.snapshot_artifact }); continue; }
      const text = snap.content.toString('utf8');
      const snapUrl = /^URL: (.*)$/m.exec(text)?.[1]?.trim();
      const body = text.split('\n\n').slice(1).join('\n\n');
      const sameUrl = !!snapUrl && snapUrl === f.url;
      const approved = !!f.url && assessDestination(s.scope, sec.worker, f.url).decision === 'ALLOW';
      const quoteOk = typeof f.quote === 'string' && checkQuote(body, f.quote).ok;
      if (sameUrl && approved && quoteOk) {
        supported++; secSupported++;
        checks.push({ name: `finding:${ref}`, status: 'pass', detail: `[${ref}] quote found on ${f.url} as captured by TaskLatch at ${f.captured_at}`, ref: f.snapshot_artifact });
      } else {
        unsupported++;
        checks.push({ name: `finding:${ref}`, status: 'fail', detail: `[${ref}] ${!quoteOk ? 'quoted text is not on the captured page' : !approved ? 'page is not on an approved site' : 'snapshot is of a different URL'} (${f.url})`, ref: f.snapshot_artifact });
      }
    }
    if (!secSupported) {
      emptySections++;
      checks.push({ name: `section:${sec.task_id ?? sec.worker}`, status: 'unverified', detail: `${sec.worker}: “${sec.title}” has no source-checked finding${sec.agent_summary ? ` (agent said: ${String(sec.agent_summary).slice(0, 120)})` : ''}` });
    }
  }
  // Files the agents made are agent statements: TaskLatch checks only that each is still the file it recorded.
  for (const f of report.files || []) {
    const r = readArtifact(sessionId, f.artifact);
    checks.push({ name: `file:${f.name}`, status: r && r.intact ? 'pass' : 'fail', detail: r && r.intact ? `${f.name} by ${f.author} is unchanged since it was saved (contents are not checked)` : `${f.name} is missing or changed after it was saved`, ref: f.artifact });
  }
  const sections = (report.sections || []).length;
  const status: VerifyStatus = !sections || (!supported && !unsupported) ? 'could_not_verify'
    : !supported ? 'failed' : unsupported || emptySections ? 'partial' : 'verified';
  const summary = status === 'verified' ? `All ${supported} finding(s) across ${sections} section(s) are source-checked`
    : status === 'partial' ? `${supported} source-checked, ${unsupported} not supported, ${emptySections} section(s) without evidence`
    : status === 'failed' ? `None of ${unsupported} finding(s) could be matched to the captured pages` : 'No findings were recorded';
  return save(sessionId, 'report', status, summary, checks);
}

export function latestVerifications(sessionId: string) {
  const rows = all('SELECT * FROM verification_results WHERE session_id=? ORDER BY created_at DESC, rowid DESC', sessionId);
  const out: Record<string, any> = {};
  for (const r of rows) if (!out[r.deliverable]) out[r.deliverable] = { ...r, checks: JSON.parse(r.checks) };
  return out;
}
