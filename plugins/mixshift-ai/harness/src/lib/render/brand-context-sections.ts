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
  renderConfidenceMarker,
  renderConfidenceGlyph,
  renderConfidenceLegend,
  renderConfidenceList,
  renderSetHint,
  formatWholePct,
  formatInt,
  escapeHtml,
  type Confidence,
  type ConfidenceListItem,
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
import { BRAND_FIELD_KEYS, type BrandFieldKey, type ResolvedField } from '../brain/read.js';

/** The resolved registered-field map, as `resolveBrandFields(slug)` returns. */
export type ResolvedFieldMap = Record<
  BrandFieldKey,
  ResolvedField<unknown> | null
>;

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
  /** Cross-tier resolution of every registered brand field (lib/brain/read
   *  `resolveBrandFields`). Drives the confidence markers: ✓ context = you
   *  confirmed it, ⊙ brain = pre-filled, ◯ null = gap. */
  resolved_fields: ResolvedFieldMap;
}

// ---------------------------------------------------------------------------
// Confidence helpers — the ✓ / ⊙ / ◯ provenance markers shared across sections
// ---------------------------------------------------------------------------

/** Map a resolved-field entry to its confidence level. */
function levelOf(resolved: ResolvedField<unknown> | null | undefined): Confidence {
  if (resolved == null) return 'gap';
  return resolved.source === 'context' ? 'confirmed' : 'prefilled';
}

/** Confidence of a REGISTERED brand field, straight from the resolver. */
function fieldConfidence(s: ReportState, key: BrandFieldKey): Confidence {
  return levelOf(s.resolved_fields[key]);
}

/** A pre-filled value's fetched_at, as a short "pre-filled <date>" note. */
function prefilledNote(resolved: ResolvedField<unknown> | null | undefined): string | undefined {
  if (resolved == null || resolved.source !== 'brain') return undefined;
  return resolved.fetched_at ? `pre-filled ${shortDate(resolved.fetched_at)}` : 'pre-filled';
}

/** Confidence for a NON-registered context value: present -> ✓, absent -> ◯. */
function presenceConfidence(present: boolean): Confidence {
  return present ? 'confirmed' : 'gap';
}

/** Glyph + (for pre-filled) fetched_at note, for inline use next to a heading. */
function markerFor(s: ReportState, key: BrandFieldKey): string {
  const resolved = s.resolved_fields[key];
  return renderConfidenceMarker({ level: levelOf(resolved), note: prefilledNote(resolved) });
}

/** Trim an ISO timestamp to YYYY-MM-DD for compact display. */
function shortDate(v: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v;
}

// ---------------------------------------------------------------------------
// 1. HEADER — brand name + verdict badge + freshness
// ---------------------------------------------------------------------------

export function sectionHeader(s: ReportState): string {
  // The design-system page header (renderPage) already shows the brand name +
  // subtitle. We attach the verdict + a one-line framing + the confidence key
  // right under it so the page reads "what we know about this brand, and how
  // sure we are."
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
</div>
<p style="color: var(--rc-text-sub); font-size: 13px; margin: 12px 0 8px; line-height: 1.55;">What we know about this brand, and how sure we are. Each field below is marked ${renderConfidenceGlyph('confirmed')} confirmed, ${renderConfidenceGlyph('prefilled')} pre-filled, or ${renderConfidenceGlyph('gap')} not set yet.</p>
${renderConfidenceLegend()}`;
}

// ---------------------------------------------------------------------------
// 2a. CONFIDENCE_SUMMARY — "What we know, and how sure we are"
//
// The single roll-up of every registered brand field with its provenance
// marker. Sourced entirely from `resolveBrandFields` (Tier 3 context wins,
// Tier 2 brain pre-fills, null = gap). Gaps carry a paste-ready set hint.
// ---------------------------------------------------------------------------

/** Human labels for the registered brand fields (sentence case). */
const FIELD_LABELS: Record<BrandFieldKey, string> = {
  acos_target_pct: 'ACoS target',
  sub_brands: 'Sub-brands',
  marketplace: 'Marketplace',
  primary_metric: 'Primary metric',
  attribution_window_days: 'Attribution window (days)',
  tacos_goal_pct: 'TACoS goal',
  posture_stance: 'Posture stance',
  posture_multiplier: 'Bid-cut intensity',
  monthly_total_sales_target: 'Monthly sales target',
  quarterly_total_sales_target: 'Quarterly sales target',
  protected_terms: 'Protected terms',
  lane_rules: 'Lane-based negation rules',
  campaign_naming_pattern: 'Campaign naming pattern',
  structural_events: 'Structural events',
  paused_campaigns: 'Paused campaigns',
  monthly_budget: 'Monthly budget',
  recent_spend_30d: '30-day spend',
  recent_acos_30d: '30-day ACoS',
  item_groups: 'Item groups',
  hero_asins: 'Hero ASINs',
  capture_rate_calibration: 'Capture-rate calibration',
  daily_settlement_curve: 'Daily settlement curve',
  stockouts: 'Stockout windows',
  brand_term_typos: 'Brand-term typos',
};

/** Percent-style fields render with a trailing %. */
const PCT_FIELDS = new Set<BrandFieldKey>([
  'acos_target_pct',
  'tacos_goal_pct',
  'recent_acos_30d',
]);

/** Money-style fields render with a $ + thousands separators. */
const MONEY_FIELDS = new Set<BrandFieldKey>([
  'monthly_total_sales_target',
  'quarterly_total_sales_target',
  'monthly_budget',
  'recent_spend_30d',
]);

/** Format a resolved value for the confidence list (compact, escaped-safe). */
function formatResolvedValue(key: BrandFieldKey, value: unknown): string {
  if (Array.isArray(value)) {
    const n = value.length;
    // Show names for the small structured lists; counts for the rest.
    if (key === 'sub_brands') {
      const names = value
        .map((v) => (v && typeof v === 'object' ? (v as { name?: string; slug?: string }).name ?? (v as { slug?: string }).slug : String(v)))
        .filter(Boolean);
      return names.length > 0 ? `${n}: ${names.join(', ')}` : `${n} entries`;
    }
    if (key === 'protected_terms' || key === 'item_groups') {
      const head = value.slice(0, 4).map(String).join(', ');
      return n > 4 ? `${n}: ${head}, …` : `${n}: ${head}`;
    }
    return `${n} ${n === 1 ? 'entry' : 'entries'}`;
  }
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value as Record<string, unknown>).length;
    return `${n} ${n === 1 ? 'entry' : 'entries'}`;
  }
  if (typeof value === 'number') {
    if (PCT_FIELDS.has(key)) return formatWholePct(value, 0);
    if (MONEY_FIELDS.has(key)) return `$${formatInt(value)}`;
    return String(value);
  }
  return String(value);
}

export function sectionConfidenceSummary(s: ReportState): string {
  const items: ConfidenceListItem[] = BRAND_FIELD_KEYS.map((key) => {
    const resolved = s.resolved_fields[key];
    const level = levelOf(resolved);
    const value = resolved ? formatResolvedValue(key, resolved.value) : '';
    // Gaps and pre-filled values both get a set/confirm hint; confirmed ones
    // don't need one. Keep it lightweight (a single inline code snippet).
    const hint =
      level === 'gap' || level === 'prefilled'
        ? renderSetHint({ field: key, brand: s.brand_slug })
        : undefined;
    return {
      label: FIELD_LABELS[key],
      level,
      value,
      note: prefilledNote(resolved),
      hint,
    };
  });

  const confirmed = items.filter((i) => i.level === 'confirmed').length;
  const prefilled = items.filter((i) => i.level === 'prefilled').length;
  const gaps = items.filter((i) => i.level === 'gap').length;
  const tally = `<div style="color: var(--rc-text-sub); font-size: 12px; margin-bottom: 12px;">${renderConfidenceGlyph('confirmed')} ${confirmed} confirmed · ${renderConfidenceGlyph('prefilled')} ${prefilled} pre-filled · ${renderConfidenceGlyph('gap')} ${gaps} not set yet</div>`;

  return renderCard({
    title: 'What we know, and how sure we are',
    body: `${tally}${renderConfidenceList(items)}`,
  });
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
      body: `<p>Forecast tracking enabled. Supply the current month's forecast (H-Bridge / dimension bridge) at mx-monthly-report run time.</p>`,
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

  // structural_events is a registered field — its marker reflects whether the
  // event log is set, independent of which events are active today.
  return renderCard({
    title: "What I'm watching right now",
    title_accessory: markerFor(s, 'structural_events'),
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
          tacos_goal_pct?: number;
          attribution_window_days?: number;
        };
      }
    | null;

  const accounts = ctx?.accounts ?? [];
  const m = ctx?.management ?? {};

  // TACOS-primary leads with TACOS goal. ACOS proxy only on ACOS-primary.
  // tacos_goal_pct is the canonical field; the deprecated tacos_target_pct
  // alias is normalized onto it by lib/context/load.ts before this renderer
  // ever sees the context, so only tacos_goal_pct needs to be read here.
  const isTacosPrimary = m.primary_metric === 'TACOS';
  const primaryLabel = isTacosPrimary ? 'TACoS goal' : 'ACoS target';
  const primaryValue = isTacosPrimary
    ? formatWholePct(m.tacos_goal_pct, 0)
    : formatWholePct(m.acos_target_pct, 0);
  // The primary-target scorecard tracks the metric that actually leads:
  // tacos_goal_pct on TACOS-primary accounts, acos_target_pct otherwise.
  const primaryTargetLevel: Confidence = isTacosPrimary
    ? fieldConfidence(s, 'tacos_goal_pct')
    : fieldConfidence(s, 'acos_target_pct');

  // Scorecard labels are plain text (renderScorecard escapes them). Each
  // scorecard's per-field provenance is surfaced in the annotation row below
  // and in the "what we know" summary; here we use the marker-bearing label
  // helper that renders the glyph as a leading word the scorecard can show.
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

  // Primary metric, target, attribution window, and marketplace are all
  // registered fields — surface their confidence as a one-line annotation
  // under the title (the scorecards themselves stay plain text).
  const targetSetHint =
    primaryTargetLevel === 'gap'
      ? renderSetHint({ field: isTacosPrimary ? 'tacos_goal_pct' : 'acos_target_pct', brand: s.brand_slug })
      : '';
  const annot = `<div style="margin-bottom: 12px; color: var(--rc-text-sub); font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap;">
  <span>${markerFor(s, 'primary_metric')} Primary metric: ${escapeHtml(String(m.primary_metric ?? 'not set yet'))}</span>
  <span>${renderConfidenceMarker({ level: primaryTargetLevel })} ${escapeHtml(primaryLabel)}: ${escapeHtml(primaryValue)}${targetSetHint}</span>
  <span>${markerFor(s, 'attribution_window_days')} Attribution window: ${escapeHtml(m.attribution_window_days !== undefined ? `${m.attribution_window_days}d` : 'not set yet')}</span>
  <span>${markerFor(s, 'marketplace')} Marketplace: ${escapeHtml(marketplaceDisplay(accounts))}</span>
</div>`;

  return renderCard({
    title: 'Account snapshot',
    body: `${annot}${scorecards}<div style="margin-top: var(--space-4);">${accountsTable}</div>`,
  });
}

/** First account's marketplace (the registry resolves `accounts.0.marketplace`). */
function marketplaceDisplay(
  accounts: Array<{ marketplace?: string }>,
): string {
  const mk = accounts[0]?.marketplace;
  return mk && mk.length > 0 ? mk : 'not set yet';
}

// ---------------------------------------------------------------------------
// 8. SUB_BRANDS — sub-brand structure table
// ---------------------------------------------------------------------------

export function sectionSubBrands(s: ReportState): string {
  const ctx = s.sources.context as
    | { sub_brands?: Array<{ slug: string; name: string; item_groups?: string[] }> }
    | null;
  const subs = ctx?.sub_brands ?? [];
  // sub_brands is a registered field (context wins, brain pre-fills) — its
  // marker reflects provenance even when the displayed table is from context.
  const marker = markerFor(s, 'sub_brands');

  if (subs.length === 0) {
    // Distinguish a true gap (no sub-brand info in either tier) from a
    // deliberate single-brand account. The resolver tells us which.
    const level = fieldConfidence(s, 'sub_brands');
    const body =
      level === 'gap'
        ? `<div class="rc-empty">Single-brand account, or sub-brands not set yet. ` +
          `${renderSetHint({ field: 'sub_brands', brand: s.brand_slug })}</div>`
        : '<div class="rc-empty">Single-brand account (no sub-brands documented).</div>';
    return renderCard({ title: 'Sub-brand structure', title_accessory: marker, body });
  }

  const itemGroupsHtml = (groups: string[] | undefined): string =>
    Array.isArray(groups) && groups.length > 0
      ? groups.map((g) => `<code style="font-size: 11px;">${escapeHtml(g)}</code>`).join(' ')
      : '<span style="color: var(--rc-text-mute);">—</span>';

  // Scale-aware rendering: 1 -> inline one-liner; 2-4 -> compact list;
  // 5+ -> summarized roll-up (count + names, no giant table). The underlying
  // data is preserved in all three modes.
  let body: string;
  if (subs.length === 1) {
    const sb = subs[0]!;
    body = `<p style="margin: 0; font-size: 13px; line-height: 1.6;">One sub-brand: <strong>${escapeHtml(sb.name)}</strong> <code>${escapeHtml(sb.slug)}</code>${
      sb.item_groups && sb.item_groups.length > 0
        ? ` — item groups: ${itemGroupsHtml(sb.item_groups)}`
        : ''
    }</p>`;
  } else if (subs.length <= 4) {
    const lis = subs
      .map(
        (sb) =>
          `<li style="margin-bottom: 6px; line-height: 1.5;"><strong>${escapeHtml(sb.name)}</strong> <code style="font-size: 11px;">${escapeHtml(sb.slug)}</code>${
            sb.item_groups && sb.item_groups.length > 0
              ? `<br><span style="color: var(--rc-text-sub); font-size: 11.5px;">${itemGroupsHtml(sb.item_groups)}</span>`
              : ''
          }</li>`,
      )
      .join('\n');
    body = `<ul style="list-style: none; padding: 0; margin: 0;">${lis}</ul>`;
  } else {
    // 5+ — roll-up: count + names as chips, item-group total, no per-row table.
    const names = subs
      .map((sb) => `<span class="rc-pill is-ghost">${escapeHtml(sb.name)}</span>`)
      .join(' ');
    const totalGroups = new Set(subs.flatMap((sb) => sb.item_groups ?? [])).size;
    body = `<p style="margin: 0 0 10px; font-size: 13px;"><strong>${subs.length}</strong> sub-brands spanning <strong>${totalGroups}</strong> item group${totalGroups === 1 ? '' : 's'}.</p>
<div style="display: flex; flex-wrap: wrap; gap: 5px;">${names}</div>`;
  }

  return renderCard({ title: 'Sub-brand structure', title_accessory: marker, body });
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
  // item_groups is a registered (brain-derived) field — show its provenance.
  const marker = markerFor(s, 'item_groups');
  if (rows.length === 0) {
    return renderCard({
      title: 'Item groups by sub-brand',
      title_accessory: marker,
      body: '<div class="rc-empty">No item-group taxonomy documented.</div>',
    });
  }
  return renderCard({
    title: 'Item groups by sub-brand',
    title_accessory: marker,
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
  // brand_terms is a non-registered context section — presence-based marker.
  const marker = renderConfidenceMarker({ level: presenceConfidence(rows.length > 0) });
  if (rows.length === 0) {
    return renderCard({
      title: 'Brand term dictionary',
      title_accessory: marker,
      body: '<div class="rc-empty">No brand terms captured yet. The Brand Brain catalog and Phase 2 AM variants populate this.</div>',
    });
  }
  return renderCard({
    title: 'Brand term dictionary',
    title_accessory: marker,
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
  // Non-registered context section: ✓ when calibration is enabled, ◯ otherwise.
  const marker = renderConfidenceMarker({ level: presenceConfidence(!!cal?.enabled) });
  if (!cal || !cal.enabled) {
    return renderCard({
      title: 'Attribution backfill calibration',
      title_accessory: marker,
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
    title_accessory: marker,
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
        brand_term_typo_candidates?: Array<{ canonical_match?: string; variant_count?: number }>;
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
      (c) => `${c.canonical_match ?? '(unknown)'} — ${c.variant_count ?? 0} variant(s)`,
    );
    blocks.push(renderAnomalyBlock({ title: 'Brand-term typo clusters (advisory)', items }));
  }
  return renderCard({
    title: 'Detected anomalies (advisory)',
    body: blocks.length > 0
      ? blocks.join('\n')
      : '<div class="rc-empty">No advisory findings. The brand brain populates stockout + brand-term-typo candidates here as it detects them.</div>',
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
