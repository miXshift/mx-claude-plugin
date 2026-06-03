/**
 * Brand Context page — main composer.
 *
 * Reads all sources, computes derived state (audit coverage, verdict,
 * buckets, skill readiness), then renders the 19-section HTML page +
 * the two JSON sidecars (headline + review).
 *
 * Called by `mixshift brand render-context <slug>` and (in the future) by
 * post_execution hook of the mx-account-cold-start manifest.
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
} from './brand-context-sections.js';
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

  // 4. Compute skill readiness (per downstream skill: context + manifest contract)
  const skillReadiness = computeSkillReadiness(sources, coverage);

  // 5. Compute verdict (validator pass = required_present == required_total,
  //    which is our coverage model — we don't shell out to zod here)
  const { verdict, reason } = computeVerdict({
    coverage,
    observational: !!args.observational,
    validator_passed: coverage.required_present === coverage.required_total,
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
  };

  // 7. Render the 19-section body in template order
  const body = [
    sectionHeader(state),
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
    subtitle: `Cold-start render · ${args.runDate}`,
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
    runtime_inputs: { title: 'Runtime inputs', description: 'Forecast, HCAM, H-Bridge — supplied at skill run time, not cold-start.' },
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
): ReportState['skill_readiness'] {
  const ctx = sources.context as
    | { management?: { primary_metric?: string }; capture_rate_calibration?: { enabled?: boolean } }
    | null;
  const hasManagement = !!ctx?.management?.primary_metric;
  const requiredOk = coverage.required_present === coverage.required_total;
  const hasCalibration = !!ctx?.capture_rate_calibration?.enabled;

  const skills: Array<{ skill: string; status: string; tone: 'complete' | 'partial' | 'missing' | 'runtime'; notes: string }> = [
    {
      skill: 'mx-daily-health-check',
      status: requiredOk ? 'Ready' : 'Blocked by context',
      tone: requiredOk ? 'complete' : 'missing',
      notes: requiredOk ? 'All required context populated.' : 'Required schema fields missing.',
    },
    {
      skill: 'mx-runaway-spend-check',
      status: requiredOk ? 'Ready' : 'Blocked by context',
      tone: requiredOk ? 'complete' : 'missing',
      notes: requiredOk ? 'All required context populated.' : 'Required schema fields missing.',
    },
    {
      skill: 'mx-keyword-bid-health',
      status: requiredOk ? 'Ready' : 'Blocked by context',
      tone: requiredOk ? 'complete' : 'missing',
      notes: requiredOk ? 'All required context populated.' : 'Required schema fields missing.',
    },
    {
      skill: 'mx-monthly-report',
      status: hasManagement && hasCalibration ? 'Ready' : 'Ready with caveats',
      tone: hasManagement && hasCalibration ? 'complete' : 'partial',
      notes: hasCalibration ? 'Capture-rate calibration available.' : 'Calibration not enabled — MoM/YoY uses raw aggregates.',
    },
    {
      skill: 'mx-competitive-analysis',
      status: sources.brand_intelligence ? 'Ready' : 'Ready with caveats',
      tone: sources.brand_intelligence ? 'complete' : 'partial',
      notes: sources.brand_intelligence ? 'Brand intelligence populated.' : 'brand-intelligence.yaml missing — analysis runs without research backing.',
    },
  ];
  return skills;
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sentenceCase(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Reserved for future YAML sidecar emission (Phase C).
