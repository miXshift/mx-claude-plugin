/**
 * Send a payload to the MixShift Discord ops webhook.
 *
 * Three payload kinds today (ip_whitelist_request, table_access_request,
 * user_feedback). Each renders as a different embed so the operator can
 * recognize and route at a glance.
 *
 * Best-effort: if the webhook is unreachable, returns an error result so
 * the caller can fall back to "email us instead."
 */

import type { PostResult, WebhookRequest } from './types.js';

const COLOR = {
  ip_whitelist_request: 0x4f46e5, // indigo
  table_access_request: 0xf59e0b, // amber
  user_feedback: 0x10b981, // emerald
} as const;

const TITLE = {
  ip_whitelist_request: 'IP Whitelist Request',
  table_access_request: 'Table Access Request',
  user_feedback: 'User Feedback',
} as const;

export async function postWebhook(
  webhookUrl: string,
  request: WebhookRequest,
  timeoutMs = 10_000,
): Promise<PostResult> {
  if (!webhookUrl) {
    return { ok: false, error: 'No webhook URL configured.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const embed = formatEmbed(request);
  const payload = {
    username: 'mx-claude-plugin',
    content: `${TITLE[request.kind]} from \`${request.user_email}\``,
    embeds: [embed],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `Webhook returned ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function formatEmbed(request: WebhookRequest): Record<string, unknown> {
  const baseFields = [
    { name: 'Email', value: request.user_email, inline: true },
    { name: 'Time (UTC)', value: new Date().toISOString(), inline: false },
    { name: 'Plugin', value: request.plugin_version, inline: true },
    { name: 'OS', value: request.os, inline: true },
  ];

  switch (request.kind) {
    case 'ip_whitelist_request':
      return embedFor(request, [
        { name: 'IP Address', value: `\`${request.public_ip}\``, inline: true },
        ...baseFields,
        ...(request.brand_slug
          ? [{ name: 'Brand', value: request.brand_slug, inline: true }]
          : []),
        ...(request.note ? [{ name: 'Note', value: request.note }] : []),
      ], 'Reply via email or run GRANT on the warehouse to approve.');

    case 'table_access_request':
      return embedFor(request, [
        { name: 'Table', value: `\`${request.table_name}\``, inline: true },
        ...baseFields,
        ...(request.seller_ids && request.seller_ids.length > 0
          ? [
              {
                name: 'Seller IDs attempted',
                value: request.seller_ids.join(', '),
                inline: false,
              },
            ]
          : []),
        ...(request.note ? [{ name: 'Note', value: request.note }] : []),
      ], 'Grant SELECT on this table to the user, or reply with rationale for denial.');

    case 'user_feedback':
      return embedFor(request, [
        ...(request.category
          ? [{ name: 'Category', value: request.category, inline: true }]
          : []),
        ...baseFields,
        ...(request.context?.skill_id
          ? [{ name: 'Skill', value: request.context.skill_id, inline: true }]
          : []),
        ...(request.context?.command
          ? [{ name: 'Command', value: `\`${request.context.command}\``, inline: true }]
          : []),
        ...(request.context?.brand_slug
          ? [{ name: 'Brand', value: request.context.brand_slug, inline: true }]
          : []),
        // Message rendered last so it has full width
        { name: 'Message', value: request.message.slice(0, 1900) },
      ], 'Reply via email or log in the feedback tracker.');
  }
}

function embedFor(
  request: WebhookRequest,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  footer: string,
): Record<string, unknown> {
  return {
    title: TITLE[request.kind],
    color: COLOR[request.kind],
    fields,
    footer: { text: footer },
  };
}

// Re-exports for ergonomics
export type {
  IpWhitelistRequest,
  TableAccessRequest,
  UserFeedback,
  WebhookRequest,
  PostResult,
} from './types.js';
