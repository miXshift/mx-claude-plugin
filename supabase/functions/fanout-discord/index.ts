// Supabase Edge Function: fanout-discord
//
// Listens for INSERTs on the `events` table (via the
// `events_to_discord_fanout` database webhook / trigger) and posts a
// Discord embed for the small subset of events that warrant real-time
// human attention: feedback (explicit + implicit), IP whitelist
// requests, table access requests, plugin crashes, the new-user
// onboarding funnel (install, auth complete, identified, automation
// configured), user-contributed skills (skill.shared), and release
// announcements (release.published).
//
// Routing: release.published posts to RELEASES_DISCORD_WEBHOOK_URL (the
// customer-facing releases channel); every other routed event posts to
// DISCORD_WEBHOOK_URL (the internal ops channel). release.published is
// skipped gracefully (HTTP 200) when its webhook secret is not set, so the
// rest of the fan-out is unaffected while that channel is being configured.
//
// Auth: deployed with verify_jwt=false. The function is only reachable
// via the DB trigger inside the same Supabase project, so a JWT check
// would add no real protection. Discord-side security is the function
// secrets-stored webhook URL â€” only this function can read it.
//
// Source of truth for this file: internal/SUPABASE-SETUP.md Â§10.2.
// Keep them in sync when changing the embed format or the
// DISCORD_EVENTS allowlist (which must also match the DB trigger's
// WHEN clause â€” see the two-layer allowlist warning at Â§10).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { feedbackParts, type FeedbackPart } from "./feedback-format.ts";

interface EventRow {
  id: number;
  ts: string;
  install_id: string;
  email?: string | null;
  // Self-attested per-employee actor email (mixshift auth login). Distinct
  // from `email`, which is the tenant's shared login. Sent by harness >= 0.6.3.
  person_label?: string | null;
  event_name: string;
  plugin_version?: string | null;
  install_path?: string | null;
  surface?: string | null;
  os?: string | null;
  payload?: Record<string, unknown> | null;
  skill_id?: string | null;
  query_id?: string | null;
  query_table?: string | null;
  error_class?: string | null;
  trigger_phrase?: string | null;
  outcome?: string | null;
  duration_ms?: number | null;
  row_count?: number | null;
  email_backfilled?: boolean | null;
}

// Rich actor block emitted on every 0.7.0+ event (payload.actor). It is the
// authoritative source of WHO acted â€” both the actor itself and, for service
// credentials, the human who owns/minted it. Pre-0.7.0 events do not carry it;
// all readers here fall back to the flat columns + registry RPC when it is
// absent.
//   service: { kind:'service', svc_label, svc_client_id, owner_user_id,
//              minted_by, purpose, scopes, client_ip }
//   human:   { kind:'human', user_id }
interface ActorBlock {
  kind?: string | null;
  user_id?: string | number | null;
  svc_label?: string | null;
  svc_client_id?: string | null;
  owner_user_id?: string | number | null;
  minted_by?: string | null;
  purpose?: string | null;
  scopes?: string[] | null;
  client_ip?: string | null;
}

function actorOf(event: EventRow): ActorBlock | null {
  const a = (event.payload ?? {}).actor;
  return a && typeof a === 'object' ? (a as ActorBlock) : null;
}

// Which event_names should fan out to Discord. Everything else stays in
// the events table for batch analytics only. MUST stay in lockstep with
// the DB trigger events_to_discord_fanout WHEN clause.
const DISCORD_EVENTS = new Set([
  // Ops alerts â€” manual action required
  'ip_whitelist.requested',
  'feedback.submitted',
  'feedback.detected_implicit',
  'table_access.requested',
  'plugin.crashed',
  // New-user onboarding funnel
  'plugin.installed',
  'auth.completed',
  'auth.login_completed',
  'user.identified',
  'auth.service_setup_completed',
  // User-contributed skill
  'skill.shared',
  // Release announcement â€” routed to the releases channel, not ops
  'release.published',
]);

const COLOR: Record<string, number> = {
  'ip_whitelist.requested':       0x4f46e5,
  'feedback.submitted':           0x10b981,
  'feedback.detected_implicit':   0xf59e0b,
  'table_access.requested':       0xf59e0b,
  'plugin.crashed':               0xef4444,
  'plugin.installed':             0x06b6d4,
  'auth.completed':               0x3b82f6,
  'auth.login_completed':         0x3b82f6,
  'user.identified':              0x8b5cf6,
  'auth.service_setup_completed': 0x14b8a6,
  'skill.shared':                 0xa855f7,
};

const TITLE: Record<string, string> = {
  'ip_whitelist.requested':       'IP Whitelist Request',
  'feedback.submitted':           'User Feedback',
  'feedback.detected_implicit':   'Implicit Feedback Detected',
  'table_access.requested':       'Table Access Request',
  'plugin.crashed':               'Plugin Crash',
  'plugin.installed':             'New install (pre-auth)',
  'auth.completed':               'New User â€” Auth Completed',
  'auth.login_completed':         'New User: Auth Login Completed',
  'user.identified':              'User Identified (installâ†”email linked)',
  'auth.service_setup_completed': 'Automation configured (service credential)',
  'skill.shared':                 'Skill Shared',
};

const SURFACE_LABEL: Record<string, string> = {
  cowork:               'Cowork (desktop chat)',
  claude_code:          'Claude Code',
  plugin_host_unknown:  'Plugin host (unidentified)',
  cli:                  'CLI (direct)',
  cli_headless:         'CLI (headless/CI)',
  chatgpt:              'ChatGPT plugin',
  claude_desktop:       'Claude Desktop',
  other:                'Other host',
};

// ---------------------------------------------------------------------------
// Service-credential enrichment (v14).
//
// Automation events carry only the local credential label, which on the raw
// --client-id/--client-secret-file path defaults to the bare svc_* client_id
// â€” unreadable in the ops channel and easy to misattribute (a bare client_id
// from an internal test run looks identical to a customer's). Resolve svc_*
// client_ids against the mx-auth-legacy project's admin-side registry so the
// embed shows the credential's admin label + who minted it.
//
// The lookup is the SECURITY DEFINER RPC `lookup_service_credential`
// (mx-legacy-auth migrations/008_svc_credential_lookup.sql). It is called
// with mx-auth-legacy's PUBLISHABLE key â€” safe to embed by design; the
// effective gate is knowledge of the unguessable client_id, and the RPC
// returns only label/created_by/revoked_at. Fail-soft everywhere: any
// error, timeout, or missing row just renders the un-enriched fallback.
// Env vars allow override without a code change.
//
// v15: the 0.7.0+ payload.actor block now carries svc_label / owner_user_id /
// minted_by / purpose / client_ip inline, so the RPC is no longer the primary
// attribution source â€” it is retained only to supply `revoked_at` (which the
// actor block does not carry) and as the pre-0.7.0 fallback.
// ---------------------------------------------------------------------------
const MX_AUTH_REST_URL =
  Deno.env.get('MX_AUTH_REST_URL') ?? 'https://ezkwwqjzenvqfsriasbs.supabase.co';
const MX_AUTH_PUBLISHABLE_KEY =
  Deno.env.get('MX_AUTH_PUBLISHABLE_KEY') ?? 'sb_publishable_GOWqTLQy8no9UOA3Q--VdA_gpAeRnyN';

interface SvcCredInfo {
  label: string | null;
  created_by: string | null;
  revoked_at: string | null;
}

const SVC_CLIENT_ID_RE = /^svc_[A-Za-z0-9_-]{10,}$/;

// Shared tenant sign-on â€” identifies a tenant, not a person, so it must never
// be rendered as the acting individual in the User field. Mirrors the guard in
// the sibling beta-health-digest function (keep the value in lockstep). The
// Login field may still legitimately surface this tenant login.
const SHARED_LOGIN = 'dev+tester@mixshift.io';

// A svc_* client_id can surface in the 0.7.0+ actor block (actor.svc_client_id),
// or on older events as payload.label (the harness's local label defaults to
// the client_id on the raw setup path) or as person_label (harness >= 0.6.3
// sends service label ?? client_id as person_label).
function svcClientIdOf(event: EventRow): string | null {
  const actor = actorOf(event);
  if (typeof actor?.svc_client_id === 'string' && actor.svc_client_id) {
    return actor.svc_client_id;
  }
  const payload = event.payload ?? {};
  for (const candidate of [payload.label, event.person_label]) {
    if (typeof candidate === 'string' && SVC_CLIENT_ID_RE.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveServiceCredential(clientId: string): Promise<SvcCredInfo | null> {
  try {
    const resp = await fetch(`${MX_AUTH_REST_URL}/rest/v1/rpc/lookup_service_credential`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: MX_AUTH_PUBLISHABLE_KEY,
        Authorization: `Bearer ${MX_AUTH_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ p_client_id: clientId }),
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0] as SvcCredInfo;
  } catch {
    return null;
  }
}

// Discord rejects the ENTIRE embed with HTTP 400 if any single field value
// exceeds 1024 characters; embed descriptions allow up to 4096. Cap free text.
function fieldValue(s: string, max = 1024): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + 'â€¦';
}

const isBareClientId = (s: string | null | undefined): boolean =>
  !!s && SVC_CLIENT_ID_RE.test(s);

// Best human-facing name for an automation actor: the actor block's svc_label
// (0.7.0+) first, then the admin-side registry label when resolved, then
// whichever local label isn't a bare client_id, else the raw client_id itself.
// This is the User field for automation events â€” it names the credential that
// acted, NOT its owner (see ownerDisplay for that).
function automationDisplay(event: EventRow, svc: SvcCredInfo | null, actor: ActorBlock | null): string {
  const payload = event.payload ?? {};
  const rawLabel = payload.label ? String(payload.label) : null;
  const personLabel = event.person_label ?? null;
  const actorLabel = actor?.svc_label ? String(actor.svc_label) : null;
  const best =
    actorLabel ??
    svc?.label ??
    (personLabel && !isBareClientId(personLabel) ? personLabel : null) ??
    (rawLabel && !isBareClientId(rawLabel) ? rawLabel : null) ??
    rawLabel ??
    personLabel ??
    '(unlabeled service credential)';
  return `${best} (automation)`;
}

// The identity that OWNS an automation credential â€” who is accountable for the
// run â€” for the Login field. This must NEVER re-echo the svc label (the
// pre-v15 bug: loginDisplay fell through to automationDisplay, so User and
// Login both read "svc:â€¦ (automation)"). Prefers the 0.7.0+ actor block:
// minted_by is the human who minted the credential, owner_user_id the legacy
// account id. Falls back to the registry RPC's created_by (pre-0.7.0). The
// numeric owner_user_id is a legacy warehouse account id and is NOT resolvable
// against the auth project's (uuid-keyed) auth.users, so it is rendered as-is.
// Prefixed "owner:" so it never reads like an interactive login.
function ownerDisplay(svc: SvcCredInfo | null, actor: ActorBlock | null): string {
  const mintedBy = actor?.minted_by ? String(actor.minted_by) : null;
  const ownerUserId = actor?.owner_user_id != null ? String(actor.owner_user_id) : null;
  const createdBy = svc?.created_by ?? null;
  if (mintedBy && ownerUserId) return `owner: ${mintedBy} (user_id=${ownerUserId})`;
  if (mintedBy)                return `owner: ${mintedBy}`;
  if (ownerUserId && createdBy) return `owner: ${createdBy} (user_id=${ownerUserId})`;
  if (ownerUserId)             return `owner: user_id=${ownerUserId}`;
  if (createdBy)               return `owner: ${createdBy}`;
  return '(service credential â€” owner unknown)';
}

function isAutomation(event: EventRow, actor: ActorBlock | null): boolean {
  const payload = event.payload ?? {};
  return !!payload.automation || actor?.kind === 'service';
}

// The individual person acting, when known. person_label is the
// self-attested per-employee email collected at `mixshift auth login`
// (harness >= 0.6.3 sends it). For automation, this shows the credential
// (the actor). Human fallbacks before "(not identified)": the 0.7.0+ actor
// (human user_id), the backfilled email path, and â€” for pre-auth
// plugin.installed where person_label is legitimately null â€” "new install".
function userDisplay(event: EventRow, svc: SvcCredInfo | null, actor: ActorBlock | null): string {
  if (isAutomation(event, actor)) return automationDisplay(event, svc, actor);
  if (event.person_label) return event.person_label;
  // The shared tenant login is NOT a person â€” never present it as the acting
  // individual (matches beta-health-digest). Treat it as "no personal email"
  // so we fall through to the human-actor user_id / new-install / not-identified
  // behavior instead of naming the tenant login.
  const personalEmail =
    event.email && event.email !== SHARED_LOGIN ? event.email : null;
  // 0.7.0+ human actor carries the legacy user_id even when person_label is null.
  if (actor?.kind === 'human' && actor.user_id != null) {
    return personalEmail
      ? `${personalEmail} (user_id=${actor.user_id})`
      : `user_id=${actor.user_id}`;
  }
  // Backfilled / any known (non-shared) email before giving up.
  if (personalEmail) return event.email_backfilled ? `${personalEmail} (returning)` : personalEmail;
  // Pre-auth install legitimately has no person â€” say so plainly.
  if (event.event_name === 'plugin.installed') return 'new install';
  return '(not identified)';
}

function loginDisplay(event: EventRow, svc: SvcCredInfo | null, actor: ActorBlock | null): string {
  // Automation: Login shows the OWNING human, never the svc label again.
  if (isAutomation(event, actor)) return ownerDisplay(svc, actor);
  if (event.email && event.email_backfilled) {
    return `${event.email} (returning)`;
  }
  if (event.email) {
    return event.email;
  }
  return '(anonymous, no prior auth)';
}

function formatEmbed(event: EventRow, svc: SvcCredInfo | null, feedbackPart?: FeedbackPart): Record<string, unknown> | null {
  if (!DISCORD_EVENTS.has(event.event_name)) return null;

  // Release announcements are not per-install events: render a dedicated
  // embed (version + highlights + link) with no per-user base fields.
  if (event.event_name === 'release.published') {
    const p = event.payload ?? {};
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (p.version) fields.push({ name: 'Version', value: `v${String(p.version)}`, inline: true });
    if (p.url)     fields.push({ name: 'Full notes', value: String(p.url), inline: true });
    return {
      title: p.title
        ? String(p.title)
        : (p.version ? `mixshift-ai v${String(p.version)} released` : 'New mixshift-ai release'),
      description: p.summary ? fieldValue(String(p.summary), 3500) : undefined,
      color: 0x10b981,
      fields,
      footer: { text: 'MixShift plugin release notes' },
    };
  }

  const actor = actorOf(event);

  const surfaceLabel = event.surface
    ? (SURFACE_LABEL[event.surface] ?? event.surface)
    : '(unknown â€” pre-0.5.1)';
  const baseFields: Array<{ name: string; value: string; inline?: boolean }> = [
    // User = the individual person / acting credential (person_label or the
    // 0.7.0+ actor); Login = the tenant's shared sign-on for humans, or the
    // credential OWNER for automation. Both shown so ops can tell WHO acted,
    // not just which tenant.
    { name: 'User',       value: userDisplay(event, svc, actor), inline: true },
    { name: 'Login',      value: loginDisplay(event, svc, actor), inline: true },
    { name: 'Install ID', value: event.install_id.slice(0, 8) + 'â€¦', inline: true },
    { name: 'Plugin',     value: event.plugin_version ?? 'unknown', inline: true },
    { name: 'Surface',    value: surfaceLabel, inline: true },
    { name: 'Install',    value: event.install_path ?? 'unknown', inline: true },
    { name: 'OS',         value: event.os ?? 'unknown', inline: true },
    { name: 'Time (UTC)', value: event.ts, inline: false },
  ];

  const payload = event.payload ?? {};
  const eventFields: Array<{ name: string; value: string; inline?: boolean }> = [];

  switch (event.event_name) {
    case 'ip_whitelist.requested':
      if (payload.public_ip) eventFields.push({ name: 'Public IP', value: `\`${payload.public_ip}\``, inline: true });
      break;
    case 'feedback.submitted':
      eventFields.push({ name: 'Feedback ID', value: String(feedbackPart?.feedbackId ?? event.id), inline: true });
      if (payload.category)   eventFields.push({ name: 'Category', value: String(payload.category), inline: true });
      if (payload.skill_id || event.skill_id)
        eventFields.push({ name: 'Skill', value: String(payload.skill_id ?? event.skill_id), inline: true });
      if (payload.brand_slug) eventFields.push({ name: 'Brand',    value: String(payload.brand_slug), inline: true });
      if (!feedbackPart && payload.message)
        eventFields.push({ name: 'Message', value: fieldValue(String(payload.message)) });
      break;
    case 'feedback.detected_implicit':
      if (event.skill_id)        eventFields.push({ name: 'Skill',    value: event.skill_id, inline: true });
      if (payload.pattern)       eventFields.push({ name: 'Pattern',  value: String(payload.pattern), inline: true });
      if (payload.brand_slug)    eventFields.push({ name: 'Brand',    value: String(payload.brand_slug), inline: true });
      if (event.trigger_phrase)  eventFields.push({ name: 'User said', value: fieldValue(String(event.trigger_phrase)) });
      if (payload.context)       eventFields.push({ name: 'Context',  value: fieldValue(String(payload.context)) });
      break;
    case 'table_access.requested':
      if (payload.table_name) eventFields.push({ name: 'Table',      value: `\`${payload.table_name}\``, inline: true });
      if (payload.seller_ids) eventFields.push({ name: 'Seller IDs', value: fieldValue(String(payload.seller_ids)) });
      break;
    case 'plugin.crashed':
      if (event.error_class)  eventFields.push({ name: 'Error class', value: event.error_class, inline: true });
      if (payload.message)    eventFields.push({ name: 'Error',       value: fieldValue(String(payload.message)) });
      break;
    case 'plugin.installed':
      break;
    case 'auth.completed':
      break;
    case 'auth.login_completed':
      break;
    case 'user.identified':
      break;
    case 'auth.service_setup_completed': {
      // Prefer the 0.7.0+ actor svc_label, then the registry label, then the
      // raw local label (often just the client_id). When the resolved label
      // differs from the raw local one, show "resolved (raw)" for provenance.
      const rawLabel = payload.label ? String(payload.label) : null;
      const actorLabel = actor?.svc_label ? String(actor.svc_label) : null;
      const bestLabel = actorLabel ?? svc?.label ?? rawLabel;
      const credDisplay = bestLabel && rawLabel && bestLabel !== rawLabel
        ? `${bestLabel} (${rawLabel})`
        : bestLabel;
      if (credDisplay)              eventFields.push({ name: 'Credential', value: fieldValue(credDisplay), inline: true });
      if (payload.via)              eventFields.push({ name: 'Via',        value: String(payload.via), inline: true });
      if (payload.verified != null) eventFields.push({ name: 'Verified',   value: String(payload.verified), inline: true });
      break;
    }
    case 'skill.shared':
      if (payload.skill_name)    eventFields.push({ name: 'Skill',   value: fieldValue(String(payload.skill_name)), inline: true });
      if (payload.kind)          eventFields.push({ name: 'Kind',    value: String(payload.kind), inline: true });
      if (payload.base_skill_id) eventFields.push({ name: 'Changes', value: String(payload.base_skill_id), inline: true });
      eventFields.push({ name: 'Bundle', value: `${payload.file_count ?? '?'} file(s), ${payload.total_bytes ?? '?'} bytes`, inline: true });
      if (payload.description)   eventFields.push({ name: 'Description', value: fieldValue(String(payload.description)) });
      eventFields.push({ name: 'Artifact', value: 'newest row in the skill_submissions table' });
      break;
  }

  // Credential provenance, on any automation event. Prefer the 0.7.0+ actor
  // block (minted_by / owner_user_id / purpose / client_ip) and fall back to
  // the registry RPC. `revoked_at` comes only from the RPC (the actor block
  // does not carry it). Internal test creds become self-identifying.
  if (actor?.kind === 'service' || svc) {
    const mintedBy = (actor?.minted_by ? String(actor.minted_by) : null) ?? svc?.created_by ?? null;
    const ownerUserId = actor?.owner_user_id != null ? String(actor.owner_user_id) : null;
    if (mintedBy)            eventFields.push({ name: 'Minted by',     value: fieldValue(mintedBy), inline: true });
    if (ownerUserId)         eventFields.push({ name: 'Owner user_id', value: ownerUserId, inline: true });
    if (actor?.purpose)      eventFields.push({ name: 'Purpose',       value: fieldValue(String(actor.purpose)), inline: true });
    if (actor?.client_ip)    eventFields.push({ name: 'Client IP',     value: `\`${String(actor.client_ip)}\``, inline: true });
    if (svc?.revoked_at)     eventFields.push({ name: 'Revoked',       value: `âš  ${svc.revoked_at}`, inline: true });
  }

  const title =
    event.event_name === 'plugin.installed' && payload.automation
      ? 'New install (automation)'
      : (TITLE[event.event_name] ?? event.event_name);

  const feedbackPartLabel = feedbackPart
    ? ` | Feedback #${feedbackPart.feedbackId} (${feedbackPart.number}/${feedbackPart.total})`
    : (event.event_name === 'feedback.submitted' ? ` | Feedback #${event.id}` : '');

  return {
    title: `${title}${feedbackPartLabel}`,
    description: feedbackPart?.text,
    color: COLOR[event.event_name] ?? 0x6b7280,
    fields: [...eventFields, ...baseFields],
    footer: { text: 'mx-claude-plugin telemetry â†’ Discord fan-out' },
  };
}

function formatEmbeds(event: EventRow, svc: SvcCredInfo | null): Record<string, unknown>[] {
  if (event.event_name === 'feedback.submitted' && typeof event.payload?.message === 'string') {
    return feedbackParts(event.id, event.payload.message).map((part) =>
      formatEmbed(event, svc, part)!,
    );
  }
  const embed = formatEmbed(event, svc);
  return embed ? [embed] : [];
}

Deno.serve(async (req: Request) => {
  try {
    // Supabase database webhooks send `{type, table, record, ...}`.
    const body = await req.json();
    const event: EventRow = body.record ?? body;

    if (!DISCORD_EVENTS.has(event.event_name)) {
      return new Response('not a discord-routed event', { status: 200 });
    }

    // Enrich svc_* automation actors from the credential registry (fail-soft).
    // Still worthwhile on 0.7.0+ events: the RPC supplies revoked_at, which the
    // payload.actor block does not carry.
    const svcClientId = svcClientIdOf(event);
    const svc = svcClientId ? await resolveServiceCredential(svcClientId) : null;

    const embeds = formatEmbeds(event, svc);
    if (embeds.length === 0) return new Response('not a discord-routed event', { status: 200 });

    // release.published goes to the customer-facing releases channel; every
    // other routed event goes to the internal ops channel.
    const isRelease = event.event_name === 'release.published';
    const webhookUrl = isRelease
      ? Deno.env.get('RELEASES_DISCORD_WEBHOOK_URL')
      : Deno.env.get('DISCORD_WEBHOOK_URL');
    if (!webhookUrl) {
      // Releases channel not configured yet: skip gracefully so it doesn't
      // error-spam. Ops webhook missing stays a hard 500 (it must exist).
      return new Response(
        isRelease ? 'RELEASES_DISCORD_WEBHOOK_URL not set' : 'DISCORD_WEBHOOK_URL not set',
        { status: isRelease ? 200 : 500 },
      );
    }

    for (const embed of embeds) {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: isRelease ? 'MixShift Releases' : 'mx-claude-plugin',
          embeds: [embed],
        }),
      });
      if (!resp.ok) {
        return new Response(`discord ${resp.status}: ${await resp.text()}`, { status: 502 });
      }
    }
    return new Response(`ok`, { status: 200 });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
});
