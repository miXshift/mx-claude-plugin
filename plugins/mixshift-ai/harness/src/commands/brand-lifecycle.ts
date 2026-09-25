/**
 * `mixshift brand retire <slug>` (alias `brand archive`) and
 * `mixshift brand restore <slug>` — brand retire, slice 1.
 *
 * Retiring a brand is a TEAM-WIDE, reversible, audited change recorded by the
 * MixShift service (POST /api/context/lifecycle). It only changes whether the
 * brand shows as active in the team's shared brand context and whether bulk
 * syncs include it. It never deletes docs, revisions, timeline history,
 * local files, Amazon accounts or warehouse data, and it never filters a
 * report or a total. The output answers the questions a customer asks right
 * after pressing the button: what changed, what did not, who it was recorded
 * as, whether the local copy can go, and the exact undo.
 *
 * Old service: a 404/405 that is not {error:'unknown_brand'} means this
 * MixShift service predates brand retire; the command says so plainly and
 * changes nothing.
 *
 * Copy rules (customer-facing): plain words, no em dashes, "brand setup"
 * never "cold start".
 */

import type { Command } from 'commander';
import { loadCredentials } from '../lib/auth/credentials.js';
import { createContextSyncClient } from '../lib/context-sync/client.js';
import {
  getCachedOrgManifest,
  ORG_MANIFEST_PERSIST_BUDGET_MS,
} from '../lib/context-sync/autosync.js';
import { brandDirExists, isSafeBrandSlug } from '../lib/context-sync/local.js';
import {
  LIFECYCLE_NOTE_MAX,
  findManifestBrand,
  formatLifecycleDate,
  retiredByClause,
  retiredLifecycleOf,
  restoreCommand,
  retireCommand,
  safeDisplay,
} from '../lib/context-sync/lifecycle.js';
import {
  resolveLedgerIdentity,
  saveOrgManifestCache,
} from '../lib/context-sync/state.js';
import {
  RETIRE_REASON_CODES,
  type BrandLifecycleAction,
  type RetireReasonCode,
  type SetBrandLifecycleResult,
  type WireBrandLifecycle,
  type WireManifestBrand,
} from '../lib/context-sync/types.js';
import { brandDir } from '../lib/paths/resolve.js';
import { DEADLINE, raceDeadline } from '../lib/utils/deadline.js';
import { EventName, track } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

/** Budget for the post-change manifest re-read that names who the change
 *  was recorded as. Past it the command falls back to this machine's
 *  sign-in; the change itself is already recorded either way. */
export const LIFECYCLE_READBACK_BUDGET_MS = 5_000;

const REASON_LABELS: Record<RetireReasonCode, string> = {
  client_left: 'client left',
  duplicate: 'duplicate of another brand',
  superseded: 'replaced by another brand',
  other: 'other',
};

export function registerBrandLifecycleCommands(brand: Command): void {
  brand
    .command('retire <slug>')
    // `brand archive` was advertised before this existed and users typed it.
    // It is the same command: retire, never a hard delete.
    .alias('archive')
    .description(
      'Retire a brand your team no longer works on. It stops showing as active ' +
        "in your team's shared brand context and bulk syncs skip it, for everyone " +
        'on your team. Nothing is deleted: docs, revision history, timeline ' +
        'history, Amazon accounts, reports and totals stay as they are. Undo with ' +
        '`mixshift brand restore <slug>`. (`brand archive` is the same command.)',
    )
    .option(
      '--reason <code>',
      `why the brand is retired: ${RETIRE_REASON_CODES.join(' | ')}`,
    )
    .option('--note <text>', `a short note for your team (up to ${LIFECYCLE_NOTE_MAX} characters)`)
    .action(async (slug: string, opts: { reason?: string; note?: string }, cmd: Command) => {
      await runLifecycleChange('retire', slug, opts, cmd.optsWithGlobals<RootOptions>());
    });

  brand
    .command('restore <slug>')
    .description(
      "Bring a retired brand back for your whole team. It shows as active in your team's " +
        'shared brand context again and bulk syncs include it again, with its docs, ' +
        'revision history and timeline exactly as they were.',
    )
    .action(async (slug: string, _opts: unknown, cmd: Command) => {
      await runLifecycleChange('restore', slug, {}, cmd.optsWithGlobals<RootOptions>());
    });
}

// ---------------------------------------------------------------------------
// The shared action
// ---------------------------------------------------------------------------

type TelemetryOutcome =
  | 'changed'
  | 'unchanged'
  | 'unknown_brand'
  | 'unsupported'
  | 'refused'
  | 'invalid_input'
  | 'failed';

export interface RecordedAs {
  label: string;
  /** 'service' = read back from the team's shared record (authoritative);
   *  'this_sign_in' = the service's record was not readable just now, so
   *  this is the sign-in this computer used for the request. */
  source: 'service' | 'this_sign_in';
  service_credential: boolean;
}

async function runLifecycleChange(
  action: BrandLifecycleAction,
  slug: string,
  opts: { reason?: string; note?: string },
  root: RootOptions,
): Promise<void> {
  const t0 = Date.now();
  const safeSlug = isSafeBrandSlug(slug);

  // --- Local validation (no network) ------------------------------------
  let invalid: string | null = null;
  let reason: RetireReasonCode | undefined;
  let note: string | undefined;
  if (!safeSlug) {
    invalid = `"${safeDisplay(slug, 80) ?? slug}" is not a brand slug. Use the slug \`mixshift brand list --all\` shows (for example acme-snacks).`;
  } else if (opts.reason !== undefined) {
    if ((RETIRE_REASON_CODES as readonly string[]).includes(opts.reason)) {
      reason = opts.reason as RetireReasonCode;
    } else {
      invalid = `--reason must be one of: ${RETIRE_REASON_CODES.join(', ')} (got "${safeDisplay(opts.reason, 40) ?? ''}").`;
    }
  }
  if (invalid === null && opts.note !== undefined) {
    const trimmed = opts.note.trim();
    if (trimmed.length > LIFECYCLE_NOTE_MAX) {
      invalid = `--note is ${trimmed.length} characters; the limit is ${LIFECYCLE_NOTE_MAX}.`;
    } else if (trimmed !== '') {
      note = trimmed;
    }
  }
  if (invalid !== null) {
    await trackChange(action, safeSlug ? slug : null, reason, 'invalid_input', undefined, t0, root);
    emitFailure(root, 'bad_params', invalid);
    return;
  }

  // --- The change -------------------------------------------------------
  const client = createContextSyncClient({ dataDirOverride: root.dataDir });
  let result: SetBrandLifecycleResult;
  if (!client.setBrandLifecycle) {
    result = {
      ok: false,
      kind: 'unsupported',
      message: 'client does not support lifecycle changes',
      friendly: unsupportedCopy(action),
    };
  } else {
    result = await client.setBrandLifecycle({
      brand_slug: slug,
      action,
      ...(reason !== undefined ? { reason_code: reason } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  if (!result.ok) {
    const outcome: TelemetryOutcome =
      result.kind === 'unknown_brand'
        ? 'unknown_brand'
        : result.kind === 'unsupported'
          ? 'unsupported'
          : result.kind === 'insufficient_scope'
            ? 'refused'
            : 'failed';
    await trackChange(action, slug, reason, outcome, undefined, t0, root);
    emitFailure(
      root,
      result.kind,
      result.kind === 'unsupported' ? unsupportedCopy(action) : result.friendly,
    );
    return;
  }

  // --- Read back who it was recorded as -----------------------------------
  // The POST answer carries no actor. The manifest's lifecycle field is the
  // team's shared record, so read it back once (bounded) and refresh the
  // local org-manifest cache with it, so `brand list` reflects the change
  // right away. Fall back to this computer's sign-in when it cannot be read.
  const readback = await readBackLifecycle(client, slug, root.dataDir);
  const recordedAs = await resolveRecordedAs(readback, result.state, root.dataDir);
  const localPath = brandDir(slug, root.dataDir);
  const localExists = await brandDirExists(slug, root.dataDir);

  await trackChange(
    action,
    slug,
    reason,
    result.changed ? 'changed' : 'unchanged',
    result.changed,
    t0,
    root,
  );

  if (root.json) {
    const undo = result.state === 'retired' ? restoreCommand(slug) : retireCommand(slug);
    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          brand_slug: result.brand_slug,
          action,
          state: result.state,
          changed: result.changed,
          at: result.at,
          ...(result.event_id !== undefined ? { event_id: result.event_id } : {}),
          reason_code: action === 'retire' ? (reason ?? null) : null,
          recorded_as: recordedAs,
          lifecycle: readback ?? null,
          local_copy: {
            path: localPath,
            exists: localExists,
            // Retired brands are never re-seeded by syncs, so deleting the
            // local copy sticks. MixShift never deletes it itself.
            ...(result.state === 'retired' ? { safe_to_delete: true } : {}),
          },
          undo,
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = 0;
    return;
  }

  const lines =
    result.state === 'retired'
      ? retireLines(slug, result.changed, readback, recordedAs, reason, note, localPath, localExists)
      : restoreLines(slug, result.changed, recordedAs, localExists);
  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function unsupportedCopy(action: BrandLifecycleAction): string {
  return (
    `${action === 'retire' ? 'Retiring' : 'Restoring'} a brand is not available on this ` +
    'MixShift service yet. Nothing was changed. Try again after the service is updated.'
  );
}

function recordedAsLine(r: RecordedAs): string {
  const who =
    r.source === 'service' ? r.label : `${r.label} (the sign-in this computer used)`;
  return r.service_credential
    ? `  Recorded as: ${who}. That is a service credential, not a person; your teammates will see this name.`
    : `  Recorded as: ${who}. Your teammates will see this name.`;
}

export function retireLines(
  slug: string,
  changed: boolean,
  readback: WireBrandLifecycle | null,
  recordedAs: RecordedAs,
  reason: RetireReasonCode | undefined,
  note: string | undefined,
  localPath: string,
  localExists: boolean,
): string[] {
  const lines: string[] = [''];
  if (!changed) {
    const by = readback ? ` (${retiredByClause(readback)})` : '';
    lines.push(`${slug} was already retired for your team${by}. Nothing changed.`);
  } else {
    lines.push(`Retired ${slug} for your team.`);
    lines.push(recordedAsLine(recordedAs));
    if (reason !== undefined || note !== undefined) {
      const bits: string[] = [];
      if (reason !== undefined) bits.push(`Reason: ${REASON_LABELS[reason]}.`);
      if (note !== undefined) bits.push(`Note: "${note}"`);
      lines.push(`  ${bits.join(' ')}`);
    }
    lines.push('');
    lines.push('What changed');
    lines.push(`  - ${slug} no longer shows as an active brand in your team's shared brand context.`);
    lines.push(
      '  - Bulk syncs (`mixshift context status`, `pull`, `push` and `sync` without --brand) ' +
        'skip it, for everyone on your team.',
    );
    lines.push(
      '  - Anyone who asks for it by name still gets it, with a short note that it is retired.',
    );
    lines.push('');
    lines.push('What did not change');
    lines.push('  - Its brand context docs and their revision history are all kept.');
    lines.push('  - Its timeline history is kept.');
    lines.push(
      '  - Its Amazon accounts, billing, reports and totals are not affected. Reports still include its data.',
    );
    lines.push(
      '  - Run files (sidecars) stay on this computer only. They were never sent to MixShift.',
    );
  }
  lines.push('');
  lines.push('Your local copy');
  if (localExists) {
    lines.push(
      `  - It is now safe to delete ${localPath} if you no longer want it here. Syncs will not ` +
        'bring a retired brand back. MixShift never deletes it for you.',
    );
    lines.push(
      '  - Deleting it also deletes the run files kept inside it, which exist only on this computer.',
    );
  } else {
    lines.push('  - This computer has no local copy of this brand. Nothing to clean up.');
  }
  lines.push('');
  lines.push(`To undo: ${restoreCommand(slug)}`);
  return lines;
}

export function restoreLines(
  slug: string,
  changed: boolean,
  recordedAs: RecordedAs,
  localExists: boolean,
): string[] {
  const lines: string[] = [''];
  if (!changed) {
    lines.push(`${slug} is already active for your team. Nothing changed.`);
    return lines;
  }
  lines.push(`Restored ${slug} for your team.`);
  lines.push(recordedAsLine(recordedAs));
  lines.push('');
  lines.push(
    `  - ${slug} shows as an active brand again in your team's shared brand context, and bulk syncs include it again.`,
  );
  lines.push(
    '  - Its docs, revision history and timeline were kept while it was retired, so there is nothing to set up again.',
  );
  if (!localExists) {
    lines.push(
      `  - To get a local copy on this computer: mixshift context pull --brand ${slug}`,
    );
  }
  lines.push('');
  lines.push(`To undo: ${retireCommand(slug)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBackLifecycle(
  client: ReturnType<typeof createContextSyncClient>,
  slug: string,
  dataDirOverride: string | undefined,
): Promise<WireBrandLifecycle | null> {
  try {
    const raced = await raceDeadline(
      client.fetchManifest({ lifecycle: 'all' }),
      LIFECYCLE_READBACK_BUDGET_MS,
    );
    if (raced === DEADLINE || !raced.ok) return null;
    await refreshOrgManifestCache(raced.brands, dataDirOverride);
    const entry = findManifestBrand(raced.brands, slug);
    return entry?.lifecycle ?? null;
  } catch {
    return null;
  }
}

/** Best-effort: replace the org-manifest cache with the fresh read so the
 *  change shows up in `brand list` immediately (the cache otherwise lives up
 *  to 15 minutes). Identity-stamped exactly like getCachedOrgManifest's own
 *  save. Never throws. */
async function refreshOrgManifestCache(
  brands: WireManifestBrand[],
  dataDirOverride: string | undefined,
): Promise<void> {
  try {
    const identity = await resolveLedgerIdentity(dataDirOverride);
    await raceDeadline(
      saveOrgManifestCache(
        {
          fetched_at: new Date().toISOString(),
          brands,
          ...(identity ? { identity } : {}),
        },
        dataDirOverride,
      ),
      ORG_MANIFEST_PERSIST_BUDGET_MS,
    );
  } catch {
    // Cache is an optimization only.
  }
}

async function resolveRecordedAs(
  readback: WireBrandLifecycle | null,
  state: 'active' | 'retired',
  dataDirOverride: string | undefined,
): Promise<RecordedAs> {
  const fromService =
    readback && readback.state === state ? safeDisplay(readback.changed_by) : null;
  if (fromService) {
    return {
      label: fromService,
      source: 'service',
      service_credential: fromService.startsWith('svc:'),
    };
  }
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    if (credentials?.datahub) {
      return {
        label: safeDisplay(credentials.datahub.person_label) ?? 'your signed-in account',
        source: 'this_sign_in',
        service_credential: false,
      };
    }
    if (credentials?.service) {
      return {
        label: safeDisplay(credentials.service.label) ?? 'a service credential',
        source: 'this_sign_in',
        service_credential: true,
      };
    }
  } catch {
    // fall through
  }
  return { label: 'your signed-in account', source: 'this_sign_in', service_credential: false };
}

function emitFailure(root: RootOptions, kind: string, message: string): void {
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'error', kind, message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

async function trackChange(
  action: BrandLifecycleAction,
  slug: string | null,
  reason: RetireReasonCode | undefined,
  outcome: TelemetryOutcome,
  changed: boolean | undefined,
  t0: number,
  root: RootOptions,
): Promise<void> {
  try {
    await track(
      {
        event_name: EventName.BrandLifecycleChanged,
        outcome: outcome === 'changed' || outcome === 'unchanged' ? 'ok' : 'failed',
        duration_ms: Date.now() - t0,
        payload: {
          brand_slug: slug,
          action,
          reason_code: action === 'retire' ? (reason ?? null) : null,
          outcome,
          ...(changed !== undefined ? { changed } : {}),
        },
      },
      root.dataDir,
    );
  } catch {
    // Telemetry never fails the command.
  }
}

// ---------------------------------------------------------------------------
// `brand list` support: which brands are retired (fail open)
// ---------------------------------------------------------------------------

/**
 * Retired brands by slug from the org manifest, via the shared org-manifest
 * cache (a cache hit costs no network; a cold cache costs one budgeted
 * fetch). null when the manifest is unavailable: callers then show every
 * brand exactly as before (fail open).
 */
export async function loadRetiredBrands(
  dataDirOverride: string | undefined,
): Promise<Map<string, WireBrandLifecycle> | null> {
  try {
    const manifest = await getCachedOrgManifest({ dataDirOverride });
    if (!manifest.ok) return null;
    const out = new Map<string, WireBrandLifecycle>();
    for (const b of manifest.brands) {
      const lc = retiredLifecycleOf(b);
      if (lc) out.set(b.brand_slug, lc);
    }
    return out;
  } catch {
    return null;
  }
}

/** Footer line for the brands `brand list` hid because they are retired. */
export function retiredHiddenFooter(hidden: Array<{ slug: string; lifecycle: WireBrandLifecycle }>): string {
  const n = hidden.length;
  const items = hidden
    .map((h) => {
      const date = formatLifecycleDate(h.lifecycle.changed_at);
      return `${h.slug} (retired by ${safeDisplay(h.lifecycle.changed_by) ?? 'a teammate'}${date ? ` on ${date}` : ''})`;
    })
    .join(', ');
  return (
    `${n} retired brand${n === 1 ? '' : 's'} hidden: ${items}. ` +
    'Use --all to see them; `mixshift brand restore <slug>` brings one back.'
  );
}
