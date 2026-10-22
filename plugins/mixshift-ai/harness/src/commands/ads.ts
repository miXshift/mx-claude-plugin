/**
 * `mixshift ads ...` — the Amazon Ads API call surface (reads + audited
 * writes). Top-level sibling of `mixshift amazon ...` (SP-API): a different
 * Amazon API with a different auth model (advertising logins +
 * profile-scoped calls), same catalog-driven shape.
 *
 * Command shape:
 *   ads profiles                              who you can call for
 *   ads operations [--family <name>]          browse what is callable
 *   ads call <operation> [selectors] [--query k=v ...] [--path k=v ...]
 *                         [--body-file <f> | --body <json>] [--commit]
 *   ads call <write-op> ... --propose [--title --rationale --evidence-file
 *                         --expires-hours]   write a proposal, not a change
 *   ads proposals list|show|approve|reject|commit   approve-later flow
 *
 * WRITE CONTRACT: operations marked write: true (bid updates, negatives,
 * campaign creation) run as a DRY RUN by default: the service validates,
 * snapshots current state, logs an audit row, and returns a preview without
 * touching Amazon. `--commit` is the ONLY way to mutate, and the skill layer
 * must show the user the preview and get explicit confirmation first.
 * `--propose` is the deferred variant: the same change set is stored as a
 * proposal for a signed-in person to approve later (`ads proposals approve`),
 * then committed with `ads proposals commit`. It never mutates Amazon.
 * Commits return Amazon's multi-status response (partial failure is normal)
 * plus the audit row id holding the pre-write snapshot.
 *
 * Discovery-first: run `ads operations` and read the notes. Reporting and
 * exports are async on Amazon's side but every call here is a single fast
 * request/response (create, then poll by re-calling get), so chat hosts need
 * no special casing. Download urls in payloads are presigned: fetch WITHOUT
 * auth headers and gunzip.
 *
 * Exit / telemetry contract matches the amazon commands: handlers set
 * process.exitCode and return; telemetry captures operation id + duration +
 * outcome + dry_run only, never the payload (it carries seller-level
 * business data).
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  listAdsProfiles,
  listAdsOperations,
  adsCall,
  type AdsCallInput,
  type AdsOperationView,
  type AdsProfileView,
  type AdsQueryValue,
} from '../lib/amazon/ads-call.js';
import {
  isReportFailure,
  exitCodeForKind,
  failureContractJson,
  failureContractLines,
  failureContractTelemetry,
  type ReportFailure,
} from '../lib/amazon/reports.js';
import {
  createProposal,
  listProposals,
  getProposal,
  approveProposal,
  rejectProposal,
  commitProposal,
  type ProposalView,
} from '../lib/ads/proposals.js';
import {
  renderProposalSummary,
  renderProposalTable,
  renderDrift,
} from '../lib/ads/proposals-render.js';
import { emitAdsCommitEvent } from '../lib/timeline/ads-emit.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { keyValueOption } from '../lib/cli/option-parsers.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerAdsCommands(program: Command): void {
  const ads = program
    .command('ads')
    .description(
      'Call the Amazon Ads API: reporting v3, entity exports, ' +
        'campaign/keyword/target lists with current bids, intraday budget usage, ' +
        'live bid and keyword recommendations, and audited writes (bids, ' +
        'negatives, campaign creation; dry-run by default, --commit to apply; ' +
        '--propose and `ads proposals` to have a person approve a change later).',
    );

  registerProfiles(ads);
  registerOperations(ads);
  registerCall(ads);
  registerProposals(ads);
}

// ---------------------------------------------------------------------------
// ads profiles
// ---------------------------------------------------------------------------

function registerProfiles(ads: Command): void {
  ads
    .command('profiles')
    .description('List the Ads profiles you can call for (one per advertiser account + marketplace).')
    .option(
      '--include-inactive',
      'Also list merchants that are INACTIVE for Ads. They cannot serve Ads data until ' +
        'someone activates them in the MixShift platform; use this to find one that needs it.',
    )
    .action(async (opts: { includeInactive?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listAdsProfiles({
          dataDirOverride: root.dataDir,
          includeInactive: opts.includeInactive === true,
        });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsProfilesListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackAds(EventName.AdsProfilesListed, 'ok', startedAt, root.dataDir, {
          count: result.profiles.length,
          // Beta richness (feedback #10): bounded projection of profile
          // identifiers so reviews can see WHICH advertiser accounts a tenant
          // can call for, not just how many. Id/name fields only, never a full
          // profile object; capped at 25 with a truncated flag.
          sample: result.profiles.slice(0, 25).map((p) => ({
            profile_id: p.profileId,
            legacy_seller_id: p.legacySellerId,
            ...(p.amazonSellerId != null ? { amazon_seller_id: p.amazonSellerId } : {}),
            ...(p.marketplaceId != null ? { marketplace_id: p.marketplaceId } : {}),
            ...(p.countryCode != null ? { country_code: p.countryCode } : {}),
          })),
          truncated: result.profiles.length > 25,
          ...(typeof result.activeCount === 'number' ? { active_count: result.activeCount } : {}),
          ...(typeof result.inactiveCount === 'number'
            ? { inactive_count: result.inactiveCount }
            : {}),
          ...(opts.includeInactive ? { include_inactive: true } : {}),
        });
        if (root.json) {
          writeJson({
            status: 'ok',
            count: result.profiles.length,
            ...(typeof result.activeCount === 'number' ? { active_count: result.activeCount } : {}),
            ...(typeof result.inactiveCount === 'number'
              ? { inactive_count: result.inactiveCount }
              : {}),
            ...(result.inactiveHidden ? { inactive_hidden: true } : {}),
            ...(result.note ? { note: result.note } : {}),
            profiles: result.profiles,
          });
        } else {
          process.stderr.write(`\n✓ ${result.profiles.length} profile(s)\n\n`);
          process.stdout.write(renderProfiles(result.profiles) + '\n');
          // Say what was withheld. Silently hiding most of the list is how the
          // original bug read to users as "my merchant is missing".
          if (result.note) process.stderr.write(`\n${result.note}\n`);
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// ads operations
// ---------------------------------------------------------------------------

function registerOperations(ads: Command): void {
  ads
    .command('operations')
    .aliases(['ops', 'catalog'])
    .description(
      'Browse the callable Ads API operations. Read the notes before calling: ' +
        'they carry body vs query conventions and media types.',
    )
    .option('--family <name>', 'filter to one family (e.g. "Reporting", "Sponsored Products")')
    .action(async (opts: { family?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listAdsOperations(opts.family, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsOperationsListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackAds(EventName.AdsOperationsListed, 'ok', startedAt, root.dataDir, {
          count: result.operations.length,
          ...(opts.family ? { family: opts.family } : {}),
        });
        if (root.json) {
          writeJson({ status: 'ok', count: result.operations.length, operations: result.operations });
        } else {
          process.stderr.write(`\n✓ ${result.operations.length} operation(s)\n\n`);
          process.stdout.write(renderOperations(result.operations) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// ads call <operation>
// ---------------------------------------------------------------------------

interface CallCliOptions {
  profileId?: string;
  legacySellerId?: string;
  sellerId?: string;
  marketplace?: string;
  query: Record<string, string>;
  path: Record<string, string>;
  bodyFile?: string;
  body?: string;
  contentType?: string;
  commit?: boolean;
  proposalId?: string;
  propose?: boolean;
  title?: string;
  rationale?: string;
  evidenceFile?: string;
  expiresHours?: string;
}

function registerCall(ads: Command): void {
  ads
    .command('call <operation>')
    .description(
      'Execute one cataloged Ads API operation. Run `ads operations` first for ' +
        'the operation id and its notes. Write operations preview by default ' +
        '(dry run); pass --commit to apply, ONLY after the user confirmed the preview.',
    )
    .option('--profile-id <id>', 'Ads profileId from `ads profiles`')
    .option(
      '--legacy-seller-id <id>',
      'exact per-marketplace seller record id (same ids as `amazon merchants`)',
    )
    .option('--seller-id <id>', 'AmazonSellerID; pair with --marketplace when multi-marketplace')
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .option(
      '--query <k=v>',
      'query param (SD lists, sb.list_keywords; repeatable)',
      keyValueOption('--query', { bodyFlag: '--body' }),
      {},
    )
    .option(
      '--path <k=v>',
      'path placeholder, e.g. --path reportId=... (repeatable)',
      keyValueOption('--path', { bodyFlag: '--body' }),
      {},
    )
    .option('--body-file <file>', 'JSON request body from a file')
    .option('--body <json>', 'inline JSON request body (small payloads; prefer --body-file)')
    .option('--content-type <vnd>', 'advanced: override the cataloged vnd media type')
    .option(
      '--commit',
      'WRITE operations: actually apply the change set (default is a dry-run ' +
        'preview that mutates nothing). Use only after explicit user confirmation.',
    )
    .option(
      '--proposal-id <id>',
      'WRITE operations, with --commit: the dry-run audit id (printed by the ' +
        'preview) so the brand-timeline event links preview → commit. When ' +
        'omitted, the commit audit id is used. Set MIXSHIFT_SKILL_ID / ' +
        'MIXSHIFT_MODEL_ID env vars to attribute the change to the driving ' +
        'skill/model. The same MIXSHIFT_SKILL_ID (or MIXSHIFT_INTENT to ' +
        'override it) also rides every request to MixShift as the ' +
        'x-mixshift-intent header, for usage attribution only.',
    )
    .option(
      '--propose',
      'WRITE operations: store this change set as a PROPOSAL for a signed-in person ' +
        'to approve later (`ads proposals approve <id>`), instead of previewing or ' +
        'committing. Mutates nothing. Cannot be combined with --commit. This is the ' +
        'mode for scheduled routines and propose-only credentials.',
    )
    .option('--title <text>', 'with --propose: short title shown to the approver')
    .option('--rationale <text>', 'with --propose: why this change, shown to the approver')
    .option(
      '--evidence-file <file>',
      'with --propose: JSON file of supporting evidence (numbers the change rests on)',
    )
    .option(
      '--expires-hours <n>',
      'with --propose: hours the proposal stays open (1-168, default 72)',
    )
    .action(async (operation: string, opts: CallCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        // Cap before anything reaches a wire body: the proposal id lands
        // verbatim on a timeline event, so free-form input is rejected up
        // front rather than bounced by the service later.
        if (
          opts.proposalId !== undefined &&
          !/^[A-Za-z0-9_-]{1,128}$/.test(opts.proposalId)
        ) {
          return emitError(
            new Error(
              '--proposal-id must be 1-128 characters of A-Z, a-z, 0-9, ' +
                'underscore, or hyphen (use the audit id printed by the dry run).',
            ),
            !!root.json,
          );
        }
        const proposeOnly: Array<[string, unknown]> = [
          ['--title', opts.title],
          ['--rationale', opts.rationale],
          ['--evidence-file', opts.evidenceFile],
          ['--expires-hours', opts.expiresHours],
        ];
        if (opts.propose) {
          if (opts.commit) {
            return emitError(
              new Error(
                '--propose and --commit cannot be combined: a proposal never commits. ' +
                  'Propose now; after a person approves it, run `ads proposals commit <id>`.',
              ),
              !!root.json,
            );
          }
          if (opts.proposalId !== undefined) {
            return emitError(
              new Error('--proposal-id belongs to --commit and cannot be used with --propose.'),
              !!root.json,
            );
          }
        } else {
          const stray = proposeOnly.find(([, v]) => v !== undefined);
          if (stray) {
            return emitError(new Error(`${stray[0]} only applies with --propose.`), !!root.json);
          }
        }
        let expiresInHours: number | undefined;
        if (opts.expiresHours !== undefined) {
          expiresInHours = Number(opts.expiresHours);
          if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
            return emitError(
              new Error('--expires-hours must be a whole number from 1 to 168.'),
              !!root.json,
            );
          }
        }
        let body: unknown;
        if (opts.bodyFile && opts.body) {
          return emitError(new Error('Pass --body-file or --body, not both.'), !!root.json);
        }
        if (opts.bodyFile) {
          body = JSON.parse(await readFile(opts.bodyFile, 'utf8'));
        } else if (opts.body) {
          body = JSON.parse(opts.body);
        }

        const input: AdsCallInput = {
          operation,
          profileId: opts.profileId,
          legacySellerId: opts.legacySellerId,
          sellerId: opts.sellerId,
          marketplace: opts.marketplace,
          pathParams: opts.path,
          query: opts.query as Record<string, AdsQueryValue>,
          ...(body !== undefined ? { body } : {}),
          ...(opts.contentType ? { contentTypeOverride: opts.contentType } : {}),
          // Only --commit sends dryRun:false; otherwise the service's own
          // dry-run default is the contract (and reads ignore it entirely).
          ...(opts.commit ? { dryRun: false } : {}),
        };
        if (opts.propose) {
          let evidence: unknown;
          if (opts.evidenceFile) {
            evidence = JSON.parse(await readFile(opts.evidenceFile, 'utf8'));
          }
          const created = await createProposal(
            {
              call: input,
              ...(opts.title ? { title: opts.title } : {}),
              ...(opts.rationale ? { rationale: opts.rationale } : {}),
              ...(evidence !== undefined ? { evidence } : {}),
              ...(expiresInHours !== undefined ? { expiresInHours } : {}),
            },
            { dataDirOverride: root.dataDir },
          );
          if (isReportFailure(created)) {
            return proposalFailed(created, 'propose', startedAt, root, undefined, operation);
          }
          const p = created.proposal;
          await trackAds(EventName.AdsProposalCreated, 'ok', startedAt, root.dataDir, {
            proposal_id: p.id,
            operation: p.operation || operation,
            ...(typeof p.itemsCount === 'number' ? { items_count: p.itemsCount } : {}),
            guard_flagged: p.guard?.flagged.length ?? 0,
            has_evidence: evidence !== undefined,
          });
          if (root.json) {
            writeJson({ status: 'ok', proposal: p });
          } else {
            process.stderr.write(
              `\nPROPOSED ${p.operation || operation}: ${p.itemsCount ?? '?'} item(s) stored, nothing applied.\n` +
                renderProposalSummary(p).join('\n') +
                '\n  A signed-in person approves it with `mixshift ads proposals approve ' +
                `${p.id}\`, then it is committed with \`mixshift ads proposals commit ${p.id}\`.\n\n`,
            );
            process.stdout.write(
              JSON.stringify(
                { id: p.id, status: p.status, expiresAt: p.expiresAt, payloadHash: p.payloadHash },
                null,
                2,
              ) + '\n',
            );
          }
          return;
        }
        const result = await adsCall(input, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsCalled, 'failed', startedAt, root.dataDir, {
            operation,
            kind: result.kind,
            // mx-ops#57: WHICH merchant failed. The success path has stamped
            // these since feedback #10; failures stamped nothing, so a user
            // reporting "every profile returns an error" produced events that
            // could not say which merchant any of them was. That blind spot
            // is what stopped the #57 investigation closing: five failures,
            // three merchants named by the reporter, and no way to match them.
            //
            // Taken from the REQUEST selector, not the response: a failure
            // envelope often carries no profile at all (the call never
            // reached Amazon), and what the user ASKED for is the thing worth
            // knowing. Ids the caller already supplied, never response data.
            ...(opts.profileId ? { profile_id: opts.profileId } : {}),
            ...(opts.legacySellerId !== undefined
              ? { legacy_seller_id: opts.legacySellerId }
              : {}),
            ...(opts.sellerId ? { seller_id: opts.sellerId } : {}),
            ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
            ...(opts.commit ? { committed: true } : {}),
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
            // Amazon's OWN error code: (operation, amazon_error_code)
            // recurring across users is a catalog-gap signature. The CODE and
            // not the message, because it is low-cardinality and carries no
            // seller/order/ASIN identifiers.
            ...(result.amazonErrorCode ? { amazon_error_code: result.amazonErrorCode } : {}),
            ...(result.amazonStatus ? { amazon_status: result.amazonStatus } : {}),
            // Contract drift: the service sent a `kind` this build does not
            // know, so the class above came from the status, not the wire.
            // Recording the raw value keeps the drift visible (mx-ops#43).
            ...(result.unrecognizedKind
              ? { unrecognized_kind: result.unrecognizedKind }
              : {}),
            // A lost answer on a create or committed write (set by the service
            // on report creates, or by this client on its own deadline): how
            // often users land here, per `operation`, decides whether report
            // creation needs real dedup. One word, no identifiers.
            ...(result.requestOutcome ? { request_outcome: result.requestOutcome } : {}),
            // The gateway contract (mx-ops#144): who acts, and whether the same
            // call can succeed later. Enums and a flag; never the fix text.
            ...failureContractTelemetry(result),
          });
          return emitFailure(result, !!root.json);
        }
        // Beta richness (feedback #10): stamp the advertiser/account
        // identifiers already resolved on `result` so reviews can slice Ads
        // usage by profile/seller/marketplace and trace a committed write to
        // its audit id — not just "an ads.called happened". Mirrors the JSON
        // output fields below; never the request/response body (seller-level
        // business data).
        await trackAds(EventName.AdsCalled, 'ok', startedAt, root.dataDir, {
          operation,
          ...(typeof result.dryRun === 'boolean' ? { dry_run: result.dryRun } : {}),
          ...(result.profileId !== undefined ? { profile_id: result.profileId } : {}),
          ...(result.legacySellerId !== undefined ? { legacy_seller_id: result.legacySellerId } : {}),
          ...(result.marketplaceId !== undefined ? { marketplace_id: result.marketplaceId } : {}),
          ...(typeof result.itemsCount === 'number' ? { items_count: result.itemsCount } : {}),
          ...(result.auditId ? { audit_id: result.auditId } : {}),
        });
        if (root.json) {
          writeJson({
            status: 'ok',
            operation: result.operation,
            profile_id: result.profileId,
            legacy_seller_id: result.legacySellerId,
            marketplace_id: result.marketplaceId,
            ...(typeof result.dryRun === 'boolean' ? { dry_run: result.dryRun } : {}),
            ...(typeof result.itemsCount === 'number' ? { items_count: result.itemsCount } : {}),
            ...(result.auditId ? { audit_id: result.auditId } : {}),
            ...(result.beforeState !== undefined ? { before_state: result.beforeState } : {}),
            ...(result.preview !== undefined ? { preview: result.preview } : {}),
            ...(result.payload !== undefined ? { payload: result.payload } : {}),
          });
        } else if (result.dryRun === true) {
          const commitHint = result.auditId
            ? `--commit --proposal-id ${result.auditId}`
            : '--commit';
          process.stderr.write(
            `\n✓ DRY RUN ${result.operation} (profile ${result.profileId}): ` +
              `${result.itemsCount ?? '?'} item(s) validated, nothing applied.\n` +
              (result.auditId ? `  audit: ${result.auditId}\n` : '') +
              `  Re-run with ${commitHint} AFTER the user confirms this change set.\n\n`,
          );
          process.stdout.write(
            JSON.stringify({ preview: result.preview, beforeState: result.beforeState }, null, 2) + '\n',
          );
        } else if (result.dryRun === false) {
          process.stderr.write(
            `\n✓ COMMITTED ${result.operation} (profile ${result.profileId}): ` +
              `${result.itemsCount ?? '?'} item(s) sent. audit: ${result.auditId ?? 'n/a'}\n` +
              '  Amazon responds per item; check success/error arrays below.\n\n',
          );
          process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
        } else {
          process.stderr.write(`\n✓ ${result.operation} (profile ${result.profileId})\n\n`);
          process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
        }

        // Instrumentation: a committed change set is a first-class brand
        // business event — append it to the org timeline (best-effort,
        // ≤2s, never affects this command's outcome; skipped silently when
        // the seller doesn't map to exactly one registry brand). The
        // server also projects mcp_ads_changes into the timeline read
        // path, so this richer native event is ADDITIVE — its payload
        // carries change_set_id (= the audit row id) so the projection can
        // be deduped later. See lib/timeline/ads-emit.ts.
        if (result.dryRun === false) {
          // emitAdsCommitEvent never throws by contract; the .catch is
          // belt-and-braces so no future regression can turn a timeline
          // hiccup into a failed (already-applied!) commit.
          await emitAdsCommitEvent(
            {
              operation: result.operation,
              legacySellerId: result.legacySellerId,
              ...(result.auditId ? { auditId: result.auditId } : {}),
              ...(typeof result.itemsCount === 'number'
                ? { itemsCount: result.itemsCount }
                : {}),
              ...(body !== undefined ? { requestBody: body } : {}),
              ...(result.beforeState !== undefined
                ? { beforeState: result.beforeState }
                : {}),
              ...(result.payload !== undefined
                ? { responsePayload: result.payload }
                : {}),
              ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
            },
            { dataDirOverride: root.dataDir },
          ).catch(() => undefined);
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// ads proposals ...
// ---------------------------------------------------------------------------

type ProposalAction = 'propose' | 'list' | 'show' | 'approve' | 'reject' | 'commit';

/** One failure path for every proposal action: telemetry, then the shared
 *  failure output (plus the drift list on a stale proposal), then the exit code. */
async function proposalFailed(
  failure: ReportFailure,
  action: ProposalAction,
  startedAt: number,
  root: RootOptions,
  proposalId?: string,
  operation?: string,
): Promise<void> {
  await trackAds(EventName.AdsProposalFailed, 'failed', startedAt, root.dataDir, {
    action,
    kind: failure.kind,
    ...(proposalId ? { proposal_id: proposalId } : {}),
    ...(operation ? { operation } : {}),
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(failure.unrecognizedKind ? { unrecognized_kind: failure.unrecognizedKind } : {}),
    ...(failure.requestOutcome ? { request_outcome: failure.requestOutcome } : {}),
    ...(failure.drift ? { drift_count: failure.drift.length } : {}),
    ...failureContractTelemetry(failure),
  });
  emitFailure(failure, !!root.json);
  if (!root.json) {
    for (const line of renderDrift(failure)) process.stderr.write(`${line}\n`);
  }
}

function registerProposals(ads: Command): void {
  const proposals = ads
    .command('proposals')
    .description(
      'Proposals: change sets written now, approved later by a signed-in person, ' +
        'committed only after approval. Create one with `ads call <write-op> --propose`.',
    );

  proposals
    .command('list')
    .description('List proposals for this account, newest first.')
    .option(
      '--status <s>',
      'filter: PROPOSED, APPROVED, REJECTED, COMMITTED, FAILED, UNCERTAIN, STALE, EXPIRED',
    )
    .option('--limit <n>', 'how many to return (default 50)')
    .action(async (opts: { status?: string; limit?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        let limit: number | undefined;
        if (opts.limit !== undefined) {
          limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit < 1) {
            return emitError(new Error('--limit must be a positive whole number.'), !!root.json);
          }
        }
        const r = await listProposals(
          {
            ...(opts.status ? { status: opts.status.toUpperCase() } : {}),
            ...(limit ? { limit } : {}),
          },
          { dataDirOverride: root.dataDir },
        );
        if (isReportFailure(r)) return proposalFailed(r, 'list', startedAt, root);
        if (root.json) {
          writeJson({ status: 'ok', count: r.proposals.length, proposals: r.proposals });
        } else {
          process.stderr.write(`\n${r.proposals.length} proposal(s)\n\n`);
          process.stdout.write(renderProposalTable(r.proposals) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  proposals
    .command('show <id>')
    .description('Show one proposal in full: operation, items, guard flags, expiry, state.')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const r = await getProposal(id, { dataDirOverride: root.dataDir });
        if (isReportFailure(r)) return proposalFailed(r, 'show', startedAt, root, id);
        if (root.json) {
          writeJson({ status: 'ok', proposal: r.proposal });
        } else {
          process.stderr.write(
            `\nproposal ${r.proposal.id}\n${renderProposalSummary(r.proposal, true).join('\n')}\n\n`,
          );
          process.stdout.write(JSON.stringify(r.proposal, null, 2) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  proposals
    .command('approve <id>')
    .description(
      'Approve a proposal. A HUMAN act: it needs a signed-in person (machine credentials are ' +
        'refused). Fetches the proposal, prints what is being approved, then approves exactly ' +
        'that version. Run it ONLY after the person has seen the proposal and said yes.',
    )
    .option(
      '--acknowledge-guard',
      'confirm you saw the money changes flagged above the safety threshold (required when any are flagged)',
    )
    .option('--note <text>', 'a note kept with the approval')
    .action(
      async (id: string, opts: { acknowledgeGuard?: boolean; note?: string }, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const startedAt = Date.now();
        try {
          const fetched = await getProposal(id, { dataDirOverride: root.dataDir });
          if (isReportFailure(fetched)) {
            return proposalFailed(fetched, 'approve', startedAt, root, id);
          }
          const p = fetched.proposal;
          process.stderr.write(
            `\nApproving this proposal (the version fetched just now, hash ${p.payloadHash.slice(0, 12)}):\n` +
              renderProposalSummary(p, true).join('\n') +
              '\n\n',
          );
          const r = await approveProposal(
            {
              id,
              payloadHash: p.payloadHash,
              ...(opts.acknowledgeGuard ? { acknowledgeGuard: true } : {}),
              ...(opts.note ? { note: opts.note } : {}),
            },
            { dataDirOverride: root.dataDir },
          );
          if (isReportFailure(r)) {
            return proposalFailed(r, 'approve', startedAt, root, id, p.operation);
          }
          await trackAds(EventName.AdsProposalApproved, 'ok', startedAt, root.dataDir, {
            proposal_id: id,
            operation: p.operation,
            ...(typeof p.itemsCount === 'number' ? { items_count: p.itemsCount } : {}),
            guard_flagged: p.guard?.flagged.length ?? 0,
            acknowledged_guard: opts.acknowledgeGuard === true,
          });
          printProposalResult(
            r.proposal,
            !!root.json,
            'APPROVED',
            `Commit it with \`mixshift ads proposals commit ${id}\`.`,
          );
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );

  proposals
    .command('reject <id>')
    .description('Reject a proposal so it can never be committed. A human act, like approve.')
    .option('--reason <text>', 'why it was rejected')
    .action(async (id: string, opts: { reason?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const r = await rejectProposal(id, opts.reason, { dataDirOverride: root.dataDir });
        if (isReportFailure(r)) return proposalFailed(r, 'reject', startedAt, root, id);
        await trackAds(EventName.AdsProposalRejected, 'ok', startedAt, root.dataDir, {
          proposal_id: id,
          operation: r.proposal.operation,
          has_reason: !!opts.reason,
        });
        printProposalResult(r.proposal, !!root.json, 'REJECTED');
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  proposals
    .command('commit <id>')
    .description(
      'Commit an APPROVED proposal to Amazon. Fetches it and sends its hash; the service ' +
        'refuses an unapproved, expired or changed proposal, and one whose live values moved ' +
        'since it was written. Works with a machine credential that holds ads:write.',
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const fetched = await getProposal(id, { dataDirOverride: root.dataDir });
        if (isReportFailure(fetched)) return proposalFailed(fetched, 'commit', startedAt, root, id);
        const p = fetched.proposal;
        const r = await commitProposal(id, p.payloadHash, { dataDirOverride: root.dataDir });
        if (isReportFailure(r)) return proposalFailed(r, 'commit', startedAt, root, id, p.operation);
        const done = r.proposal;
        const base = {
          proposal_id: id,
          operation: done.operation || p.operation,
          status: done.status,
          ...(typeof done.itemsCount === 'number' ? { items_count: done.itemsCount } : {}),
          ...(done.commitAuditId ? { audit_id: done.commitAuditId } : {}),
        };
        if (done.status === 'FAILED' || done.status === 'UNCERTAIN') {
          // Answered, but the write did not land cleanly. UNCERTAIN means Amazon
          // may have applied it: never resend, re-list the entities first.
          await trackAds(EventName.AdsProposalFailed, 'failed', startedAt, root.dataDir, {
            action: 'commit',
            kind: done.status === 'UNCERTAIN' ? 'commit_uncertain' : 'commit_failed',
            ...base,
          });
          printProposalResult(
            done,
            !!root.json,
            done.status,
            done.status === 'UNCERTAIN'
              ? 'Amazon may have applied it. Do NOT commit again: re-list the targeted entities first.'
              : 'Amazon refused it before applying anything. Propose the change again if it is still wanted.',
          );
          process.exitCode = 1;
          return;
        }
        await trackAds(EventName.AdsProposalCommitted, 'ok', startedAt, root.dataDir, base);
        printProposalResult(
          done,
          !!root.json,
          done.status || 'COMMITTED',
          'Amazon answers per item: read the response below for any item that errored.',
          true,
        );
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

function printProposalResult(
  p: ProposalView,
  json: boolean,
  label: string,
  hint?: string,
  withResponse = false,
): void {
  if (json) {
    writeJson({ status: 'ok', proposal: p });
    return;
  }
  process.stderr.write(
    `\n${label} proposal ${p.id}\n${renderProposalSummary(p).join('\n')}\n` +
      (hint ? `  ${hint}\n` : '') +
      '\n',
  );
  process.stdout.write(
    JSON.stringify(
      withResponse && p.response !== undefined ? { response: p.response } : { id: p.id, status: p.status },
      null,
      2,
    ) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function trackAds(
  eventName: string,
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: eventName,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind === 'string'
        ? { error_class: payload.kind }
        : {}),
      payload,
    },
    dataDir,
  );
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      // Amazon's OWN code, status and response body. Previously dropped on the
      // floor, which left a user reporting a failure with nothing complete to
      // send and left us unable to tell a catalog gap from an outage.
      amazon_error_code: failure.amazonErrorCode,
      amazon_status: failure.amazonStatus,
      unrecognized_kind: failure.unrecognizedKind,
      amazon_response: failure.responsePayload ?? failure.responseText,
      candidates: failure.candidates,
      // 'unknown' = the call may have gone through (report create or write):
      // check before resending. Dropped until now, so --json callers could not
      // tell a lost answer from a refusal.
      request_outcome: failure.requestOutcome,
      // proposal_stale: which live values moved since the proposal was written.
      drift: failure.drift,
      automatic_retry: failure.automaticRetry,
      concurrency_cap: failure.concurrencyCap,
      // The skill's `throttled` row has promised this; it was never emitted.
      retry_after_ms: failure.retryAfterMs,
      // source / retryable / fix / *_params / amazon (mx-ops#144 P5).
      ...failureContractJson(failure),
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message) process.stderr.write(`  ${failure.message}\n`);
    for (const line of failureContractLines(failure)) process.stderr.write(`${line}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    writeJson({ status: 'error', message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderProfiles(profiles: AdsProfileView[]): string {
  if (profiles.length === 0) {
    return '_(no Ads profiles: this tenant has no connected advertising logins with profile ids)_';
  }
  const cols = ['profileId', 'legacySellerId', 'name', 'type', 'region', 'marketplace'];
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = profiles.map((p) => {
    const marketplace = [p.countryCode, p.marketplaceName ?? p.marketplaceId]
      .filter((s): s is string => !!s)
      .join(' ');
    return (
      '| ' +
      [
        p.profileId,
        String(p.legacySellerId),
        mdCell(p.name),
        p.merchantType,
        p.merchantRegion,
        mdCell(marketplace),
      ].join(' | ') +
      ' |'
    );
  });
  return [header, sep, ...rows].join('\n');
}

function renderOperations(operations: AdsOperationView[]): string {
  if (operations.length === 0) {
    return '_(no operations matched: check the --family spelling against `ads operations`)_';
  }
  const byFamily = new Map<string, AdsOperationView[]>();
  for (const op of operations) {
    const list = byFamily.get(op.family) ?? [];
    list.push(op);
    byFamily.set(op.family, list);
  }
  const blocks: string[] = [];
  for (const [family, ops] of byFamily) {
    blocks.push(`## ${family}`);
    for (const op of ops) {
      const flags = [
        op.method !== 'GET' ? op.method : null,
        op.body === 'required' ? 'body required' : op.body === 'optional' ? 'body optional' : null,
      ]
        .filter(Boolean)
        .join(', ');
      blocks.push(`- **${op.id}**${flags ? ` (${flags})` : ''}: ${op.summary}`);
      if (op.notes) blocks.push(`  - notes: ${op.notes}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trimEnd();
}

function mdCell(s: string): string {
  return s.replaceAll('|', '\\|');
}
