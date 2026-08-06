/**
 * Schema for `~/.mixshift/clients/index.yaml` — the brand registry.
 *
 * Populated by `mixshift brand discover` (manual) and `runPostAuthDiscovery`
 * (automatic after auth.completed). One row per brand the install has access
 * to in the warehouse, INCLUDING fully-dormant brands (both ads + retail
 * inactive). Display filtering happens at read time so the file is the full
 * picture and "why am I not seeing brand X" is answerable instantly.
 *
 * Distinct from `~/.mixshift/clients/<slug>/context.yaml` (per-brand cold-start
 * context). The registry tracks WHAT brands exist; the per-slug folder tracks
 * the cold-start details for brands that have been onboarded for analytical
 * skills.
 *
 * Refresh strategy: TTL-based (24h) + manual (`mixshift brand discover`).
 * See lib/clients/index.ts.
 */

import { z } from 'zod';

/**
 * One account inside a brand. Mirrors SellerRow's user-relevant subset.
 *
 * `is_mws_user` is the SP-API access flag (DB column name predates Amazon's
 * MWS→SP-API rename). Semantically: does this seller have a Selling Partner
 * API connection set up so MixShift can ingest retail data? `is_active` is
 * the parent IsActive flag (ads); `ads_active` is the derived "ads truly
 * usable" boolean (factors in lost-access + hide flags). Same pattern for
 * retail.
 */
export const indexAccountSchema = z.object({
  seller_id: z.number().int(),
  seller_name: z.string(),
  merchant_alias: z.string().nullable(),
  account_type: z.enum(['SC', 'VC', 'DSP', 'unknown']),
  marketplace: z.string().nullable(),
  region: z.string().nullable(),
  // Raw flags (mirrors source columns)
  is_active: z.boolean(), // IsActive — top-level enable
  is_mws_user: z.boolean(), // isMwsUser — SP-API access set up (legacy column name)
  // Derived flags (richer than raw — factors in lost_access + hide flags;
  // matches the `ads_active` / `retail_active` semantics in seller-query.ts)
  ads_active: z.boolean(),
  retail_active: z.boolean(),
});

export type IndexAccount = z.infer<typeof indexAccountSchema>;

/**
 * One brand row in the registry. `accounts` carries the per-marketplace
 * detail; the brand-level booleans aggregate via "any account has it active."
 *
 * `is_dormant` is the derived "no active accounts at all" flag — drives
 * default visibility. Stored for read-time efficiency; computed from
 * accounts during save.
 *
 * `cold_started` flips to `true` once the brand goes through
 * mx-brand-context (and stays true even if the brand later goes dormant,
 * so the on-disk context isn't lost across transient lapses).
 *
 * `aliases` (optional, feedback #37278) records retired identifiers for
 * this brand: slugs it used to be filed under, and canonicalized
 * MerchantAlias labels retained on its accounts. Populated by
 * `buildIndexFromBrands`'s identity-stability path — when a brand's
 * Name-derived slug changes (e.g. after a storefront rename, or after
 * this version's alias-first-to-Name-first flip) but its warehouse
 * seller_ids overlap a brand already in the registry, the OLD slug is
 * kept as `slug` and the new would-be slug + retained aliases land here
 * instead, so `mixshift brand key add <old name>` and friends keep
 * resolving. Absent (not merely empty) on brands that have never had a
 * slug/alias change — this is additive, and OMITTING the field (rather
 * than always writing `[]`) keeps a plugin version that predates this
 * field from ever seeing it on the common case. A version that predates
 * this field ignores it entirely either way: zod's default `z.object`
 * behavior strips unrecognized keys instead of failing, so an old
 * harness reading a NEW index.yaml with `aliases` present still parses
 * successfully (see index.ts buildIndexFromBrands and the harness
 * CHANGELOG for the #117 precedent on additive schema fields).
 */
export const indexBrandSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  display_name: z.string(),
  // Derived brand-level flags
  ads_active: z.boolean(), // any account has ads_active
  retail_active: z.boolean(), // any account has retail_active
  is_dormant: z.boolean(), // !ads_active && !retail_active across all accounts
  // Cold-start state (independent of dormancy — preserved through lapses)
  cold_started: z.boolean(),
  cold_started_at: z.iso.datetime().nullable(),
  accounts: z.array(indexAccountSchema).min(1),
  // Optional + forward/backward tolerant — see comment above.
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
});

export type IndexBrand = z.infer<typeof indexBrandSchema>;

/**
 * The full registry file. `discovered_at` is the timestamp of the most
 * recent successful discovery — drives TTL refresh decisions.
 */
export const clientsIndexSchema = z.object({
  schema_version: z.literal(1),
  discovered_at: z.iso.datetime(),
  brands: z.array(indexBrandSchema),
});

export type ClientsIndex = z.infer<typeof clientsIndexSchema>;

/**
 * Empty registry — used when no discovery has run yet and a caller asks
 * to read the index. The TTL check treats this as "stale" so the next
 * caller-with-creds triggers a refresh.
 */
export function emptyIndex(): ClientsIndex {
  return {
    schema_version: 1,
    discovered_at: new Date(0).toISOString(), // epoch — always stale
    brands: [],
  };
}
