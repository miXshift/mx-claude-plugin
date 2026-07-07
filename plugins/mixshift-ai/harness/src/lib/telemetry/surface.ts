/**
 * Surface detection — which client/runtime is invoking the harness.
 *
 * Telemetry tracks this as a top-level field on every event so analytics
 * can split usage by surface (Cowork vs Claude Code vs CLI), and the
 * Discord fan-out embeds include it.
 *
 * --------------------------------------------------------------------------
 * Why this is its own module
 * --------------------------------------------------------------------------
 * The set of surfaces grows over time. Today: cowork, claude_code,
 * claude_desktop, cli, cli_headless. Future: ChatGPT plugin, third-party LLM
 * hosts. Each adds a new detector. Keeping detection in a chain of detectors
 * (each returns a Surface or null; first non-null wins) makes adding a new
 * host one function instead of editing the call site.
 *
 * --------------------------------------------------------------------------
 * Two hosts share the Claude desktop app; neither sets a first-class signal
 * (2026-07-07 correction — supersedes the 2026-06-16 "Cowork-first" note)
 * --------------------------------------------------------------------------
 * Both Cowork and the Claude Code DESKTOP app run inside the Claude desktop
 * application, but from DIFFERENT payload substrates, and — as of 2026-07-07,
 * verified with real `mixshift telemetry surface` dumps from each — NEITHER
 * exposes a first-class "who am I" env var:
 *   - Claude Code DESKTOP app (win32): CLAUDECODE=1,
 *     CLAUDE_CODE_ENTRYPOINT=claude-desktop, payload under
 *     %APPDATA%/Claude/local-agent-mode-sessions/<...>/rpm/plugin_<id>/...
 *   - Cloud Cowork (linux): NO COWORK_*, NO CLAUDECODE, NO entrypoint; payload
 *     under /sessions/<id>/mnt/.remote-plugins/plugin_<id>/...
 *
 * The 2026-06-16 fix mistook the `local-agent-mode-sessions` marker for a
 * Cowork signal and mapped it to `cowork`. It is actually the DESKTOP APP
 * marker, so that fix inverted the two: CC-desktop sessions tagged `cowork`,
 * while real (cloud) Cowork — which carries no marker and no env — fell
 * through to the `cli_headless` fallback (and got dropped by the beta
 * dashboard filter). Corrected here:
 *   - `local-agent-mode-sessions` (or CLAUDE_CODE_ENTRYPOINT=claude-desktop) →
 *     `claude_desktop` (detectClaudeCode).
 *   - `/sessions/.../.remote-plugins/` → `cowork` (detectCowork), but ONLY when no
 *     Claude Code engine signal (CLAUDECODE etc.) is present: remote/cloud Claude Code
 *     shares the same /sessions substrate yet sets CLAUDECODE=1, so it stays
 *     `claude_code`. The path match is ANCHORED (needs a `/sessions/` segment AND a
 *     `.remote-plugins` path segment), not a bare substring. Durable fix is upstream —
 *     Cowork should set a COWORK_* env var (checked first, before any path heuristic).
 *
 * --------------------------------------------------------------------------
 * Detection precedence
 * --------------------------------------------------------------------------
 *   1. `MIXSHIFT_SURFACE` env var override (testing / debugging escape hatch)
 *   2. `--surface <name>` CLI flag (set by wrappers that know who they are)
 *   3. Env/path detection: Cowork (COWORK_* env OR /sessions/.remote-plugins
 *      payload marker) → Claude Code / Claude Desktop (claude-desktop
 *      entrypoint or local-agent-mode-sessions marker → claude_desktop;
 *      CLAUDECODE otherwise → claude_code) → plugin_host_unknown
 *      (CLAUDE_PLUGIN_ROOT set, no other signal)
 *   4. Fallback (no host signal): `cli` when an interactive TTY is attached,
 *      else `cli_headless` (a CI env var is set, or no TTY — CI, test rigs,
 *      piped automation, or a host session that lost its env). Splitting these
 *      keeps real human terminal use distinct from headless noise that would
 *      otherwise masquerade as direct CLI usage.
 */

import { fileURLToPath } from 'node:url';

/**
 * Canonical surface identifiers. Extend this union when adding a new host.
 * Snake_case to match telemetry-field conventions.
 */
export type Surface =
  | 'cowork'
  | 'claude_code'
  | 'plugin_host_unknown'
  | 'cli'
  // Direct CLI in a non-interactive context: CI, test rig, piped automation, or
  // a host session that lost its env. Split from `cli` (interactive human
  // terminal) so headless noise doesn't masquerade as real direct usage.
  | 'cli_headless'
  // Future surfaces — keep documented so analytics can pre-bucket:
  | 'chatgpt'
  | 'claude_desktop'
  | 'other';

/**
 * Diagnostic snapshot returned by {@link probeSurface}. Captures the resolved
 * surface AND every raw signal the decision was made from, so we can inspect
 * what a real host actually exposes at emit time instead of inferring it.
 */
export interface SurfaceProbe {
  /** What detectSurface() resolves to right now — the value stamped on every
   *  telemetry event emitted by this process. */
  result: Surface;
  /** Which precedence rule produced `result`. `fallback` means no host marker
   *  matched and detection resolved `cli` / `cli_headless` by interactivity. */
  decidedBy:
    | 'env_override'
    | 'flag'
    | 'cowork'
    | 'claude_code'
    | 'claude_desktop'
    | 'plugin_host_unknown'
    | 'fallback';
  /** Raw env signals the detectors read. `undefined` = variable not set. */
  env: {
    MIXSHIFT_SURFACE?: string;
    COWORK?: string;
    COWORK_VERSION?: string;
    COWORK_PLUGIN_HOST?: string;
    CLAUDECODE?: string;
    CLAUDE_CODE?: string;
    CLAUDE_CODE_ENTRYPOINT?: string;
    CLAUDE_CODE_VERSION?: string;
    CLAUDE_PLUGIN_ROOT?: string;
  };
  /** The `--surface` flag value detection saw (undefined when not passed). */
  flag?: string;
  /** Paths checked for the payload-path markers: CLAUDE_PLUGIN_ROOT, argv[1],
   *  and this module's own path. */
  runtimePaths: string[];
  /** The cloud-Cowork payload marker (`.remote-plugins`) searched for in
   *  `runtimePaths`. */
  coworkMarker: string;
  /** Whether `coworkMarker` (cloud Cowork) appears in any `runtimePaths` entry. */
  coworkMarkerPresent: boolean;
  /** The Claude-desktop-app payload marker (`local-agent-mode-sessions`) searched
   *  for in `runtimePaths`. */
  desktopMarker: string;
  /** Whether `desktopMarker` (Claude desktop app) appears in any `runtimePaths` entry. */
  desktopMarkerPresent: boolean;
  /** Whether an interactive TTY is attached (stdout or stderr). At the
   *  fallback this picks `cli` (true) vs `cli_headless` (false). */
  tty: boolean;
  /** Whether a CI/automation env var is set. Forces `cli_headless` at the
   *  fallback even if a TTY happens to be attached. */
  ci: boolean;
}

const ENV_VAR_OVERRIDE = 'MIXSHIFT_SURFACE';

/**
 * Resolve the current surface. `flagValue` is the value from the CLI's
 * top-level `--surface` flag (when present). Falls back to env-based
 * detection and finally to 'cli'.
 *
 * Safe to call multiple times; pure over its inputs (env, argv, module path).
 */
export function detectSurface(flagValue?: string | undefined): Surface {
  return probeSurface(flagValue).result;
}

/**
 * Diagnostic counterpart of {@link detectSurface}: returns the resolved
 * surface, which precedence rule decided it, and every raw signal that fed the
 * decision. detectSurface() delegates to this, so the probe can NEVER drift
 * from the real decision.
 *
 * Surfaced via `mixshift telemetry surface` so we can capture GROUND TRUTH from
 * inside a real host — which markers actually reach the harness at emit time —
 * instead of guessing. (Guessing is the trap the 2026-06-16 path-marker fix
 * fell into: it shipped on an *assumed* Cowork payload path that was never
 * verified against a live env dump.)
 */
export function probeSurface(flagValue?: string | undefined): SurfaceProbe {
  const env: SurfaceProbe['env'] = {
    MIXSHIFT_SURFACE: process.env[ENV_VAR_OVERRIDE],
    COWORK: process.env.COWORK,
    COWORK_VERSION: process.env.COWORK_VERSION,
    COWORK_PLUGIN_HOST: process.env.COWORK_PLUGIN_HOST,
    CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE: process.env.CLAUDE_CODE,
    CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_CODE_VERSION: process.env.CLAUDE_CODE_VERSION,
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  };
  const paths = runtimePaths();
  const lowerPaths = paths.map((p) => p.toLowerCase());
  const coworkMarkerPresent = isCloudCoworkPath();
  const desktopMarkerPresent = lowerPaths.some((p) => p.includes(CLAUDE_DESKTOP_MARKER));
  const ci = isCiEnv();
  const tty = hasInteractiveTty();
  const base = {
    env,
    flag: flagValue,
    runtimePaths: paths,
    coworkMarker: COWORK_CLOUD_MARKER,
    coworkMarkerPresent,
    desktopMarker: CLAUDE_DESKTOP_MARKER,
    desktopMarkerPresent,
    tty,
    ci,
  };

  // Mirror detectSurface precedence EXACTLY — this loop IS the decision.
  // 1. Env override — debugging / testing escape hatch
  const envOverride = process.env[ENV_VAR_OVERRIDE];
  if (envOverride && isKnownSurface(envOverride)) {
    return { ...base, result: envOverride as Surface, decidedBy: 'env_override' };
  }
  // 2. Flag value from CLI
  if (flagValue && isKnownSurface(flagValue)) {
    return { ...base, result: flagValue as Surface, decidedBy: 'flag' };
  }
  // 3. Env-based detection (try each detector in order). decidedBy reports the
  // RESOLVED surface (detectClaudeCode can resolve claude_desktop, not just claude_code).
  for (const d of detectors) {
    const result = d.detect();
    if (result !== null) return { ...base, result, decidedBy: result };
  }
  // 4. Fallback (no host signal). Split interactive human terminal use (`cli`)
  // from headless contexts — CI, test rigs, piped automation, or a host session
  // that lost its env (`cli_headless`) — so the latter stops masquerading as
  // direct CLI usage in analytics.
  return {
    ...base,
    result: ci || !tty ? 'cli_headless' : 'cli',
    decidedBy: 'fallback',
  };
}

// ---------------------------------------------------------------------------
// Detectors — each returns a Surface or null
// ---------------------------------------------------------------------------

/** Surfaces a detector can positively resolve. The fallback (`cli`/`cli_headless`) and
 *  the reserved `chatgpt`/`other` are never produced by a detector, so `decidedBy` can
 *  faithfully mirror a detector result. */
type DetectorSurface = 'cowork' | 'claude_code' | 'claude_desktop' | 'plugin_host_unknown';

type Detector = () => DetectorSurface | null;

/**
 * The Claude *desktop* app materializes plugins under
 * `%APPDATA%/Claude/local-agent-mode-sessions/…`. This marks the DESKTOP APP, NOT
 * Cowork — the 2026-06-16 fix mistook it for Cowork and inverted the two (see the
 * module header). Consumed by detectClaudeCode → `claude_desktop`.
 */
const CLAUDE_DESKTOP_MARKER = 'local-agent-mode-sessions';

/** Human-readable description of the cloud-Cowork path shape — for the probe display
 *  only; the actual match is the anchored {@link isCloudCoworkPath}. */
const COWORK_CLOUD_MARKER = '/sessions/…/.remote-plugins/ (anchored)';

/**
 * Whether a runtime path looks like the cloud-Cowork payload
 * (`/sessions/<id>/mnt/.remote-plugins/…`, verified via a real Cowork
 * `mixshift telemetry surface` dump 2026-07-07). ANCHORED on purpose: a path must
 * contain BOTH the `/sessions/` cloud-session segment AND a `.remote-plugins` PATH
 * SEGMENT — not a bare `.remote-plugins` substring — so a local dir that merely
 * contains those characters (e.g. `foo.remote-plugins-old`, `my.remote-plugins.txt`)
 * cannot false-match. INTERIM: the `/sessions` cloud substrate is shared with
 * remote/cloud Claude Code, which is why detectCowork gates this on the ABSENCE of a
 * Claude Code engine signal. The durable signal is a first-class COWORK_* env var.
 */
function isCloudCoworkPath(): boolean {
  return runtimePaths().some((p) => {
    const s = p.toLowerCase().replace(/\\/g, '/');
    return s.includes('/sessions/') && /(^|\/)\.remote-plugins(\/|$)/.test(s);
  });
}

/**
 * True when the process carries ANY Claude Code engine signal. Real cloud Cowork
 * carries NONE (no CLAUDECODE, no entrypoint), so this is how we keep remote/cloud
 * Claude Code — which sets CLAUDECODE=1 and shares the `/sessions/.remote-plugins`
 * substrate — OUT of the Cowork bucket.
 */
function hasClaudeCodeEngineEnv(): boolean {
  return (
    process.env.CLAUDECODE === '1' ||
    process.env.CLAUDE_CODE === '1' ||
    Boolean(process.env.CLAUDE_CODE_ENTRYPOINT) ||
    Boolean(process.env.CLAUDE_CODE_VERSION)
  );
}

/**
 * Cowork. Detected by an explicit COWORK_* env var (forward-compatible; not set by
 * Cowork today), else by the anchored cloud payload path — but ONLY when no Claude
 * Code engine signal is present, so a CLAUDECODE-bearing remote/cloud Claude Code
 * session on the shared /sessions substrate is NOT mislabeled `cowork`. Runs before
 * detectClaudeCode (an explicit COWORK_* must win); the path rule cannot mis-fire on
 * Claude Code because of the engine-env gate.
 */
function detectCowork(): DetectorSurface | null {
  if (process.env.COWORK === '1') return 'cowork';
  if (process.env.COWORK_VERSION) return 'cowork';
  if (process.env.COWORK_PLUGIN_HOST) return 'cowork';
  if (!hasClaudeCodeEngineEnv() && isCloudCoworkPath()) {
    return 'cowork';
  }
  return null;
}

/**
 * Paths that reveal where the plugin payload lives / runs from. Checked for the
 * host payload-path markers (`.remote-plugins` → cloud Cowork;
 * `local-agent-mode-sessions` → Claude desktop app). Several are checked because
 * which is populated varies by host and by how the CLI was launched:
 *   - CLAUDE_PLUGIN_ROOT: set by plugin hosts to the install dir.
 *   - process.argv[1]: the invoked cli.js path.
 *   - import.meta.url: this module's own location (bundled into cli.js).
 */
function runtimePaths(): string[] {
  const paths: string[] = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) paths.push(process.env.CLAUDE_PLUGIN_ROOT);
  if (process.argv[1]) paths.push(process.argv[1]);
  try {
    paths.push(fileURLToPath(import.meta.url));
  } catch {
    // import.meta.url not a file: URL in some runtimes — skip it.
  }
  return paths;
}

/**
 * Claude Code, split into the DESKTOP app (`claude_desktop`) and terminal/other
 * Claude Code (`claude_code`). The desktop app is identified by
 * CLAUDE_CODE_ENTRYPOINT=claude-desktop, or — as a subprocess-safe fallback — by
 * its `local-agent-mode-sessions` payload-path marker; both are checked before the
 * generic CLAUDECODE branch so a desktop session never collapses to `claude_code`.
 * Cloud Cowork carries none of these (and is caught earlier by detectCowork).
 */
function detectClaudeCode(): DetectorSurface | null {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude_desktop';
  if (runtimePaths().some((p) => p.toLowerCase().includes(CLAUDE_DESKTOP_MARKER))) {
    return 'claude_desktop';
  }
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE === '1') {
    return 'claude_code';
  }
  if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_VERSION) {
    return 'claude_code';
  }
  return null;
}

/**
 * Plugin runtime detected (CLAUDE_PLUGIN_ROOT set) but neither Cowork nor
 * Claude Code signals fired. Mark as plugin_host_unknown so analytics can
 * surface "we couldn't tell" without conflating with direct-CLI usage.
 *
 * When this fires, the next session's detection should be improved by adding
 * signals to detectClaudeCode/detectCowork above.
 */
function detectPluginHostUnknown(): DetectorSurface | null {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'plugin_host_unknown';
  return null;
}

// ---------------------------------------------------------------------------
// Bare-CLI fallback classifiers — only consulted when no host signal matched.
// They split the fallback into `cli` (interactive human terminal) vs
// `cli_headless` (CI / test rig / piped automation / host that lost its env).
// ---------------------------------------------------------------------------

/**
 * CI / automation environment markers. Any one set means this invocation is
 * almost certainly not a human at an interactive terminal — so the bare-CLI
 * fallback should resolve `cli_headless`, not `cli`. `CI` alone covers most
 * providers (GitHub Actions, GitLab, CircleCI, Travis, …); the rest are
 * belt-and-suspenders for providers that don't set it.
 */
function isCiEnv(): boolean {
  return Boolean(
    process.env.CI ||
      process.env.CONTINUOUS_INTEGRATION ||
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.BUILDKITE ||
      process.env.CIRCLECI ||
      process.env.JENKINS_URL ||
      process.env.TEAMCITY_VERSION ||
      process.env.TF_BUILD,
  );
}

/**
 * Whether an interactive terminal is attached. Checks stdout AND stderr so
 * `mixshift … | grep` (stdout piped, stderr still a TTY) still reads as
 * interactive human use. Headless contexts (CI, fully redirected, test rigs,
 * a Bash-tool subprocess that lost CLAUDECODE) have neither.
 */
function hasInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

/**
 * Ordered detector chain; first non-null wins. The probe's `decidedBy` reports the
 * RESOLVED surface (not the entry `name`), so detectClaudeCode resolving `claude_desktop`
 * reads as `decidedBy: claude_desktop`. Order matters — see header.
 */
const detectors: ReadonlyArray<{
  name: 'cowork' | 'claude_code' | 'plugin_host_unknown';
  detect: Detector;
}> = [
  // Cowork first so an explicit COWORK_* env wins; its cloud-path rule is gated on the
  // ABSENCE of a Claude Code engine signal, so remote/cloud Claude Code (CLAUDECODE=1 on
  // the same /sessions substrate) falls through to detectClaudeCode instead of cowork.
  { name: 'cowork', detect: detectCowork },
  { name: 'claude_code', detect: detectClaudeCode },
  { name: 'plugin_host_unknown', detect: detectPluginHostUnknown },
];

// ---------------------------------------------------------------------------
// Type-guard
// ---------------------------------------------------------------------------

const KNOWN_SURFACES = new Set<string>([
  'cowork',
  'claude_code',
  'plugin_host_unknown',
  'cli',
  'cli_headless',
  'chatgpt',
  'claude_desktop',
  'other',
]);

function isKnownSurface(s: string): boolean {
  return KNOWN_SURFACES.has(s);
}
