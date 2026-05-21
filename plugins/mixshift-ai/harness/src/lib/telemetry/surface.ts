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
 * Detection precedence
 * --------------------------------------------------------------------------
 *   1. `MIXSHIFT_SURFACE` env var override (testing / debugging escape hatch)
 *   2. `--surface <name>` CLI flag (set by wrappers that know who they are)
 *   3. Env-based detection (CLAUDECODE → claude_code, etc.)
 *   4. CLAUDE_PLUGIN_ROOT present without specific signal → plugin_host_unknown
 *   5. Fallback → cli
 */

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
 * Safe to call multiple times; pure function over its inputs.
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

/**
 * Claude Code sets CLAUDECODE=1 in the harness environment.
 * (And often CLAUDE_CODE_ENTRYPOINT or CLAUDE_CODE_VERSION.)
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
 * Cowork's desktop runtime — env signals we know about. Update this as
 * Cowork stabilizes its env-var contract. For now: if CLAUDE_PLUGIN_ROOT
 * is set AND we don't see Claude Code signals, AND we see a likely-Cowork
 * marker, return 'cowork'. Otherwise fall through.
 *
 * Known signals (verify during E2E testing — Sam, this is the part to
 * validate; the env-var names may need updating):
 *   - COWORK=1
 *   - COWORK_VERSION
 *   - COWORK_PLUGIN_HOST
 */
function detectCowork(): Surface | null {
  if (process.env.COWORK === '1') return 'cowork';
  if (process.env.COWORK_VERSION) return 'cowork';
  if (process.env.COWORK_PLUGIN_HOST) return 'cowork';
  return null;
}

/**
 * Plugin runtime detected (CLAUDE_PLUGIN_ROOT set) but neither Cowork nor
 * Claude Code signals fired. Mark as plugin_host_unknown so analytics can
 * surface "we couldn't tell" without conflating with direct-CLI usage.
 *
 * When this fires, the next session's detection should be improved by
 * adding signals to detectClaudeCode/detectCowork above.
 */
function detectPluginHostUnknown(): Surface | null {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'plugin_host_unknown';
  return null;
}

const detectors: Detector[] = [
  detectClaudeCode,
  detectCowork,
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
