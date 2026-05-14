/**
 * Send an IP whitelist request to the MixShift Discord webhook.
 *
 * Webhook URL ships in .mixshift-defaults.yaml; users / CI can override
 * via profile or env. The message is structured as a Discord embed so it
 * renders nicely in the ops channel: an operator clicks through, runs
 * GRANT on the warehouse, and the user can retry their connection.
 *
 * Best-effort: if the webhook is unreachable, returns an error result and
 * the auth-setup flow falls back to instructing the user to forward the
 * request manually (email, screenshot, etc.).
 */

export interface WhitelistRequest {
  user_email: string;
  public_ip: string;
  plugin_version: string;
  os: string;
  brand_slug?: string;
  note?: string;
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function postIpWhitelistRequest(
  webhookUrl: string,
  request: WhitelistRequest,
  timeoutMs = 10_000,
): Promise<PostResult> {
  if (!webhookUrl) {
    return { ok: false, error: 'No webhook URL configured.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    username: 'mx-claude-plugin',
    content: `New IP whitelist request from \`${request.user_email}\``,
    embeds: [
      {
        title: 'IP Whitelist Request',
        color: 0x4f46e5,
        fields: [
          { name: 'Email', value: request.user_email, inline: true },
          { name: 'IP Address', value: `\`${request.public_ip}\``, inline: true },
          { name: 'Time (UTC)', value: new Date().toISOString(), inline: false },
          { name: 'Plugin', value: request.plugin_version, inline: true },
          { name: 'OS', value: request.os, inline: true },
          ...(request.brand_slug
            ? [{ name: 'Brand', value: request.brand_slug, inline: true }]
            : []),
          ...(request.note
            ? [{ name: 'Note', value: request.note, inline: false }]
            : []),
        ],
        footer: {
          text: 'Reply via email or run GRANT on the warehouse to approve.',
        },
      },
    ],
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
