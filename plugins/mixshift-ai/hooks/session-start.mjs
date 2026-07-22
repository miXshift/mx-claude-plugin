#!/usr/bin/env node
/**
 * SessionStart hook: register the `mixshift` CLI shim on the session's PATH.
 *
 * The claude.ai plugin validator forbids top-level bin/ executables (which the
 * CLI runtime used to PATH-register automatically), so the shim now lives at
 * harness/bin/mixshift and this hook performs the PATH registration instead,
 * by appending exports to the session env file the host exposes via
 * CLAUDE_ENV_FILE (sourced by the Bash tool). It also exports MIXSHIFT_CLI
 * (absolute path to the bundled cli.js) so skills have a PATH-independent
 * invocation: `node "$MIXSHIFT_CLI" <args>`.
 *
 * Contract: fast, offline, and silent. This hook must NEVER block or fail a
 * session start — on any error it exits 0 having done nothing, and skills
 * fall back to resolving the plugin root from their own base directory.
 *
 * Security: the exported lines are sourced by every Bash invocation of the
 * session, so the interpolated paths are (a) restricted to a conservative
 * character allowlist and (b) single-quoted. If the install path fails the
 * allowlist, we write nothing rather than risk a malformed or injectable
 * line; skills' fallback covers functionality.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, release } from 'node:os';

const MARKER = '# mixshift-ai session PATH registration';
const SAFE = /^[A-Za-z0-9 _/:.\-]+$/;

function posixify(p) {
  if (process.platform !== 'win32') return p;
  // The env file is sourced by Git Bash, whose PATH is colon-separated —
  // a `C:/...` entry would split at the drive colon. Use the /c/... form.
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
}

try {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const pluginRoot =
      process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const binDir = posixify(join(pluginRoot, 'harness', 'bin'));
    const cliPath = posixify(join(pluginRoot, 'harness', 'dist', 'cli.js'));
    if (SAFE.test(binDir) && SAFE.test(cliPath)) {
      // SessionStart fires more than once per session (startup, then again on
      // every resume/compact) against the SAME env file — append only once.
      let already = false;
      try {
        already = readFileSync(envFile, 'utf8').includes(MARKER);
      } catch {}
      if (!already) {
        appendFileSync(
          envFile,
          `\n${MARKER}\nexport PATH='${binDir}':"$PATH"\nexport MIXSHIFT_CLI='${cliPath}'\n`
        );
      }
    }
  }
} catch {
  // Never surface errors from a session-start hook; fallback invocation covers us.
}

// -----------------------------------------------------------------------------
// Stage 2: proactive update notice
// -----------------------------------------------------------------------------
/**
 * After the PATH stage above, tell the model (via `additionalContext`, which
 * reaches it on every surface — unlike `systemMessage`, which desktop Claude
 * Code doesn't render) when this install either just updated, or is behind
 * the latest published version, so the model can proactively mention it once
 * instead of the user finding out by accident.
 *
 * Fires on EVERY SessionStart (startup, resume, compact, concurrent
 * background sessions), so every step here is cheap, tolerant of a
 * missing/corrupt state file, and throttled against repeat work (one fetch
 * attempt / 24h, one stale-notice repeat / 24h). Never blocks or fails the
 * session: this whole stage is one big try/catch and the process always
 * exits 0.
 *
 * MIRRORED SCHEMA WARNING: this stage re-implements, in plain zero-dependency
 * JS, the exact state-file shape and read/write contract that
 * harness/src/lib/update-notice-state.ts also implements (that side backs
 * `mixshift whatsnew --dismiss`). If you change the shape or the state-dir
 * resolution rule here, make the matching edit there, and vice versa — the
 * two must never drift apart.
 *
 * State machine, in order:
 *   1. Resolve currentVersion from plugin.json. Failure -> skip the whole
 *      stage (steps 2-10 never run).
 *   2. dataDir: MIXSHIFT_DATA_DIR or ~/.mixshift. Used for version-check.json
 *      (the harness's own 24h cache) and the telemetry queue — same files the
 *      harness itself reads/writes, so a hook-side refresh benefits later
 *      `mixshift` invocations too.
 *   3. State file lives in CLAUDE_PLUGIN_DATA (if the host sets it) or else
 *      dataDir. Missing/corrupt -> treated as empty state.
 *   4. "Just updated" notice: state.last_seen_version was a real version and
 *      differs from currentVersion. last_seen_version is then advanced to
 *      currentVersion regardless (so this only ever fires once per update).
 *   5. Staleness: read the harness's version-check.json cache; if fresh
 *      (<24h) use it, else fetch the marketplace manifest at most once/24h
 *      (2.5s timeout, no retries) and refresh that same cache file on
 *      success. Any failure here is silent — no staleness signal this run.
 *   6. Compare currentVersion vs latest with the SAME hand-rolled comparator
 *      the harness uses (src/lib/version-check.ts::compareVersions) —
 *      reimplemented here rather than imported, since this script can't
 *      import from harness/dist.
 *   7. Stale notices are suppressed once the user dismisses that exact
 *      version, or within 24h of the last time we showed that exact stale
 *      notice.
 *   8. Precedence: if BOTH an update just happened AND a newer version than
 *      that exists, emit ONE "updated" notice that also mentions the newer
 *      version — never two separate notices in the same run.
 *   9. Output: a single JSON object on stdout — `systemMessage` (terminal
 *      surfaces) + `hookSpecificOutput.additionalContext` (every surface,
 *      relayed by the model) — only when a notice actually applies. Nothing
 *      printed otherwise (unchanged from today).
 *  10. Telemetry: best-effort, one JSONL line appended straight to the
 *      harness's own telemetry queue file, gated on the same "is telemetry
 *      configured/opted-in" preconditions the harness checks, but read here
 *      via plain regex over profile.yaml / .mixshift-defaults.yaml (no YAML
 *      parser dependency).
 */

const STATE_FILENAME = 'update-notice-state.json';
const VERSION_CHECK_FILENAME = 'version-check.json';
const DEFAULT_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/.claude-plugin/marketplace.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

// --- tiny fs helpers ---------------------------------------------------------

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename() over the
 *  target. Matches the temp-then-rename convention used throughout the
 *  harness (profile/save.ts, telemetry/queue.ts). Throws on failure — callers
 *  decide whether that's fatal to them (it never is here; every call site is
 *  itself inside the outer stage try/catch). */
async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const body = JSON.stringify(obj, null, 2) + '\n';
  try {
    await writeFile(tmp, body, 'utf-8');
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function isFreshIso(iso, nowMs, ttlMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return nowMs - t < ttlMs;
}

// --- state file (step 3) -----------------------------------------------------

function emptyState() {
  return {
    last_seen_version: null,
    stale_notice: null,
    dismissed_version: null,
    last_fetch_attempt_at: null,
  };
}

/** Tolerant read: missing OR corrupt (unreadable / invalid JSON / wrong
 *  shape) collapses to the empty state. Recovers whatever individual fields
 *  ARE valid rather than discarding the whole file on one bad field. */
async function readState(path) {
  const parsed = await readJsonFile(path);
  const state = emptyState();
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.last_seen_version === 'string') state.last_seen_version = parsed.last_seen_version;
    if (typeof parsed.dismissed_version === 'string') state.dismissed_version = parsed.dismissed_version;
    if (typeof parsed.last_fetch_attempt_at === 'string') {
      state.last_fetch_attempt_at = parsed.last_fetch_attempt_at;
    }
    if (parsed.stale_notice && typeof parsed.stale_notice === 'object') {
      const sn = parsed.stale_notice;
      if (typeof sn.version === 'string' && typeof sn.at === 'string') {
        state.stale_notice = { version: sn.version, at: sn.at };
      }
    }
  }
  return state;
}

// --- version resolution (steps 1, 5, 6) -------------------------------------

function readCurrentVersion(pluginRoot) {
  try {
    const raw = readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Hand-rolled version comparator — NOT a semver lib. MUST stay semantically
 * identical to harness/src/lib/version-check.ts::compareVersions (that file
 * is the canonical implementation; this is a standalone reimplementation
 * because this script cannot import from harness/dist). Split on the first
 * `-` into core/prerelease; core split on `.`; each segment compared as an
 * integer (missing or non-numeric segments count as 0); equal core with one
 * side carrying a prerelease tag loses to the side without one; two
 * prerelease tags fall back to a plain string compare.
 */
function compareVersions(a, b) {
  const [coreA, preA = ''] = a.split('-', 2);
  const [coreB, preB = ''] = b.split('-', 2);
  const partsA = coreA.split('.').map((x) => parseInt(x, 10) || 0);
  const partsB = coreB.split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const valA = partsA[i] ?? 0;
    const valB = partsB[i] ?? 0;
    if (valA < valB) return -1;
    if (valA > valB) return 1;
  }
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA < preB) return -1;
  if (preA > preB) return 1;
  return 0;
}

async function fetchMarketplaceVersion(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = Array.isArray(data?.plugins)
      ? data.plugins.find((p) => p && p.name === 'mixshift-ai')
      : undefined;
    return entry && typeof entry.version === 'string' ? entry.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve "latest known version" (step 5). Returns null when there is no
 * fresh signal — either nothing cached and no fetch was due, a throttled
 * fetch attempt (tried within the last 24h, so we stay quiet this run), or
 * an outright fetch failure. On a successful fresh fetch, rewrites
 * version-check.json in the harness's EXACT cache schema so the harness
 * itself benefits from the refresh on its next invocation.
 */
async function resolveLatestVersion({ dataDir, state, now, markDirty }) {
  const vcPath = join(dataDir, VERSION_CHECK_FILENAME);
  const cached = await readJsonFile(vcPath);
  if (
    cached &&
    typeof cached.checked_at === 'string' &&
    typeof cached.latest_version === 'string' &&
    isFreshIso(cached.checked_at, now, DAY_MS)
  ) {
    return cached.latest_version;
  }

  // Absent or stale cache. Throttle fetch attempts to at most once per 24h
  // regardless of outcome, so an offline host doesn't retry every session.
  const lastAttempt = state.last_fetch_attempt_at;
  const attemptIsStale = !(
    typeof lastAttempt === 'string' &&
    lastAttempt &&
    isFreshIso(lastAttempt, now, DAY_MS)
  );
  if (!attemptIsStale) return null;

  state.last_fetch_attempt_at = new Date(now).toISOString();
  markDirty();

  const url = process.env.MIXSHIFT_VERSION_CHECK_URL || DEFAULT_MARKETPLACE_URL;
  const fetched = await fetchMarketplaceVersion(url, FETCH_TIMEOUT_MS);
  if (!fetched) return null;

  try {
    await writeJsonAtomic(vcPath, {
      checked_at: new Date(now).toISOString(),
      latest_version: fetched,
    });
  } catch {
    // Cache refresh is a bonus, not a requirement — we still have `fetched`.
  }
  return fetched;
}

// --- notice copy (steps 8-9) --------------------------------------------------

/** Customer-facing copy: no em dashes, never "cold start". */
function renderNotice(notice) {
  if (notice.kind === 'updated') {
    const { from, to, newerAvailable } = notice;
    if (newerAvailable) {
      return {
        systemMessage:
          `[mixshift-ai] Updated ${from} -> ${to}. A newer version (${newerAvailable}) ` +
          `is also available. Run "mixshift whatsnew" for what changed.`,
        additionalContext:
          `[mixshift-ai plugin] This install just updated from ${from} to ${to}. An even ` +
          `newer version (${newerAvailable}) is already available. At the START of your ` +
          `FIRST reply only, tell the user in one friendly sentence that the MixShift ` +
          `plugin updated (and mention the newer version available too) and offer to run ` +
          `"mixshift whatsnew" for a rundown of what is new and any recommended ` +
          `follow-ups. If they accept, run it via Bash and walk them through the output. ` +
          `If they decline or ignore it, drop the subject for the rest of the session. If ` +
          `they ask to stop being reminded, run "mixshift whatsnew --dismiss". Do not ` +
          `repeat this notice.`,
      };
    }
    return {
      systemMessage: `[mixshift-ai] Updated ${from} -> ${to}. Run "mixshift whatsnew" for what changed.`,
      additionalContext:
        `[mixshift-ai plugin] This install just updated from ${from} to ${to}. At the ` +
        `START of your FIRST reply only, tell the user in one friendly sentence that the ` +
        `MixShift plugin updated and offer to run "mixshift whatsnew" for a rundown of ` +
        `what is new and any recommended follow-ups. If they accept, run it via Bash and ` +
        `walk them through the output. If they decline or ignore it, drop the subject for ` +
        `the rest of the session. If they ask to stop being reminded, run "mixshift ` +
        `whatsnew --dismiss". Do not repeat this notice.`,
    };
  }
  const { current, latest } = notice;
  return {
    systemMessage: `[mixshift-ai] Update available: ${current} -> ${latest}. Run "mixshift version" for update steps.`,
    additionalContext:
      `[mixshift-ai plugin] This install is on version ${current}; version ${latest} is ` +
      `available. At the START of your FIRST reply only, tell the user in one friendly ` +
      `sentence that a MixShift plugin update is available and offer to run "mixshift ` +
      `version" for exact update steps for their setup. If they accept, run it via Bash ` +
      `and walk them through the output. If they decline or ignore it, drop the subject ` +
      `for the rest of the session. If they ask to stop being reminded, run "mixshift ` +
      `whatsnew --dismiss". Do not repeat this notice.`,
  };
}

// --- telemetry (step 10, best-effort, entirely optional) ---------------------

/** Extract the top-level YAML block starting at a `<key>:` line (no leading
 *  whitespace) through to (not including) the next line that starts at
 *  column 0. Good enough for our own generated profile.yaml /
 *  .mixshift-defaults.yaml — this hook has no YAML parser dependency, so
 *  every value below is pulled with plain regexes instead. */
function findTopLevelYamlBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const startRe = new RegExp(`^${key}:\\s*$`);
  const startIdx = lines.findIndex((l) => startRe.test(l));
  if (startIdx === -1) return null;
  const out = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Checks preconditions (a)-(c) in order, all silent-skip on failure. Returns
 * `{ installId }` when telemetry may fire, else null. Never invents an
 * install_id — no regex match means skip, full stop.
 */
async function resolveTelemetryPermission(dataDir, pluginRoot) {
  // (a) env kill switch
  const envVal = (process.env.MIXSHIFT_TELEMETRY ?? '').toLowerCase().trim();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(envVal)) return null;

  // (b) profile.yaml: exists, not opted out, has an install_id
  let profileText;
  try {
    profileText = await readFile(join(dataDir, 'profile.yaml'), 'utf-8');
  } catch {
    return null;
  }
  const profileTelemetry = findTopLevelYamlBlock(profileText, 'telemetry') ?? '';
  if (/^\s*opted_out:\s*true/m.test(profileTelemetry)) return null;
  const idMatch = profileTelemetry.match(/install_id:\s*["']?([A-Za-z0-9_-]+)/);
  if (!idMatch) return null;

  // (c) .mixshift-defaults.yaml: non-empty endpoint + apikey in its telemetry block
  let defaultsText;
  try {
    defaultsText = await readFile(join(pluginRoot, '.mixshift-defaults.yaml'), 'utf-8');
  } catch {
    return null;
  }
  const defaultsTelemetry = findTopLevelYamlBlock(defaultsText, 'telemetry') ?? '';
  const endpointMatch = defaultsTelemetry.match(/^\s*endpoint:\s*(\S.*)$/m);
  const apikeyMatch = defaultsTelemetry.match(/^\s*apikey:\s*(\S.*)$/m);
  if (!endpointMatch || !apikeyMatch) return null;
  if (!endpointMatch[1].trim() || !apikeyMatch[1].trim()) return null;

  return { installId: idMatch[1] };
}

/** Coarse hook-side approximation of harness/src/lib/telemetry/surface.ts's
 *  fuller detection chain (which also handles Cowork, claude_desktop,
 *  plugin_host_unknown, and a TTY/CI-aware CLI fallback). The hook only needs
 *  a best-effort label for one optional event, so we keep this intentionally
 *  simple rather than porting the whole detector chain into a zero-dependency
 *  script. */
function approximateSurface() {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude_desktop';
  if (process.env.CLAUDECODE) return 'claude_code';
  return 'cli';
}

function noticePayload(notice) {
  if (notice.kind === 'updated') {
    return {
      kind: 'updated',
      from: notice.from,
      to: notice.to,
      ...(notice.newerAvailable ? { latest: notice.newerAvailable } : {}),
      source: 'session-start-hook',
    };
  }
  return { kind: 'stale', latest: notice.latest, source: 'session-start-hook' };
}

async function maybeEmitTelemetry({ dataDir, pluginRoot, currentVersion, notice }) {
  try {
    const permission = await resolveTelemetryPermission(dataDir, pluginRoot);
    if (!permission) return;

    const record = {
      event_name: 'update.banner_shown',
      install_id: permission.installId,
      plugin_version: currentVersion,
      install_path: process.env.CLAUDE_PLUGIN_ROOT ? 'plugin-host' : 'cli',
      surface: approximateSurface(),
      os: `${platform()}-${release()}`,
      node_version: process.version,
      ts: new Date().toISOString(),
      payload: noticePayload(notice),
    };

    // Every field the events table requires must be present, or don't append
    // — a partial line would poison the harness's flush batch (PostgREST
    // 400s the whole batch on a key-set mismatch, PGRST102).
    const required = [
      'event_name',
      'install_id',
      'plugin_version',
      'install_path',
      'surface',
      'os',
      'node_version',
      'ts',
      'payload',
    ];
    for (const key of required) {
      if (record[key] === undefined || record[key] === null || record[key] === '') return;
    }

    const telemetryDir = join(dataDir, 'telemetry');
    await mkdir(telemetryDir, { recursive: true });
    await appendFile(join(telemetryDir, 'queue.jsonl'), JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Telemetry is best-effort and entirely optional — never let it surface.
  }
}

// --- orchestration -------------------------------------------------------------

async function runUpdateNoticeStage() {
  try {
    const pluginRoot =
      process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');

    // Step 1: resolve current version. Failure skips the entire stage.
    const currentVersion = readCurrentVersion(pluginRoot);
    if (!currentVersion) return;

    // Step 2: data dir (harness cache + telemetry queue always live here).
    const dataDir = resolve(process.env.MIXSHIFT_DATA_DIR ?? join(homedir(), '.mixshift'));
    // Step 3: state-file dir (plugin-host-provided data dir wins if set).
    const stateDir = process.env.CLAUDE_PLUGIN_DATA || dataDir;
    const statePath = join(stateDir, STATE_FILENAME);

    const state = await readState(statePath);
    let dirty = false;
    const markDirty = () => {
      dirty = true;
    };
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Step 4: "just updated" notice.
    const prevSeen = state.last_seen_version;
    let updatedNotice = null;
    if (typeof prevSeen === 'string' && prevSeen && prevSeen !== currentVersion) {
      updatedNotice = { from: prevSeen, to: currentVersion };
    }
    if (prevSeen !== currentVersion) {
      state.last_seen_version = currentVersion;
      dirty = true;
    }

    // Steps 5-6: staleness signal (throttled fetch + comparator).
    const latest = await resolveLatestVersion({ dataDir, state, now, markDirty });

    // Step 7: suppression -> does a stale notice apply this run?
    let staleApplies = false;
    if (latest && compareVersions(currentVersion, latest) < 0) {
      const dismissed = state.dismissed_version === latest;
      const recentlyShown =
        state.stale_notice &&
        state.stale_notice.version === latest &&
        isFreshIso(state.stale_notice.at, now, DAY_MS);
      if (!dismissed && !recentlyShown) staleApplies = true;
    }

    // Step 8: precedence — at most ONE notice.
    let notice = null;
    if (updatedNotice) {
      notice = { kind: 'updated', from: updatedNotice.from, to: updatedNotice.to };
      if (staleApplies) {
        notice.newerAvailable = latest;
        state.stale_notice = { version: latest, at: nowIso };
        dirty = true;
      }
    } else if (staleApplies) {
      notice = { kind: 'stale', current: currentVersion, latest };
      state.stale_notice = { version: latest, at: nowIso };
      dirty = true;
    }

    if (dirty) {
      try {
        await writeJsonAtomic(statePath, state);
      } catch {
        // Best-effort — worst case we re-notify sooner than intended next time.
      }
    }

    if (!notice) return; // nothing to show — print nothing, matches current behavior.

    // Step 9: single JSON object on stdout.
    const { systemMessage, additionalContext } = renderNotice(notice);
    process.stdout.write(
      JSON.stringify({
        systemMessage,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
      }) + '\n',
    );

    // Step 10: best-effort telemetry, entirely optional.
    await maybeEmitTelemetry({ dataDir, pluginRoot, currentVersion, notice });
  } catch {
    // Stage 2 must never break a session start.
  }
}

await runUpdateNoticeStage();
process.exit(0);
