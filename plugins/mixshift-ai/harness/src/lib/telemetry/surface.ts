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
 * The set of surfaces grows over time. Today: cowork, claude_code, cli.
 * Future: ChatGPT plugin, Claude Desktop, third-party LLM hosts. Each adds
 * a new detector. Keeping detection in a chain of detectors (each returns
 * a Surface or null; first non-null wins) makes adding a new host one
 * function instead of editing the call site.
 *
 * --------------------------------------------------------------------------
 * Cowork MUST be detected before Claude Code (2026-06-16 fix)
 * --------------------------------------------------------------------------
 * Cowork embeds the Claude Code engine, so a Cowork session ALSO sets
 * CLAUDECODE=1. The original detector order ran detectClaudeCode first, so
 * every Cowork session mis-tagged as `claude_code` and detectCowork never
 * ran — a month of telemetry had ZERO `cowork` events despite heavy Cowork
 * testing. Fix: run detectCowork first, with a signal that's present even
 * when CLAUDECODE is set. The Cowork desktop host materializes and runs the
 * plugin payload from
 *   %APPDATA%/Claude/local-agent-mode-sessions/<...>/rpm/plugin_<id>/...
 * so the `local-agent-mode-sessions` marker appears in the plugin root AND in
 * the running harness's own path. Claude Code's plugin path lives under
 * ~/.claude/plugins/ and never contains that marker, so it discriminates the
 * two cleanly. (Verified against this machine's Cowork payload path
 * 2026-06-16; the explicit COWORK_* env vars below are kept as
 * forward-compatible signals but are not currently set by Cowork. If a real
 * Cowork env dump later reveals a first-class env signal, prefer it and keep
 * the path check as the fallback.)
 *
 * --------------------------------------------------------------------------
 * Detection precedence
 * --------------------------------------------------------------------------
 *   1. `MIXSHIFT_SURFACE` env var override (testing / debugging escape hatch)
 *   2. `--surface <name>` CLI flag (set by wrappers that know who they are)
 *   3. Env/path detection: Cowork (COWORK_* env OR payload-path marker) →
 *      Claude Code (CLAUDECODE) → plugin_host_unknown (CLAUDE_PLUGIN_ROOT set,
 *      no other signal)
 *   4. Fallback → cli
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
   *  matched and detection defaulted to `cli`. */
  decidedBy:
    | 'env_override'
    | 'flag'
    | 'cowork'
    | 'claude_code'
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
  /** Paths checked for the Cowork payload marker: CLAUDE_PLUGIN_ROOT, argv[1],
   *  and this module's own path. */
  runtimePaths: string[];
  /** The marker string searched for in `runtimePaths`. */
  coworkMarker: string;
  /** Whether `coworkMarker` appears in any `runtimePaths` entry. */
  coworkMarkerPresent: boolean;
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
  const coworkMarkerPresent = paths.some((p) =>
    p.toLowerCase().includes(COWORK_PATH_MARKER),
  );
  const base = {
    env,
    flag: flagValue,
    runtimePaths: paths,
    coworkMarker: COWORK_PATH_MARKER,
    coworkMarkerPresent,
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
  // 3. Env-based detection (try each detector in order)
  for (const d of detectors) {
    const result = d.detect();
    if (result !== null) return { ...base, result, decidedBy: d.name };
  }
  // 4. Fallback
  return { ...base, result: 'cli', decidedBy: 'fallback' };
}

// ---------------------------------------------------------------------------
// Detectors — each returns a Surface or null
// ---------------------------------------------------------------------------

type Detector = () => Surface | null;

/** Marker in every Cowork plugin-payload path; see the module header. */
const COWORK_PATH_MARKER = 'local-agent-mode-sessions';

/**
 * Cowork's desktop runtime. Detected by either an explicit COWORK_* env var
 * (forward-compatible; not currently set by Cowork) OR the payload-path
 * marker, which is present even though Cowork also sets CLAUDECODE=1 (it
 * embeds the Claude Code engine). MUST run before detectClaudeCode — see the
 * module header for the mis-tagging bug this fixes.
 */
function detectCowork(): Surface | null {
  if (process.env.COWORK === '1') return 'cowork';
  if (process.env.COWORK_VERSION) return 'cowork';
  if (process.env.COWORK_PLUGIN_HOST) return 'cowork';
  if (runtimePaths().some((p) => p.toLowerCase().includes(COWORK_PATH_MARKER))) {
    return 'cowork';
  }
  return null;
}

/**
 * Paths that reveal where the plugin payload lives / runs from. Any one
 * containing COWORK_PATH_MARKER means we're inside a Cowork session. Several
 * are checked because which is populated varies by host and by how the CLI
 * was launched:
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
 * Claude Code sets CLAUDECODE=1 (and often CLAUDE_CODE_ENTRYPOINT or
 * CLAUDE_CODE_VERSION). NOTE: Cowork sets CLAUDECODE too because it embeds the
 * CC engine, so detectCowork runs BEFORE this — this detector only fires for a
 * genuine Claude Code session (one with no Cowork payload-path marker).
 */
function detectClaudeCode(): Surface | null {
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
function detectPluginHostUnknown(): Surface | null {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'plugin_host_unknown';
  return null;
}

/**
 * Ordered detector chain. Each entry's `name` is reported as `decidedBy` in
 * the surface probe when that detector fires. Order matters — see header.
 */
const detectors: ReadonlyArray<{
  name: 'cowork' | 'claude_code' | 'plugin_host_unknown';
  detect: Detector;
}> = [
  // MUST be first — Cowork also sets CLAUDECODE (embeds the CC engine).
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
  'chatgpt',
  'claude_desktop',
  'other',
]);

function isKnownSurface(s: string): boolean {
  return KNOWN_SURFACES.has(s);
}
