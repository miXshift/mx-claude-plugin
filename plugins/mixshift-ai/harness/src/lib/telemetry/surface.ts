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

const ENV_VAR_OVERRIDE = 'MIXSHIFT_SURFACE';

/**
 * Resolve the current surface. `flagValue` is the value from the CLI's
 * top-level `--surface` flag (when present). Falls back to env-based
 * detection and finally to 'cli'.
 *
 * Safe to call multiple times; pure over its inputs (env, argv, module path).
 */
export function detectSurface(flagValue?: string | undefined): Surface {
  // 1. Env override — debugging / testing escape hatch
  const envOverride = process.env[ENV_VAR_OVERRIDE];
  if (envOverride && isKnownSurface(envOverride)) {
    return envOverride as Surface;
  }

  // 2. Flag value from CLI
  if (flagValue && isKnownSurface(flagValue)) {
    return flagValue as Surface;
  }

  // 3. Env-based detection (try each detector in order)
  for (const detector of detectors) {
    const result = detector();
    if (result !== null) return result;
  }

  // 4. Fallback
  return 'cli';
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

const detectors: Detector[] = [
  detectCowork, // MUST be first — Cowork also sets CLAUDECODE (embeds CC engine).
  detectClaudeCode,
  detectPluginHostUnknown,
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
