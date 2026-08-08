/**
 * Skill-submission transport.
 *
 * The "capture by other means" half of skill sharing. A `skill.shared`
 * telemetry event (small: name + description + counts) rides the normal
 * events → Discord fan-out so ops gets pinged in real time. But the actual
 * skill ARTIFACT (a SKILL.md plus any supporting files) is too big and too
 * structured to live in the events firehose — the events payload feeds a
 * Discord embed whose fields cap at 1024 chars, and we don't want whole
 * documents polluting the analytics stream.
 *
 * So the artifact bytes go to a dedicated, uncapped Supabase table,
 * `skill_submissions`, written through the SAME PostgREST endpoint + anon
 * apikey the telemetry client already uses (reuse the pipeline, just a
 * different table). The table column is jsonb, which has no practical size
 * limit, so a full multi-file bundle inserts in one row.
 *
 * Unlike telemetry (fire-and-forget, queue-and-retry), this is synchronous
 * with an honest result: the share flow tells the user "received" or "could
 * not send, try again" based on the real HTTP outcome. We never claim a skill
 * was received when it wasn't.
 *
 * Backend prerequisite: the `skill_submissions` table + an insert-only RLS
 * policy for the anon role must exist. Until
 * then this returns { status: 'failed' } with the PostgREST error, which the
 * share flow surfaces rather than swallowing.
 */

import { loadPluginDefaults } from '../defaults/load.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SkillSubmissionFile {
  /** Relative path within the bundle, e.g. "SKILL.md" or "reference.md". */
  path: string;
  /** UTF-8 text content. */
  content: string;
  /** Byte length of `content`. */
  bytes: number;
}

export type SubmissionKind = 'new_skill' | 'modified_plugin_skill' | 'idea';

export interface SkillSubmissionInput {
  skill_name: string;
  description: string;
  kind: SubmissionKind;
  /** When kind = 'modified_plugin_skill', the plugin skill id being changed. */
  base_skill_id?: string;
  email?: string;
  person_label?: string;
  surface?: string;
  plugin_version?: string;
  install_id?: string;
  files: SkillSubmissionFile[];
  /** Free-form context from the contributor (what it does, why, how to use). */
  notes?: string;
}

export interface SubmitResult {
  status: 'sent' | 'no_endpoint' | 'failed';
  error?: string;
  /** Bytes across all files, surfaced for the user-facing confirmation. */
  total_bytes?: number;
  file_count?: number;
}

/**
 * Derive the skill-submissions URL from the telemetry events URL. Two known
 * shapes, rewritten segment-for-segment; anything else is refused so a
 * misconfigured endpoint can't post to a surprise location:
 *
 *   gateway (shipped default): https://mcp.mixshift.io/telemetry/events
 *                           -> https://mcp.mixshift.io/telemetry/submissions
 *   PostgREST (env override):  https://<ref>.supabase.co/rest/v1/events
 *                           -> https://<ref>.supabase.co/rest/v1/skill_submissions
 *
 * Exported for tests.
 */
export function deriveSubmissionsEndpoint(eventsEndpoint: string): string | null {
  if (/\/telemetry\/events\/?$/.test(eventsEndpoint)) {
    return eventsEndpoint.replace(/\/events\/?$/, '/submissions');
  }
  if (/\/rest\/v1\/events\/?$/.test(eventsEndpoint)) {
    return eventsEndpoint.replace(/\/events\/?$/, '/skill_submissions');
  }
  return null;
}

export async function submitSkill(
  input: SkillSubmissionInput,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SubmitResult> {
  const defaults = await loadPluginDefaults();
  const { endpoint, apikey } = defaults.telemetry;
  if (!endpoint || !apikey) return { status: 'no_endpoint' };

  const target = deriveSubmissionsEndpoint(endpoint);
  if (!target) return { status: 'no_endpoint' };

  const totalBytes = input.files.reduce((n, f) => n + f.bytes, 0);
  const row = {
    skill_name: input.skill_name,
    description: input.description,
    kind: input.kind,
    base_skill_id: input.base_skill_id ?? null,
    email: input.email ?? null,
    person_label: input.person_label ?? null,
    surface: input.surface ?? null,
    plugin_version: input.plugin_version ?? null,
    install_id: input.install_id ?? null,
    file_count: input.files.length,
    total_bytes: totalBytes,
    files: input.files, // jsonb
    notes: input.notes ?? null,
    status: 'received', // server-side review state
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${apikey}`,
        // Insert-only: the anon policy grants INSERT, not SELECT, so don't ask
        // for the row back (return=representation would 401/403 under that RLS).
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<unreadable>');
      return {
        status: 'failed',
        error: `Supabase responded ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
        total_bytes: totalBytes,
        file_count: input.files.length,
      };
    }
    return {
      status: 'sent',
      total_bytes: totalBytes,
      file_count: input.files.length,
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      total_bytes: totalBytes,
      file_count: input.files.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
