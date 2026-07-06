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
  /** Self-attested per-employee actor email. Distinct from `email`
   *  (which is the tenant's shared MySQL login). Populated on datahub
   *  flow events (auth.login_completed, query.*, etc.) and absent on
   *  events that pre-date a successful `mixshift auth login`. */
  person_label?: string;
  plugin_version: string;
  install_path: string;
  /** Which runtime/host is invoking the harness. See lib/telemetry/surface.ts.
   *  Values: cowork | claude_code | plugin_host_unknown | cli | cli_headless |
   *  chatgpt | claude_desktop | other. Evolves as new LLM hosts are added. */
  surface: string;
  os: string;
  node_version: string;
  /** Self-reported CLI/runtime UA string. The events table has always had a
   *  user_agent column; the client began populating it in the beta-richness
   *  pass (feedback #10). Absent on queue entries written before that. */
  user_agent?: string;
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
  /** Self-attested per-employee actor email (datahub flow). See
   *  TelemetryEventRecord.person_label for semantics. */
  person_label?: string;
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
  /** Token-based login (PKCE or device-code) against mx-legacy-auth. */
  AuthLoginCompleted: 'auth.login_completed',
  /** /auth/refresh returned a non-success status (401 = replay revocation,
   *  others = transient / unexpected). Emitted from getValidAccessToken. */
  AuthRefreshFailed: 'auth.refresh_failed',
  UserIdentified: 'user.identified',
  IpWhitelistRequested: 'ip_whitelist.requested',

  // Brand context
  BrandDiscovered: 'brand.discovered',
  BrandAdded: 'brand.added',
  // Brand config editor (mixshift brand config <slug>)
  BrandConfigViewed: 'brand_config.viewed',
  BrandConfigEdited: 'brand_config.edited',
  // Brand Brain Tier-2 background discovery (lib/brain/fetch.ts +
  // `mixshift brand brain fetch`). Privacy: payloads carry slug, row
  // counts, duration, dispatch path; never seller row contents.
  BrainFetchStarted: 'brain.fetch_started',
  BrainFetchCompleted: 'brain.fetch_completed',
  BrainFetchFailed: 'brain.fetch_failed',
  BrainFetchSkipped: 'brain.fetch_skipped',

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

  // Help hub (`mixshift guide` + mx-help skill). No payload privacy concerns —
  // help.viewed carries only format + auth-ready + an uncatalogued-skill count.
  HelpViewed: 'help.viewed',

  // User-contributed skills (`mixshift share-skill` + mx-share-skill skill).
  // Privacy: skill.shared carries only the contributor-authored artifact's
  // METADATA (name, description, file count, byte size, sha). The full skill
  // bytes go to the dedicated skill_submissions table, never this event (which
  // fans out to Discord, where embed fields cap at 1024 chars).
  SkillShared: 'skill.shared',

  // Amazon SP-API on-demand reports (lib/amazon/reports.ts + `mixshift amazon`).
  // Privacy: these capture report_type + duration + outcome only — NEVER the
  // document bytes (which can contain order/customer rows) and never the
  // amazonSellerId in a way that leaks customer identity beyond what auth.*
  // already links.
  AmazonMerchantsListed: 'amazon.merchants_listed',
  ReportStarted: 'report.started',
  ReportPolled: 'report.polled',
  ReportRetrieved: 'report.retrieved',
  ReportFailed: 'report.failed',
  // Emitted at most ONCE per `report run` when Amazon rate-limited one or more
  // status polls but the run kept going (backoff-and-retry) rather than failing.
  // Split out from report.failed so a throttle absorbed mid-poll is not counted
  // as a failed pull (a single slow pull used to log many report.failed rows,
  // which skewed the error-aggregate triage). payload: {report_type,
  // throttled_polls, via}. Internal diagnostic only — not in the Discord fanout.
  ReportPollThrottled: 'report.poll_throttled',

  // Service-credential setup (`mixshift auth service-setup`). Fired after
  // the service block is persisted so a fresh data dir's synthetic
  // plugin.installed event attributes to the svc: label instead of landing
  // as an anonymous install. payload: {label, verified, via}.
  AuthServiceSetupCompleted: 'auth.service_setup_completed',

  // Amazon SP-API Pricing batch endpoints (lib/amazon/pricing.ts +
  // `mixshift amazon pricing`). Privacy: capture operation + item counts +
  // duration + outcome — never the responses payload (which carries seller
  // pricing data).
  AmazonPricingStarted: 'amazon.pricing.started',
  AmazonPricingPolled: 'amazon.pricing.polled',
  AmazonPricingRetrieved: 'amazon.pricing.retrieved',
  AmazonPricingFailed: 'amazon.pricing.failed',

  // Generic SP-API call surface (lib/amazon/spapi-call.ts + `mixshift amazon
  // operations|call`). Privacy: capture operation id + duration + outcome
  // only — never the payload (it carries seller-level business data).
  AmazonSpApiOperationsListed: 'amazon.spapi.operations_listed',
  AmazonSpApiCalled: 'amazon.spapi.called',

  // Amazon Ads API call surface (lib/amazon/ads-call.ts + `mixshift ads`).
  // Same privacy rule: operation id + duration + outcome only — never the
  // payload (campaign/keyword/bid data is seller-level business data).
  AdsProfilesListed: 'ads.profiles_listed',
  AdsOperationsListed: 'ads.operations_listed',
  AdsCalled: 'ads.called',

  // Org-shared brand context sync (lib/context-sync/ + `mixshift context`).
  // Privacy: payloads carry brand slugs, per-action doc counts, force flag,
  // duration + outcome — never doc content or file paths.
  ContextPullCompleted: 'context_sync.pull_completed',
  ContextPushCompleted: 'context_sync.push_completed',
  ContextSyncCompleted: 'context_sync.sync_completed',
  ContextMigrateCompleted: 'context_sync.migrate_completed',
  // Manual `mixshift context autosync <brand>` runs only — the implicit
  // preflight hook inside resolveBrandFields stays silent by design (it
  // fires on every skill step; telemetry there would be noise).
  ContextAutosyncCompleted: 'context_sync.autosync_completed',

  // Brand timeline (lib/timeline/ + `mixshift timeline`). Privacy: payloads
  // carry filters, counts, kinds + duration/outcome — never event contents
  // (timeline events are the customer's business record, not telemetry).
  TimelineListed: 'timeline.listed',
  TimelineEventAdded: 'timeline.event_added',

  // Chat-surface signals (fired from SKILL.md by Claude, not the harness)
  WarmStartServed: 'warm_start.served',
} as const;

export type EventNameValue = (typeof EventName)[keyof typeof EventName];
