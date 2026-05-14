/**
 * Discord webhook payload types. All three flow to the same MixShift
 * ops channel; they're distinguished by title + color so the operator
 * can scan at a glance.
 *
 * Adding a new type:
 *   1. Add an entry to `WebhookKind`
 *   2. Add a corresponding request type below
 *   3. Add a renderer in lib/webhook/discord.ts (formatEmbed)
 */

export type WebhookKind =
  | 'ip_whitelist_request'
  | 'table_access_request'
  | 'user_feedback';

export interface BaseRequest {
  user_email: string;
  /** Plugin version (currently '0.0.1'). */
  plugin_version: string;
  /** OS string ('win32 22.04', 'linux 5.15', etc.). */
  os: string;
}

export interface IpWhitelistRequest extends BaseRequest {
  kind: 'ip_whitelist_request';
  public_ip: string;
  brand_slug?: string;
  note?: string;
}

export interface TableAccessRequest extends BaseRequest {
  kind: 'table_access_request';
  table_name: string;
  /** SellerIDs the user attempted to query — useful for scoped grants. */
  seller_ids?: number[];
  note?: string;
}

export interface UserFeedback extends BaseRequest {
  kind: 'user_feedback';
  /** Free-text from the user. */
  message: string;
  /** Optional category hint ('bug' | 'feature_request' | 'comment' | 'other'). */
  category?: 'bug' | 'feature_request' | 'comment' | 'other';
  /** Optional context: which skill / command / brand they were using. */
  context?: {
    skill_id?: string;
    command?: string;
    brand_slug?: string;
  };
}

export type WebhookRequest =
  | IpWhitelistRequest
  | TableAccessRequest
  | UserFeedback;

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}
