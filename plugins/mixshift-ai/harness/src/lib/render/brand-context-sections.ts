/**
 * Brand Context page — 19-section renderers.
 *
 * Each function takes the prepared composer state and returns HTML for one
 * section. Matches the upstream's brand-context-template.html layout but uses our
 * design-system primitives so the output respects light/dark theming and
 * sentence-case voice rules.
 *
 * Sections that depend on Phase C data (enrichment, reporting-style)
 * render graceful empty states.
 */

import {
  renderCard,
  renderTable,
  renderPill,
  renderScorecardRow,
  renderProofGrid,
  renderRuntimeGrid,
  renderConditionBlock,
  renderLaneGrid,
  renderBucketGrid,
  renderAuditSection,
  renderAnomalyBlock,
  renderStatusPill,
  formatWholePct,
  formatInt,
  escapeHtml,
  type ProofCardOptions,
  type RuntimeCardOptions,
  type ConditionBlockOptions,
  type LaneCardOptions,
  type BucketCardOptions,
  type AuditBlockOptions,
  type TableColumn,
} from './design-system.js';
import type {
  BrandContextSources,
  AuditCoverage,
  Verdict,
} from './brand-context-report.js';

// ---------------------------------------------------------------------------
// Shared composer state passed to every section
// ---------------------------------------------------------------------------

export interface ReportState {
  brand_slug: string;
  brand_name: string;
  run_date: string;
  sources: BrandContextSources;
  narrative_sections: Record<string, string>;
  coverage: AuditCoverage;
  verdict: Verdict;
  verdict_reason: string;
  /** Buckets computed from open_gaps + audit coverage. */
  buckets: BucketCardOptions[];
  /** Skill readiness rows (computed from downstream skill manifests). */
  skill_readiness: Array<{ skill: string; status: string; tone: 'complete' | 'partial' | 'missing' | 'runtime'; notes: string }>;
}

// ---------------------------------------------------------------------------
// 1. HEADER — brand name + verdict badge + freshness
// ---------------------------------------------------------------------------

export function sectionHeader(s: ReportState): string {
  // Empty — the design-system page header (renderPage) already shows the
  // brand name + subtitle. We attach the verdict via a card right under it
  // so the page chrome stays consistent across surfaces.
  const verdictTone =
    s.verdict === 'GREEN' ? 'complete' :
    s.verdict === 'YELLOW' ? 'partial' :
    s.verdict === 'RED' ? 'missing' : 'runtime';
  const freshness = s.sources.last_updated
    ? `Last updated ${s.sources.last_updated}`
    : 'Freshness unknown';
  return `<div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
  ${renderStatusPill(s.verdict, verdictTone)}
  <span style="color: var(--rc-text-sub); font-size: 12px;">${escapeHtml(freshness)}</span>
  <span style="color: var(--rc-text); font-size: 13px;">${escapeHtml(s.verdict_reason)}</span>
</div>`;
}

// ---------------------------------------------------------------------------
// 2. BRAND_SUMMARY — "What I Know About This Brand"
// ---------------------------------------------------------------------------

export function sectionBrandSummary(s: ReportState): string {
  const intel = s.sources.brand_intelligence as
    | {
        hero_narrative?: string;
        proof_points?: Array<{
          title: string;
          status: 'strong' | 'partial' | 'identified_no_counts' | 'needs_capture';
          summary: string;
          evidence?: Array<string | { label: string; href?: string }>;
        }>;
      }
    | null;
  const heroFromIntel = intel?.hero_narrative;
  const heroFallback = findSection(s.narrative_sections, ['brand identity', 'brand positioning']);
  const heroProse = heroFromIntel ?? heroFallback;
  const proofPoints = intel?.proof_points ?? [];

  const heroBlock = heroProse
    ? `<div style="padding: 14px 18px; background: var(--rc-subtle); border-left: 4px solid var(--rc-info); border-radius: 6px; margin-bottom: 14px; font-size: 14px; line-height: 1.65;">${mdToHtmlParagraphs(heroProse)}</div>`
    : `<div class="rc-empty">No brand summary yet. Add a hero narrative in <code>brand-intelligence.yaml::hero_narrative</code> or <code>narrative.md ## Brand Identity</code>.</div>`;

  const proofCards: ProofCardOptions[] = proofPoints.map((p) => ({
    title: p.title,
    status: p.status,
    body: escapeHtml(p.summary),
    sources: (p.evidence ?? []).map((e) =>
      typeof e === 'string'
        ? { label: e }
        : { label: e.label, href: e.href },
    ),
  }));

  return renderCard({
    title: 'What I know about this brand',
    body: `${heroBlock}${proofCards.length > 0 ? renderProofGrid(proofCards) : ''}`,
  });
}

// ---------------------------------------------------------------------------
// 3. REVIEW_AT_A_GLANCE — 4-card scorecard summary
// ---------------------------------------------------------------------------

export function sectionReviewAtAGlance(s: ReportState): string {
  return renderScorecardRow([
    {
      label: 'Required fields',
      value: `${s.coverage.required_present}/${s.coverage.required_total}`,
      delta: s.coverage.required_present === s.coverage.required_total
        ? { text: 'Complete', direction: 'positive' }
        : { text: `${s.coverage.required_total - s.coverage.required_present} missing`, direction: 'negative' },
    },
    {
      label: 'Recommended fields',
      value: `${s.coverage.recommended_present}/${s.coverage.recommended_total}`,
    },
    {
      label: 'Open gaps',
      value: formatInt(s.coverage.open_gaps_count),
      delta: s.coverage.open_gaps_count === 0
        ? { text: 'None', direction: 'positive' }
        : undefined,
    },
    {
      label: 'Stale fields',
      value: formatInt(s.coverage.stale_count),
      delta: s.coverage.stale_count === 0
        ? { text: 'Fresh', direction: 'positive' }
        : { text: `${s.coverage.stale_count} stale`, direction: 'negative' },
    },
  ]);
}

// ---------------------------------------------------------------------------
// 4. RUNTIME_INPUTS — artifacts supplied at downstream skill run time
// ---------------------------------------------------------------------------

export function sectionRuntimeInputs(s: ReportState): string {
  const ctx = s.sources.context as
    | { goals?: { forecast_tracking?: unknown }; delivery?: unknown }
    | null;
  const cards: RuntimeCardOptions[] = [];
  if (ctx?.goals?.forecast_tracking) {
    cards.push({
      title: 'Forecast model',
      body: `<p>Forecast tracking enabled. Supply the current month's forecast (HCAM / H-Bridge / dimension bridge) at mx-monthly-report run time.</p>`,
    });
  }
  // Other runtime cards would come from open_gaps tagged as runtime —
  // graceful empty state when nothing is documented.
  return renderCard({
    title: 'Runtime inputs required',
    body: renderRuntimeGrid(cards),
  });
}

// ---------------------------------------------------------------------------
// 5. SKILL_READINESS — table of downstream skills + status
// ---------------------------------------------------------------------------

export function sectionSkillReadiness(s: ReportState): string {
  const columns: TableColumn[] = [
    {
      key: 'skill',
      label: 'Skill',
      render: (row) => `<code style="font-size: 12px;">${escapeHtml(String(row.skill))}</code>`,
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => renderStatusPill(String(row.status), row.tone as 'complete' | 'partial' | 'missing' | 'runtime'),
    },
    { key: 'notes', label: 'Notes' },
  ];
  return renderCard({
    title: 'Skill readiness',
    body: renderTable(columns, s.skill_readiness as unknown as Array<Record<string, unknown>>),
  });
}

// ---------------------------------------------------------------------------
// 6. ACTIVE_CONDITIONS — "What I'm Watching Right Now"
// ---------------------------------------------------------------------------

export function sectionActiveConditions(s: ReportState): string {
  const ctx = s.sources.context as
    | {
        structural_events?: Array<{
          id: string;
          type: string;
          interpretation: string;
          start?: string;
          end?: string;
          active_through?: string;
        }>;
        active_watch?: Array<{ id?: string; question?: string; note?: string }>;
      }
    | null;

  const today = new Date().toISOString().slice(0, 10);
  const activeEvents = (ctx?.structural_events ?? []).filter((e) =>
    isEventActive(e, today),
  );
  const watch = ctx?.active_watch ?? [];

  const blocks: ConditionBlockOptions[] = [];
  for (const evt of activeEvents) {
    blocks.push({
      title: evt.id,
      kind: 'event',
      pill: { text: friendlyEventType(evt.type), tone: 'default' },
      body: escapeHtml(evt.interpretation),
    });
  }
  for (const w of watch) {
    blocks.push({
      title: w.id ?? 'Open watch',
      kind: 'watch',
      body: escapeHtml(w.question ?? w.note ?? ''),
    });
  }

  const quarterContext = findSection(s.narrative_sections, ['current quarter context']);
  const leadHtml = quarterContext
    ? `<div style="color: var(--rc-text-sub); font-size: 12px; font-style: italic; margin-bottom: 12px;">${mdToHtmlParagraphs(quarterContext)}</div>`
    : '';

  const body = blocks.length === 0
    ? leadHtml + '<div class="rc-empty">No active conditions documented.</div>'
    : leadHtml + blocks.map(renderConditionBlock).join('\n');

  return renderCard({
    title: "What I'm watching right now",
    body,
  });
}

// ---------------------------------------------------------------------------
// 7. ACCOUNT_SNAPSHOT — SellerIDs + targets + accounts table
// ---------------------------------------------------------------------------

export function sectionAccountSnapshot(s: ReportState): string {
  const ctx = s.sources.context as
    | {
        accounts?: Array<{
          seller_id: number;
          seller_name: string;
          account_type: string;
          marketplace?: string;
          region?: string;
          status?: string;
          role?: string;
        }>;
        management?: {
          primary_metric?: string;
          acos_target_pct?: number;
          tacos_target_pct?: number;
          tacos_goal_pct?: number;
          attribution_window_days?: number;
        };
      }
    | null;

  const accounts = ctx?.accounts ?? [];
  const m = ctx?.management ?? {};

  // TACOS-primary leads with TACOS goal. ACOS proxy only on ACOS-primary.
  const isTacosPrimary = m.primary_metric === 'TACOS';
  const primaryLabel = isTacosPrimary ? 'TACoS target' : 'ACoS target';
  const primaryValue = isTacosPrimary
    ? formatWholePct(m.tacos_target_pct ?? m.tacos_goal_pct, 0)
    : formatWholePct(m.acos_target_pct, 0);

  const scorecards = renderScorecardRow([
    { label: 'Accounts', value: formatInt(accounts.length) },
    {
      label: 'Account types',
      value: Array.from(new Set(accounts.map((a) => a.account_type))).join(' / ') || '—',
    },
    { label: primaryLabel, value: primaryValue },
    {
      label: 'Attribution window',
      value: m.attribution_window_days !== undefined ? `${m.attribution_window_days}d` : '—',
    },
  ]);

  const columns: TableColumn[] = [
    { key: 'seller_id', label: 'SellerID' },
    { key: 'seller_name', label: 'Name' },
    { key: 'account_type', label: 'Type' },
    { key: 'marketplace', label: 'Marketplace' },
    {
      key: 'status',
      label: 'Status',
      render: (row) => {
        const status = String(row.status ?? 'active');
        const tone =
          status === 'active' ? 'green' :
          status === 'wind_down' ? 'amber' : 'ghost';
        return renderPill(sentenceCase(status), tone);
      },
    },
    { key: 'role', label: 'Role' },
  ];

  const accountsTable = renderTable(
    columns,
    accounts.map((a) => ({
      seller_id: a.seller_id,
      seller_name: a.seller_name,
      account_type: a.account_type,
      marketplace: a.marketplace ?? '—',
      status: a.status ?? 'active',
      role: a.role ?? 'primary',
    })),
  );

  return renderCard({
    title: 'Account snapshot',
    body: `${scorecards}<div style="margin-top: var(--space-4);">${accountsTable}</div>`,
  });
}

// ---------------------------------------------------------------------------
// 8. SUB_BRANDS — sub-brand structure table
// ---------------------------------------------------------------------------

export function sectionSubBrands(s: ReportState): string {
  const ctx = s.sources.context as
    | { sub_brands?: Array<{ slug: string; name: string; item_groups?: string[] }> }
    | null;
  const subs = ctx?.sub_brands ?? [];
  if (subs.length === 0) {
    return renderCard({
      title: 'Sub-brand structure',
      body: '<div class="rc-empty">Single-brand account (no sub-brands documented).</div>',
    });
  }
  const columns: TableColumn[] = [
    { key: 'slug', label: 'Slug', render: (r) => `<code>${escapeHtml(String(r.slug))}</code>` },
    { key: 'name', label: 'Name' },
    {
      key: 'item_groups',
      label: 'Item groups',
      render: (r) =>
        Array.isArray(r.item_groups) && r.item_groups.length > 0
          ? (r.item_groups as string[]).map((g) => `<code style="font-size: 11px;">${escapeHtml(g)}</code>`).join(' ')
          : '<span style="color: var(--rc-text-mute);">—</span>',
    },
  ];
  return renderCard({
    title: 'Sub-brand structure',
    body: renderTable(columns, subs as unknown as Array<Record<string, unknown>>),
  });
}

// ---------------------------------------------------------------------------
// 9. ITEM_GROUPS — item groups by sub-brand
// ---------------------------------------------------------------------------

export function sectionItemGroups(s: ReportState): string {
  const ctx = s.sources.context as
    | { sub_brands?: Array<{ slug: string; name: string; item_groups?: string[] }> }
    | null;
  const subs = ctx?.sub_brands ?? [];
  const rows: Array<{ sub_brand: string; item_group: string }> = [];
  for (const sb of subs) {
    for (const ig of sb.item_groups ?? []) {
      rows.push({ sub_brand: sb.name, item_group: ig });
    }
  }
  if (rows.length === 0) {
    return renderCard({
      title: 'Item groups by sub-brand',
      body: '<div class="rc-empty">No item-group taxonomy documented.</div>',
    });
  }
  return renderCard({
    title: 'Item groups by sub-brand',
    body: renderTable(
      [
        { key: 'sub_brand', label: 'Sub-brand' },
        { key: 'item_group', label: 'Item group', render: (r) => `<code>${escapeHtml(String(r.item_group))}</code>` },
      ],
      rows as unknown as Array<Record<string, unknown>>,
    ),
  });
}

// ---------------------------------------------------------------------------
// 10. BRAND_TERMS — brand term dictionary
// ---------------------------------------------------------------------------

export function sectionBrandTerms(s: ReportState): string {
  const ctx = s.sources.context as
    | { brand_terms?: Record<string, { canonical?: string[]; variants?: string[] }> }
    | null;
  const terms = ctx?.brand_terms ?? {};
  const rows: Array<{ sub_brand: string; canonical: string; variants: string }> = [];
  for (const [subBrand, entry] of Object.entries(terms)) {
    rows.push({
      sub_brand: subBrand,
      canonical: (entry.canonical ?? []).join(', ') || '—',
      variants: (entry.variants ?? []).join(', ') || '—',
    });
  }
  if (rows.length === 0) {
    return renderCard({
      title: 'Brand term dictionary',
      body: '<div class="rc-empty">No brand terms captured yet. Phase 1 CS-19/CS-20 + Phase 2 AM variants populate this.</div>',
    });
  }
  return renderCard({
    title: 'Brand term dictionary',
    body: renderTable(
      [
        { key: 'sub_brand', label: 'Sub-brand' },
        { key: 'canonical', label: 'Canonical' },
        { key: 'variants', label: 'Variants' },
      ],
      rows as unknown as Array<Record<string, unknown>>,
    ),
  });
}

// ---------------------------------------------------------------------------
// 11. ASIN_CORPORA — lane grid (item-group / count)
// ---------------------------------------------------------------------------

export function sectionAsinCorpora(s: ReportState): string {
  const cards: LaneCardOptions[] = s.sources.corpora_summary.map((c) => ({
    name: c.filename.replace(/\.csv$/, ''),
    sub: 'rows',
    count: c.row_count,
  }));
  return renderCard({
    title: 'ASIN negation corpora',
    body: renderLaneGrid(cards),
  });
}

// ---------------------------------------------------------------------------
// 12. SEASONALITY — tentpole calendar
// ---------------------------------------------------------------------------

export function sectionSeasonality(_s: ReportState): string {
  // Static tentpole calendar plus any brand-specific seasonality from
  // context.yaml (when we add that field). For 0.5.x: render the static
  // tentpoles only.
  const tentpoles: Array<{ event: string; window: string; notes: string }> = [
    { event: 'Prime Day', window: 'mid-July', notes: 'Spend + ASP spike across SP and SD; reset baselines after.' },
    { event: 'Prime Big Deal Days', window: 'October', notes: 'Second Prime event; check year-over-year against July.' },
    { event: 'Black Friday / Cyber Monday', window: 'late November', notes: 'Highest-volume week; spend caps often hit.' },
    { event: 'Holiday peak', window: 'Dec 1–20', notes: 'Sustained elevated traffic; conversion ramps then declines.' },
    { event: 'January reset', window: 'first 2 weeks of January', notes: 'Traffic + conversion drop; ACoS often inflated.' },
  ];
  return renderCard({
    title: 'Seasonality & tentpole calendar',
    body: renderTable(
      [
        { key: 'event', label: 'Event' },
        { key: 'window', label: 'Window' },
        { key: 'notes', label: 'Notes' },
      ],
      tentpoles as unknown as Array<Record<string, unknown>>,
    ),
  });
}

// ---------------------------------------------------------------------------
// 13. CALIBRATION — attribution backfill calibration
// ---------------------------------------------------------------------------

export function sectionCalibration(s: ReportState): string {
  const ctx = s.sources.context as
    | {
        capture_rate_calibration?: {
          enabled?: boolean;
          capture_rate_pct?: number;
          fresh_day_acos_improvement_pts?: number;
          settlement_application_rule?: string;
          stability_score?: string;
        };
      }
    | null;
  const cal = ctx?.capture_rate_calibration;
  if (!cal || !cal.enabled) {
    return renderCard({
      title: 'Attribution backfill calibration',
      body: '<div class="rc-empty">Capture-rate calibration not enabled for this brand. Required when attribution window > 1 day.</div>',
    });
  }
  const rows = [
    { field: 'Capture rate', value: cal.capture_rate_pct !== undefined ? formatWholePct(cal.capture_rate_pct, 1) : '—' },
    { field: 'Fresh-day ACoS lift (pts)', value: cal.fresh_day_acos_improvement_pts !== undefined ? `${cal.fresh_day_acos_improvement_pts.toFixed(2)} pts` : '—' },
    { field: 'Settlement application rule', value: cal.settlement_application_rule ?? '—' },
    { field: 'Stability score', value: cal.stability_score ? sentenceCase(cal.stability_score) : '—' },
  ];
  return renderCard({
    title: 'Attribution backfill calibration',
    body: renderTable(
      [
        { key: 'field', label: 'Field' },
        { key: 'value', label: 'Value' },
      ],
      rows as unknown as Array<Record<string, unknown>>,
    ),
  });
}

// ---------------------------------------------------------------------------
// 14. DETECTED_ANOMALIES — enrichment advisory findings
// ---------------------------------------------------------------------------

export function sectionDetectedAnomalies(s: ReportState): string {
  const enr = s.sources.enrichment as
    | {
        stockout_candidates?: Array<{ asin?: string; item_name?: string; days_in_window?: number }>;
        brand_term_typo_candidates?: Array<{ canonical_match?: string; total_variants?: number }>;
      }
    | null;
  const blocks: string[] = [];
  if (enr?.stockout_candidates && enr.stockout_candidates.length > 0) {
    const items = enr.stockout_candidates.slice(0, 10).map(
      (sc) => `${sc.item_name ?? sc.asin ?? '(unknown)'} — ${sc.days_in_window ?? 0}d window`,
    );
    blocks.push(renderAnomalyBlock({ title: 'Stockout candidates (advisory)', items }));
  }
  if (enr?.brand_term_typo_candidates && enr.brand_term_typo_candidates.length > 0) {
    const items = enr.brand_term_typo_candidates.slice(0, 10).map(
      (c) => `${c.canonical_match ?? '(unknown)'} — ${c.total_variants ?? 0} variant(s)`,
    );
    blocks.push(renderAnomalyBlock({ title: 'Brand-term typo clusters (advisory)', items }));
  }
  return renderCard({
    title: 'Detected anomalies (advisory)',
    body: blocks.length > 0
      ? blocks.join('\n')
      : '<div class="rc-empty">No advisory findings. Phase 1.5 enrichment will populate stockout + brand-term-typo candidates here once enabled.</div>',
  });
}

// ---------------------------------------------------------------------------
// 15. BRAND_IDENTITY — prose context (narrative.md)
// ---------------------------------------------------------------------------

export function sectionBrandIdentity(s: ReportState): string {
  const identity = findSection(s.narrative_sections, ['brand identity', 'brand positioning']);
  const lang = findSection(s.narrative_sections, ['customer language samples', 'buyer language']);
  const history = findSection(s.narrative_sections, ['historical notes']);

  const blocks: string[] = [];
  if (identity) blocks.push(`<h4 style="font-size: 13px; margin: 0 0 8px;">Identity</h4>${mdToHtmlParagraphs(identity)}`);
  if (lang) blocks.push(`<h4 style="font-size: 13px; margin: 16px 0 8px;">Customer language</h4>${mdToHtmlParagraphs(lang)}`);
  if (history) blocks.push(`<h4 style="font-size: 13px; margin: 16px 0 8px;">Historical notes</h4>${mdToHtmlParagraphs(history)}`);

  return renderCard({
    title: 'Brand identity (prose context)',
    body: blocks.length > 0
      ? blocks.join('\n')
      : '<div class="rc-empty">No narrative prose yet. Add H2 sections to <code>narrative.md</code>: Brand Identity, Customer Language Samples, Historical Notes.</div>',
  });
}

// ---------------------------------------------------------------------------
// 16. OPEN_GAPS — Missing Context Buckets
// ---------------------------------------------------------------------------

export function sectionOpenGaps(s: ReportState): string {
  return renderCard({
    title: 'Missing context buckets',
    body: renderBucketGrid(s.buckets),
  });
}

// ---------------------------------------------------------------------------
// 17. AUDIT_CHECKLIST — Schema Coverage Audit (collapsible)
// ---------------------------------------------------------------------------

export function sectionAuditChecklist(s: ReportState): string {
  // Group rows by category
  const byCategory = new Map<string, AuditBlockOptions>();
  for (const row of s.coverage.rows) {
    const cat = row.label.category;
    if (!byCategory.has(cat)) {
      byCategory.set(cat, {
        title: categoryLabel(cat),
        rows: [],
      });
    }
    byCategory.get(cat)!.rows.push({
      icon: row.status,
      label: row.label.label,
      description: row.label.description,
      value: row.display,
      valueClass: row.status === 'miss' ? 'missing' : row.is_stale ? 'stale' : undefined,
    });
  }
  const blocks = Array.from(byCategory.values());
  const footer = `<b>${s.coverage.required_present}</b>/${s.coverage.required_total} required · <b>${s.coverage.recommended_present}</b>/${s.coverage.recommended_total} recommended · <b>${s.coverage.stale_count}</b> stale · <b>${s.coverage.open_gaps_count}</b> open gap(s)`;
  return renderCard({
    title: 'Schema coverage audit',
    body: renderAuditSection({
      summary: 'Reviewer view — expand to see field-by-field schema status',
      blocks,
      footer,
    }),
  });
}

// ---------------------------------------------------------------------------
// 18. FOOTER — generated-by note. (Handled by renderPage's footer; we
// suppress this section in the body to avoid double-footer.)
// ---------------------------------------------------------------------------

export function sectionFooter(_s: ReportState): string {
  // Intentionally empty — renderPage emits the design-system footer
  // (copyright + wordmark) globally.
  return '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSection(
  sections: Record<string, string>,
  candidates: string[],
): string | null {
  for (const c of candidates) {
    if (c in sections && sections[c]!.length > 0) return sections[c]!;
  }
  return null;
}

/**
 * Minimal markdown → HTML for narrative paragraphs. Handles:
 *   - Paragraph breaks (blank line)
 *   - **bold** → <strong>
 *   - *italic* → <em>
 * Anything else passes through escaped.
 */
function mdToHtmlParagraphs(md: string): string {
  const paragraphs = md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs
    .map((p) => {
      let html = escapeHtml(p);
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
      // Single newlines inside a paragraph → <br>
      html = html.replace(/\n/g, '<br>');
      return `<p style="margin: 0 0 12px;">${html}</p>`;
    })
    .join('\n');
}

function isEventActive(
  evt: { start?: string; end?: string; active_through?: string },
  today: string,
): boolean {
  if (evt.active_through && evt.active_through >= today) return true;
  if (evt.end && evt.end >= today) return true;
  if (!evt.end && !evt.active_through && evt.start) {
    // open-ended event — treat as active if start is in the past
    return evt.start <= today;
  }
  return false;
}

function friendlyEventType(t: string): string {
  const map: Record<string, string> = {
    brand_migration: 'Brand migration',
    media_spike: 'Media spike',
    media_spike_recurring: 'Recurring media spike',
    portfolio_decision: 'Portfolio decision',
    promotional_window: 'Promo window',
    promotional_window_recurring: 'Recurring promo',
    stockout: 'Stockout',
    price_test: 'Price test',
    launch: 'Launch',
  };
  return map[t] ?? sentenceCase(t);
}

function sentenceCase(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    identity: 'Account identity',
    targets: 'Management & targets',
    calibration: 'Attribution backfill calibration',
    brand_structure: 'Brand & sub-brand structure',
    bid_posture: 'Bid health & posture',
    campaign: 'Campaign structure & events',
    negation: 'Negation rules',
    reporting: 'Reporting & delivery',
    gaps: 'Open gaps & TODOs',
  };
  return map[category] ?? sentenceCase(category);
}
