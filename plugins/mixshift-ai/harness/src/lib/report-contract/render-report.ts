/**
 * render-report.ts — the single HTML writer for the smart-tier monthly
 * report. Reads a validated report-data document (the same Figure /
 * Derived / Claim / Section composition `validate.ts` checks at the render
 * seam) and emits deterministic, self-contained HTML. Corrections go to the
 * document, never to this file's output: `renderMonthlyReport` is a pure
 * function of its input — same document in, byte-identical HTML out. No
 * `Date.now()`, no `Math.random()`, no host-locale formatting (every number
 * goes through `toLocaleString('en-US', ...)` with an explicit locale).
 *
 * Reference: `render-monthly-report.py` (mpr-v2 handover). That script's
 * document shape is a section-type registry (title_block / kpi_heroes /
 * bottom_line / ...) driving a full page layout. This project's report-data
 * document is the flatter, traceability-first shape `validate.ts` defines
 * instead — figures carrying unit/basis/caveats, sections that are
 * quotation sites (figure_refs + claim_refs + caveats_rendered +
 * display_text), no section "type" registry at all. So this renderer
 * reimplements the reference's BEHAVIORS against that shape rather than
 * porting its section functions 1:1:
 *
 *   1. A figure's displayed value is formatted from its unit + precision —
 *      never hand-formatted in prose. `formatFigureValue` mirrors the
 *      reference's `fmt_spec_text` unit switch (currency / currency_abbrev /
 *      count / ratio / percent / points / item_days / weeks / raw), EXTENDED
 *      with the analysis engine's own unit vocabulary (currency-2dp / number
 *      / number-2dp / percent-points, plus the contribution-scale tokens bps
 *      / bps-1dp / pts / ratio-2dp) and our extractor's `points_fraction`.
 *      An unrecognized unit renders the number WITH its token rather than
 *      falling through to a bare number — see `formatFigureValue`.
 *   2. Visual accent (positive/negative) derives ONLY from the value's sign
 *      via `figureAccentClass` — never from prose tone. Mirrors
 *      `fmt_spec_class`'s auto / auto_invert split (auto_invert: a rise is
 *      bad, e.g. TACoS/ACoS).
 *   3. Shared blocks — content that must appear at more than one quotation
 *      site with byte-identical rendering — are authored once under
 *      `doc.shared_blocks` and injected via a section whose only job is
 *      `{id, shared_block_ref}`. The render is memoized per ref so every
 *      injection site reuses the exact same string. Mirrors the reference's
 *      `shared_ref` section type.
 *   4. Forecast-dependent content (`kind: 'forecast'`, a display-only
 *      extension — see below) renders only when `doc.forecast.state` is
 *      `'provided_current'`. Mirrors `CONDITIONAL_FORECAST_SECTIONS`.
 *   5. A section's `caveats_rendered` list is rendered inline at that exact
 *      section — independently at every site that quotes the flagged
 *      figure, per `CAVEAT-1`.
 *   6. A figure with `unit: 'item_days'` never renders as plain "N days" —
 *      `formatFigureValue` emits "N item-day(s)", which never matches
 *      `validate.ts`'s `DAYS_TEXT` regex (mirrors `UNIT-1`).
 *   7. This file does not correct, invalidate, or re-run
 *      `validateReportData` — that is a separate pass the assembly pipeline
 *      runs before handing the document here. This renderer only formats
 *      and lays out whatever it is given.
 *
 * Display-only extensions: `validate.ts`'s `Figure` / `Derived` / `Section`
 * carry only what the semantic validator needs. This renderer needs a
 * little more presentation metadata (should this figure show a sign? what
 * accent? is this section a forecast section or a shared-block pointer?).
 * Those fields live in `FigureDisplay` / `SectionDisplay` below and are
 * layered onto the validator's types via `RenderReportDataDocument` — never
 * added to `validate.ts` itself. All of them are optional; a document with
 * none of them still renders (plainly — no signs, no accent, no
 * suppression, no sharing).
 *
 * Prose convention (matches the reference's own split): `display_text` and
 * shared-block prose are pre-composed by the report-assembly pass and
 * rendered RAW — not re-escaped — so an intentional HTML entity
 * (`&mdash;`, `&nbsp;`) authored into the prose survives. HTML-safety of
 * that text is the assembly pass's responsibility, exactly as the
 * reference's `render_bottom_line` / `render_narrative` treat their prose
 * fields. Everything else this renderer emits from structured data (labels,
 * formatted values, caveat text) is escaped.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { designSystemDir, escapeHtml, escapeAttr } from '../render/design-system.js';
import type {
  ReportDataDocument,
  Figure,
  Derived,
  Claim,
  Section,
  FigureCommon,
  CaveatRegistryEntry,
} from './validate.js';

// ---------------------------------------------------------------------------
// Display-only extensions (never part of the report-contract validator
// schema — see file header)
// ---------------------------------------------------------------------------

export interface FigureDisplay {
  /** Digits after the decimal point for the figure's unit. `Figure` already
   *  declares this; `Derived` does not, so it is re-declared here as a
   *  display-only fallback available on either shape. Unit-specific
   *  defaults apply when omitted (see `formatFigureValue`). */
  precision?: number;
  /** Render an explicit leading "+" on a positive value (deltas). Negative
   *  values always render with the typographic minus, signed or not. */
  signed?: boolean;
  /** 'auto': positive is good (green), negative is bad (red). 'auto_invert':
   *  a rise is bad (TACoS/ACoS-style metrics) — the sign check flips.
   *  'none' or absent: no accent class at all. Derived ONLY from the
   *  numeric sign of `value`, never from surrounding prose. */
  accent?: 'auto' | 'auto_invert' | 'none';
  /** Literal text appended after the formatted number. */
  suffix?: string;
}

export interface SectionDisplay {
  /** Sentence-case heading shown above the section's prose. Omit for a
   *  heading-less block (e.g. a Bottom Line injected without its own
   *  visible title). */
  title?: string;
  /** 'forecast' sections/blocks render ONLY when the document's forecast is
   *  marked provided-current. Default 'standard' (always renders, subject
   *  to no other gate). */
  kind?: 'standard' | 'forecast';
  /** When set, this section is a thin pointer: its own `title` /
   *  `display_text` / `figure_refs` / `claim_refs` / `caveats_rendered` are
   *  ignored, and the content of `doc.shared_blocks[shared_block_ref]` is
   *  rendered at this site instead. Two sections pointing at the same ref
   *  render byte-identical content (memoized, not recomputed per site). */
  shared_block_ref?: string;
}

export type DisplaySection = Section & SectionDisplay;

/** The document shape this renderer actually consumes: the report-contract
 *  validator's `ReportDataDocument`, plus the display-only fields above. */
export interface RenderReportDataDocument extends ReportDataDocument {
  figures?: (Figure & FigureDisplay)[];
  derived?: (Derived & FigureDisplay)[];
  sections?: DisplaySection[];
  /** Content authored once and injected at every section pointing to it
   *  via `shared_block_ref`. */
  shared_blocks?: Record<string, DisplaySection>;
  /** Mirrors the run sidecar's forecast state. Forecast-kind sections
   *  render only when `state === 'provided_current'`. */
  forecast?: { state?: string };
}

export interface RenderMonthlyReportOptions {
  /** Currency symbol fallback used only when the document itself carries no
   *  `currency` field. Defaults to a bare '$' (see file header re: the
   *  reference's documented hardcoded-'$' defect — this renderer only
   *  falls back to '$', it never overrides a document-declared currency). */
  defaultCurrency?: string;
  /** Page `<title>` / `<h1>` fallback when the document has no brand_slug. */
  title?: string;
  /** Default 'light'. */
  theme?: 'light' | 'dark';
}

// ---------------------------------------------------------------------------
// Number formatting — unit + precision drive the format; sign drives accent
// ---------------------------------------------------------------------------

type FigureLike = FigureCommon & FigureDisplay;

/**
 * Typographic glyphs used in rendered output. MINUS and MIDDOT match the
 * reference implementation's own shipped-report conventions. MISSING_VALUE
 * reuses the same em-dash-as-placeholder-glyph design-system.ts's own
 * formatPct/formatMoney/formatInt already ship for "no value" -- a fixed
 * UI glyph, not prose punctuation, so it is unaffected by the house rule
 * against em dashes in customer-facing PROSE (sentences). This renderer
 * honors that prose rule where it actually applies: the page title/subtitle
 * built below use a colon and a middot, never an em dash, to join text.
 */
const MINUS = '−'; // typographic minus, matches shipped-report convention
const MIDDOT = '·'; // metadata separator (schema version, currency)
const MISSING_VALUE = '—'; // placeholder glyph for a missing/NaN value
const MULTIPLE = '×'; // multiple/times affix for a bare-ratio unit (ROAS)

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  AUD: 'A$',
};

function currencySymbol(code: string | undefined): string {
  if (!code) return '$';
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

/** Fixed-precision, thousands-grouped, locale-PINNED (always en-US — never
 *  the host locale, so output cannot drift by environment). */
function fixed(n: number, precision: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** Marker for a unit token this renderer does not know AND cannot safely
 *  echo (nothing survived the output allowlist). Better a visible "I do not
 *  know this unit" than a bare number the reader will take for a count. */
const UNKNOWN_UNIT = '[unknown unit]';

/**
 * Sanitize an unrecognized unit token for display.
 *
 * `unit` comes from an untrusted report-data document, and an unrecognized
 * one is now ECHOED into the page rather than dropped. The single in-repo
 * call site already wraps this function's return in `escapeHtml`, but the
 * function is exported, so the OUTPUT ALPHABET is allowlisted here too
 * rather than relying on a caller to escape: enumerate what may appear, not
 * what must be stripped. Length-bounded so a garbage "unit" cannot dominate
 * the chip. Returns '' when nothing survives — the caller then falls back to
 * `UNKNOWN_UNIT`.
 */
function unitToken(unit: string): string {
  return unit.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

/**
 * Format one figure's value from its `unit` + `precision` alone. Prose
 * never formats numbers — this is the only place a figure's value becomes
 * display text. Mirrors the reference's `fmt_spec_text`, EXTENDED with the
 * analysis engine's own unit vocabulary (below) and with a unit-carrying
 * fallback so an unknown token can never render as a bare number.
 *
 * ── Where the engine's tokens come from ──────────────────────────────────
 * A figure extracted from an analysis envelope does not carry OUR unit
 * vocabulary: `extract.ts` labels figures from the engine's metric registry,
 * so engine tokens arrive here verbatim (`currency-2dp` on every per-unit
 * money metric, for instance). Three engine vocabularies exist and they are
 * NOT interchangeable — the same token can mean different scales in two of
 * them, which is why each case below names the one it implements:
 *
 *   1. `HorizontalBridgeValueUnit` — `component.valueUnit`. Members:
 *      currency, currency-2dp, number, number-2dp, percent. These are LEVEL
 *      units and carry NO stored-scale trick: a `currency-2dp` value is
 *      plain dollars at two decimals (ASP $12.34, CPC $0.85), never a ×10⁴
 *      scalar. `extract.ts` used to pass this field straight onto every
 *      bridge-leg figure; it no longer does, because a leg figure stores the
 *      component's `impact` (denominated in the ANCHOR metric) and not the
 *      levels `valueUnit` describes — so these tokens now reach this
 *      function only from a document authored outside the extractor. The
 *      cases stay: this renderer formats whatever it is handed.
 *   2. `DisplayUnit` — `METRIC_DEFINITIONS[m].display`. Members: currency,
 *      currency-2dp, number, percent, percent-points. Also level units.
 *   3. `ContributionUnit` — `contributionUnit` / `decompositionUnit`, the
 *      GRID's C2C and mix/rate cells. Members: bps, bps-1dp, pts,
 *      currency-2dp, weeks, ratio-2dp. These DO carry a stored scale (the
 *      engine stores contribution × 10⁴). This vocabulary is NOT serialized
 *      into the insight envelope at all — it appears only in the engine's
 *      metric registry and its own grid formatter — so it cannot reach a
 *      figure through `extract.ts` today. The four tokens UNIQUE to it are
 *      still handled below, defensively and with the engine's own scale, so
 *      that if a future envelope ever does carry one it is not silently
 *      mis-read as a level.
 *
 * ⚠ TWO TOKENS ARE OVERLOADED ACROSS VOCABULARIES WITH DIFFERENT SCALES,
 *   and both deliberately take the LEVEL reading here, because the level
 *   vocabulary is the one that actually reaches this renderer:
 *     • `currency-2dp` — level: plain dollars at 2dp. Contribution:
 *       stored ÷ 10⁴. Applying the contribution divide would turn a real
 *       $0.85 CPC into $0.000085, so it is NOT applied.
 *     • `weeks` — our long-standing level unit (weeks of cover, a bare 1dp
 *       number). Contribution: stored ÷ 10⁴ with a " wks" affix. The
 *       existing level behavior is preserved unchanged.
 *   If contribution cells are ever serialized into an envelope they must
 *   arrive under their own distinct tokens (or a scale marker), NOT by
 *   reusing these two — there is no way to tell them apart from the value.
 */
export function formatFigureValue(fig: FigureLike, currencyCode: string | undefined): string {
  const v = fig.value;
  if (v === undefined || v === null) return MISSING_VALUE;
  // Coerce BEFORE checking finiteness: an untrusted document can carry a
  // non-numeric value ('n/a', '1,234', an object) that Number.isNaN(v)
  // never catches because v itself is not literally the number NaN. Number
  // coercion collapses every non-numeric shape to NaN, which the
  // finiteness check below then catches uniformly -- so a bad value always
  // renders the same missing-value placeholder, never "$NaN" with a sign
  // implied that was never there.
  const n = Number(v);
  if (!Number.isFinite(n)) return MISSING_VALUE;
  const unit = fig.unit ?? 'raw';
  const neg = n < 0;
  const a = Math.abs(n);
  const prec = fig.precision;

  let body: string;
  switch (unit) {
    case 'currency':
      body = `${currencySymbol(currencyCode)}${fixed(a, prec ?? 0)}`;
      break;
    case 'currency_abbrev': {
      const sym = currencySymbol(currencyCode);
      if (a >= 1_000_000) body = `${sym}${(a / 1_000_000).toFixed(1)}M`;
      else if (a >= 1_000) body = `${sym}${(a / 1_000).toFixed(1)}K`;
      else body = `${sym}${fixed(a, 0)}`;
      break;
    }
    case 'count':
      body = fixed(a, prec ?? 0);
      break;
    case 'ratio':
      body = `${(a * 100).toFixed(prec ?? 1)}%`;
      break;
    case 'percent':
      body = `${a.toFixed(prec ?? 1)}%`;
      break;
    case 'points':
      body = `${a.toFixed(prec ?? 1)} pts`;
      break;
    case 'item_days': {
      // UNIT-1: an item_days figure never renders as plain "N days". The
      // validator's DAYS_TEXT regex only matches a bare number immediately
      // (optionally via whitespace) followed by "day"/"days" — "item-day(s)"
      // never matches that pattern.
      const count = fixed(a, prec ?? 0);
      body = `${count} item-day${a === 1 ? '' : 's'}`;
      break;
    }
    case 'weeks':
      // LEVEL weeks (weeks of cover). NOT the engine's `weeks`
      // ContributionUnit, which is stored ÷ 10⁴ with a " wks" affix — see
      // the overload warning in this function's doc comment.
      body = a.toFixed(prec ?? 1);
      break;

    // -----------------------------------------------------------------
    // Engine `HorizontalBridgeValueUnit` / `DisplayUnit` level tokens. No
    // stored scale. `currency-2dp` reaches here on every per-unit money
    // metric via the extractor's interim unit map; `number` / `number-2dp`
    // only from a document authored outside the extractor (see this
    // function's doc comment).
    // -----------------------------------------------------------------
    case 'currency-2dp':
      // Plain dollars at two decimals (ASP, CPC, CPA, AOV, ROAS). The
      // engine's own level formatters render this as `cur2` / `$X.XX`.
      body = `${currencySymbol(currencyCode)}${fixed(a, prec ?? 2)}`;
      break;
    case 'number':
      // Whole-number display. Same shape as our `count`; kept as its own
      // case so the engine token is explicitly recognized rather than
      // landing in the unknown-unit fallback.
      body = fixed(a, prec ?? 0);
      break;
    case 'number-2dp':
      // Two-decimal bare number, for fractional rates whose movement is
      // meaningful below integer precision (e.g. lost units per OOS day).
      body = fixed(a, prec ?? 2);
      break;

    // -----------------------------------------------------------------
    // Engine `DisplayUnit` — the metric-registry level vocabulary.
    // -----------------------------------------------------------------
    case 'percent-points':
      // Already IN points; rendered as-is with the affix (the engine does
      // the same). Distinct from `points_fraction` below, which is not.
      body = `${a.toFixed(prec ?? 1)} pts`;
      break;

    // -----------------------------------------------------------------
    // Emitted by our own extractor, previously unhandled.
    // -----------------------------------------------------------------
    case 'points_fraction':
      // A CHANGE in a rate, stored as a fraction: every bridge leg anchored
      // on a rate metric, the TACoS decomposition legs, and the cross-domain
      // `delta_pts` figures. The engine types those as rate units
      // (0.01 = 1 pt) and renders them ×100 with " pts" (`formatDelta`'s
      // `deltaUnit === 'pts'` branch) — so ×100 recovers points here too.
      // Without this a −2.8 point TACoS move rendered as a bare "−0.03",
      // which reads as a rounding artifact rather than a real move.
      body = `${(a * 100).toFixed(prec ?? 1)} pts`;
      break;

    // -----------------------------------------------------------------
    // Engine `ContributionUnit` — grid C2C / mix-rate cells. Handled
    // defensively: these are NOT serialized into the insight envelope
    // today, so nothing can reach here through `extract.ts`. Only the four
    // tokens UNIQUE to this vocabulary are implemented — `currency-2dp`
    // and `weeks` are overloaded and keep their level reading above.
    // Scales are the engine's own (contribution values are stored ×10⁴).
    // -----------------------------------------------------------------
    case 'bps':
      // Stored AS-IS in basis points; the engine renders integer-rounded.
      body = `${fixed(a, prec ?? 0)} bps`;
      break;
    case 'bps-1dp':
      // Basis points at one decimal, for a rate so small that whole points
      // round every driver row away (CTR contributions).
      body = `${fixed(a, prec ?? 1)} bps`;
      break;
    case 'pts':
      // Stored ÷ 100 → percentage points.
      body = `${(a / 100).toFixed(prec ?? 1)} pts`;
      break;
    case 'ratio-2dp':
      // Stored ÷ 10⁴ → a bare multiple (ROAS). The engine prints it with
      // no affix because its grid column is labeled; a figure chip has no
      // such guarantee, so the multiplication sign carries the unit.
      body = `${(a / 10_000).toFixed(prec ?? 2)}${MULTIPLE}`;
      break;

    default: {
      // 'raw' / absent unit → the historical bare number. Those two assert
      // "this figure genuinely has no unit", and that contract is kept.
      const plain = prec !== undefined ? fixed(a, prec) : String(a);
      if (unit === 'raw' || unit === '') {
        body = plain;
        break;
      }
      // Anything else is a token this renderer does not know. It must NOT
      // render as a bare number — an unlabeled figure reads as a plain
      // count, which is exactly how a rate, a ratio and a count become
      // indistinguishable. Show the number AND the token that qualifies it
      // so the gap is visible to the reader (and reportable) instead of
      // silent.
      const tok = unitToken(unit);
      body = `${plain} ${tok || UNKNOWN_UNIT}`;
      break;
    }
  }

  if (neg) body = MINUS + body;
  else if (fig.signed && n > 0) body = '+' + body;
  return body + (fig.suffix ?? '');
}

/** CSS accent class from the VALUE SIGN alone — never from prose tone.
 *  Mirrors the reference's `fmt_spec_class`. */
export function figureAccentClass(fig: FigureLike): '' | 'is-positive' | 'is-negative' | 'is-neutral' {
  const accent = fig.accent;
  if (accent !== 'auto' && accent !== 'auto_invert') return '';
  const v = fig.value;
  if (v === undefined || v === null) return 'is-neutral';
  // Coerce, then gate on finiteness: a non-numeric value ('n/a', an object)
  // must never earn a positive/negative accent -- it carries no sign to
  // report. Number('n/a') is NaN, which is neither > 0 nor === 0 under a
  // naive check, so the old code fell through to "not risen" and picked a
  // real accent class for a value that was never a number.
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'is-neutral';
  const rose = n > 0;
  const good = accent === 'auto' ? rose : !rose;
  return good ? 'is-positive' : 'is-negative';
}

// ---------------------------------------------------------------------------
// Section content: prose + quoted figures + caveats
// ---------------------------------------------------------------------------

function buildFigureIndex(doc: RenderReportDataDocument): Map<string, FigureLike> {
  const idx = new Map<string, FigureLike>();
  for (const f of doc.figures ?? []) idx.set(f.id, f);
  for (const d of doc.derived ?? []) idx.set(d.id, d);
  return idx;
}

/** The figures a section quotes: its own `figure_refs` plus the
 *  `figure_refs` of every claim it references via `claim_refs`. Mirrors the
 *  "quoted" set `validate.ts`'s CAVEAT-1 builds. Order-preserving,
 *  de-duplicated, insertion-ordered — deterministic given the same input. */
function quotedFigureIds(section: Section, claims: Map<string, Claim>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const id of section.figure_refs ?? []) add(id);
  for (const cid of section.claim_refs ?? []) {
    for (const id of claims.get(cid)?.figure_refs ?? []) add(id);
  }
  return ids;
}

function renderFigureStrip(
  ids: string[],
  figureIdx: Map<string, FigureLike>,
  currencyCode: string | undefined,
): string {
  const chips: string[] = [];
  for (const id of ids) {
    const fig = figureIdx.get(id);
    if (!fig) continue; // unresolved refs are TRACE-1's concern, not this renderer's
    const accentCls = figureAccentClass(fig);
    const valueCls = accentCls ? `rr-figure-value ${accentCls}` : 'rr-figure-value';
    const label = escapeHtml(fig.label);
    const value = escapeHtml(formatFigureValue(fig, currencyCode));
    chips.push(
      `<span class="rr-figure-chip"><span class="rr-figure-label">${label}</span>` +
        `<span class="${valueCls}">${value}</span></span>`,
    );
  }
  if (chips.length === 0) return '';
  return `<div class="rr-figure-strip">${chips.join('')}</div>\n`;
}

function renderCaveats(
  caveatIds: string[],
  registry: Record<string, CaveatRegistryEntry>,
): string {
  const lines: string[] = [];
  for (const id of caveatIds) {
    const entry = registry[id];
    const text = entry?.text;
    if (text) {
      lines.push(`<p class="rr-caveat">${escapeHtml(text)}</p>`);
    } else if (entry?.severity === 'blocking') {
      // A blocking caveat with no text would otherwise vanish silently here
      // (validate.ts's CAVEAT-1 now catches this at the door, but the
      // renderer stays defensive on its own -- corrections go to the data,
      // never a silently blank page).
      lines.push(`<p class="rr-caveat rr-caveat-missing">[caveat text missing: ${escapeHtml(id)}]</p>`);
    }
  }
  return lines.join('\n');
}

function renderSectionBody(
  block: DisplaySection,
  figureIdx: Map<string, FigureLike>,
  claims: Map<string, Claim>,
  registry: Record<string, CaveatRegistryEntry>,
  currencyCode: string | undefined,
): string {
  const title = block.title ? `<h2 class="rr-section-title">${escapeHtml(block.title)}</h2>\n` : '';
  // Pre-composed prose, rendered raw — see file header.
  const prose = block.display_text ? `<p class="rr-prose">${block.display_text}</p>\n` : '';
  const ids = quotedFigureIds(block, claims);
  const figures = renderFigureStrip(ids, figureIdx, currencyCode);
  const caveats = renderCaveats(block.caveats_rendered ?? [], registry);
  return `${title}${prose}${figures}${caveats}`;
}

// ---------------------------------------------------------------------------
// Page shell — design-system tokens, loaded synchronously so this renderer
// can stay a pure sync function (`readDesignSystemCss` in design-system.ts
// is async; we mirror its font-URL rewrite here with a sync read instead).
// ---------------------------------------------------------------------------

/** Matches a single-line `@font-face { ... src: url('fonts/X.ttf') ... }`
 *  declaration (the design system's colors_and_type.css writes exactly one
 *  per line, verified against the shipped file). */
const LOCAL_FONT_FACE = /^@font-face\s*\{[^}]*url\(['"]?fonts\/[^}]*\}[ \t]*$/gm;

function loadReportCss(): string {
  const dsDir = designSystemDir();
  const raw = readFileSync(join(dsDir, 'colors_and_type.css'), 'utf-8');
  // Do NOT rewrite local font URLs to file:///<local-install-path>/fonts/...
  // -- that bakes the operator's own machine's absolute path (and OS
  // username, on Windows) into HTML that ships to a customer, and it makes
  // the same document render to different bytes on every machine. Strip the
  // @font-face rules that point at local files instead; the design
  // system's own font-family fallback stack (--font-sans / --font-heading,
  // both end in system-ui / sans-serif) carries the page without them. The
  // Google Fonts @import lines above them are already absolute https: URLs
  // and pass through untouched.
  const withoutLocalFonts = raw.replace(LOCAL_FONT_FACE, '').replace(/\n{3,}/g, '\n\n');
  return `${withoutLocalFonts}\n${REPORT_CSS}`;
}

const REPORT_CSS = `
html, body { margin: 0; padding: 0; }
body { background: var(--rc-bg); }
.rr-page {
  max-width: 900px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
  font-family: var(--font-sans);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-body);
  color: var(--rc-text);
  font-feature-settings: 'tnum' 1, 'rlig' 1, 'calt' 1;
}
.rr-header {
  border-bottom: 1px solid var(--rc-border);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-6);
}
.rr-title {
  font-family: var(--font-heading);
  font-size: var(--fs-h2);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--rc-text);
}
.rr-subtitle {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  margin: 4px 0 0;
}
.rr-content { display: flex; flex-direction: column; gap: var(--space-6); }
.rr-section {
  background: var(--rc-card);
  border: 1px solid var(--rc-border);
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  box-shadow: var(--rc-shadow-1);
}
.rr-section-title {
  font-size: var(--fs-h4);
  font-weight: 600;
  margin: 0 0 var(--space-3);
  color: var(--rc-text);
}
.rr-prose { margin: 0 0 var(--space-3); color: var(--rc-text); }
.rr-prose:last-child { margin-bottom: 0; }
.rr-figure-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
}
.rr-figure-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--rc-border);
  background: var(--rc-chip-bg);
  font-size: var(--fs-caption);
}
.rr-figure-label { color: var(--rc-text-sub); }
.rr-figure-value {
  font-weight: 600;
  color: var(--rc-text);
  font-feature-settings: 'tnum' 1;
}
.rr-figure-value.is-positive { color: var(--rc-positive); }
.rr-figure-value.is-negative { color: var(--rc-negative); }
.rr-figure-value.is-neutral  { color: var(--rc-text-sub); }
.rr-caveat {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  font-style: italic;
  margin: var(--space-2) 0 0;
}
.rr-caveat:first-child { margin-top: 0; }
.rr-caveat-missing { color: var(--rc-negative); font-style: normal; font-weight: 600; }
.rr-footer {
  margin-top: var(--space-12);
  padding-top: var(--space-6);
  border-top: 1px solid var(--rc-border);
  text-align: center;
}
.rr-footer-copy {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  margin: 0;
}
`;

function buildPage(args: {
  title: string;
  theme: 'light' | 'dark';
  css: string;
  currencyCode: string | undefined;
  schemaVersion: string | undefined;
  bodyHtml: string;
}): string {
  const { title, theme, css, currencyCode, schemaVersion, bodyHtml } = args;
  const metaParts: string[] = [];
  if (schemaVersion) metaParts.push(escapeHtml(`Schema ${schemaVersion}`));
  if (currencyCode) metaParts.push(escapeHtml(`Currency ${currencyCode}`));
  // Parts are escaped individually above; the join separator is a bare
  // Unicode middot (not markup), so no double-escaping risk here.
  const subtitle = metaParts.join(` ${MIDDOT} `);
  const escapedTitle = escapeHtml(title);

  return `<!DOCTYPE html>
<html lang="en" data-rc-theme="${escapeAttr(theme)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapedTitle}: Monthly report</title>
<style>${css}</style>
</head>
<body>
<div class="rr-page">
  <header class="rr-header">
    <h1 class="rr-title">${escapedTitle}</h1>
    ${subtitle ? `<p class="rr-subtitle">${subtitle}</p>` : ''}
  </header>
  <main class="rr-content">
${bodyHtml}
  </main>
  <footer class="rr-footer">
    <p class="rr-footer-copy">MixShift smart-tier monthly report.</p>
  </footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Forecast vocabulary scan (fail-closed door, see file header point 4)
// ---------------------------------------------------------------------------

/** Same spirit as the reference's CONDITIONAL_FORECAST_SECTIONS suppression
 *  list: language that only makes sense next to a live forecast. */
const FORECAST_VOCAB = /\b(forecast|projected|projection|ahead of|behind)\b/i;

/**
 * Suppression of forecast content is opt-in today: only a section/shared
 * block explicitly tagged `kind: 'forecast'` gets suppressed when the
 * document's forecast isn't provided-current (see the render loop below).
 * That is correct for TAGGED content but leaves a gap -- forecast prose
 * that was never tagged ships regardless of forecast state. This scans
 * every claim and every quotation site that will actually render (an
 * ordinary section, or the shared block a `shared_block_ref` section
 * resolves to -- never a pointer section's own ignored fields) for forecast
 * vocabulary, and returns the offending ids. Already-tagged forecast
 * content is skipped here: it is suppressed at render regardless, so it is
 * not a leak and callers should not refuse on its account. Returns `[]`
 * whenever the forecast IS provided-current (nothing to guard against) or
 * nothing matches.
 */
export function scanForecastVocabulary(doc: RenderReportDataDocument): string[] {
  if (doc.forecast?.state === 'provided_current') return [];

  const offenders = new Set<string>();
  const sharedBlocks = doc.shared_blocks ?? {};

  for (const c of doc.claims ?? []) {
    if (c.text && FORECAST_VOCAB.test(c.text)) offenders.add(c.id);
  }

  for (const s of doc.sections ?? []) {
    let block: DisplaySection;
    let subjectId: string;
    if (s.shared_block_ref) {
      const shared = sharedBlocks[s.shared_block_ref];
      if (!shared) continue; // unresolved ref: TRACE-1 / render's own error, not this scan's
      block = shared;
      subjectId = shared.id ?? s.shared_block_ref;
    } else {
      block = s;
      subjectId = s.id;
    }
    if (block.kind === 'forecast') continue; // tagged + suppressed at render already
    if (block.display_text && FORECAST_VOCAB.test(block.display_text)) {
      offenders.add(subjectId);
    }
  }

  return [...offenders].sort();
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

/**
 * Render a validated report-data document to a self-contained HTML string.
 * Pure and synchronous: no clock, no randomness, no host-locale dependence.
 * Calling this twice with the same document (or two structurally identical
 * documents) always returns byte-identical strings.
 */
export function renderMonthlyReport(
  doc: RenderReportDataDocument,
  opts: RenderMonthlyReportOptions = {},
): string {
  const currencyCode = doc.currency ?? opts.defaultCurrency;
  const figureIdx = buildFigureIndex(doc);
  const claimIdx = new Map<string, Claim>();
  for (const c of doc.claims ?? []) claimIdx.set(c.id, c);
  const registry = doc.caveat_registry ?? {};
  const forecastState = doc.forecast?.state;
  const sharedBlocks = doc.shared_blocks ?? {};

  const sharedRendered = new Map<string, string>();
  const sectionsHtml: string[] = [];

  for (const section of doc.sections ?? []) {
    let block: DisplaySection;
    if (section.shared_block_ref) {
      const shared = sharedBlocks[section.shared_block_ref];
      if (!shared) {
        throw new Error(
          `render-report: shared_block_ref '${section.shared_block_ref}' ` +
            `(section '${section.id}') has no definition in doc.shared_blocks`,
        );
      }
      block = shared;
    } else {
      block = section;
    }

    // Forecast suppression: applies to the RESOLVED block (a shared block's
    // own kind governs it, same as any other section).
    if (block.kind === 'forecast' && forecastState !== 'provided_current') {
      continue;
    }

    let html: string;
    if (section.shared_block_ref) {
      const ref = section.shared_block_ref;
      const cached = sharedRendered.get(ref);
      if (cached !== undefined) {
        html = cached;
      } else {
        html = renderSectionBody(block, figureIdx, claimIdx, registry, currencyCode);
        sharedRendered.set(ref, html);
      }
    } else {
      html = renderSectionBody(block, figureIdx, claimIdx, registry, currencyCode);
    }

    sectionsHtml.push(`<section class="rr-section" id="${escapeAttr(section.id)}">\n${html}</section>`);
  }

  const css = loadReportCss();
  const title = opts.title ?? doc.brand_slug ?? 'Monthly report';
  const theme = opts.theme ?? 'light';

  return buildPage({
    title,
    theme,
    css,
    currencyCode,
    schemaVersion: doc.schema_version,
    bodyHtml: sectionsHtml.join('\n'),
  });
}
