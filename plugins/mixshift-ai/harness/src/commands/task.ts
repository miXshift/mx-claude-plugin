/**
 * `mixshift task preflight` — the one command a scheduled/unattended run
 * executes FIRST. It answers "can this run do MixShift work, and if not,
 * exactly why" in code, not hand-rolled shell preamble.
 *
 * Context: Cowork scheduled tasks run in fresh sandboxes. The service
 * credential lives in a granted persistent folder mounted somewhere under
 * `/sessions/...`; the default data-dir resolution (`~/.mixshift`) misses
 * it. Every task prompt used to hand-roll a
 * `find /sessions -path ".../.mixshift/auth/credentials"` preamble — this
 * command replaces the discovery + verification half of that preamble, and
 * (unlike a frozen task prompt) keeps improving underneath it.
 *
 * Behavior, in order:
 *   1. Resolve the data dir the standard way (--data-dir ?? MIXSHIFT_DATA_DIR
 *      ?? ~/.mixshift). If a USABLE credential (datahub or service block)
 *      lives there, done. A file that is absent, malformed, or a legacy
 *      envelope with neither block does NOT stop the search.
 *   2. Otherwise scan bounded candidate roots (the sessions tree deep, cwd +
 *      cwd/outputs shallow) for a nested `.mixshift/auth/credentials`; hits
 *      are tried newest-first until one holds a usable credential, and every
 *      candidate is reported.
 *   3. Load whatever credential was found and report its kind (service vs
 *      interactive) using the SAME precedence getValidAccessToken uses.
 *   4. Mint a real access token the same way `auth service-setup --verify`
 *      does, classifying a failure as a bad credential vs an unreachable
 *      endpoint.
 *   5. For each --brand, ensure context.yaml exists locally, pulling it from
 *      the org store when it doesn't.
 *   6. Print a checklist + a final READY/BLOCKED verdict, and (whenever a
 *      credential was found) the `export MIXSHIFT_DATA_DIR=...` line the
 *      task's later shell steps should use.
 *
 * The discovered/resolved data dir is threaded EXPLICITLY as a
 * dataDirOverride argument to every helper below — process.env is never
 * mutated. The printed export line is for the CALLER's subsequent shell
 * steps, not for this process.
 */

import type { Command } from 'commander';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getValidAccessToken, loadCredentials } from '../lib/auth/credentials.js';
import { createContextSyncClient } from '../lib/context-sync/client.js';
import { pull } from '../lib/context-sync/engine.js';
import {
  contextPath,
  credentialsPath,
  resolveDataDir,
} from '../lib/paths/resolve.js';
import { readServiceAttributionCache } from '../lib/telemetry/service-attribution-cache.js';
import { EventName, track } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface PreflightCliOptions {
  brand: string[];
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

type DiscoveredVia = 'flag' | 'env' | 'default' | 'sessions_scan' | 'cwd_scan';

/**
 * House codes 1-5 are already claimed elsewhere (1 generic error, 2 stub, 3
 * auth pending_whitelist, 4 validation, 5 context_missing in
 * brand-config.ts) — this command claims fresh ones. "First blocker wins the
 * exit code" (see computeExitCode below): when more than one blocker class is
 * present in one run, the exit code reports the earliest/most-fundamental one
 * even though every blocker found still rides the `blockers` array.
 */
type BlockerClass =
  | 'credential_missing'
  | 'credential_invalid'
  | 'endpoint_unreachable'
  | 'context_unavailable';

type CredentialKind = 'service' | 'interactive';
type BrandStatus = 'present' | 'pulled' | 'unavailable';

interface Blocker {
  class: BlockerClass;
  message: string;
  remediation: string;
}

interface BrandResult {
  slug: string;
  status: BrandStatus;
}

interface CredentialSummary {
  path: string;
  kind: CredentialKind;
  label?: string;
  verified: boolean;
  /** Informational only (v1): present when a service token mint echoed
   *  attribution.scopes and the on-disk cache still carries it. */
  scopes?: string[];
}

interface PreflightResult {
  ready: boolean;
  data_dir: string;
  export_line: string | null;
  discovered_via: DiscoveredVia;
  candidates: string[];
  credential: CredentialSummary | null;
  brands: BrandResult[];
  blockers: Blocker[];
  warnings: string[];
}

const EXIT_CODES: Record<BlockerClass, number> = {
  credential_missing: 6,
  credential_invalid: 7,
  endpoint_unreachable: 8,
  context_unavailable: 9,
};

/** Priority order for picking ONE exit code out of possibly-several blockers. */
const BLOCKER_PRIORITY: readonly BlockerClass[] = [
  'credential_missing',
  'credential_invalid',
  'endpoint_unreachable',
  'context_unavailable',
];

function computeExitCode(blockers: readonly Blocker[]): {
  exitCode: number;
  firstBlockerClass: BlockerClass | null;
} {
  for (const cls of BLOCKER_PRIORITY) {
    if (blockers.some((b) => b.class === cls)) {
      return { exitCode: EXIT_CODES[cls], firstBlockerClass: cls };
    }
  }
  return { exitCode: 0, firstBlockerClass: null };
}

// ---------------------------------------------------------------------------
// Sandbox discovery
// ---------------------------------------------------------------------------

/** The sessions tree can be deeply nested (a Cowork mount path under it);
 *  cwd is shallow (the task's own working tree). The proven hand-rolled
 *  preambles this replaces bound their `find` at -maxdepth 7 and -maxdepth 9
 *  depending on the task; we take the wider bound for the sessions tree. */
const SESSIONS_MAX_DEPTH = 9;
const CWD_MAX_DEPTH = 4;

/** Test/ops seam for where the Cowork sessions tree is mounted. Lets the
 *  test suite stay hermetic on machines that HAVE a real /sessions, and lets
 *  unusual hosts relocate the mount. Not part of the public contract. */
function sessionsRoot(): string {
  return process.env.MIXSHIFT_PREFLIGHT_SESSIONS_ROOT || '/sessions';
}

/** POSIX single-quote escaping for the printed export line. Double quotes
 *  would leave $, backticks and backslashes live, and task prompts execute
 *  this line verbatim in a shell, so a crafted directory name discovered by
 *  the scan must not be able to inject. Inside single quotes only the single
 *  quote itself needs handling ('\''). [red-team fix] */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** What we say about a credentials file that exists but failed to load.
 *  NEVER include the underlying Error message: JSON.parse errors embed a
 *  window of the raw file text, which for this particular file can be secret
 *  material. [red-team fix] */
function describeCredentialLoadFailure(dir: string): string {
  return (
    `credentials file at ${credentialsPath(dir)} exists but could not be parsed ` +
    '(malformed JSON or invalid schema; contents not shown)'
  );
}

/** Never worth descending into for a credentials file, and node_modules in
 *  particular can be enormous. */
const NEVER_DESCEND = new Set(['node_modules', '.git']);

/**
 * Bounded, symlink-safe recursive scan for a nested `.mixshift/auth/credentials`
 * under one or more roots. Pure with respect to the filesystem snapshot at
 * call time; roots are injectable so tests never touch a real /sessions.
 *
 * Depth is counted in path segments below `root`: a hit at
 * `<root>/a/b/.mixshift/auth/credentials` is depth 5 (a=1, b=2, .mixshift=3,
 * auth=4, credentials=5). `maxDepth` bounds the CREDENTIALS FILE's own depth
 * (a candidate exactly at the bound is included; one level deeper is not).
 *
 * Every directory read is wrapped so a permission error (EACCES), a vanished
 * entry (ENOENT — a race with something else on the box), or a root that
 * simply doesn't exist (e.g. no /sessions outside a Cowork sandbox) just
 * prunes that branch silently; discovery never throws. Symlinks (directory
 * or file) are never followed or reported as candidates — checked via
 * `dirent.isSymbolicLink()` before deciding anything else about an entry.
 */
export async function discoverCredentialFiles(
  roots: string[],
  maxDepth: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    await walkForCredentials(root, 0, maxDepth, found);
  }
  return found;
}

async function walkForCredentials(
  dir: string,
  depth: number,
  maxDepth: number,
  found: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Missing, not a directory, or unreadable (ENOENT/ENOTDIR/EACCES) — skip
    // this branch silently rather than failing the whole scan.
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow a symlink, dir or file
    // Names with control characters (newlines especially) cannot be real
    // anchor folders, and letting one through could corrupt the printed
    // export line a task prompt executes. Skip them outright. [red-team fix]
    if (/[\u0000-\u001f]/.test(entry.name)) continue;
    const childDepth = depth + 1;

    if (entry.isDirectory()) {
      if (NEVER_DESCEND.has(entry.name)) continue;
      if (childDepth > maxDepth) continue; // would exceed the bound; prune
      await walkForCredentials(join(dir, entry.name), childDepth, maxDepth, found);
      continue;
    }

    if (!entry.isFile()) continue; // sockets/fifos/devices: not a candidate
    if (entry.name !== 'credentials') continue;
    if (childDepth > maxDepth) continue;
    // Match the fixed shape `.mixshift/auth/credentials` exactly: `dir` here
    // is the file's parent, so it must be an `auth` directory sitting
    // directly inside a `.mixshift` directory.
    if (basename(dir) !== 'auth' || basename(dirname(dir)) !== '.mixshift') continue;
    found.push(join(dir, entry.name));
  }
}

/**
 * Pick the newest candidate by mtime; ties broken by input order (first-seen
 * wins). A candidate that vanishes or becomes unreadable between discovery
 * and this stat (a race with something else on the box) is dropped rather
 * than failing the whole selection. Returns null when every candidate failed
 * stat, including the trivial empty-input case.
 */
export async function pickNewestCandidate(paths: string[]): Promise<string | null> {
  return (await sortCandidatesByMtime(paths))[0] ?? null;
}

/** All candidates ordered by mtime, newest first (ties keep input order —
 *  Array.prototype.sort is stable); candidates that fail stat (vanished or
 *  unreadable since discovery) are dropped. */
export async function sortCandidatesByMtime(paths: string[]): Promise<string[]> {
  const stated: Array<{ path: string; mtimeMs: number }> = [];
  for (const p of paths) {
    try {
      stated.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
    } catch {
      // dropped: gone or unreadable since discovery
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stated.map((s) => s.path);
}

/**
 * Derive the MIXSHIFT_DATA_DIR-equivalent root from a discovered credentials
 * file path. Throughout this codebase "dataDir" IS the `.mixshift`-named
 * directory itself (paths are built as `<dataDir>/auth/credentials`,
 * `<dataDir>/clients/<slug>/...`), so this is the hit path minus its trailing
 * `/auth/credentials` — two `dirname()` calls (credentials -> auth -> the
 * `.mixshift` dir).
 */
export function dataDirFromCredentialPath(hitPath: string): string {
  return dirname(dirname(hitPath));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token-mint failure classification
// ---------------------------------------------------------------------------

/**
 * Classify a thrown Error from the getValidAccessToken mint/refresh path.
 *
 * doMintServiceToken and doRefresh (lib/auth/credentials.ts) both collapse
 * every failure into a plain Error with no machine-readable status code
 * attached to it — callers only ever see `.message`. We pattern-match the
 * handful of message shapes those two functions are known to produce:
 *
 *   - service 401  -> "Service credential rejected (revoked, or rotated
 *     without updating this machine). Ask your tenant admin..."
 *   - datahub 401  -> "Your MixShift session expired. Run `mixshift auth
 *     login`..." (doRefresh), or getValidAccessToken's own "No credentials
 *     found..." after clearDatahub() runs following a replay-revocation 401.
 *   Both are "the credential itself is the problem" -> credential_invalid.
 *
 *   - a fetch-level failure (DNS/connection error, or the AbortSignal.
 *     timeout() firing) is wrapped as "Could not reach <url>: <message>.
 *     Check your network..." -> endpoint_unreachable.
 *
 * Everything else (a 429 rate limit, an unexpected 5xx/other 4xx wrapped as
 * "returned HTTP <status>", a 200 with no access_token) has no reliable
 * signal to bucket as "your credential is bad" vs "the service had a bad
 * moment". We default those to endpoint_unreachable: its remediation (check
 * egress, retry) is harmless if the real cause turns out to be something
 * else, whereas defaulting to credential_invalid would send someone to
 * re-mint a perfectly good credential over what might be a transient server
 * hiccup — the safer default when genuinely ambiguous.
 */
export function classifyMintError(err: unknown): 'credential_invalid' | 'endpoint_unreachable' {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /rejected \(revoked/i.test(message) ||
    /session expired/i.test(message) ||
    /returned HTTP 401\b/.test(message)
  ) {
    return 'credential_invalid';
  }
  return 'endpoint_unreachable';
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Repeatable-option accumulator for commander (matches commands/timeline.ts). */
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export function registerTaskCommands(program: Command): void {
  const task = program
    .command('task')
    .description(
      'Helpers for scheduled/unattended runs (Cowork scheduled tasks, CI, ' +
        'cloud automations): code a task prompt calls first instead of ' +
        'hand-rolling shell preamble.',
    );

  task
    .command('preflight')
    .description(
      'Resolve and verify the credential a scheduled/unattended run should ' +
        'use (including scanning a fresh Cowork sandbox under /sessions ' +
        'when the default data dir has none), seed any requested brand ' +
        'contexts, and report READY or the exact blocker + remediation. ' +
        'Exit codes: 0 ready, 6 credential_missing, 7 credential_invalid, ' +
        '8 endpoint_unreachable, 9 context_unavailable.',
    )
    .option(
      '--brand <slug>',
      'brand slug to ensure local context.yaml for (repeatable); pulls ' +
        'from the org store when not already present locally',
      collect,
      [] as string[],
    )
    .action(async (opts: PreflightCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await runPreflight(opts.brand, root);
    });
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

async function runPreflight(brandSlugs: string[], root: RootOptions): Promise<void> {
  const t0 = Date.now();
  try {
    const lines: string[] = [];
    const blockers: Blocker[] = [];
    const warnings: string[] = [];

    // --- Step 1: resolve the data dir the standard way. ------------------
    const resolvedDir = resolveDataDir(root.dataDir);
    let discoveredVia: DiscoveredVia = root.dataDir
      ? 'flag'
      : process.env.MIXSHIFT_DATA_DIR
        ? 'env'
        : 'default';
    let dataDir = resolvedDir;
    let candidates: string[] = [];
    /** Results of the sandbox scan, kept so the verify stage can fall through
     *  to other discovered credentials on a mint REJECTION without scanning
     *  twice. null = no scan has run yet (the resolved dir was usable). */
    let scanState: { sessionsHits: string[]; scanHits: string[] } | null = null;

    type CredentialsEnvelope = Awaited<ReturnType<typeof loadCredentials>>['credentials'];
    const isUsable = (env: CredentialsEnvelope): boolean =>
      Boolean(env?.datahub || env?.service);

    let credentials: CredentialsEnvelope = null;
    /** Sanitized (never the raw Error message — see
     *  describeCredentialLoadFailure) record of a credentials file that
     *  exists but failed to parse. */
    let loadFailure: { dir: string; message: string } | null = null;
    let malformedResolvedWarning: string | null = null;

    const loadFrom = async (
      dir: string,
    ): Promise<{ envelope: CredentialsEnvelope; failure: typeof loadFailure }> => {
      try {
        const loaded = await loadCredentials(dir);
        return { envelope: loaded.credentials, failure: null };
      } catch {
        return { envelope: null, failure: { dir, message: describeCredentialLoadFailure(dir) } };
      }
    };

    const first = await loadFrom(resolvedDir);
    credentials = first.envelope;
    loadFailure = first.failure;
    const resolvedDirHadFile = first.envelope !== null || first.failure !== null;

    if (isUsable(credentials)) {
      candidates = [credentialsPath(resolvedDir)];
    } else {
      // --- Step 2: sandbox discovery. -------------------------------------
      // The resolved dir has nothing USABLE: the file is absent, malformed,
      // or a legacy envelope with neither a datahub nor a service block
      // (mysql-only, or the remnant clearDatahub leaves behind). None of
      // those may suppress the scan — the whole point of discovery is that
      // the working credential lives somewhere ELSE (the granted anchor
      // folder), and a stale local file must not hide it. [red-team fix]
      const resolvedFailure = loadFailure;
      const sessionsHits = await discoverCredentialFiles([sessionsRoot()], SESSIONS_MAX_DEPTH);
      const cwdRoots = [process.cwd(), join(process.cwd(), 'outputs')];
      const cwdHits = await discoverCredentialFiles(cwdRoots, CWD_MAX_DEPTH);
      // The scan roots overlap in practice (a sandbox cwd sits under the
      // sessions mount, and cwd/outputs sits inside cwd), so one file can be
      // hit twice; dedupe before counting candidates or picking winners.
      const scanHits = [...new Set([...sessionsHits, ...cwdHits])];
      scanState = { sessionsHits, scanHits };
      // The resolved dir can itself sit under a scan root (MIXSHIFT_DATA_DIR
      // pointing into the sessions tree), so dedupe it against the hits too.
      candidates = [
        ...new Set([
          ...(resolvedDirHadFile ? [credentialsPath(resolvedDir)] : []),
          ...scanHits,
        ]),
      ];

      // Try hits newest-first until one holds a usable credential, so a
      // stray unusable file cannot shadow the real one behind it.
      credentials = null;
      loadFailure = null;
      for (const hit of await sortCandidatesByMtime(scanHits)) {
        const hitDir = dataDirFromCredentialPath(hit);
        const attempt = await loadFrom(hitDir);
        if (isUsable(attempt.envelope)) {
          credentials = attempt.envelope;
          dataDir = hitDir;
          discoveredVia = sessionsHits.includes(hit) ? 'sessions_scan' : 'cwd_scan';
          break;
        }
        // Unusable envelope or malformed file: keep looking; remember the
        // first scan-side parse failure in case nothing usable turns up.
        if (!loadFailure && attempt.failure) loadFailure = attempt.failure;
      }

      if (isUsable(credentials)) {
        // A malformed file at the RESOLVED dir demotes to a warning: the run
        // proceeds on the discovered credential, but someone should clean up.
        if (resolvedFailure) {
          // Name the malformed file's own location (stable), NOT the dir we
          // proceed on: a later mint-rejection fall-through can change the
          // adopted dir, so "proceeding under <X>" could point at the wrong
          // place. The verdict's data_dir shows what was actually used.
          // [red-team LOW fix]
          malformedResolvedWarning =
            `${resolvedFailure.message}; skipped it and proceeded with a credential ` +
            'found by scanning. Delete or repair the malformed file.';
        }
        loadFailure = null;
      } else if (resolvedFailure) {
        // Nothing usable anywhere: the resolved-dir failure is the primary
        // story again.
        loadFailure = resolvedFailure;
      }
    }

    lines.push(
      statusLine(
        'ok',
        `data dir: ${dataDir}  (via ${discoveredVia}; ${candidates.length} candidate(s) found)`,
      ),
    );
    for (const c of candidates) lines.push(`          ${c}`);
    if (malformedResolvedWarning) {
      warnings.push(malformedResolvedWarning);
      lines.push(statusLine('warn', malformedResolvedWarning));
    }

    // --- Steps 3-4: credential kind + real verify. ------------------------
    let credentialSummary: CredentialSummary | null = null;
    /** Telemetry: how many real mints this run performed (1 = no fall-through)
     *  and whether a fallback credential is the one that verified. */
    let mintAttemptsTotal = 0;
    let fallbackUsed = false;

    // datahub wins over service — the SAME precedence getValidAccessToken
    // uses, because that is what will actually authenticate. A `mysql`-only
    // (or empty) envelope is "nothing usable": the legacy raw-MySQL path is
    // retired and getValidAccessToken would throw for it. Such a file does
    // NOT suppress the sandbox scan above; when the scan also finds nothing
    // usable, this lands in credential_missing below.
    let kind: CredentialKind | null = null;
    let credentialLabel: string | undefined;
    let serviceClientId: string | undefined;
    if (credentials?.datahub) {
      kind = 'interactive';
      credentialLabel = credentials.datahub.person_label || credentials.datahub.email;
    } else if (credentials?.service) {
      kind = 'service';
      credentialLabel = credentials.service.label ?? credentials.service.client_id;
      serviceClientId = credentials.service.client_id;
    }

    if (loadFailure !== null) {
      lines.push(statusLine('BLOCKED', `credential: ${loadFailure.message}`));
      blockers.push({
        class: 'credential_invalid',
        message: loadFailure.message,
        remediation:
          'Delete the malformed credentials file and recreate it with ' +
          '`mixshift auth service-setup` (unattended) or `mixshift auth login` (interactive).',
      });
    } else if (kind === null) {
      const message =
        candidates.length > 0
          ? `Found ${candidates.length} candidate credentials file(s), but none contain a usable service or interactive credential.`
          : `No credentials file found at ${credentialsPath(resolvedDir)}, under ${sessionsRoot()}, ` +
            `or under the current directory (${process.cwd()}) / its outputs subdirectory.`;
      lines.push(statusLine('BLOCKED', `credential: ${message}`));
      blockers.push({
        class: 'credential_missing',
        message,
        remediation:
          'Run `mixshift auth service-setup` (recommended for unattended/scheduled runs) ' +
          'or `mixshift auth login` (interactive) to create one, then re-run this command.',
      });
    } else {
      // --- Step 4: real verify, with bounded fall-through on REJECTION. ----
      // A structurally-usable credential can still be revoked (field case,
      // Cartology 2026-07-23: discovery picked a stale credential out of a
      // previously-granted folder that had been rotated at /admin, while a
      // valid credential sat in another candidate — the run died "credential
      // rejected" even though a working one existed). So: when the mint is
      // REJECTED (credential_invalid), try the next discovered candidate,
      // newest-first, up to MAX_MINT_ATTEMPTS total mints. Never fall through
      // on endpoint_unreachable — a network failure would fail every
      // candidate identically, and each mint is a real network round trip.
      const describeSelected = (
        env: CredentialsEnvelope,
      ): { kind: CredentialKind; label?: string; serviceClientId?: string } | null => {
        if (env?.datahub) {
          return { kind: 'interactive', label: env.datahub.person_label || env.datahub.email };
        }
        if (env?.service) {
          return {
            kind: 'service',
            label: env.service.label ?? env.service.client_id,
            serviceClientId: env.service.client_id,
          };
        }
        return null; // callers filter on isUsable, so this is unreachable
      };

      /** Usable alternates in newest-first order, excluding dirs already
       *  tried. Draws ONLY from a scan that already ran during discovery
       *  (Step 2). It deliberately does NOT trigger a fresh scan: falling
       *  through only makes sense when the current credential was itself
       *  discovered by scanning. If the credential came from an explicit
       *  `--data-dir`/`MIXSHIFT_DATA_DIR` (or the default ~/.mixshift) that
       *  the caller pointed at, a rejection there is terminal — we must not
       *  react to it by scanning /sessions and adopting some other
       *  credential, which would defeat the explicit pin AND let a planted
       *  credentials file (its self-declared api_base is the mint oracle)
       *  hijack the run. [red-team HIGH fix] So: no scanState => no
       *  alternates => the rejection stands. */
      const materializeAlternates = async (
        triedDirs: ReadonlySet<string>,
      ): Promise<Array<{ dir: string; envelope: CredentialsEnvelope; via: DiscoveredVia }>> => {
        if (!scanState) return [];
        const out: Array<{ dir: string; envelope: CredentialsEnvelope; via: DiscoveredVia }> = [];
        for (const hit of await sortCandidatesByMtime(scanState.scanHits)) {
          const dir = dataDirFromCredentialPath(hit);
          if (triedDirs.has(dir)) continue;
          const attempt = await loadFrom(dir);
          if (!isUsable(attempt.envelope)) continue;
          out.push({
            dir,
            envelope: attempt.envelope,
            via: scanState.sessionsHits.includes(hit) ? 'sessions_scan' : 'cwd_scan',
          });
        }
        return out;
      };

      const MAX_MINT_ATTEMPTS = 3;
      const triedDirs = new Set<string>([dataDir]);
      let current: {
        dir: string;
        via: DiscoveredVia;
        kind: CredentialKind;
        label?: string;
        serviceClientId?: string;
      } = { dir: dataDir, via: discoveredVia, kind, label: credentialLabel, serviceClientId };
      let queue: Array<{ dir: string; envelope: CredentialsEnvelope; via: DiscoveredVia }> | null = null;
      let mintAttempts = 0;
      let verified = false;
      /** The PRIMARY credential's rejection — the blocker we report when
       *  nothing verifies (later rejections become a warning count). */
      let firstRejection: string | null = null;
      let extraRejections = 0;
      let unreachableMessage: string | null = null;

      for (;;) {
        lines.push(
          statusLine(
            'ok',
            `credential: ${current.kind}${current.label ? ` (${current.label})` : ''}`,
          ),
        );

        mintAttempts++;
        try {
          // Mint exactly the way `auth service-setup`'s verify step does (same
          // helper, forceRefresh: true so this is a REAL round trip, never a
          // stale cached token papering over a revoked credential).
          await getValidAccessToken(current.dir, true);
          verified = true;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lines.push(statusLine('BLOCKED', `auth verify: ${message}`));
          if (classifyMintError(err) === 'endpoint_unreachable') {
            unreachableMessage = message;
            break;
          }
          if (firstRejection === null) firstRejection = message;
          else extraRejections++;
          if (mintAttempts >= MAX_MINT_ATTEMPTS) break;
          if (queue === null) queue = await materializeAlternates(triedDirs);
          const next = queue.shift();
          if (!next) break;
          const described = describeSelected(next.envelope);
          if (!described) break; // defensive; alternates are pre-filtered usable
          triedDirs.add(next.dir);
          lines.push(statusLine('warn', 'trying the next discovered credential (newest first)'));
          current = { dir: next.dir, via: next.via, ...described };
        }
      }

      const INVALID_REMEDIATION =
        'Re-run `mixshift auth service-setup` with a fresh setup code (service ' +
        'credential), or `mixshift auth login` (interactive credential).';

      mintAttemptsTotal = mintAttempts;
      fallbackUsed = verified && mintAttempts > 1;

      // Interactive-credential warning: emit ONCE, for the credential actually
      // in play (the adopted one when verified, else the primary the failure
      // report describes) — not once per attempt, which duplicated it and
      // inflated warnings_count. [red-team LOW fix]
      const effectiveKind = verified ? current.kind : kind;
      if (effectiveKind === 'interactive') {
        const w =
          'signed in with an interactive credential; scheduled/unattended runs should use ' +
          'a service credential (`mixshift auth service-setup`), because interactive token ' +
          'refresh is unreliable when nobody is present to re-authenticate.';
        warnings.push(w);
        lines.push(statusLine('warn', w));
      }

      if (verified) {
        // Adopt the verified credential for everything downstream (data dir,
        // export line, scopes, brand pulls). On the no-fallback path these
        // assignments are no-ops.
        dataDir = current.dir;
        discoveredVia = current.via;
        kind = current.kind;
        credentialLabel = current.label;
        serviceClientId = current.serviceClientId;

        lines.push(statusLine('ok', 'auth verify: minted a fresh access token'));
        if (firstRejection !== null) {
          const w =
            `a discovered credential was rejected (revoked or rotated) before this one ` +
            `verified${extraRejections > 0 ? `, and ${extraRejections} more also rejected` : ''}. ` +
            'Delete stale credentials files and revoke unused credentials at /admin ' +
            'so discovery stays unambiguous.';
          warnings.push(w);
          lines.push(statusLine('warn', w));
        }

        let scopes: string[] | undefined;
        if (kind === 'service' && serviceClientId) {
          const attribution = await readServiceAttributionCache(serviceClientId, dataDir);
          if (attribution.scopes && attribution.scopes.length > 0) {
            scopes = attribution.scopes;
            lines.push(statusLine('ok', `scopes: ${scopes.join(', ')}`));
          }
        }

        credentialSummary = {
          path: credentialsPath(dataDir),
          kind,
          verified: true,
          ...(credentialLabel ? { label: credentialLabel } : {}),
          ...(scopes ? { scopes } : {}),
        };
      } else {
        // Not verified: report against the PRIMARY credential (the outer
        // dataDir/kind/label were never reassigned), so the blocker, summary,
        // and export line all describe the same credential the run selected
        // first — fallback attempts are context, not the headline.
        if (firstRejection !== null) {
          blockers.push({
            class: 'credential_invalid',
            message: firstRejection,
            remediation: INVALID_REMEDIATION,
          });
          if (extraRejections > 0) {
            const w = `${extraRejections} other discovered credential(s) were also rejected (revoked or rotated?).`;
            warnings.push(w);
            lines.push(statusLine('warn', w));
          }
        }
        if (unreachableMessage !== null) {
          blockers.push({
            class: 'endpoint_unreachable',
            message: unreachableMessage,
            remediation:
              'Check egress connectivity to the MixShift auth service (mcp.mixshift.io ' +
              'must be reachable/allowlisted from this sandbox), then retry.',
          });
        }
        credentialSummary = {
          path: credentialsPath(dataDir),
          kind,
          verified: false,
          ...(credentialLabel ? { label: credentialLabel } : {}),
        };
      }
    }

    // --- Step 5: brand context, sequential. -------------------------------
    const brands: BrandResult[] = [];
    for (const slug of brandSlugs) {
      const ctxPath = contextPath(slug, dataDir);
      if (await pathExists(ctxPath)) {
        brands.push({ slug, status: 'present' });
        lines.push(statusLine('ok', `brand ${slug}: present`));
        continue;
      }

      const client = createContextSyncClient({ dataDirOverride: dataDir });
      const result = await pull(slug, { client, dataDirOverride: dataDir });

      if (!result.ok) {
        const message = `brand '${slug}': ${result.message}`;
        lines.push(statusLine('BLOCKED', message));
        blockers.push({
          class: 'context_unavailable',
          message,
          remediation:
            'Confirm the brand slug and that this credential has access to it ' +
            '(`mixshift context status` lists the known brands), or run ' +
            '`mixshift context pull --brand <slug>` directly to see the full error.',
        });
        brands.push({ slug, status: 'unavailable' });
        continue;
      }

      // ok:true doesn't guarantee context.yaml specifically landed — the org
      // store may know the brand but hold no context doc for it yet. Re-check
      // before calling it 'pulled'.
      if (await pathExists(ctxPath)) {
        brands.push({ slug, status: 'pulled' });
        lines.push(statusLine('ok', `brand ${slug}: pulled`));
      } else {
        const message =
          `brand '${slug}': pull completed but context.yaml still does not exist locally; ` +
          'the org store may not hold a context doc for this brand yet';
        lines.push(statusLine('BLOCKED', message));
        blockers.push({
          class: 'context_unavailable',
          message,
          remediation:
            'Run brand-context setup for this brand (`mixshift brand discover` / the ' +
            'mx-brand-context skill), or confirm the slug with `mixshift context status`.',
        });
        brands.push({ slug, status: 'unavailable' });
      }
    }

    // --- Step 6: verdict. --------------------------------------------------
    const { exitCode, firstBlockerClass } = computeExitCode(blockers);
    const ready = blockers.length === 0;
    // Single-quoted: this line is executed verbatim by task shells, and the
    // path may come from a scan across directories this process does not
    // control. [red-team fix]
    const exportLine =
      kind !== null ? `export MIXSHIFT_DATA_DIR=${shellQuoteSingle(dataDir)}` : null;

    const resultOut: PreflightResult = {
      ready,
      data_dir: dataDir,
      export_line: exportLine,
      discovered_via: discoveredVia,
      candidates,
      credential: credentialSummary,
      brands,
      blockers,
      warnings,
    };

    await track(
      {
        event_name: EventName.TaskPreflightCompleted,
        outcome: ready ? 'ok' : 'failed',
        ...(firstBlockerClass ? { error_class: firstBlockerClass } : {}),
        duration_ms: Date.now() - t0,
        payload: {
          discovered_via: discoveredVia,
          candidates_found: candidates.length,
          brand_count: brandSlugs.length,
          brands_pulled: brands.filter((b) => b.status === 'pulled').length,
          warnings_count: warnings.length,
          // Fall-through visibility (counts/booleans only): >1 attempts means
          // a discovered credential was rejected at mint and alternates were
          // tried; fallback_used means one of them is what verified.
          mint_attempts: mintAttemptsTotal,
          fallback_used: fallbackUsed,
        },
      },
      // Deviation from the house `track(..., root.dataDir)` pattern,
      // deliberately: attribution (the svc actor block), the install id, and
      // the offline queue must ride the DISCOVERED data dir. On the scan
      // path root.dataDir is undefined and would resolve to the throwaway
      // sandbox home — the event would go out anonymous (or queue into a dir
      // that dies with the sandbox). [red-team fix]
      dataDir,
    );

    if (root.json) {
      process.stdout.write(JSON.stringify(resultOut, null, 2) + '\n');
      process.exitCode = exitCode;
      return;
    }

    lines.push('');
    if (ready) {
      lines.push('READY');
      if (exportLine) lines.push(exportLine);
    } else {
      const first = blockers.find((b) => b.class === firstBlockerClass) ?? blockers[0];
      lines.push(`BLOCKED: ${first.class} - ${first.message}`);
      lines.push(`Remediation: ${first.remediation}`);
      if (exportLine) {
        lines.push('');
        lines.push(exportLine);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
    process.exitCode = exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (root.json) {
      process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

function statusLine(status: 'ok' | 'warn' | 'BLOCKED', message: string): string {
  return `${status.padEnd(8)}${message}`;
}
