/**
 * Static-HTML design system primitives.
 *
 * Renders HTML strings using MixShift design tokens. No React, no runtime
 * dependencies — the output is a self-contained HTML file the user opens
 * in a browser.
 *
 * Token source: `harness/assets/design-system/colors_and_type.css`.
 * Primitive reference: `harness/assets/design-system/ui_kits/report_center/
 * src/ui.jsx` (we mirror the visual contract, not the React code).
 *
 * Voice rules from the design system SKILL.md (enforced via review, not
 * code):
 *   - Sentence case for labels
 *   - No emoji, no decorative imagery
 *   - Tabular numerals always (built into the renderNumber helpers)
 *   - Specific vocabulary: ACoS / TACoS / RoAS / Buy Box %
 *   - Brand color #16a34a used sparingly (only for trend-positive deltas
 *     and the rail accent)
 *
 * Usage:
 *
 *   const html = renderPage({
 *     title: 'Skratch Labs',
 *     theme: 'light',
 *     body: [
 *       renderScorecardRow([...]),
 *       renderCard({ title: 'Context', body: '...' }),
 *     ].join('\n'),
 *   });
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Asset paths (CSS + icons loaded at render time)
// ---------------------------------------------------------------------------

/**
 * Resolve the design-system asset root.
 *
 * Has to work across three invocation modes:
 *   - Bundled dist (`harness/dist/cli.js`, one level deep) — production
 *   - Direct source (`harness/src/lib/render/design-system.ts`, three deep) — tests
 *   - tsc-out / tsx runs from various depths — dev
 *
 * Strategy: walk upward from this file looking for a directory that
 * contains `assets/design-system/colors_and_type.css`. Cap at 8 hops to
 * avoid runaway recursion on misconfigured installs.
 *
 * Override via env `MIXSHIFT_DESIGN_SYSTEM_DIR` for unit tests or for
 * customers who want to swap in branded variants.
 */
export function designSystemDir(): string {
  if (process.env.MIXSHIFT_DESIGN_SYSTEM_DIR) {
    return process.env.MIXSHIFT_DESIGN_SYSTEM_DIR;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'assets', 'design-system');
    if (existsSync(join(candidate, 'colors_and_type.css'))) {
      return candidate;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(
    'Could not locate harness/assets/design-system/. The renderer walks up ' +
      'from the running CLI file looking for assets/design-system/' +
      'colors_and_type.css. Set MIXSHIFT_DESIGN_SYSTEM_DIR if your install ' +
      'puts the assets elsewhere.',
  );
}

/**
 * Read the canonical colors_and_type.css and rewrite local font URLs to
 * absolute file:// paths so the bundled HTML loads them regardless of
 * where the HTML lives. (The HTML opens at
 * `~/.mixshift/clients/<slug>/view.html`, far from
 * `harness/assets/design-system/fonts/`.)
 *
 * Google Fonts @imports (Poppins, JetBrains Mono) pass through unchanged
 * — they're already absolute URLs.
 */
export async function readDesignSystemCss(): Promise<string> {
  const dsDir = designSystemDir();
  const raw = await readFile(join(dsDir, 'colors_and_type.css'), 'utf-8');
  // Rewrite `url('fonts/X.ttf')` → `url('file:///abs/path/fonts/X.ttf')`.
  // Forward slashes work in file:// URLs on Windows too.
  const fontsAbsUrl = `file:///${dsDir.replace(/\\/g, '/')}/fonts`;
  return raw.replace(
    /url\((['"]?)fonts\//g,
    (_match, quote) => `url(${quote}${fontsAbsUrl}/`,
  );
}

/**
 * Read a logo SVG and strip the XML prolog so it can be inlined inside an
 * HTML body. Caller is responsible for sizing via the outer container's
 * width/height — the inline `<svg>` keeps its viewBox so it scales.
 */
async function readLogoSvg(filename: string): Promise<string> {
  const raw = await readFile(join(designSystemDir(), filename), 'utf-8');
  // Strip XML prolog + Adobe Illustrator comment, keep the <svg>...</svg>.
  return raw
    .replace(/<\?xml[\s\S]*?\?>\s*/, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export interface PageOptions {
  /** Document title and chrome heading. */
  title: string;
  /** Default 'light'. Toggle visible via theme switcher in the page chrome. */
  theme?: 'light' | 'dark';
  /** Inner HTML for the main column. Use the primitives below or hand-write. */
  body: string;
  /** Optional subtitle below the title in the page header. */
  subtitle?: string;
  /** Inline additional CSS, after the design system CSS. */
  extra_css?: string;
}

/**
 * Build a full HTML page. The result is a self-contained file (CSS inlined,
 * fonts loaded from same-directory `fonts/`). Logos inlined from the
 * design-system assets so the file is fully portable — Sam can email
 * `view.html` to a teammate and the branding survives intact.
 */
export async function renderPage(options: PageOptions): Promise<string> {
  const theme = options.theme ?? 'light';
  const css = await readDesignSystemCss();
  const railIcon = await readLogoSvg('mixshift-icon-white.svg');
  const wordmarkDark = await readLogoSvg('mixshift-logo-dark.svg');
  const wordmarkWhite = await readLogoSvg('mixshift-logo-white.svg');
  return `<!DOCTYPE html>
<html lang="en" data-rc-theme="${escapeAttr(theme)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)} — MixShift</title>
<style>${css}
${pageShellCss()}${options.extra_css ? '\n' + options.extra_css : ''}</style>
</head>
<body>
<div class="rc-app">
  ${renderRail(railIcon)}
  <main class="rc-main">
    <header class="rc-header">
      <div>
        <h1 class="rc-title">${escapeHtml(options.title)}</h1>
        ${options.subtitle ? `<p class="rc-subtitle">${escapeHtml(options.subtitle)}</p>` : ''}
      </div>
      ${renderThemeToggle(theme)}
    </header>
    <section class="rc-content">
${options.body}
    </section>
    ${renderFooter(wordmarkDark, wordmarkWhite)}
  </main>
</div>
<script>${themeToggleScript()}</script>
</body>
</html>`;
}

/**
 * Page-shell CSS — layout grid, app rail, header. Lives outside
 * colors_and_type.css because it's view-specific, not a brand token.
 */
function pageShellCss(): string {
  return `
/* Browsers ship with 8px body margin by default — without resetting it,
   the rail sits ~8px in from the viewport edge instead of flush. */
html, body { margin: 0; padding: 0; }
body { background: var(--rc-bg); }
.rc-app {
  display: grid;
  grid-template-columns: 56px 1fr;
  min-height: 100vh;
  background: var(--rc-bg);
  color: var(--rc-text);
  font-family: var(--font-sans);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-body);
  font-feature-settings: 'tnum' 1, 'rlig' 1, 'calt' 1;
}
.rc-rail {
  background: var(--rc-rail-bg);
  border-right: 1px solid var(--rc-rail-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-4) 0;
  gap: var(--space-4);
}
.rc-rail-mark {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rc-rail-mark > svg { width: 100%; height: 100%; display: block; }
.rc-main { padding: var(--space-6) var(--space-8); max-width: 1280px; }
.rc-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  border-bottom: 1px solid var(--rc-border);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-6);
}
.rc-title {
  font-family: var(--font-heading);
  font-size: var(--fs-h2);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--rc-text);
}
.rc-subtitle {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  margin: 4px 0 0;
}
.rc-content { display: flex; flex-direction: column; gap: var(--space-6); }
.rc-segmented {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  background: var(--rc-chip-bg);
  border: 1px solid var(--rc-border);
  border-radius: 7px;
}
.rc-segmented button {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: var(--rc-text-sub);
  cursor: pointer;
  font-family: inherit;
}
.rc-segmented button.is-active {
  background: var(--rc-card);
  color: var(--rc-text);
  box-shadow: 0 1px 2px rgba(15,23,42,0.08);
}
/* Scorecards */
.rc-scorecard-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}
.rc-scorecard {
  background: var(--rc-card);
  border: 1px solid var(--rc-border);
  border-radius: var(--radius-xl);
  padding: var(--space-4) var(--space-5);
  box-shadow: var(--rc-shadow-1);
}
.rc-scorecard-label {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  text-transform: none;
  margin: 0;
}
.rc-scorecard-value {
  font-family: var(--font-heading);
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 6px 0 4px;
  color: var(--rc-text);
  font-feature-settings: 'tnum' 1;
}
.rc-scorecard-delta {
  font-size: var(--fs-caption);
  font-weight: 500;
  font-feature-settings: 'tnum' 1;
}
.rc-scorecard-delta.is-positive { color: var(--rc-positive); }
.rc-scorecard-delta.is-negative { color: var(--rc-negative); }
.rc-scorecard-delta.is-neutral  { color: var(--rc-text-sub); }
/* Cards */
.rc-card {
  background: var(--rc-card);
  border: 1px solid var(--rc-border);
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  box-shadow: var(--rc-shadow-1);
}
.rc-card-title {
  font-size: var(--fs-h4);
  font-weight: 600;
  margin: 0 0 var(--space-3);
}
.rc-card-body { color: var(--rc-text); font-size: var(--fs-body-sm); }
/* Table */
.rc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body-sm);
  font-feature-settings: 'tnum' 1;
}
.rc-table th {
  text-align: left;
  font-weight: 500;
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--rc-border);
}
.rc-table td {
  padding: var(--space-3);
  border-bottom: 1px solid var(--rc-divider);
}
.rc-table tr:last-child td { border-bottom: 0; }
.rc-table td.is-numeric { text-align: right; font-feature-settings: 'tnum' 1; }
/* Pills */
.rc-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  border: 1px solid var(--rc-border);
  background: var(--rc-chip-bg);
  color: var(--rc-text);
}
.rc-pill.is-green {
  background: color-mix(in srgb, var(--rc-green) 10%, transparent);
  color: var(--rc-green-ink);
  border-color: color-mix(in srgb, var(--rc-green) 25%, transparent);
}
.rc-pill.is-amber {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #b45309;
  border-color: color-mix(in srgb, #f59e0b 30%, transparent);
}
.rc-pill.is-red {
  background: color-mix(in srgb, var(--rc-red) 10%, transparent);
  color: var(--rc-red);
  border-color: color-mix(in srgb, var(--rc-red) 25%, transparent);
}
.rc-pill.is-ghost {
  background: transparent;
  color: var(--rc-text-sub);
}
/* Empty state */
.rc-empty {
  border: 1px dashed var(--rc-border);
  border-radius: var(--radius-xl);
  padding: var(--space-8);
  text-align: center;
  color: var(--rc-text-sub);
  background: var(--rc-card);
}
/* Footer (branding + copyright). Stacked + centered: copyright first,
   wordmark below it. The wordmark is intentionally generous so the
   brand registers — designed as the visual signature, not a sign-off. */
.rc-footer {
  margin-top: var(--space-12);
  padding-top: var(--space-6);
  padding-bottom: var(--space-6);
  border-top: 1px solid var(--rc-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}
.rc-footer-copy {
  font-size: var(--fs-caption);
  color: var(--rc-text-sub);
  margin: 0;
}
.rc-footer-mark {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rc-footer-mark > svg {
  height: 100%;
  width: auto;
  display: block;
}
`;
}

// ---------------------------------------------------------------------------
// Rail + theme toggle
// ---------------------------------------------------------------------------

function renderRail(railIconSvg: string): string {
  // Real MixShift X mark, embedded inline. The icon SVG is the white-on-
  // transparent version — sits on the always-dark rail background. We
  // wrap it in a fixed-size div so the SVG's intrinsic dimensions don't
  // blow out the 56px-wide rail.
  return `<aside class="rc-rail" aria-label="MixShift">
  <div class="rc-rail-mark" aria-hidden="true">${railIconSvg}</div>
</aside>`;
}

/**
 * Branded footer with the MixShift wordmark + copyright. Theme-aware via
 * the `.ms-logo-light` / `.ms-logo-dark` swap classes already defined in
 * colors_and_type.css.
 *
 * Copyright entity per Sam: "© 2026 Dash Applications LLC, DBA MixShift."
 */
function renderFooter(wordmarkDarkSvg: string, wordmarkWhiteSvg: string): string {
  const year = new Date().getFullYear();
  return `<footer class="rc-footer">
  <p class="rc-footer-copy">© ${year} Dash Applications LLC, DBA MixShift. All rights reserved.</p>
  <div class="rc-footer-mark ms-logo-light" aria-hidden="true">${wordmarkDarkSvg}</div>
  <div class="rc-footer-mark ms-logo-dark"  aria-hidden="true">${wordmarkWhiteSvg}</div>
</footer>`;
}

function renderThemeToggle(theme: 'light' | 'dark'): string {
  return `<div class="rc-segmented" role="tablist" aria-label="Theme">
  <button data-theme="light" class="${theme === 'light' ? 'is-active' : ''}">Light</button>
  <button data-theme="dark"  class="${theme === 'dark' ? 'is-active' : ''}">Dark</button>
</div>`;
}

function themeToggleScript(): string {
  return `
(function () {
  const root = document.documentElement;
  document.querySelectorAll('.rc-segmented button[data-theme]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = btn.getAttribute('data-theme');
      root.setAttribute('data-rc-theme', next);
      document.querySelectorAll('.rc-segmented button[data-theme]').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-theme') === next);
      });
    });
  });
})();
`;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface ScorecardOptions {
  /** Sentence-case label. e.g. "30-day spend". */
  label: string;
  /** Pre-formatted display value. Use the formatting helpers below. */
  value: string;
  /** Optional delta vs prior period. `direction` drives the color tone. */
  delta?: {
    text: string;
    direction: 'positive' | 'negative' | 'neutral';
  };
}

/**
 * One scorecard. Use `renderScorecardRow([...])` for the grid layout that
 * matches the design system spec.
 */
export function renderScorecard(opts: ScorecardOptions): string {
  const deltaHtml = opts.delta
    ? `<div class="rc-scorecard-delta is-${opts.delta.direction}">${escapeHtml(opts.delta.text)}</div>`
    : '';
  return `<div class="rc-scorecard">
  <p class="rc-scorecard-label">${escapeHtml(opts.label)}</p>
  <div class="rc-scorecard-value">${escapeHtml(opts.value)}</div>
  ${deltaHtml}
</div>`;
}

export function renderScorecardRow(cards: ScorecardOptions[]): string {
  return `<div class="rc-scorecard-row">
${cards.map(renderScorecard).join('\n')}
</div>`;
}

export interface CardOptions {
  title?: string;
  /** Inner HTML — caller is responsible for escaping. */
  body: string;
}

export function renderCard(opts: CardOptions): string {
  const title = opts.title
    ? `<h3 class="rc-card-title">${escapeHtml(opts.title)}</h3>`
    : '';
  return `<div class="rc-card">${title}<div class="rc-card-body">${opts.body}</div></div>`;
}

export type PillTone = 'default' | 'green' | 'amber' | 'red' | 'ghost';

export function renderPill(text: string, tone: PillTone = 'default'): string {
  const cls =
    tone === 'default' ? 'rc-pill' : `rc-pill is-${tone}`;
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

export interface TableColumn {
  key: string;
  label: string;
  /** Right-align numeric columns. */
  numeric?: boolean;
  /** Optional cell renderer. Default: text content of row[key]. */
  render?: (row: Record<string, unknown>) => string;
}

export function renderTable(
  columns: TableColumn[],
  rows: Array<Record<string, unknown>>,
): string {
  if (rows.length === 0) {
    return `<div class="rc-empty">No data yet.</div>`;
  }
  const head = columns
    .map((c) => `<th${c.numeric ? ' class="is-numeric"' : ''}>${escapeHtml(c.label)}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c) => {
          const content = c.render ? c.render(row) : escapeHtml(String(row[c.key] ?? ''));
          return `<td${c.numeric ? ' class="is-numeric"' : ''}>${content}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<table class="rc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Number formatters (tabular, MixShift conventions)
// ---------------------------------------------------------------------------

/**
 * Format a percentage. `precision` defaults to 1 decimal; pass 0 for whole
 * numbers. Returns "—" for null/undefined.
 */
export function formatPct(
  value: number | null | undefined,
  precision: number = 1,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(precision)}%`;
}

/**
 * Format a RoAS (return on ad spend) multiplier — the inverse of ACoS.
 *   ACoS 28%  → RoAS 3.57x
 *   TACoS 18% → TRoAS 5.56x
 * Returns "—" for null/undefined/zero (zero ACoS = infinite RoAS, which
 * we render as a placeholder rather than displaying ∞).
 */
export function formatRoas(
  acosValue: number | null | undefined,
  precision: number = 2,
): string {
  if (acosValue === null || acosValue === undefined || Number.isNaN(acosValue))
    return '—';
  if (acosValue <= 0) return '—';
  return `${(1 / acosValue).toFixed(precision)}x`;
}

/**
 * Display label + value for a target metric, framing-aware.
 *
 *   framing='acos': { label: 'ACoS target',  value: '28%'   }
 *   framing='roas': { label: 'RoAS target',  value: '3.57x' }
 *
 * Pass `kind` to control whether the metric is ad-attributed (acos/roas)
 * or total-sales (tacos/troas). Same canonical storage (ACoS-style
 * percent); display flips at this layer.
 */
export function frameMetric(
  acosValue: number | null | undefined,
  kind: 'ad' | 'total',
  framing: 'acos' | 'roas',
): { label: string; value: string } {
  if (framing === 'roas') {
    return {
      label: kind === 'ad' ? 'RoAS target' : 'TRoAS target',
      value: formatRoas(acosValue),
    };
  }
  return {
    label: kind === 'ad' ? 'ACoS target' : 'TACoS target',
    value: formatPct(acosValue, 0),
  };
}

/**
 * Format US dollars. `precision` defaults to 0 (whole dollars); pass 2 for
 * cents. Returns "—" for null/undefined.
 */
export function formatMoney(
  value: number | null | undefined,
  precision: number = 0,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** Format an integer with thousands separators. */
export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * Build a delta object for `renderScorecard` given prior/current values.
 * Returns null when one side is missing (no delta to show).
 */
export function buildDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
  opts: { format: 'pct' | 'money' | 'int'; lower_is_better?: boolean } = {
    format: 'pct',
  },
): ScorecardOptions['delta'] | null {
  if (current === null || current === undefined) return null;
  if (prior === null || prior === undefined) return null;
  if (prior === 0) return null;
  const diff = current - prior;
  const pctChange = (current - prior) / Math.abs(prior);
  const text =
    opts.format === 'pct'
      ? formatPct(pctChange, 1)
      : opts.format === 'money'
        ? `${diff >= 0 ? '+' : '-'}${formatMoney(Math.abs(diff))}`
        : `${diff >= 0 ? '+' : '-'}${formatInt(Math.abs(diff))}`;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const direction: 'positive' | 'negative' | 'neutral' =
    sign === 'flat'
      ? 'neutral'
      : opts.lower_is_better
        ? sign === 'down'
          ? 'positive'
          : 'negative'
        : sign === 'up'
          ? 'positive'
          : 'negative';
  return { text, direction };
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

export function escapeAttr(s: string): string {
  // Same set works for attribute values (since we always quote with ").
  return escapeHtml(s);
}
