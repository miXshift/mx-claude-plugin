/**
 * `mixshift brand view <slug>` — render a per-brand HTML overview.
 *
 * Writes to `~/.mixshift/clients/<slug>/view.html` and opens with the OS
 * default browser (unless --no-open). The view is regenerated on every
 * invocation; no caching, no daemon.
 *
 * Composition (all blocks fall back gracefully if data is missing):
 *   - Page header: brand name + activity pills
 *   - Scorecards row: active campaigns, accounts, cold-start date, skills set up
 *   - Context card: posture + target ACoS + accounts + sub-brands
 *   - Calibration card: per-skill OCL status (first-run vs tuned, field counts)
 *   - Recent runs table: scans runs/<skill>/<date>/ across all skills
 *
 * All sections honor the design system (cards, pills, tabular numerals,
 * sentence case, no emoji, no decorative imagery).
 */

import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import { loadKeyBrands } from '../lib/clients/key-brands.js';
import { readBrandConfig } from '../lib/calibration/brand-config.js';
import { validateBrandContext } from '../lib/context/load.js';
import { contextPath, brandDir } from '../lib/paths/resolve.js';
import {
  renderPage,
  renderScorecardRow,
  renderCard,
  renderPill,
  renderTable,
  formatInt,
  frameMetric,
  escapeHtml,
  type ScorecardOptions,
  type TableColumn,
} from '../lib/render/design-system.js';
import { loadProfile } from '../lib/profile/load.js';
import { track } from '../lib/telemetry/index.js';
import type { Command } from 'commander';

const exec = promisify(execCb);

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandViewCommand(brandCmd: Command): void {
  brandCmd
    .command('view <slug>')
    .description(
      'Render a per-brand HTML overview to ~/.mixshift/clients/<slug>/view.html ' +
        'and open in the default browser. Use --no-open to just write the file.',
    )
    .option('--no-open', 'write the file but do not open the browser')
    .option(
      '--theme <theme>',
      'initial theme (light | dark)',
      'light',
    )
    .action(
      async (
        slug: string,
        opts: { open: boolean; theme: 'light' | 'dark' },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const result = await renderBrandView({
            slug,
            theme: opts.theme,
            dataDir: root.dataDir,
          });

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                { status: 'ok', view_path: result.path, slug, theme: opts.theme },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(`\n✓ Wrote ${result.path}\n`);
          }

          if (opts.open) {
            await openInBrowser(result.path);
          }

          await track(
            {
              event_name: 'brand.viewed',
              payload: { slug, theme: opts.theme },
            },
            root.dataDir,
          );
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message}\n`);
          }
          process.exitCode = 1;
          return;
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderArgs {
  slug: string;
  theme: 'light' | 'dark';
  dataDir?: string;
}

export async function renderBrandView(
  args: RenderArgs,
): Promise<{ path: string }> {
  // 1. Registry row (defines the brand exists + activity flags). Accepts
  // the same fuzzy input as `brand key add` — slug, display name, acronym,
  // or prefix. Exact slug match wins; fuzzy resolver handles the rest.
  const { index } = await readIndex(args.dataDir);
  let row = index.brands.find((b) => b.slug === args.slug);
  if (!row) {
    const resolved = resolveBrandName(args.slug, index);
    if (resolved.status === 'found') {
      row = resolved.brand;
    } else if (resolved.status === 'ambiguous') {
      const candidates = resolved.candidates
        .slice(0, 5)
        .map((c) => `  - ${c.display_name} (slug: ${c.slug})`)
        .join('\n');
      throw new Error(
        `Brand input "${args.slug}" matches ${resolved.candidates.length} brands. Disambiguate by slug:\n${candidates}`,
      );
    } else {
      throw new Error(
        `Brand "${args.slug}" not found in the registry. Run \`node dist/cli.js brand list\` to see what's available. The resolver accepts slugs, display names, acronyms, and prefixes.`,
      );
    }
  }

  // From here on, ALWAYS use the canonical slug from the registry row —
  // args.slug may be a fuzzy input ("AOP", "Summit Labs").
  const canonicalSlug = row.slug;

  // 2. Cold-start context (validated).
  const ctxResult = await validateBrandContext(canonicalSlug, args.dataDir);
  const context = ctxResult.ok ? ctxResult.context : null;

  // 3. Brand config (OCL).
  const { config: brandConfig } = await readBrandConfig(
    canonicalSlug,
    args.dataDir,
  );

  // 4. Key brand flag.
  const keyBrands = await loadKeyBrands(args.dataDir);
  const isKey = keyBrands.some((k) => k.slug === canonicalSlug);

  // 5. Recent runs scan.
  const runs = await scanRecentRuns(canonicalSlug, args.dataDir, 10);

  // 6. User's display framing preference (acos | roas).
  const { profile } = await loadProfile(args.dataDir);
  const framing = profile.display?.metric_framing ?? 'acos';

  // ----- Compose body -----
  const blocks: string[] = [];

  blocks.push(
    renderPillsRow({
      isKey,
      adsActive: row.ads_active,
      retailActive: row.retail_active,
      coldStarted: row.cold_started,
    }),
  );

  blocks.push(
    renderScorecardRow(
      buildScorecards({ row, context, brandConfig, runs, isKey, framing }),
    ),
  );

  if (context) {
    blocks.push(
      renderCard({ title: 'Context', body: renderContextBody(context, framing) }),
    );
  } else {
    blocks.push(
      renderCard({
        title: 'Context',
        body: `
<p>No brand context yet. Run <code>/mx-brand-context ${escapeHtml(args.slug)}</code> in chat to capture posture, goals, and structural events.</p>`,
      }),
    );
  }

  blocks.push(
    renderCard({
      title: 'Calibration',
      body: renderCalibrationBody(brandConfig, args.slug),
    }),
  );

  blocks.push(
    renderCard({
      title: 'Recent runs',
      body: renderRunsTable(runs),
    }),
  );

  // ----- Build and write HTML -----
  const subtitle = row.cold_started_at
    ? `Set up ${formatDate(row.cold_started_at)} · ${row.accounts.length} account(s)`
    : `${row.accounts.length} account(s)`;

  const html = await renderPage({
    title: row.display_name,
    subtitle,
    theme: args.theme,
    body: blocks.join('\n\n'),
  });

  const outPath = `${brandDir(args.slug, args.dataDir)}/view.html`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf-8');
  return { path: outPath };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderPillsRow(opts: {
  isKey: boolean;
  adsActive: boolean;
  retailActive: boolean;
  coldStarted: boolean;
}): string {
  const pills: string[] = [];
  if (opts.isKey) pills.push(renderPill('Key brand', 'green'));
  if (opts.adsActive) pills.push(renderPill('Ads', 'default'));
  else pills.push(renderPill('Ads inactive', 'ghost'));
  if (opts.retailActive) pills.push(renderPill('Retail', 'default'));
  else pills.push(renderPill('Retail inactive', 'ghost'));
  if (opts.coldStarted) pills.push(renderPill('Brand context ready', 'green'));
  else pills.push(renderPill('Setup pending', 'amber'));
  return `<div style="display: flex; gap: 8px; flex-wrap: wrap;">${pills.join('')}</div>`;
}

function buildScorecards(args: {
  row: { accounts: Array<unknown>; ads_active: boolean; retail_active: boolean };
  context: unknown;
  brandConfig: Record<string, Record<string, unknown>>;
  runs: RunRecord[];
  isKey: boolean;
  framing: 'acos' | 'roas';
}): ScorecardOptions[] {
  const ctx = args.context as null | {
    management?: {
      acos_target_pct?: number;
      tacos_goal_pct?: number;
      primary_metric?: string;
    };
  };

  const skillsConfigured = Object.keys(args.brandConfig).length;
  const lastRunDate = args.runs.length > 0 ? args.runs[0]!.run_date : null;

  // ACoS + TACoS targets are framing-aware. We store canonical ACoS-style
  // percentages but display as RoAS multipliers when the user prefers it.
  // "Posture" is intentionally absent — it was an implicit input that
  // shaped skill behavior without surfacing on confirm cards. The skill
  // OCL now exposes the values it actually uses (ACoS + TACoS targets,
  // hero SKUs, etc.) instead of leaning on brand-level posture.
  const adMetric = frameMetric(
    ctx?.management?.acos_target_pct,
    'ad',
    args.framing,
  );
  const totalMetric = frameMetric(
    ctx?.management?.tacos_goal_pct,
    'total',
    args.framing,
  );

  return [
    {
      label: 'Accounts',
      value: formatInt(args.row.accounts.length),
    },
    { label: adMetric.label, value: adMetric.value },
    { label: totalMetric.label, value: totalMetric.value },
    {
      label: 'Skills configured',
      value: formatInt(skillsConfigured),
    },
    {
      label: 'Last run',
      value: lastRunDate ?? '—',
    },
  ];
}

function renderContextBody(ctx: unknown, framing: 'acos' | 'roas'): string {
  const c = ctx as {
    management?: {
      primary_metric?: string;
      acos_target_pct?: number;
      attribution_window_days?: number;
      tacos_goal_pct?: number;
    };
    accounts?: Array<{
      seller_name: string;
      account_type: string;
      marketplace?: string;
      status?: string;
    }>;
    sub_brands?: Array<{ slug: string; name: string }>;
    structural_events?: Array<{ id: string; type: string }>;
  };

  const lines: string[] = [];

  if (c.management) {
    const m = c.management;
    const items: string[] = [];
    // Primary metric only matters when framing is ACoS — RoAS-thinkers
    // implicitly use total/ad and don't need the explicit label.
    if (m.primary_metric && framing === 'acos')
      items.push(
        `Primary metric: <strong>${escapeHtml(m.primary_metric === 'TACOS' ? 'TACoS' : 'ACoS')}</strong>`,
      );
    if (m.acos_target_pct !== undefined) {
      const ad = frameMetric(m.acos_target_pct, 'ad', framing);
      items.push(`${ad.label}: <strong>${ad.value}</strong>`);
    }
    if (m.tacos_goal_pct !== undefined) {
      const total = frameMetric(m.tacos_goal_pct, 'total', framing);
      items.push(`${total.label}: <strong>${total.value}</strong>`);
    }
    if (m.attribution_window_days !== undefined)
      items.push(
        `Attribution window: <strong>${m.attribution_window_days} days</strong>`,
      );
    if (items.length > 0) {
      lines.push(`<p style="margin: 0 0 12px;">${items.join(' · ')}</p>`);
    }
  }

  if (c.accounts && c.accounts.length > 0) {
    lines.push(
      `<h4 style="margin: 16px 0 8px; font-size: 12px; font-weight: 600; color: var(--rc-text-sub); text-transform: none;">Accounts</h4>`,
    );
    const accountColumns: TableColumn[] = [
      { key: 'seller_name', label: 'Name' },
      { key: 'account_type', label: 'Type' },
      { key: 'marketplace', label: 'Marketplace' },
      {
        key: 'status',
        label: 'Status',
        render: (row) => {
          const s = String(row.status ?? 'active');
          const tone = s === 'active' ? 'green' : s === 'wind_down' ? 'amber' : 'ghost';
          return renderPill(sentenceCase(s), tone);
        },
      },
    ];
    lines.push(
      renderTable(
        accountColumns,
        c.accounts.map((a) => ({
          seller_name: a.seller_name,
          account_type: a.account_type,
          marketplace: a.marketplace ?? '—',
          status: a.status ?? 'active',
        })),
      ),
    );
  }

  if (c.sub_brands && c.sub_brands.length > 0) {
    const names = c.sub_brands.map((sb) => escapeHtml(sb.name)).join(', ');
    lines.push(
      `<p style="margin: 16px 0 0;"><span style="color: var(--rc-text-sub); font-size: 12px;">Sub-brands:</span> ${names}</p>`,
    );
  }

  if (c.structural_events && c.structural_events.length > 0) {
    const events = c.structural_events
      .map((e) => `${escapeHtml(e.type)} (${escapeHtml(e.id)})`)
      .join(', ');
    lines.push(
      `<p style="margin: 8px 0 0;"><span style="color: var(--rc-text-sub); font-size: 12px;">Active events:</span> ${events}</p>`,
    );
  }

  return lines.length > 0
    ? lines.join('\n')
    : `<p style="color: var(--rc-text-sub);">Context loaded but no rendered fields. Edit ${escapeHtml(contextPath('<slug>'))} to add posture, management, and accounts.</p>`;
}

function renderCalibrationBody(
  brandConfig: Record<string, Record<string, unknown>>,
  slug: string,
): string {
  const skillIds = Object.keys(brandConfig);
  if (skillIds.length === 0) {
    return `<p style="color: var(--rc-text-sub);">No skills calibrated yet. Run any skill — the confirmation prompt walks through tuning, then saves on confirm.</p>`;
  }
  const cols: TableColumn[] = [
    {
      key: 'skill_id',
      label: 'Skill',
      render: (row) => `<code style="font-size: 12px;">${escapeHtml(String(row.skill_id))}</code>`,
    },
    { key: 'field_count', label: 'Fields set', numeric: true },
    {
      key: 'edit',
      label: '',
      render: (row) =>
        `<span style="color: var(--rc-text-sub); font-size: 12px;">mixshift skill config ${escapeHtml(String(row.skill_id))} --brand ${escapeHtml(slug)}</span>`,
    },
  ];
  const rows = skillIds.map((id) => ({
    skill_id: id,
    field_count: Object.keys(brandConfig[id] ?? {}).length,
    edit: '',
  }));
  return renderTable(cols, rows);
}

interface RunRecord {
  skill_id: string;
  run_date: string;
  has_data: boolean;
  has_suggestions: boolean;
  has_applied: boolean;
  artifacts: string[];
}

function renderRunsTable(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return `<p style="color: var(--rc-text-sub);">No runs recorded yet. Skill runs land under <code>~/.mixshift/clients/&lt;slug&gt;/runs/&lt;skill&gt;/&lt;date&gt;/</code>.</p>`;
  }
  const cols: TableColumn[] = [
    {
      key: 'skill_id',
      label: 'Skill',
      render: (row) => `<code style="font-size: 12px;">${escapeHtml(String(row.skill_id))}</code>`,
    },
    { key: 'run_date', label: 'Date' },
    {
      key: 'artifacts',
      label: 'Artifacts',
      render: (row) => {
        const arts = (row.artifacts as string[]) ?? [];
        if (arts.length === 0) return renderPill('Empty', 'ghost');
        return arts.map((a) => renderPill(a, 'default')).join(' ');
      },
    },
    {
      key: 'status',
      label: 'Apply',
      render: (row) => {
        if (row.has_applied) return renderPill('Applied (dry-run)', 'green');
        if (row.has_suggestions) return renderPill('Pending apply', 'amber');
        return renderPill('—', 'ghost');
      },
    },
  ];
  return renderTable(cols, runs as unknown as Array<Record<string, unknown>>);
}

// ---------------------------------------------------------------------------
// Run scan
// ---------------------------------------------------------------------------

async function scanRecentRuns(
  slug: string,
  dataDir: string | undefined,
  limit: number,
): Promise<RunRecord[]> {
  const runsRoot = `${brandDir(slug, dataDir)}/runs`;
  let skillDirs: string[];
  try {
    skillDirs = await readdir(runsRoot);
  } catch {
    return [];
  }

  const records: RunRecord[] = [];
  for (const skillId of skillDirs) {
    const skillDir = `${runsRoot}/${skillId}`;
    let dateDirs: string[];
    try {
      dateDirs = await readdir(skillDir);
    } catch {
      continue;
    }
    for (const runDate of dateDirs) {
      const runDir = `${skillDir}/${runDate}`;
      try {
        const s = await stat(runDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      const [hasData, hasSuggestions, hasApplied, files] = await Promise.all([
        fileExists(`${runDir}/data.json`),
        fileExists(`${runDir}/suggestions.json`),
        fileExists(`${runDir}/applied.json`),
        listKnownArtifacts(runDir),
      ]);
      records.push({
        skill_id: skillId,
        run_date: runDate,
        has_data: hasData,
        has_suggestions: hasSuggestions,
        has_applied: hasApplied,
        artifacts: files,
      });
    }
  }

  // Newest first by run_date string (YYYY-MM-DD sorts lexicographically).
  records.sort((a, b) => (a.run_date < b.run_date ? 1 : a.run_date > b.run_date ? -1 : 0));
  return records.slice(0, limit);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listKnownArtifacts(runDir: string): Promise<string[]> {
  const candidates = [
    { file: 'data.json', label: 'data' },
    { file: 'suggestions.json', label: 'suggestions' },
    { file: 'overrides.json', label: 'overrides' },
    { file: 'applied.json', label: 'applied' },
    { file: 'ocl.yaml', label: 'ocl' },
    { file: 'report.html', label: 'report' },
    { file: 'report.md', label: 'report' },
  ];
  const labels: string[] = [];
  for (const c of candidates) {
    if (await fileExists(`${runDir}/${c.file}`)) {
      if (!labels.includes(c.label)) labels.push(c.label);
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentenceCase(s: string): string {
  if (!s) return s;
  // snake_case → "Snake case"
  const spaced = s.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

async function openInBrowser(path: string): Promise<void> {
  // Cross-platform: pick the right command. Errors are non-fatal — the file
  // is written regardless and the user sees its path.
  try {
    if (process.platform === 'win32') {
      await exec(`start "" "${path}"`);
    } else if (process.platform === 'darwin') {
      await exec(`open "${path}"`);
    } else {
      await exec(`xdg-open "${path}"`);
    }
  } catch {
    // Best effort.
  }
}
