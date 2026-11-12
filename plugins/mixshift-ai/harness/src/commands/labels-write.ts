/**
 * `mixshift labels ...` WRITE commands: change the labels on your items (ASINs) and Amazon
 * campaigns through the MixShift service (lib/labels/write-client.ts). The read commands are in
 * labels.ts; this file adds to the same `labels` group.
 *
 * Command shape:
 *   labels preview --account <id> [--entity item|campaign] [--scope marketplace|region|all]
 *                  ( --ids <a,b> | --ids-file <path> | --where <field=value> ) ( --set field=value | --clear field )...
 *                  | --file <changes.csv>
 *                  | --rename <field> --from <value> --to <value>
 *   labels commit <change-set-id> [--commit] [--approval-hash <hash>]
 *   labels undo <change-set-id>
 *   labels sets --account <id> [--limit n] [--before <time>] [--all]
 *   labels set <change-set-id>
 *   labels cancel <change-set-id>
 *   labels field-name --account <id> [--entity ...] --field <key> ( --name <text> | --remove ) [--commit]
 *   (all take --json)
 *
 * The contract, in one paragraph. `preview` changes NOTHING: it asks the service to freeze the
 * selection and answer with a change set id, an approval hash, a 24-hour expiry and a summary of
 * exactly what would change. The id and the hash are kept on this machine (lib/labels/pending.ts),
 * so nobody retypes a hash. `commit` applies THAT preview, and the request is made ONLY when
 * `--commit` is passed (the flag the Amazon Ads writes use): without it, `commit` reads the
 * change set back, shows it, and sends nothing. The skill or person that runs it must show the
 * preview and get an explicit yes first. `field-name` (an account's own name for a field) has no
 * preview in the service, so it follows the same rule: it prints what it would do, and only
 * `--commit` sends it.
 *
 * Output contract (same as the read commands): `--json` prints ONE compact JSON object on one line,
 * last on stdout; human notes go to stderr; handlers set process.exitCode. A commit that did not
 * fully apply is never a success: exit 17 and the per-item results, whatever the mix.
 * Telemetry carries counts, the change set id and the outcome; never a label value, an item or
 * campaign id, or the approval hash.
 */

import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { exitCodeForLabelsKind, isLabelsFailure, type LabelEntity, type LabelsFailure } from '../lib/labels/client.js';
import {
  CHANGE_SET_MAX,
  LABEL_SCOPES,
  labelsCancel,
  labelsChangeSet,
  labelsChangeSets,
  labelsCommit,
  labelsPreview,
  labelsRemoveFieldName,
  labelsSetFieldName,
  labelsUndo,
  type ChangeSetListRow,
  type ChangeSetView,
  type CommitBody,
  type LabelScope,
  type LabelsSelection,
  type ResultRow,
} from '../lib/labels/write-client.js';
import { checkEntityId, checkLabelValue, fieldKeysFor, parseChangeCsv, parseSetFlags, type FieldSet } from '../lib/labels/change-input.js';
import { HASH_RE, UUID_RE, loadPending, removePending, savePending } from '../lib/labels/pending.js';
import {
  UTF16_MESSAGE,
  accountMessage,
  badInput,
  blank,
  cell,
  decodeIdsFile,
  entityMessage,
  noteFreshness,
  normalizeIds,
  parseAccount,
  parseEntity,
  trackLabels,
  writeJson,
  withoutOk,
  type CallKind,
  type RootOptions,
} from './labels.js';

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** Rows of detail printed in a table before "and N more" (the full list stays in --json). */
const SHOW_ROWS = 50;

/** The longest filter or rename value the service takes. */
const MATCH_MAX = 4_000;

/** The longest display name for a field. */
const NAME_MAX = 80;

const SETS_PAGE_MAX = 200;
const SETS_DEFAULT = 20;
const SETS_ALL_CAP = 200;

const commitCommand = (id: string): string => `mixshift labels commit ${id} --commit`;

export function registerLabelsWriteCommands(program: Command): void {
  const labels = program.commands.find((c) => c.name() === 'labels');
  if (!labels) throw new Error('registerLabelsCommands must run before registerLabelsWriteCommands');

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------
  labels
    .command('preview')
    .description(
      'Preview a label change. Changes NOTHING: it prints a change set id and a summary of exactly what would change ' +
        '(counts, the accounts reached, what was left out and why, warnings, a before and after sample) and expires in 24 hours. ' +
        'Pick items or campaigns with --ids / --ids-file, with --where field=value (everything whose field has that value), ' +
        'with --file (a CSV, one row per item or campaign), or rename a value everywhere with --rename. ' +
        'Apply it with `labels commit <id> --commit`, only after the person has confirmed this preview. ' +
        'Works once label editing is turned on for the account.',
    )
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--entity <entity>', 'item (default) or campaign')
    .option('--ids <list>', 'comma-separated ASINs (or campaign ids with --entity campaign) to change')
    .option('--ids-file <path>', 'a text file of ids, separated by commas, spaces or new lines')
    .option('--where <field=value>', 'every item or campaign whose field equals this exact value (case and spacing included), for example item_group="Water Bottles"')
    .option('--file <path>', `a CSV: a header (asin or campaign_id first, then one column per label field), then one row per item or campaign; at most ${CHANGE_SET_MAX} rows. An empty cell leaves a field alone and <clear> removes it`)
    .option('--set <field=value>', 'with --ids, --ids-file or --where: set a field to a value (repeatable), for example --set brand="Acme Home"', collect)
    .option('--clear <field>', 'with --ids, --ids-file or --where: remove the label from a field (repeatable)', collect)
    .option('--rename <field>', 'rename a value: every item or campaign whose <field> equals --from gets --to (with --from and --to)')
    .option('--from <value>', 'with --rename: the exact value to replace')
    .option('--to <value>', 'with --rename: the new value')
    .option('--scope <scope>', 'marketplace (this account only), region (every marketplace of the merchant; the usual default) or all (every account of that merchant type). Items only: a campaign belongs to one account')
    .action(async (opts: PreviewOpts, cmd: Command) => runPreview(opts, cmd.optsWithGlobals<RootOptions>()));

  // -------------------------------------------------------------------------
  // commit
  // -------------------------------------------------------------------------
  labels
    .command('commit <change-set-id>')
    .description(
      'Commit a previewed label change. WRITES to your labels, so it is sent ONLY with --commit, and only after the person has seen the preview ' +
        'and confirmed it. Without --commit it shows the change set again and sends nothing. ' +
        'The approval hash is read from the preview made on this machine. ' +
        'Each item or campaign is checked against what the preview saw: one changed since is left as it is and reported stale. ' +
        'Exit 17 when anything was stale, refused or failed. Committing the same change set again is safe.',
    )
    .option('--commit', 'actually apply the change set (default: show it and send nothing). Use only after explicit confirmation of the preview')
    .option('--approval-hash <hash>', 'the approval hash the preview returned, for a change set previewed on another machine (this machine keeps its own)')
    .action(async (id: string, opts: { commit?: boolean; approvalHash?: string }, cmd: Command) => runCommit(id, opts, cmd.optsWithGlobals<RootOptions>()));

  // -------------------------------------------------------------------------
  // undo / sets / set / cancel
  // -------------------------------------------------------------------------
  labels
    .command('undo <change-set-id>')
    .description(
      'Preview the reversal of a committed change set: a NEW change set that sets each field back to what it was. Changes nothing until you commit it with `labels commit <new id> --commit`. ' +
        'An item changed again since is left alone and reported stale, so nothing newer is overwritten.',
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => runUndo(id, cmd.optsWithGlobals<RootOptions>()));

  labels
    .command('sets')
    .description('The label change sets that reach an account, newest first: id, kind, status, scope, what changed, who and when.')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--limit <n>', `change sets a page, 1 to ${SETS_PAGE_MAX} (default ${SETS_DEFAULT})`)
    .option('--before <time>', 'continue from the next_before of a previous page')
    .option('--all', `follow every page, up to ${SETS_ALL_CAP} change sets; says when it stopped and how to continue`)
    .action(async (opts: { account: string; limit?: string; before?: string; all?: boolean }, cmd: Command) => runSets(opts, cmd.optsWithGlobals<RootOptions>()));

  labels
    .command('set <change-set-id>')
    .description('One change set: the preview (what would change) or, once committed, what happened to each item or campaign.')
    .action(async (id: string, _opts: unknown, cmd: Command) => runSet(id, cmd.optsWithGlobals<RootOptions>()));

  labels
    .command('cancel <change-set-id>')
    .description('Cancel a preview you no longer want. Nothing was changed by it, and nothing is. Only a preview can be cancelled.')
    .action(async (id: string, _opts: unknown, cmd: Command) => runCancel(id, cmd.optsWithGlobals<RootOptions>()));

  // -------------------------------------------------------------------------
  // field-name
  // -------------------------------------------------------------------------
  labels
    .command('field-name')
    .description(
      'Give an account its own name for a label field (for example "Pattern ID" for Item Label 2) that every label read then shows, or remove it. ' +
        'There is no preview for this: it is sent ONLY with --commit, after the person confirms. Without --commit it prints what it would do and sends nothing.',
    )
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--entity <entity>', 'item (default) or campaign')
    .requiredOption('--field <key>', 'a field key from `labels fields` (for example label_2)')
    .option('--name <text>', `the display name, plain text on one line, at most ${NAME_MAX} characters`)
    .option('--remove', 'remove the custom name so the field shows its standard name again')
    .option('--commit', 'actually make the change (default: print it and send nothing). Use only after explicit confirmation')
    .action(async (opts: FieldNameOpts, cmd: Command) => runFieldName(opts, cmd.optsWithGlobals<RootOptions>()));
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

interface PreviewOpts {
  account: string;
  entity?: string;
  ids?: string;
  idsFile?: string;
  where?: string;
  file?: string;
  set?: string[];
  clear?: string[];
  rename?: string;
  from?: string;
  to?: string;
  scope?: string;
}

type PreviewMode = 'ids' | 'where' | 'file' | 'rename';

/** One change set to ask for: its selection and, for ids and filters, the fields to set. */
interface PreviewRequest {
  selection: LabelsSelection;
  set?: FieldSet;
}

async function runPreview(opts: PreviewOpts, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  const account = parseAccount(opts.account);
  if (!account) return badInput(accountMessage(), root);
  const parsedEntity = parseEntity(opts.entity ?? 'item');
  if (!parsedEntity || parsedEntity.length !== 1) return badInput(entityMessage(), root);
  const entity = parsedEntity[0]!;
  let scope: LabelScope | undefined;
  if (opts.scope !== undefined) {
    const s = opts.scope.trim().toLowerCase();
    if (!(LABEL_SCOPES as readonly string[]).includes(s)) return badInput(`--scope must be one of ${LABEL_SCOPES.join(', ')}.`, root);
    scope = s as LabelScope;
  }
  if (entity === 'campaign' && scope !== undefined && scope !== 'marketplace') {
    return badInput('A campaign belongs to exactly one account, so a campaign change can only use --scope marketplace.', root);
  }

  const modes: PreviewMode[] = [];
  if (opts.ids !== undefined || opts.idsFile !== undefined) modes.push('ids');
  if (opts.where !== undefined) modes.push('where');
  if (opts.file !== undefined) modes.push('file');
  if (opts.rename !== undefined) modes.push('rename');
  if (modes.length !== 1) {
    return badInput('Pick exactly one way to choose what changes: --ids or --ids-file, --where, --file, or --rename (with --from and --to).', root);
  }
  const mode = modes[0]!;
  if (opts.ids !== undefined && opts.idsFile !== undefined) return badInput('Pass either --ids <a,b,c> or --ids-file <path>, not both.', root);
  const hasFlagsSet = (opts.set?.length ?? 0) + (opts.clear?.length ?? 0) > 0;
  if (mode === 'file' || mode === 'rename') {
    if (hasFlagsSet) return badInput(`--set and --clear do not go with ${mode === 'file' ? '--file (the file holds the values)' : '--rename (it has --from and --to)'}.`, root);
  }
  if (mode !== 'rename' && (opts.from !== undefined || opts.to !== undefined)) return badInput('--from and --to only go with --rename.', root);
  if (mode === 'rename' && (opts.from === undefined || opts.to === undefined)) return badInput('--rename needs --from <current value> and --to <new value>.', root);

  const requests: PreviewRequest[] = [];
  let fileRows: number | undefined;
  if (mode === 'ids' || mode === 'where') {
    if (!hasFlagsSet) return badInput('Say what to change: --set <field=value> and/or --clear <field>.', root);
    const flags = parseSetFlags(entity, opts.set ?? [], opts.clear ?? []);
    if (!flags.ok) return badInput(flags.message, root);
    if (mode === 'ids') {
      const read = await readIds(opts, entity);
      if (!read.ok) return badInput(read.message, root);
      requests.push({ selection: { ids: read.ids }, set: flags.set });
    } else {
      const eq = (opts.where as string).indexOf('=');
      if (eq <= 0) return badInput('--where takes field=value, for example --where item_group="Water Bottles".', root);
      const field = (opts.where as string).slice(0, eq).trim().toLowerCase();
      const value = (opts.where as string).slice(eq + 1);
      if (!fieldKeysFor(entity).includes(field)) return badInput(`--where ${field}: not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).`, root);
      if (value.length === 0 || value.length > MATCH_MAX) return badInput(`--where needs a value of 1 to ${MATCH_MAX} characters: the exact value to match.`, root);
      requests.push({ selection: { filter: { field, value } }, set: flags.set });
    }
  } else if (mode === 'rename') {
    const field = (opts.rename as string).trim().toLowerCase();
    const from = opts.from as string;
    if (!fieldKeysFor(entity).includes(field)) return badInput(`--rename ${field}: not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).`, root);
    if (from.length === 0 || from.length > MATCH_MAX) return badInput(`--from needs 1 to ${MATCH_MAX} characters: the exact value to replace.`, root);
    const to = checkLabelValue(entity, field, opts.to as string);
    if (!to.ok) return badInput(`--to: ${to.message}.`, root);
    if (to.value === from) return badInput('--to is the same as --from; there is nothing to rename.', root);
    requests.push({ selection: { rename: { field, from, to: to.value } } });
  } else {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.file as string);
    } catch (err) {
      return badInput(`Cannot read --file: ${err instanceof Error ? err.message : String(err)}`, root);
    }
    const text = decodeIdsFile(bytes);
    if (text === null) return badInput(UTF16_MESSAGE.replace('--ids-file', '--file').replace('ids.txt', 'changes.csv'), root);
    const parsed = parseChangeCsv(text, entity);
    if (!parsed.ok) {
      const lines = [...parsed.errors, ...(parsed.more > 0 ? [`...and ${parsed.more} more.`] : [])];
      if (root.json) writeJson({ status: 'error', failure_kind: 'invalid_input', message: `The file has ${parsed.errors.length + parsed.more} problem(s); nothing was sent.`, errors: parsed.errors, more: parsed.more });
      else process.stderr.write(`error: the file has problems; nothing was sent.\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    fileRows = parsed.rows;
    for (const g of parsed.groups) requests.push({ selection: { ids: g.ids }, set: g.set });
  }

  const base = { account: Number(account), entity, mode, scope: scope ?? 'default', ...(fileRows !== undefined ? { rows: fileRows } : {}) };
  const created: ChangeSetView[] = [];
  let saved = 0;
  for (const [i, req] of requests.entries()) {
    const result = await labelsPreview(
      { account, entity, selection: req.selection, ...(req.set !== undefined ? { set: req.set } : {}), ...(scope !== undefined ? { scope } : {}) },
      { dataDirOverride: root.dataDir },
    );
    if (isLabelsFailure(result)) {
      const extra = created.length > 0 ? { change_sets: created.map((v) => viewJson(v)), failed_group: i + 1, groups: requests.length } : {};
      if (!root.json && created.length > 0) {
        printPreviews(created, entity, root, requests.length);
        process.stderr.write(`\nChange set ${i + 1} of ${requests.length} could not be made; the ${created.length} above were. Previews change nothing, so you can use them, or cancel them with \`mixshift labels cancel <id>\`.\n`);
      }
      return fail(result, 'preview', startedAt, root, { ...base, change_sets: requests.length }, extra);
    }
    created.push(result);
    if (await rememberApproval(result, Number(account), root.dataDir)) saved += 1;
  }

  const totals = sumTotals(created);
  await trackLabels('preview', 'ok', startedAt, root.dataDir, {
    ...base,
    service_state: created[0]!.state,
    change_sets: created.length,
    identities: totals.identities,
    to_change: totals.to_change,
    unchanged: totals.unchanged,
    dropped: created.reduce((n, v) => n + (v.dropped?.identities ?? 0), 0),
    warnings: created.reduce((n, v) => n + v.warnings.length, 0),
    committable: created.every((v) => v.can_commit),
    change_set_ids: created.map((v) => v.change_set_id),
  });
  if (root.json) {
    return writeJson({
      status: 'ok',
      committed: false,
      count: created.length,
      ...(fileRows !== undefined ? { rows: fileRows } : {}),
      change_sets: created.map((v) => viewJson(v, saved === created.length)),
    });
  }
  printPreviews(created, entity, root, requests.length);
  if (saved < created.length) {
    process.stderr.write('  (This machine could not keep the approvals, so commit needs --approval-hash; run again with --json to see it.)\n');
  }
}

async function readIds(opts: PreviewOpts, entity: LabelEntity): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  let raw: string;
  if (opts.ids !== undefined) raw = opts.ids;
  else {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.idsFile as string);
    } catch (err) {
      return { ok: false, message: `Cannot read --ids-file: ${err instanceof Error ? err.message : String(err)}` };
    }
    const text = decodeIdsFile(bytes);
    if (text === null) return { ok: false, message: UTF16_MESSAGE };
    raw = text;
  }
  const ids = normalizeIds(raw, entity);
  if (ids.length === 0) return { ok: false, message: 'No ids given.' };
  if (ids.length > CHANGE_SET_MAX) {
    return { ok: false, message: `That is ${ids.length} ids, and one change set holds at most ${CHANGE_SET_MAX}. Split the list and preview each part.` };
  }
  for (const id of ids) {
    const checked = checkEntityId(entity, id);
    if (!checked.ok) return { ok: false, message: `${checked.message}. Check --ids.` };
  }
  return { ok: true, ids };
}

/** Keep a preview's approval on this machine (never its values or ids). Returns whether it was kept. */
async function rememberApproval(view: ChangeSetView, account: number, dataDir: string | undefined): Promise<boolean> {
  if (!view.approval_hash) return false;
  return savePending(
    {
      change_set_id: view.change_set_id,
      approval_hash: view.approval_hash,
      account: view.accounts[0]?.account ?? account,
      kind: view.kind,
      scope: view.scope,
      created_at: view.created_at,
      expires_at: view.expires_at,
    },
    dataDir,
  );
}

function sumTotals(views: readonly ChangeSetView[]): { identities: number; to_change: number; unchanged: number; fields_to_change: number } {
  const t = { identities: 0, to_change: 0, unchanged: 0, fields_to_change: 0 };
  for (const v of views) {
    t.identities += v.totals?.identities ?? 0;
    t.to_change += v.totals?.to_change ?? 0;
    t.unchanged += v.totals?.unchanged ?? 0;
    t.fields_to_change += v.totals?.fields_to_change ?? 0;
  }
  return t;
}

/** A change set as --json carries it: the service's view, plus the command that commits it. */
function viewJson(view: ChangeSetView, approvalSaved?: boolean): Record<string, unknown> {
  const rest = withoutOk(view);
  const preview = view.status === 'preview';
  return {
    ...rest,
    ...(preview ? { commit_command: commitCommand(view.change_set_id), ...(approvalSaved !== undefined ? { approval_saved: approvalSaved } : {}) } : {}),
  };
}

function printPreviews(views: readonly ChangeSetView[], entity: LabelEntity | undefined, _root: RootOptions, planned: number): void {
  views.forEach((v, i) => {
    const heading = planned > 1 ? `Change set ${i + 1} of ${planned}` : v.kind === 'undo' ? 'Undo preview' : 'Preview';
    process.stderr.write(`\n${heading}: nothing has been changed.\n`);
    process.stdout.write(renderChangeSet(v, entity) + '\n');
  });
  noteFreshness(views[0]!.state);
  const ready = views.filter((v) => v.status === 'preview');
  if (ready.length === 0) return;
  const blocked = ready.filter((v) => !v.can_commit);
  const lines: string[] = [];
  if (blocked.length > 0) lines.push(`  ${blockedText(blocked[0]!)}`);
  if (blocked.length < ready.length) {
    lines.push(
      '  Show the person this preview and get their yes before committing. To apply exactly this change:',
      ...ready.filter((v) => v.can_commit).map((v) => `    ${commitCommand(v.change_set_id)}`),
      '  To drop it instead: `mixshift labels cancel <id>`. A preview expires on its own after 24 hours.',
    );
  }
  process.stderr.write(`\n${lines.join('\n')}\n`);
}

function blockedText(v: ChangeSetView): string {
  if (v.blocked_by === 'writes_off') return 'Label changes are switched off right now, so this cannot be committed yet. Reading labels still works.';
  if (v.blocked_by === 'tenant_not_on') {
    return 'Label changes are not turned on for this account yet (its labels are still being copied and checked), so this preview cannot be committed until MixShift turns them on.';
  }
  return 'This change set cannot be committed right now.';
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

async function runCommit(id: string, opts: { commit?: boolean; approvalHash?: string }, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  if (!UUID_RE.test(id.trim())) return badInput('The change set id is the one `mixshift labels preview` printed (36 characters with dashes).', root);
  const setId = id.trim().toLowerCase();
  if (opts.approvalHash !== undefined && !HASH_RE.test(opts.approvalHash.trim())) {
    return badInput('--approval-hash is the 64-character hash the preview returned.', root);
  }

  // Without --commit nothing is sent that could change a label: read the change set back and say so.
  if (!opts.commit) {
    const view = await labelsChangeSet(setId, { dataDirOverride: root.dataDir });
    if (isLabelsFailure(view)) return fail(view, 'commit', startedAt, root, { committed: false, dry_run: true }, { change_set_id: setId });
    const saved = (await loadPending(setId, root.dataDir)) !== null || opts.approvalHash !== undefined;
    await trackLabels('commit', 'ok', startedAt, root.dataDir, { dry_run: true, committed: false, change_set_id: setId, status: view.status, service_state: view.state, committable: view.can_commit, approval_available: saved });
    if (root.json) {
      return writeJson({ status: 'ok', committed: false, dry_run: true, approval_available: saved, change_set: viewJson(view, saved) });
    }
    process.stderr.write(`\nNOT COMMITTED (no --commit): nothing has been changed.\n`);
    process.stdout.write(renderChangeSet(view, undefined) + '\n');
    if (view.status !== 'preview') {
      process.stderr.write(`\nThis change set is ${view.status}; there is nothing to commit.\n`);
    } else if (!view.can_commit) {
      process.stderr.write(`\n${blockedText(view)}\n`);
    } else {
      process.stderr.write(
        `\n${saved ? '' : 'No approval for this change set is kept on this machine, so the commit also needs --approval-hash (or preview it again here).\n'}` +
          `Show the person this preview and get their yes. To apply exactly this change:\n  ${commitCommand(setId)}\n`,
      );
    }
    return;
  }

  // --commit: the approval comes from the preview made here, or from --approval-hash.
  let hash = opts.approvalHash?.trim().toLowerCase();
  const source = hash !== undefined ? 'flag' : 'saved';
  if (hash === undefined) {
    const pending = await loadPending(setId, root.dataDir);
    if (!pending) {
      const message =
        'This machine has no approval for that change set, so nothing was sent. Preview it again here (`mixshift labels preview ...`), or pass --approval-hash with the hash the preview returned.';
      await trackLabels('commit', 'failed', startedAt, root.dataDir, { committed: true, change_set_id: setId, kind_failed: 'no_approval' });
      if (root.json) writeJson({ status: 'error', failure_kind: 'no_approval', message, change_set_id: setId });
      else process.stderr.write(`\n✗ ${message}\n`);
      process.exitCode = 16;
      return;
    }
    hash = pending.approval_hash;
  }

  const result = await labelsCommit({ changeSetId: setId, approvalHash: hash }, { dataDirOverride: root.dataDir });
  if (isLabelsFailure(result)) {
    // A commit that did not fully apply is final: show every item and exit non-zero.
    if (result.kind === 'partially_applied' || result.kind === 'stale' || result.kind === 'failed') {
      await removePending(setId, root.dataDir);
      return failedCommit(result, setId, startedAt, root, source);
    }
    if (result.kind === 'change_set_expired' || result.kind === 'change_set_cancelled') await removePending(setId, root.dataDir);
    return fail(result, 'commit', startedAt, root, { committed: true, approval_source: source }, { change_set_id: setId });
  }
  await removePending(setId, root.dataDir);
  const body = withoutOk(result);
  const counts = result.counts;
  // The service answers ok only when everything applied; a count that says otherwise is never shown as success.
  const incomplete = counts.stale > 0 || counts.refused > 0;
  await trackLabels('commit', incomplete ? 'failed' : 'ok', startedAt, root.dataDir, {
    committed: true,
    change_set_id: setId,
    approval_source: source,
    status: result.status,
    already_committed: result.already_committed,
    service_state: result.state,
    ...countsPayload(counts),
    ...(incomplete ? { kind_failed: 'partially_applied' } : {}),
  });
  if (root.json) {
    if (incomplete) writeJson({ status: 'error', failure_kind: 'partially_applied', message: 'Not every item was changed. See needs_attention.', ...stripBody(body) });
    else writeJson({ status: 'ok', committed: true, ...stripBody(body) });
  } else {
    process.stderr.write(`\n${incomplete ? '✗ PARTLY COMMITTED' : '✓ COMMITTED'} ${setId}: ${commitSentence(counts)}${result.already_committed ? ' This change set was already committed; nothing new was written.' : ''}\n`);
    process.stdout.write(renderCommitBody(body) + '\n');
    if (result.sync?.note) process.stderr.write(`\n${result.sync.note}\n`);
  }
  if (incomplete) process.exitCode = 17;
}

/** The body of a commit that did not fully apply: print every item that needs attention, exit 17. */
async function failedCommit(failure: LabelsFailure, setId: string, startedAt: number, root: RootOptions, source: string): Promise<void> {
  const b = (failure.body ?? {}) as Partial<CommitBody> & Record<string, unknown>;
  const counts = b.counts as CommitBody['counts'] | undefined;
  await trackLabels('commit', 'failed', startedAt, root.dataDir, {
    committed: true,
    change_set_id: setId,
    approval_source: source,
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(counts ? countsPayload(counts) : {}),
  });
  if (root.json) {
    const { ok: _ok, kind: _kind, friendly: _friendly, ...rest } = b as Record<string, unknown>;
    writeJson({ status: 'error', failure_kind: failure.kind, message: failure.friendly, http_status: failure.httpStatus, ...stripBody(rest) });
  } else {
    process.stderr.write(`\n✗ ${failure.kind === 'stale' ? 'NOTHING COMMITTED (all stale)' : failure.kind === 'failed' ? 'NOTHING COMMITTED' : 'PARTLY COMMITTED'} ${setId}: ${failure.friendly}\n`);
    if (counts) process.stdout.write(renderCommitBody(b as Partial<CommitBody>) + '\n');
    process.stderr.write(`\nTo include the items that were left as they are, preview the change again: \`mixshift labels preview ...\`.\n`);
  }
  process.exitCode = 17;
}

const countsPayload = (c: CommitBody['counts']): Record<string, number> => ({
  identities: c.identities,
  applied: c.applied,
  unchanged: c.unchanged,
  stale: c.stale,
  refused: c.refused,
  fields_changed: c.fields_changed,
});

/** The commit body without the envelope words the --json wrapper adds itself. */
function stripBody(b: Record<string, unknown>): Record<string, unknown> {
  const { status: _s, ...rest } = b as Record<string, unknown>;
  return { outcome: (b as { status?: unknown }).status, ...rest };
}

const commitSentence = (c: CommitBody['counts']): string =>
  `${c.applied} of ${c.identities} changed (${c.fields_changed} field${c.fields_changed === 1 ? '' : 's'}), ${c.unchanged} already had these values, ${c.stale} stale, ${c.refused} refused.`;

// ---------------------------------------------------------------------------
// undo / sets / set / cancel
// ---------------------------------------------------------------------------

async function runUndo(id: string, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  if (!UUID_RE.test(id.trim())) return badInput('The change set id is the one `mixshift labels preview` or `labels sets` printed (36 characters with dashes).', root);
  const setId = id.trim().toLowerCase();
  const result = await labelsUndo(setId, { dataDirOverride: root.dataDir });
  if (isLabelsFailure(result)) return fail(result, 'undo', startedAt, root, { undoes: setId }, { change_set_id: setId });
  const saved = await rememberApproval(result, 0, root.dataDir);
  await trackLabels('undo', 'ok', startedAt, root.dataDir, {
    undoes: setId,
    change_set_id: result.change_set_id,
    service_state: result.state,
    identities: result.totals?.identities ?? 0,
    to_change: result.totals?.to_change ?? 0,
    warnings: result.warnings.length,
    committable: result.can_commit,
  });
  if (root.json) return writeJson({ status: 'ok', committed: false, count: 1, change_sets: [viewJson(result, saved)] });
  printPreviews([result], undefined, root, 1);
}

async function runSets(opts: { account: string; limit?: string; before?: string; all?: boolean }, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  const account = parseAccount(opts.account);
  if (!account) return badInput(accountMessage(), root);
  let limit = SETS_DEFAULT;
  if (opts.limit !== undefined) {
    if (!/^[0-9]{1,4}$/.test(opts.limit.trim()) || Number(opts.limit) < 1 || Number(opts.limit) > SETS_PAGE_MAX) return badInput(`--limit must be a whole number from 1 to ${SETS_PAGE_MAX}.`, root);
    limit = Number(opts.limit);
  } else if (opts.all) limit = SETS_PAGE_MAX;
  if (opts.before !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(opts.before.trim())) {
    return badInput('--before is the next_before value a previous page printed (a UTC time with six fraction digits).', root);
  }
  const rows: ChangeSetListRow[] = [];
  let before = opts.before?.trim();
  let first: Awaited<ReturnType<typeof labelsChangeSets>> | undefined;
  let last = undefined as { has_more: boolean; next_before: string | null } | undefined;
  let pages = 0;
  const used = new Set<string>();
  for (;;) {
    if (before !== undefined) used.add(before);
    const page = await labelsChangeSets({ account, limit, ...(before !== undefined ? { before } : {}) }, { dataDirOverride: root.dataDir });
    if (isLabelsFailure(page)) return fail(page, 'sets', startedAt, root, { account: Number(account) });
    first ??= page;
    last = page;
    pages += 1;
    rows.push(...page.rows);
    before = page.next_before ?? undefined;
    if (!opts.all || !page.has_more || before === undefined || page.rows.length === 0 || used.has(before) || rows.length >= SETS_ALL_CAP) break;
  }
  const ok = first as Exclude<typeof first, LabelsFailure | undefined>;
  const more = last!.has_more && last!.next_before !== null;
  const next = more ? last!.next_before : null;
  await trackLabels('sets', 'ok', startedAt, root.dataDir, { account: Number(account), service_state: ok.state, rows: rows.length, pages, has_more: more, all: !!opts.all });
  if (root.json) {
    return writeJson({ status: 'ok', account: ok.account, state: ok.state, count: rows.length, pages, has_more: more, next_before: next, change_sets: rows });
  }
  process.stderr.write(`\n✓ ${rows.length} change set(s)${opts.all ? ` over ${pages} page(s)` : ''}\n`);
  process.stdout.write(renderSets(rows) + '\n');
  if (more) process.stdout.write(`\nMore change sets: add --before ${next}\n`);
}

async function runSet(id: string, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  if (!UUID_RE.test(id.trim())) return badInput('The change set id is the one `mixshift labels preview` or `labels sets` printed (36 characters with dashes).', root);
  const setId = id.trim().toLowerCase();
  const view = await labelsChangeSet(setId, { dataDirOverride: root.dataDir });
  if (isLabelsFailure(view)) return fail(view, 'set', startedAt, root, {}, { change_set_id: setId });
  await trackLabels('set', 'ok', startedAt, root.dataDir, { change_set_id: setId, status: view.status, service_state: view.state });
  if (root.json) return writeJson({ status: 'ok', change_set: viewJson(view) });
  process.stdout.write(renderChangeSet(view, undefined) + '\n');
  if (view.status === 'preview' && view.can_commit) {
    process.stderr.write(`\nThis is a preview; nothing has been changed. To apply it after the person confirms: ${commitCommand(setId)}\n`);
  }
}

async function runCancel(id: string, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  if (!UUID_RE.test(id.trim())) return badInput('The change set id is the one `mixshift labels preview` or `labels sets` printed (36 characters with dashes).', root);
  const setId = id.trim().toLowerCase();
  const result = await labelsCancel(setId, { dataDirOverride: root.dataDir });
  if (isLabelsFailure(result)) return fail(result, 'cancel', startedAt, root, {}, { change_set_id: setId });
  await removePending(setId, root.dataDir);
  await trackLabels('cancel', 'ok', startedAt, root.dataDir, { change_set_id: setId, service_state: result.state });
  if (root.json) return writeJson({ status: 'ok', change_set_id: result.change_set_id, outcome: result.status, message: result.friendly ?? 'Cancelled. Nothing was changed.' });
  process.stderr.write(`\n✓ ${result.friendly ?? 'Cancelled. Nothing was changed.'}\n`);
}

// ---------------------------------------------------------------------------
// field-name
// ---------------------------------------------------------------------------

interface FieldNameOpts {
  account: string;
  entity?: string;
  field: string;
  name?: string;
  remove?: boolean;
  commit?: boolean;
}

async function runFieldName(opts: FieldNameOpts, root: RootOptions): Promise<void> {
  const startedAt = Date.now();
  const account = parseAccount(opts.account);
  if (!account) return badInput(accountMessage(), root);
  const parsedEntity = parseEntity(opts.entity ?? 'item');
  if (!parsedEntity || parsedEntity.length !== 1) return badInput(entityMessage(), root);
  const entity = parsedEntity[0]!;
  const field = opts.field.trim().toLowerCase();
  if (!fieldKeysFor(entity).includes(field)) return badInput(`--field ${field}: not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).`, root);
  if ((opts.name === undefined) === (opts.remove !== true)) return badInput('Pass --name <text> to set a display name, or --remove to remove it (not both).', root);
  let name: string | undefined;
  if (opts.name !== undefined) {
    name = opts.name.trim();
    // eslint-disable-next-line no-control-regex
    if (name === '' || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
      return badInput(`--name must be plain text on one line, 1 to ${NAME_MAX} characters.`, root);
    }
  }
  const base = { account: Number(account), entity, field, action: name !== undefined ? 'set' : 'remove' };

  if (!opts.commit) {
    const what = name !== undefined ? `show ${field} as "${name}"` : `show ${field} under its standard name again`;
    await trackLabels('field_name', 'ok', startedAt, root.dataDir, { ...base, dry_run: true, committed: false });
    if (root.json) return writeJson({ status: 'ok', committed: false, dry_run: true, account: Number(account), entity, field, action: base.action, ...(name !== undefined ? { name } : {}) });
    process.stderr.write(
      `\nNOT SENT (no --commit): nothing has been changed. This would ${what} on account ${account}, in every label read.\n` +
        '  Get the person\'s yes first, then run the same command with --commit.\n',
    );
    return;
  }

  const result =
    name !== undefined
      ? await labelsSetFieldName({ account, entity, field, name }, { dataDirOverride: root.dataDir })
      : await labelsRemoveFieldName({ account, entity, field }, { dataDirOverride: root.dataDir });
  if (isLabelsFailure(result)) return fail(result, 'field_name', startedAt, root, { ...base, committed: true });
  await trackLabels('field_name', 'ok', startedAt, root.dataDir, { ...base, committed: true, service_state: result.state, ...(result.removed !== undefined ? { removed: result.removed } : {}) });
  if (root.json) return writeJson({ status: 'ok', committed: true, ...withoutOk(result) });
  process.stderr.write(`\n✓ ${result.friendly ?? 'Done.'}\n`);
}

// ---------------------------------------------------------------------------
// Failure plumbing
// ---------------------------------------------------------------------------

/** What to do next, per failure kind: the service's sentence says what happened, this says which command comes next. */
function nextStep(failure: LabelsFailure, kind: CallKind, extra: Record<string, unknown>): string | undefined {
  const id = typeof extra.change_set_id === 'string' ? extra.change_set_id : '<id>';
  switch (failure.kind) {
    case 'approval_mismatch':
    case 'change_set_expired':
    case 'change_set_cancelled':
      return 'Preview the change again (`mixshift labels preview ...`) and commit the new change set.';
    case 'commit_retry':
    case 'commit_in_flight':
      return `Nothing was lost. Run the same command again: \`${commitCommand(id)}\`.`;
    case 'commit_too_large':
      return `Do not retry it as it is. Split the change into smaller change sets (at most ${CHANGE_SET_MAX} each) and preview and commit each one.`;
    case 'host_unreachable':
      return kind === 'commit'
        ? `The answer was lost, so the commit may or may not have gone through. Check with \`mixshift labels set ${id}\`; committing the same change set again is safe.`
        : undefined;
    case 'too_many_open_previews':
      return 'List them with `mixshift labels sets --account <id>` and cancel the ones you do not need with `mixshift labels cancel <id>`.';
    case 'change_set_not_found':
      return 'List the change sets of an account with `mixshift labels sets --account <id>`.';
    default:
      return undefined;
  }
}

async function fail(failure: LabelsFailure, kind: CallKind, startedAt: number, root: RootOptions, base: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
  const reason = typeof failure.body?.reason === 'string' ? failure.body.reason : undefined;
  const serviceState = typeof failure.body?.state === 'string' ? failure.body.state : undefined;
  await trackLabels(kind, 'failed', startedAt, root.dataDir, {
    ...base,
    ...(typeof extra.change_set_id === 'string' ? { change_set_id: extra.change_set_id } : {}),
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(failure.unrecognizedKind ? { unrecognized_kind: failure.unrecognizedKind } : {}),
    ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
    ...(reason ? { reason } : {}),
    ...(serviceState ? { service_state: serviceState } : {}),
  });
  // A sign-in that may read labels but not change them gets one line saying so (the service's default words are about reading).
  const friendly = failure.kind === 'insufficient_scope' && !failure.message ? 'This sign-in cannot change labels. Ask your organization admin for label-editing permission.' : failure.friendly;
  const issues = Array.isArray(failure.body?.issues) ? (failure.body?.issues as unknown[]) : undefined;
  const issueLines = (issues ?? []).flatMap((i) => (isRecord(i) && typeof i.field === 'string' && typeof i.message === 'string' ? [`  ${i.field}: ${i.message}`] : []));
  const step = nextStep(failure, kind, extra);
  if (root.json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      retryable: failure.retryable,
      reason,
      state: serviceState,
      issues,
      invalid_params: failure.invalidParams,
      unrecognized_kind: failure.unrecognizedKind,
      next_step: step,
      ...extra,
    });
  } else if (failure.kind === 'not_enabled') {
    // Not a fault: label editing is turned on account by account. One plain sentence, and the reason when the service gave one.
    process.stderr.write(`${friendly}\n`);
  } else {
    process.stderr.write(`\n✗ ${friendly}\n`);
    if (failure.message && failure.message !== friendly) process.stderr.write(`  ${failure.message}\n`);
    for (const l of issueLines) process.stderr.write(`${l}\n`);
    if (failure.kind === 'not_found') process.stderr.write('  Run `mixshift amazon merchants` for the account ids you can use (the legacySellerId).\n');
    if (step) process.stderr.write(`  ${step}\n`);
  }
  process.exitCode = exitCodeForLabelsKind(failure.kind);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// ---------------------------------------------------------------------------
// Rendering (chat markdown; --json carries the full envelope)
// ---------------------------------------------------------------------------

const thing = (entity: LabelEntity | undefined, n: number): string =>
  entity === 'item' ? (n === 1 ? 'item' : 'items') : entity === 'campaign' ? (n === 1 ? 'campaign' : 'campaigns') : n === 1 ? 'item or campaign' : 'items or campaigns';

function entityOf(v: ChangeSetView, hint: LabelEntity | undefined): LabelEntity | undefined {
  if (hint) return hint;
  const e = new Set(v.sample.map((s) => s.entity));
  return e.size === 1 ? ([...e][0] as LabelEntity) : undefined;
}

const KIND_WORDS: Record<string, string> = { set: 'set or clear', rename: 'rename a value', undo: 'undo' };

export function renderChangeSet(v: ChangeSetView, entityHint: LabelEntity | undefined): string {
  const entity = entityOf(v, entityHint);
  const L: string[] = [];
  const isPreview = v.status === 'preview';
  L.push(`**Change set ${v.change_set_id}** (${isPreview ? 'preview, nothing changed yet' : v.status})`, '');
  L.push(`- kind: ${KIND_WORDS[v.kind] ?? v.kind}${v.undoes ? `, undoing ${v.undoes}` : ''}`);
  L.push(`- scope: ${v.scope}, reaching ${v.accounts.length} account${v.accounts.length === 1 ? '' : 's'}`);
  if (isPreview) L.push(`- expires: ${v.expires_at}`);
  else {
    L.push(`- created: ${v.created_at}`);
    if (v.committed_at) L.push(`- committed: ${v.committed_at}${v.commit_actor ? ` by ${cell(v.commit_actor)}` : ''}`);
  }
  if (v.totals) {
    L.push(`- ${isPreview ? 'would change' : 'selected'}: ${v.totals.to_change} of ${v.totals.identities} ${thing(entity, v.totals.identities)} (${v.totals.fields_to_change} field${v.totals.fields_to_change === 1 ? '' : 's'}); ${v.totals.unchanged} already ${v.totals.unchanged === 1 ? 'has' : 'have'} these values`);
  }
  const commit = v.commit as Partial<CommitBody['counts']> | undefined;
  if (!isPreview && commit && typeof commit.applied === 'number') {
    L.push(`- result: ${commit.applied} changed, ${commit.unchanged ?? 0} already had these values, ${commit.stale ?? 0} stale, ${commit.refused ?? 0} refused`);
  }
  if (isPreview && !v.can_commit) L.push(`- cannot be committed yet: ${blockedText(v)}`);

  if (v.accounts.length > 0) {
    L.push('', '| account | marketplace | selected | will change | already right |', '|---|---|---|---|---|');
    for (const a of v.accounts) {
      L.push(`| ${a.account} | ${a.marketplace_id ?? '-'} | ${a.identities ?? '-'} | ${a.to_change ?? '-'} | ${a.unchanged ?? '-'} |`);
    }
  }
  const dropped = v.dropped;
  if (dropped && (dropped.identities > 0 || dropped.accounts > 0)) {
    L.push('', '**Left out**');
    for (const d of dropped.details) {
      if (d.reason === 'not_seen') L.push(`- account ${d.account}: ${d.identities ?? '?'} ${thing(entity, d.identities ?? 2)} MixShift has not read yet (it only changes ones it has seen)`);
      else if (d.reason === 'account_not_accessible') L.push(`- account ${d.account}: not an account you can use, so it is not changed`);
      else L.push(`- account ${d.account}: ${d.reason}`);
    }
  }
  if (v.warnings.length > 0) {
    L.push('', '**Warnings**');
    for (const w of v.warnings) L.push(`- ${w.message}`);
  }
  if (v.sample.length > 0) {
    L.push('', `**${isPreview ? 'Before and after' : 'Sample of changes'}** (first ${v.sample.length})`, '', '| account | id | field | before | after |', '|---|---|---|---|---|');
    for (const s of v.sample) {
      const before = s.before === null ? '(never set)' : blank(s.before);
      const after = s.after === null || s.after === '' ? '(cleared)' : cell(s.after);
      L.push(`| ${s.account} | ${cell(s.id, 24)} | ${s.field} | ${before} | ${after} |`);
    }
  }
  if (!isPreview && v.needs_attention && v.needs_attention.length > 0) {
    L.push('', renderNeedsAttention(v.needs_attention, v.needs_attention_truncated === true));
  }
  return L.join('\n');
}

export function renderNeedsAttention(rows: readonly ResultRow[], truncated: boolean): string {
  const L = ['**Not changed (needs attention)**', '', '| account | id | result | reason | fields changed since |', '|---|---|---|---|---|'];
  for (const r of rows.slice(0, SHOW_ROWS)) {
    L.push(`| ${r.account} | ${cell(r.id, 24)} | ${r.result} | ${cell(r.reason)} | ${r.stale_fields ? r.stale_fields.join(', ') : '-'} |`);
  }
  if (rows.length > SHOW_ROWS) L.push('', `...and ${rows.length - SHOW_ROWS} more here (all of them are in --json).`);
  if (truncated) L.push('', 'The service lists the first 200 that need attention; there are more. Preview the change again to include the rest.');
  L.push('', 'stale: changed by someone else after the preview, so it was left exactly as it is. refused: not changed (see the reason).');
  return L.join('\n');
}

export function renderCommitBody(b: Partial<CommitBody>): string {
  const L: string[] = [];
  const c = b.counts;
  if (c) {
    L.push('| applied | already right | stale | refused | fields changed |', '|---|---|---|---|---|', `| ${c.applied} | ${c.unchanged} | ${c.stale} | ${c.refused} | ${c.fields_changed} |`);
  }
  if ((b.accounts?.length ?? 0) > 1) {
    L.push('', '| account | applied | already right | stale | refused |', '|---|---|---|---|---|');
    for (const a of b.accounts!) L.push(`| ${a.account} | ${a.applied} | ${a.unchanged} | ${a.stale} | ${a.refused} |`);
  }
  if ((b.needs_attention?.length ?? 0) > 0) L.push('', renderNeedsAttention(b.needs_attention!, b.needs_attention_truncated === true));
  return L.join('\n');
}

export function renderSets(rows: readonly ChangeSetListRow[]): string {
  if (rows.length === 0) return '_(no change sets)_';
  const L = ['| id | kind | status | scope | changed | by | created |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const commit = r.commit as Partial<CommitBody['counts']> | null;
    const changed =
      commit && typeof commit.applied === 'number'
        ? `${commit.applied} of ${commit.identities ?? r.totals?.identities ?? '?'}${(commit.stale ?? 0) + (commit.refused ?? 0) > 0 ? ` (${commit.stale ?? 0} stale, ${commit.refused ?? 0} refused)` : ''}`
        : r.totals
          ? `${r.totals.to_change} to change of ${r.totals.identities}`
          : '-';
    L.push(`| ${r.change_set_id} | ${r.kind}${r.undoes ? ' (undo)' : ''} | ${r.status} | ${r.scope} | ${changed} | ${cell(r.commit_actor ?? r.preview_actor)} | ${r.created_at} |`);
  }
  return L.join('\n');
}
