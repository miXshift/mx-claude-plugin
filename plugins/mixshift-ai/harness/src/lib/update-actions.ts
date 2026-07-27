/**
 * Guided catch-up actions (P2): fetch + validate + compute pending post-
 * update actions from `releases/actions.yaml`, for `mixshift update-actions`
 * and the mx-update skill.
 *
 * ---------------------------------------------------------------------------
 * Threat model (read before touching anything in this file)
 * ---------------------------------------------------------------------------
 * `releases/actions.yaml` is fetched from GitHub raw — the SAME untrusted-
 * source threat class as the version strings that produced two red-team
 * HIGHs in the update-notice feature (P1). Every field in it (title, teach,
 * run, predicates) is attacker-influenceable if the repo is compromised or
 * MITM'd. This module is defensive by construction:
 *
 *   - `applies_if` / `detect_done` are a FIXED VOCABULARY of predicate
 *     kinds (PREDICATE_KINDS below), never eval'd strings/shell/paths.
 *     Unknown kind -> the whole action is dropped at parse time (zod
 *     `z.enum` rejects it, `parseActions` silently drops the entry).
 *     Deliberately NARROWER than the original design doc's vocab (which
 *     included `file_exists`/`file_absent` with a path template): this
 *     ships only `always` | `signed_in` | `has_brands`, so there is no
 *     path-traversal surface at all, by construction rather than by
 *     careful path-sanitization.
 *   - `run.skill` is validated against the ACTUAL installed skills/
 *     directory set (see `listInstalledSkillIds`). A poisoned `run.skill`
 *     can only ever name a real, already-shipped skill; it cannot
 *     introduce a new command or path. `run.args_hint` is a short
 *     freeform hint SHOWN to the user, never executed — see
 *     commands/update-actions.ts and skills/mx-update/SKILL.md, both of
 *     which treat it as display data.
 *   - `title` / `teach` are DATA, length-bounded (see MAX_TITLE_CHARS /
 *     MAX_TEACH_CHARS below). Callers present them to the user as quoted
 *     content, never as instructions to follow.
 *   - This module WRITES NOTHING (not even a cache write failure is
 *     fatal). It only ever COMPUTES a list of pending actions; the
 *     ledger lives in update-actions-state.ts and is only ever mutated by
 *     the `mixshift update-actions record|catch-up` commands. Executing
 *     an action always goes through the NAMED skill, which carries its
 *     own confirm flow — this engine never executes anything itself.
 *
 * `parseActions` drops any malformed, oversized, or invalid entry SILENTLY
 * (no logging) — a malformed entry is exactly as unremarkable as one that
 * simply doesn't apply yet; there is nothing actionable to tell an operator
 * from inside a user's CLI invocation, and echoing attacker-controlled
 * fragments back out (even to stderr) would just be another injection
 * surface.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { resolveDataDir } from './paths/resolve.js';
import { pluginPath } from './prefetch/plugin-root.js';
import { isValidVersion } from './update-notice-state.js';
import { compareVersions } from './version-check.js';
import { loadCredentials } from './auth/credentials.js';
import { readIndex } from './clients/index.js';
import { resolveGatewayBaseSafe } from './net/gateway-url.js';
import type { ActionsLedger } from './update-actions-state.js';

const ACTIONS_URL_DEFAULT =
  'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/releases/actions.yaml';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on the fetched manifest so a hostile/compromised feed can't drive
// unbounded memory/CPU. actions.yaml is a handful of short entries; 256KB is
// generous. A larger body is treated as a fetch failure.
const MAX_YAML_BYTES = 256 * 1024;
// Cap the number of entries we will even attempt to validate, so a feed with
// a giant `actions:` array can't force unbounded parse work.
const MAX_ACTIONS = 200;

/** Resolved at call time (not module load) so tests can flip
 *  MIXSHIFT_ACTIONS_URL between cases without re-importing the module.
 *
 *  The override is honored ONLY for https, or http on loopback (test
 *  affordance) — identical restriction to version-check.ts's
 *  resolveMarketplaceUrl. Without this an env var becomes an open
 *  SSRF/redirect target that also feeds the untrusted-manifest surface
 *  below; never widen it to arbitrary hosts. */
function actionsUrl(): string {
  const override = process.env.MIXSHIFT_ACTIONS_URL;
  if (!override) return ACTIONS_URL_DEFAULT;
  try {
    const u = new URL(override);
    if (u.protocol === 'https:') return override;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
      return override;
    }
  } catch {
    // malformed — fall through to the default
  }
  return ACTIONS_URL_DEFAULT;
}

// ---------------------------------------------------------------------------
// Fixed vocabulary — the ONLY predicate kinds this engine will ever evaluate.
// Anything else fails the zod enum and the whole action is dropped.
// ---------------------------------------------------------------------------

export const PREDICATE_KINDS = ['always', 'signed_in', 'has_brands'] as const;
export type PredicateKind = (typeof PREDICATE_KINDS)[number];

export const WRITES_TIERS = ['none', 'local', 'warehouse', 'amazon'] as const;
export type WritesTier = (typeof WRITES_TIERS)[number];

export const MAX_TITLE_CHARS = 120;
export const MAX_TEACH_CHARS = 600;
export const MAX_ARGS_HINT_CHARS = 60;

// ---------------------------------------------------------------------------
// Schema — every bound below is enforced by zod itself, so a violation
// fails safeParse and the entry is dropped by parseActions, never coerced
// or truncated into something "close enough".
// ---------------------------------------------------------------------------

const predicateSchema = z.object({
  kind: z.enum(PREDICATE_KINDS),
});

const runSchema = z.object({
  skill: z.string().min(1).max(120),
  args_hint: z.string().max(MAX_ARGS_HINT_CHARS).default(''),
});

const actionSchema = z.object({
  id: z.string().min(1).max(120),
  introduced_in: z.string().refine(isValidVersion, 'not a valid version shape'),
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  teach: z.string().min(1).max(MAX_TEACH_CHARS),
  applies_if: predicateSchema,
  detect_done: predicateSchema.optional(),
  run: runSchema,
  writes: z.enum(WRITES_TIERS),
  supersedes: z.array(z.string().min(1).max(120)).default([]),
});

export type ActionPredicate = z.infer<typeof predicateSchema>;
export type ActionRun = z.infer<typeof runSchema>;
export type Action = z.infer<typeof actionSchema>;

/** What `computePending` (and `update-actions --json`) hand to the caller —
 *  just the display + execution-routing fields. Never includes
 *  `introduced_in` / `supersedes` (window-collapse bookkeeping the caller
 *  doesn't need to know about). */
export interface PendingAction {
  id: string;
  title: string;
  teach: string;
  run: ActionRun;
  writes: WritesTier;
}

const actionsFileSchema = z.object({
  version: z.literal(1),
  actions: z.array(z.unknown()).default([]),
});

/** title/teach come from an untrusted feed and are surfaced to the model +
 *  user. They are prose (not charset-gateable like a version), so strip
 *  formatting-breaking control characters at the boundary. */
function stripControl(s: string, keepNewline: boolean): string {
  // Escape-free by construction: compare code points numerically rather than
  // matching control-char ranges with regex literals (which are fragile to
  // author and read). C0 controls (< 0x20) and DEL (0x7f) are removed; a
  // newline (0x0a) is optionally kept, other controls become a space so words
  // don't fuse.
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7f) {
      out += ch;
    } else if (keepNewline && c === 0x0a) {
      out += ch;
    } else {
      out += ' ';
    }
  }
  return out;
}

function sanitizeTitle(s: string): string {
  // A title is a single line: strip every control char, collapse whitespace.
  // A stray newline would otherwise break out of the "### <title>" markdown
  // heading the renderer builds.
  return stripControl(s, false).replace(/\s+/g, ' ').trim();
}

function sanitizeTeach(s: string): string {
  // teach keeps newlines (the renderer quotes each line); other control chars
  // are dropped and 3+ blank lines collapse to a single paragraph break.
  const kept = stripControl(s.replace(/\r/g, ''), true);
  return kept.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse + validate `releases/actions.yaml`. Any entry that fails schema
 * validation (malformed shape, oversized title/teach, invalid
 * introduced_in, unknown predicate kind, anything) is silently dropped —
 * never logged, never partially coerced. Pure + total: any input yields an
 * array (possibly empty), never throws. The entry count is capped at
 * MAX_ACTIONS so a giant feed can't drive unbounded validation work.
 */
export function parseActions(yamlText: string): Action[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return [];
  }
  const top = actionsFileSchema.safeParse(parsed);
  if (!top.success) return [];

  const out: Action[] = [];
  for (const raw of top.data.actions.slice(0, MAX_ACTIONS)) {
    const result = actionSchema.safeParse(raw);
    if (!result.success) continue; // drop silently — see module header.
    const title = sanitizeTitle(result.data.title);
    const teach = sanitizeTeach(result.data.teach);
    if (!title || !teach) continue; // sanitized away to nothing -> drop.
    out.push({ ...result.data, title, teach });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch + 24h cache — mirrors lib/changelog.ts's loadChangelog() exactly
// (same cache-file shape, same TTL, same never-throw contract).
// ---------------------------------------------------------------------------

interface ActionsCache {
  checked_at: string; // ISO
  yaml: string;
}

export interface ActionsLoadResult {
  actions: Action[];
  source: 'network' | 'cache' | 'none';
  error?: string;
}

function actionsCachePath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'actions.yaml.cache.json');
}

/**
 * Load + parse the actions feed. 24h disk cache; on a stale/forced miss,
 * fetch fresh and re-cache; on fetch failure, fall back to whatever is
 * cached. Never throws.
 */
export async function loadActions(
  opts: { dataDirOverride?: string; forceFetch?: boolean } = {},
): Promise<ActionsLoadResult> {
  const path = actionsCachePath(opts.dataDirOverride);

  let cached: ActionsCache | null = null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ActionsCache>;
    if (typeof parsed.checked_at === 'string' && typeof parsed.yaml === 'string') {
      cached = { checked_at: parsed.checked_at, yaml: parsed.yaml };
    }
  } catch {
    // no/invalid cache
  }

  const cacheAge = cached ? Date.now() - Date.parse(cached.checked_at) : Infinity;
  const cacheFresh = !opts.forceFetch && cached !== null && cacheAge < CACHE_TTL_MS;

  if (cacheFresh && cached) {
    return { actions: parseActions(cached.yaml), source: 'cache' };
  }

  const fetched = await fetchActionsYaml();
  if (fetched.yaml !== null) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ checked_at: new Date().toISOString(), yaml: fetched.yaml }, null, 2) + '\n',
        'utf-8',
      );
    } catch {
      // cache write is non-fatal
    }
    return { actions: parseActions(fetched.yaml), source: 'network' };
  }

  if (cached) {
    return { actions: parseActions(cached.yaml), source: 'cache', error: fetched.error };
  }
  return { actions: [], source: 'none', error: fetched.error };
}

/**
 * Gateway-first, GitHub-raw-fallback. The gateway route (mx-legacy-auth's
 * `GET {base}/plugin/actions.yaml`) rides the one domain every install
 * already reaches — sandboxes that block raw.githubusercontent.com allow
 * mcp.mixshift.io. When no gateway is configured (or the gateway leg fails
 * for any reason) this falls through to the existing direct fetch of
 * `actionsUrl()` unchanged. Same size cap applies to both legs.
 */
/**
 * Structural check for the gateway leg: does the body parse as a valid actions
 * manifest (`{actions: [...]}`, possibly EMPTY)? This distinguishes the real
 * file — including a legitimately empty manifest — from a 200 whose body is not
 * the manifest at all (empty body, HTML captive-portal/WAF interstitial), so
 * that garbage can't win over, or poison the 24h cache against, the GitHub-raw
 * fallback. Uses the same schema `parseActions()` gates on; never throws.
 * (`parseActions(...).length > 0` would be WRONG here — an empty manifest is
 * valid content, not garbage.)
 */
function isActionsManifest(yamlText: string): boolean {
  try {
    return actionsFileSchema.safeParse(parseYaml(yamlText)).success;
  } catch {
    return false;
  }
}

async function fetchActionsYaml(): Promise<{ yaml: string | null; error?: string }> {
  const base = await resolveGatewayBaseSafe();
  if (base) {
    const viaGateway = await fetchActionsYamlFrom(`${base}/plugin/actions.yaml`);
    if (viaGateway.yaml !== null && isActionsManifest(viaGateway.yaml)) return viaGateway;
  }
  return fetchActionsYamlFrom(actionsUrl());
}

async function fetchActionsYamlFrom(url: string): Promise<{ yaml: string | null; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { yaml: null, error: `HTTP ${res.status}` };
    // Reject an oversized body before materializing it as a string. Trust the
    // content-length when present; otherwise fall back to a post-read byte
    // check (the body is already capped by the string length below).
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_YAML_BYTES) {
      return { yaml: null, error: 'manifest too large' };
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf-8') > MAX_YAML_BYTES) {
      return { yaml: null, error: 'manifest too large' };
    }
    return { yaml: text };
  } catch (err) {
    return { yaml: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Predicate evaluator — the FIXED VOCABULARY mapped to real readers. This is
// the only place a predicate `kind` is interpreted; there is no generic
// dispatch, no eval, no string templating. Anything not in PREDICATE_KINDS
// (which can't reach here anyway, since parseActions already dropped it)
// resolves to false, never true, if it somehow did.
// ---------------------------------------------------------------------------

export async function evalPredicate(
  kind: string,
  opts: { dataDirOverride?: string } = {},
): Promise<boolean> {
  // Fail closed and NEVER throw: a predicate reads on-disk state (credentials,
  // brand index) that a corrupt/locked file could make throw. A predicate that
  // can't be evaluated resolves to false, so the action simply isn't offered,
  // rather than crashing `mixshift update-actions`. This is what makes
  // computePending's own "never throws" contract hold.
  try {
    return await evalPredicateInner(kind, opts);
  } catch {
    return false;
  }
}

async function evalPredicateInner(
  kind: string,
  opts: { dataDirOverride?: string },
): Promise<boolean> {
  switch (kind) {
    case 'always':
      return true;
    case 'signed_in': {
      const { credentials } = await loadCredentials(opts.dataDirOverride);
      return !!(credentials?.datahub || credentials?.service || credentials?.mysql);
    }
    case 'has_brands': {
      // Counts any brand in the registry (active or dormant), not
      // specifically ones that have completed brand-context setup — keeps
      // the fixed vocabulary simple and generic rather than adding a
      // narrower predicate kind for one seed action. If a future action
      // needs "has completed brand setup" specifically, add a new named
      // kind to PREDICATE_KINDS (still fixed-vocabulary, never eval'd)
      // rather than overloading this one.
      const { index } = await readIndex(opts.dataDirOverride);
      return index.brands.length > 0;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Installed-skill allowlist — `run.skill` must name a directory that
// actually exists under skills/, so a poisoned actions.yaml can only ever
// point at a skill that is ALREADY shipped and already has its own
// confirm/write-gating behavior.
// ---------------------------------------------------------------------------

async function listInstalledSkillIds(): Promise<Set<string>> {
  try {
    const dir = pluginPath('skills');
    const entries = await readdir(dir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// computePending — the read-only compute `mixshift update-actions` exposes.
// ---------------------------------------------------------------------------

export interface ComputePendingArgs {
  /** Currently-installed plugin version (getPluginVersion()). */
  installed: string;
  /** The watermark version the user is already caught up through. Actions
   *  with `introduced_in` at or before this version are excluded. */
  caughtUpTo: string;
  ledger: ActionsLedger;
  actions: Action[];
  dataDirOverride?: string;
  /** Override for testing; defaults to the real installed skills/ set
   *  (see listInstalledSkillIds). */
  installedSkillIds?: Set<string>;
}

/**
 * Compute the actions still pending for this install: window-filtered by
 * version, supersedes-collapsed, ledger-filtered (not completed/dismissed),
 * skill-allowlist-filtered, then predicate-filtered (applies_if true AND
 * detect_done, if present, false). Never throws — a bad predicate/skill
 * lookup just drops that one action rather than failing the whole list.
 */
export async function computePending(args: ComputePendingArgs): Promise<PendingAction[]> {
  const { installed, caughtUpTo, ledger, actions } = args;

  // 1. Window filter: introduced_in in (caughtUpTo, installed].
  let candidates = actions.filter((a) => {
    if (compareVersions(a.introduced_in, installed) > 0) return false; // not yet installed
    if (compareVersions(caughtUpTo, a.introduced_in) >= 0) return false; // already caught up
    return true;
  });

  // 2. Ledger filter: an action already completed or dismissed never
  // resurfaces. ('skipped' / 'later' DO resurface — see design.)
  candidates = candidates.filter((a) => {
    const rec = ledger.actions[a.id];
    return !(rec && (rec.status === 'completed' || rec.status === 'dismissed'));
  });

  // 3. Skill allowlist: run.skill must be a real, installed skill.
  const installedSkills = args.installedSkillIds ?? (await listInstalledSkillIds());
  candidates = candidates.filter((a) => installedSkills.has(a.run.skill));

  // 4. Predicate filter -> the actions that would actually be offered.
  const eligible: Action[] = [];
  for (const a of candidates) {
    const applies = await evalPredicate(a.applies_if.kind, { dataDirOverride: args.dataDirOverride });
    if (!applies) continue;
    if (a.detect_done) {
      const done = await evalPredicate(a.detect_done.kind, { dataDirOverride: args.dataDirOverride });
      if (done) continue;
    }
    eligible.push(a);
  }

  // 5. Collapse supersedes AMONG THE ELIGIBLE SET ONLY, so jumping several
  // versions at once offers just the newest action in a chain. Doing this
  // last (not on raw window candidates) is load-bearing: an action that was
  // filtered out above — because its skill isn't installed, its predicate is
  // false, or it is a hostile phantom in a poisoned manifest — must NOT be
  // able to suppress a real, offerable action via its `supersedes` list.
  const supersededIds = new Set<string>();
  for (const a of eligible) for (const s of a.supersedes) supersededIds.add(s);
  return eligible
    .filter((a) => !supersededIds.has(a.id))
    .map((a) => ({ id: a.id, title: a.title, teach: a.teach, run: a.run, writes: a.writes }));
}
