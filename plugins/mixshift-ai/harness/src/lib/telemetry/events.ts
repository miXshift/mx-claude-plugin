/**
 * Typed event definitions.
 *
 * Each event is an object with `event_name` (the discriminator) plus a
 * payload that varies per event type. We lift commonly-queried fields to
 * top level (skill_id, query_id, query_table, duration_ms, outcome, etc.)
 * for easier dashboarding; everything else lives in `payload`.
 *
 * Event names use dot-separated namespaces: `plugin.installed`, `auth.completed`,
 * `query.executed`, etc. New events: add to the union and document below.
 */

export type Outcome = 'ok' | 'failed' | 'timeout' | 'deferred' | 'skipped';

/**
 * Server-side representation. The client adds install_id, plugin_version,
 * etc. before insertion — those fields aren't part of the event factories.
 */
export interface TelemetryEventRecord {
  event_name: string;
  install_id: string;
  email?: string;
  plugin_version: string;
  install_path: string;
  /** Which runtime/host is invoking the harness. See lib/telemetry/surface.ts.
   *  Values: cowork | claude_code | plugin_host_unknown | cli | chatgpt |
   *  claude_desktop | other. Evolves as new LLM hosts are added. */
  surface: string;
  os: string;
  node_version: string;
  ts: string; // ISO timestamp set client-side at queue time
  payload: Record<string, unknown>;
  // Lifted fields for queryability:
  skill_id?: string;
  duration_ms?: number;
  outcome?: Outcome;
  query_id?: string;
  query_table?: string;
  row_count?: number;
  error_class?: string;
  trigger_phrase?: string;
}

/**
 * What callers pass to `track(...)`. The client fills in the rest.
 */
export interface TrackInput {
  event_name: string;
  /** Free-form payload — anything not captured by the lifted fields below. */
  payload?: Record<string, unknown>;
  // Lifted optional fields:
  skill_id?: string;
  duration_ms?: number;
  outcome?: Outcome;
  query_id?: string;
  query_table?: string;
  row_count?: number;
  error_class?: string;
  trigger_phrase?: string;
  /** When the event mentions a user identity (email), set this for downstream linkage. */
  email?: string;
}

// -----------------------------------------------------------------------
// Event-name catalog (for IDE autocomplete + lint)
// -----------------------------------------------------------------------

export const EventName = {
  // Lifecycle
  PluginInstalled: 'plugin.installed',
  PluginUpdated: 'plugin.updated',
  PluginCrashed: 'plugin.crashed',
  CliCommandRun: 'cli.command_run',

  // Onboarding
  WelcomeViewed: 'welcome.viewed',
  ConsentAcknowledged: 'consent.acknowledged',
  AuthStarted: 'auth.started',
  AuthCompleted: 'auth.completed',
  AuthFailed: 'auth.failed',
  AuthConnectionTested: 'auth.connection_tested',
  UserIdentified: 'user.identified',
  IpWhitelistRequested: 'ip_whitelist.requested',

  // Brand context
  BrandDiscovered: 'brand.discovered',
  BrandAdded: 'brand.added',
  // Brand config editor (mixshift brand config <slug>)
  BrandConfigViewed: 'brand_config.viewed',
  BrandConfigEdited: 'brand_config.edited',

  // Skill + query
  SkillInvoked: 'skill.invoked',
  SkillCompleted: 'skill.completed',
  SkillTriggerPhraseMatched: 'skill.trigger_phrase_matched',
  QueryExecuted: 'query.executed',
  QueryFailed: 'query.failed',
  PrefetchStarted: 'skill.prefetch_started',
  PrefetchCompleted: 'skill.prefetch_completed',
  SidecarWritten: 'skill.sidecar_written',

  // OCL (Objective Level Configuration) — confirm-on-run flow
  SkillCalibrationConfirmed: 'skill.calibration_confirmed',
  SkillCalibrationEdited: 'skill.calibration_edited',
  SkillCalibrationReset: 'skill.calibration_reset',

  // Apply gate (dry-run today; flips to real writes when MCP/API lands)
  SkillApplyAttempted: 'skill.apply_attempted',
  SkillApplied: 'skill.applied',

  // Feedback
  FeedbackSubmitted: 'feedback.submitted',
  FeedbackDetectedImplicit: 'feedback.detected_implicit',
  TableAccessRequested: 'table_access.requested',

  // Chat-surface signals (fired from SKILL.md by Claude, not the harness)
  WarmStartServed: 'warm_start.served',
} as const;

export type EventNameValue = (typeof EventName)[keyof typeof EventName];
