/**
 * Brand Context page — main composer.
 *
 * Reads all sources, computes derived state (audit coverage, verdict,
 * buckets, skill readiness), then renders the 19-section HTML page +
 * the two JSON sidecars (headline + review).
 *
 * Called by `mixshift brand render-context <slug>` and (in the future) by
 * post_execution hook of the mx-brand-context manifest.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brandDir } from '../paths/resolve.js';
import { renderPage } from './design-system.js';
import {
  readBrandContextSources,
  parseNarrativeSections,
  computeAuditCoverage,
  computeVerdict,
  loadAuditLabels,
  type AuditCoverage,
  type Verdict,
  type BrandContextSources,
} from './brand-context-report.js';
import {
  sectionHeader,
  sectionConfidenceSummary,
  sectionBrandSummary,
  sectionReviewAtAGlance,
  sectionRuntimeInputs,
  sectionSkillReadiness,
  sectionActiveConditions,
  sectionAccountSnapshot,
  sectionSubBrands,
  sectionItemGroups,
  sectionBrandTerms,
  sectionAsinCorpora,
  sectionSeasonality,
  sectionCalibration,
  sectionDetectedAnomalies,
  sectionBrandIdentity,
  sectionOpenGaps,
  sectionAuditChecklist,
  type ReportState,
  type ResolvedFieldMap,
} from './brand-context-sections.js';
import { resolveBrandFields } from '../brain/read.js';
import { validateBrandContext } from '../context/load.js';
import type { ContextState } from './brand-context-report.js';
import type { BucketCardOptions } from './design-system.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComposeArgs {
  brandSlug: string;
  brandName: string;
  runDate: string;
  theme?: 'light' | 'dark';
  dataDirOverride?: string;
  /** Mark this as a Phase-1-only render (Phase 2 AMA still pending). */
  observational?: boolean;
}

export interface ComposeResult {
  html_path: string;
  headline_path: string;
  review_path: string;
  verdict: Verdict;
  verdict_reason: string;
  coverage: AuditCoverage;
}

/**
 * Compose all artifacts: brand-context.html, brand-context.headline.json,
 * brand-context.review.json. Returns paths + verdict for the caller.
 */
export async function composeBrandContextReport(
  args: ComposeArgs,
): Promise<ComposeResult> {
  // 1. Load sources
  const sources = await readBrandContextSources(
    args.brandSlug,
    args.runDate,
    args.dataDirOverride,
  );
  const narrativeSections = parseNarrativeSections(sources.narrative_md);

  // 2. Load audit-labels + compute coverage
  const labels = await loadAuditLabels();
  const coverage = computeAuditCoverage(sources.context, labels);

  // 3. Compute open-gap buckets
  const buckets = buildBuckets(sources, coverage);

  // 4. Skill readiness is computed below (after the brain resolve) so it is
  //    brain-aware: the Tier-2 brain unblocks skills, not just Tier-3 context.

  // 4b. Resolve every registered brand field across the tiers (Tier 3 context
  //     wins, Tier 2 brain pre-fills, null = gap). Drives the confidence
  //     markers (✓ / ⊙ / ◯). Reads context + brain once; the render is
  //     otherwise context-only, so this is the page's provenance source.
  const resolvedFields: ResolvedFieldMap = await resolveBrandFields(
    args.brandSlug,
    args.dataDirOverride,
  );

  // 5. Compute verdict. We need a PRECISE context state (absent vs malformed)
  //    so a brain-only brand renders the early "auto-discovered" state instead
  //    of a RED schema-fail. `readBrandContextSources` collapses both into a
  //    null `context`, so re-validate here to recover the distinction:
  //      file_missing  → 'absent'  (early state, never RED)
  //      malformed/schema_violation → 'invalid' (genuinely broken → RED)
  //      ok            → 'valid'   (the coverage model takes over)
  const ctxValidation = await validateBrandContext(
    args.brandSlug,
    args.dataDirOverride,
  );
  const contextState: ContextState = ctxValidation.ok
    ? 'valid'
    : ctxValidation.kind === 'file_missing'
      ? 'absent'
      : 'invalid';
  // A Tier-2 brain exists if any registered field resolved from the brain.
  const brainPresent = Object.values(resolvedFields).some(
    (r) => r?.source === 'brain',
  );

  // Brain-aware skill readiness: skills run from the brain + per-skill defaults;
  // missing AM/OCL knobs sharpen output, they don't block it. Computed here (not
  // before the brain resolve) so a brain-only brand reads "Ready", not the stale
  // "BLOCKED BY CONTEXT" the Tier-3-only check produced.
  const skillReadiness = computeSkillReadiness(
    sources,
    coverage,
    resolvedFields,
    brainPresent,
  );
  const { verdict, reason } = computeVerdict({
    coverage,
    observational: !!args.observational,
    // validator pass = required_present == required_total, our coverage model;
    // we don't shell out to zod for the coverage ladder. The precise context
    // state below is what gates the early-state vs RED branch.
    validator_passed: coverage.required_present === coverage.required_total,
    context_state: contextState,
    brain_present: brainPresent,
  });

  // 6. Build state passed to every section
  const state: ReportState = {
    brand_slug: args.brandSlug,
    brand_name: args.brandName,
    run_date: args.runDate,
    sources,
    narrative_sections: narrativeSections,
    coverage,
    verdict,
    verdict_reason: reason,
    buckets,
    skill_readiness: skillReadiness,
    resolved_fields: resolvedFields,
  };

  // 7. Render the body in template order. The header now carries the
  //    confidence framing + legend, and a "what we know" confidence summary
  //    sits right after it so the page leads with provenance.
  const body = [
    sectionHeader(state),
    sectionConfidenceSummary(state),
    sectionBrandSummary(state),
    sectionReviewAtAGlance(state),
    sectionRuntimeInputs(state),
    sectionSkillReadiness(state),
    sectionActiveConditions(state),
    sectionAccountSnapshot(state),
    sectionSubBrands(state),
    sectionItemGroups(state),
    sectionBrandTerms(state),
    sectionAsinCorpora(state),
    sectionSeasonality(state),
    sectionCalibration(state),
    sectionDetectedAnomalies(state),
    sectionBrandIdentity(state),
    sectionOpenGaps(state),
    sectionAuditChecklist(state),
    // sectionFooter intentionally omitted — renderPage emits the
    // design-system footer with copyright + wordmark.
  ].filter(Boolean).join('\n\n');

  // 8. Wrap in the design-system page chrome
  const html = await renderPage({
    title: `${args.brandName} — Brand Context`,
    subtitle: `What we know about this brand, and how sure we are · ${args.runDate}`,
    theme: args.theme ?? 'light',
    body,
  });

  // 9. Compose headline.json + review.json
  const headline = composeHeadlineJson(state);
  const review = composeReviewJson(state);

  // 10. Write all three files
  const dir = brandDir(args.brandSlug, args.dataDirOverride);
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, 'brand-context.html');
  const headlinePath = join(dir, 'brand-context.headline.json');
  const reviewPath = join(dir, 'brand-context.review.json');
  await Promise.all([
    writeFile(htmlPath, html, 'utf-8'),
    writeFile(headlinePath, JSON.stringify(headline, null, 2), 'utf-8'),
    writeFile(reviewPath, JSON.stringify(review, null, 2), 'utf-8'),
  ]);

  return {
    html_path: htmlPath,
    headline_path: headlinePath,
    review_path: reviewPath,
    verdict,
    verdict_reason: reason,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Bucket classification — turn open_gaps + audit coverage into bucket cards
// ---------------------------------------------------------------------------

function buildBuckets(
  sources: BrandContextSources,
  coverage: AuditCoverage,
): BucketCardOptions[] {
  const buckets: BucketCardOptions[] = [];
  const ctx = sources.context as
    | { open_gaps?: Array<{ id?: string; description?: string; category?: string }> }
    | null;
  const openGaps = ctx?.open_gaps ?? [];

  // Group open_gaps by category (default 'operating_rules' when unspecified).
  const byCategory = new Map<string, Array<{ id?: string; description?: string }>>();
  for (const gap of openGaps) {
    const category = gap.category ?? 'operating_rules';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(gap);
  }

  const categoryMeta: Record<string, { title: string; description: string }> = {
    operating_rules: { title: 'Operating rules', description: 'Targets, posture, thresholds the AM still needs to set.' },
    brand_voice: { title: 'Brand voice & buyer language', description: 'Customer-language samples and brand identity prose.' },
    product_coverage: { title: 'Product & ASIN coverage', description: 'Item-group taxonomy, hero SKUs, conquesting catalog.' },
    reporting_setup: { title: 'Reporting setup', description: 'Audience, voice-lint, monthly-report style preferences.' },
    runtime_inputs: { title: 'Runtime inputs', description: 'Forecast, HCAM, H-Bridge: supplied at skill run time, not during brand setup.' },
    accepted: { title: 'Accepted gaps', description: 'Explicitly acknowledged; not blocking.' },
  };

  for (const [cat, items] of byCategory.entries()) {
    const meta = categoryMeta[cat] ?? { title: sentenceCase(cat), description: '' };
    const tone =
      cat === 'runtime_inputs' ? 'runtime' :
      cat === 'accepted' ? 'complete' :
      items.length === 0 ? 'complete' : 'partial';
    buckets.push({
      title: meta.title,
      status: tone,
      description: meta.description,
      summary: `${items.length} item(s) in this bucket.`,
      details: items.length > 0
        ? {
            label: 'Show items',
            items: items.map((g) => g.description ?? g.id ?? '(unspecified)'),
          }
        : undefined,
    });
  }

  // If no open_gaps at all and verdict surface is clean, show a Complete bucket.
  if (buckets.length === 0 && coverage.required_present === coverage.required_total) {
    buckets.push({
      title: 'Context coverage',
      status: 'complete',
      description: 'All required + recommended fields populated; no open gaps documented.',
    });
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Skill readiness — basic version for 0.5.x
// ---------------------------------------------------------------------------

function computeSkillReadiness(
  sources: BrandContextSources,
  coverage: AuditCoverage,
  resolvedFields: ResolvedFieldMap,
  brainPresent: boolean,
): ReportState['skill_readiness'] {
  const ctx = sources.context as { accounts?: unknown[] } | null;
  // Pivot model: the Tier-2 brain unblocks skills. A brand is runnable once it
  // is bootstrapped (accounts present) AND has a brain or confirmed context;
  // unset AM/OCL knobs fall back to per-skill defaults, which sharpen output but
  // never block it. The ONLY true blocker is a brand that was never bootstrapped.
  const bootstrapped =
    (Array.isArray(ctx?.accounts) && ctx.accounts.length > 0) || brainPresent;
  const requiredOk = coverage.required_present === coverage.required_total;

  const tier: 'context' | 'brain' | 'partial' | 'defaults' = requiredOk
    ? 'context'
    : brainPresent
      ? 'brain'
      : ctx
        ? 'partial'
        : 'defaults';
  const readyNote =
    tier === 'context'
      ? 'All required context confirmed.'
      : tier === 'brain'
        ? 'Running from the brand brain plus skill defaults; confirm context or set OCL knobs to sharpen.'
        : tier === 'partial'
          ? 'Partial context; unset fields fall back to skill defaults.'
          : 'No brain or context yet; runs on skill defaults. Run `mixshift brand brain fetch` to sharpen.';
  const readyTone: 'complete' | 'partial' = tier === 'context' ? 'complete' : 'partial';

  const notBootstrapped = {
    status: 'Blocked',
    tone: 'missing' as const,
    notes: 'Brand not bootstrapped: run `mixshift brand add <slug>` first.',
  };
  const analytical = (skill: string) =>
    bootstrapped
      ? { skill, status: 'Ready', tone: readyTone, notes: readyNote }
      : { skill, ...notBootstrapped };

  // monthly-report: capture-rate calibration now comes from the brain too, so it
  // is "available" whenever the brain (or context) resolved it.
  const calib =
    resolvedFields['daily_settlement_curve'] ??
    resolvedFields['capture_rate_calibration'];
  const monthly = !bootstrapped
    ? { skill: 'mx-monthly-report', ...notBootstrapped }
    : calib
      ? {
          skill: 'mx-monthly-report',
          status: 'Ready',
          tone: 'complete' as const,
          notes: `Capture-rate calibration available (${calib.source === 'brain' ? 'from brand brain' : 'context-confirmed'}).`,
        }
      : {
          skill: 'mx-monthly-report',
          status: 'Ready with caveats',
          tone: 'partial' as const,
          notes: 'Calibration not set yet; MoM/YoY uses raw aggregates until the brain fetches it.',
        };

  return [
    analytical('mx-daily-health-check'),
    analytical('mx-runaway-spend-check'),
    analytical('mx-keyword-bid-health'),
    monthly,
  ];
}

// ---------------------------------------------------------------------------
// headline.json — ~500-token model summary
// ---------------------------------------------------------------------------

function composeHeadlineJson(s: ReportState): Record<string, unknown> {
  const ctx = s.sources.context as
    | { management?: { primary_metric?: string; acos_target_pct?: number; tacos_target_pct?: number; attribution_window_days?: number }; accounts?: Array<{ seller_id: number; account_type: string }> }
    | null;
  return {
    schema_version: 1,
    brand_slug: s.brand_slug,
    brand_name: s.brand_name,
    run_date: s.run_date,
    verdict: s.verdict,
    verdict_reason: s.verdict_reason,
    headline_metrics: {
      required_present: s.coverage.required_present,
      required_total: s.coverage.required_total,
      recommended_present: s.coverage.recommended_present,
      recommended_total: s.coverage.recommended_total,
      stale_count: s.coverage.stale_count,
      open_gaps_count: s.coverage.open_gaps_count,
    },
    context_snapshot: ctx
      ? {
          primary_metric: ctx.management?.primary_metric,
          acos_target_pct: ctx.management?.acos_target_pct,
          tacos_target_pct: ctx.management?.tacos_target_pct,
          attribution_window_days: ctx.management?.attribution_window_days,
          account_count: ctx.accounts?.length ?? 0,
          account_types: Array.from(new Set((ctx.accounts ?? []).map((a) => a.account_type))),
        }
      : null,
    artifacts: {
      html_path: 'brand-context.html',
      review_path: 'brand-context.review.json',
    },
  };
}

// ---------------------------------------------------------------------------
// review.json — compact machine map for downstream skills
// ---------------------------------------------------------------------------

function composeReviewJson(s: ReportState): Record<string, unknown> {
  return {
    schema_version: 1,
    brand_slug: s.brand_slug,
    run_date: s.run_date,
    verdict: s.verdict,
    coverage: {
      required_present: s.coverage.required_present,
      required_total: s.coverage.required_total,
      recommended_present: s.coverage.recommended_present,
      recommended_total: s.coverage.recommended_total,
      stale_count: s.coverage.stale_count,
      open_gaps_count: s.coverage.open_gaps_count,
    },
    buckets: s.buckets.map((b) => ({
      title: b.title,
      status: b.status,
      description: b.description,
      summary: b.summary,
      item_count: b.details?.items.length ?? 0,
    })),
    skill_readiness: s.skill_readiness,
    // Per-field provenance behind the ✓ / ⊙ / ◯ markers, machine-readable for
    // downstream skills (confirmed = Tier-3 context, prefilled = Tier-2 brain,
    // gap = neither). Counts let a consumer gauge confidence at a glance.
    confidence: composeConfidenceSummary(s),
    audit_rows: s.coverage.rows.map((r) => ({
      path: r.label.path,
      category: r.label.category,
      tier: r.label.tier,
      status: r.status,
      value: r.display,
      is_stale: r.is_stale,
    })),
  };
}

/**
 * Reduce the resolved-field map to a compact provenance summary: per-field
 * level + counts. Mirrors the ✓ / ⊙ / ◯ the HTML shows.
 */
function composeConfidenceSummary(s: ReportState): {
  confirmed: number;
  prefilled: number;
  gap: number;
  fields: Record<string, { level: 'confirmed' | 'prefilled' | 'gap'; source: 'context' | 'brain' | null; fetched_at?: string }>;
} {
  const fields: Record<
    string,
    { level: 'confirmed' | 'prefilled' | 'gap'; source: 'context' | 'brain' | null; fetched_at?: string }
  > = {};
  let confirmed = 0;
  let prefilled = 0;
  let gap = 0;
  for (const [key, resolved] of Object.entries(s.resolved_fields)) {
    if (resolved == null) {
      gap++;
      fields[key] = { level: 'gap', source: null };
    } else if (resolved.source === 'context') {
      confirmed++;
      fields[key] = { level: 'confirmed', source: 'context' };
    } else {
      prefilled++;
      fields[key] = { level: 'prefilled', source: 'brain', fetched_at: resolved.fetched_at };
    }
  }
  return { confirmed, prefilled, gap, fields };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sentenceCase(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Reserved for future YAML sidecar emission (Phase C).
