/**
 * The DSP responsive-creative map: which responsive ecommerce creative (REC)
 * each DSP order is meant to carry, per tenant and advertiser.
 *
 * Why it exists: in the DSP console the creative chooser on a line item lists
 * every order's automatically created responsive ad, so a user who builds the
 * orders first and attaches creatives later can attach another order's REC
 * without noticing. Amazon's API does not say which order a creative was made
 * for (a DSP ad carries no campaign id, and an association shows the current
 * attachment, not the origin), so `dsp readiness` can only tell a right REC
 * from a wrong one against a mapping someone stated. This module is that
 * mapping. It is never inferred: names, ASINs, dates, eligibility and existing
 * attachments can suggest a candidate, never fill it in.
 *
 * Two ways an entry is written, and nothing else writes one:
 *   - plugin_build:   `ads call dsp.create_ads --commit --for-order <id>`
 *                     records each created ad id against the order the user
 *                     named for the build. It is the intended identity of a
 *                     creative MixShift built, not proof of the console's
 *                     automatic one.
 *   - user_confirmed: `dsp creative-map confirm <orderId> --creative-id <id>
 *                     --commit`, after the user said which order a console-built
 *                     creative belongs to.
 *
 * Storage: one plugin-local JSON file in the data dir (<data dir>/dsp/
 * creative-map.json, mode 0600, atomic write). No server table, no schema
 * change, no migration. Every entry is keyed by tenant + advertiser + order,
 * and every read filters on tenant and advertiser first, so a data dir that is
 * signed in to another tenant later never sees the first tenant's entries.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveDataDir } from '../paths/resolve.js';
import { loadCredentials } from '../auth/credentials.js';
import { decodeAccessTokenClaims } from '../auth/token-claims.js';
import { readServiceAttributionCache } from '../telemetry/service-attribution-cache.js';

export type MappingSource = 'plugin_build' | 'user_confirmed';

const NUMERIC_ID = /^\d{1,30}$/;

const entrySchema = z.object({
  tenant: z.string().min(1),
  advertiser_id: z.string().regex(NUMERIC_ID),
  order_id: z.string().regex(NUMERIC_ID),
  creative_id: z.string().regex(NUMERIC_ID),
  source: z.enum(['plugin_build', 'user_confirmed']),
  recorded_at: z.iso.datetime(),
  recorded_by: z.string().min(1).optional(),
  /** plugin_build: the audit id of the dsp.create_ads commit that made it. */
  audit_id: z.string().min(1).max(128).optional(),
  /** user_confirmed: the user said this creative is shared with another order on purpose. */
  reuse: z.boolean().optional(),
});

const fileSchema = z.object({
  schema_version: z.literal(1),
  entries: z.array(entrySchema),
});

export type CreativeMappingEntry = z.infer<typeof entrySchema>;
type CreativeMapFile = z.infer<typeof fileSchema>;

/**
 * What `dsp readiness` is handed: the tenant's entries, or why there are none
 * to use. "unavailable" never reads as a pass: every REC is then unverified.
 */
export type CreativeMapInput =
  | { status: 'ok'; tenant: string; entries: CreativeMappingEntry[] }
  | { status: 'unavailable'; reason: string };

export function creativeMapPath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'dsp', 'creative-map.json');
}

/** Read the whole file. A missing file is an empty map; a malformed one is an error, never "empty". */
export async function loadCreativeMap(
  dataDirOverride?: string,
): Promise<{ ok: true; entries: CreativeMappingEntry[] } | { ok: false; reason: string }> {
  const path = creativeMapPath(dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: false, reason: `could not read ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  const res = fileSchema.safeParse(parsed);
  if (!res.success) return { ok: false, reason: `${path} does not match the creative map format` };
  return { ok: true, entries: res.data.entries };
}

async function saveCreativeMap(file: CreativeMapFile, dataDirOverride?: string): Promise<void> {
  const validated = fileSchema.parse(file);
  const path = creativeMapPath(dataDirOverride);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

const sameKey = (a: CreativeMappingEntry, b: Pick<CreativeMappingEntry, 'tenant' | 'advertiser_id' | 'order_id' | 'creative_id'>): boolean =>
  a.tenant === b.tenant &&
  a.advertiser_id === b.advertiser_id &&
  a.order_id === b.order_id &&
  a.creative_id === b.creative_id;

/**
 * Add entries. An entry whose tenant + advertiser + order + creative is already
 * recorded is left as it was (the first record keeps its source and date).
 * Throws on a malformed existing file rather than overwrite it.
 */
export async function recordCreativeMappings(
  entries: CreativeMappingEntry[],
  dataDirOverride?: string,
): Promise<{ added: CreativeMappingEntry[]; existing: CreativeMappingEntry[] }> {
  const loaded = await loadCreativeMap(dataDirOverride);
  if (!loaded.ok) throw new Error(`${loaded.reason}; fix or move the file, nothing was recorded.`);
  const all = [...loaded.entries];
  const added: CreativeMappingEntry[] = [];
  const existing: CreativeMappingEntry[] = [];
  for (const raw of entries) {
    const e = entrySchema.parse(raw);
    const found = all.find((x) => sameKey(x, e));
    if (found) {
      existing.push(found);
      continue;
    }
    all.push(e);
    added.push(e);
  }
  if (added.length) await saveCreativeMap({ schema_version: 1, entries: all }, dataDirOverride);
  return { added, existing };
}

/** Remove one tenant + advertiser + order + creative entry. Returns what was removed. */
export async function removeCreativeMapping(
  key: Pick<CreativeMappingEntry, 'tenant' | 'advertiser_id' | 'order_id' | 'creative_id'>,
  dataDirOverride?: string,
): Promise<CreativeMappingEntry[]> {
  const loaded = await loadCreativeMap(dataDirOverride);
  if (!loaded.ok) throw new Error(`${loaded.reason}; fix or move the file, nothing was removed.`);
  const removed = loaded.entries.filter((x) => sameKey(x, key));
  if (removed.length) {
    await saveCreativeMap(
      { schema_version: 1, entries: loaded.entries.filter((x) => !sameKey(x, key)) },
      dataDirOverride,
    );
  }
  return removed;
}

/** The entries of one tenant and advertiser: the only rows any check may look at. */
export function scopedEntries(
  entries: CreativeMappingEntry[],
  tenant: string,
  advertiserId: string,
): CreativeMappingEntry[] {
  return entries.filter((e) => e.tenant === tenant && e.advertiser_id === advertiserId);
}

export interface MappingIdentity {
  /** Tenant key: "user:<id>" from the signed-in token (or a service credential's owner). */
  tenant: string;
  /** Who is acting, for the record (the signed-in person, or the service label). */
  actor?: string;
  /** True for a service credential: nobody is there to confirm a mapping. */
  automation: boolean;
}

/**
 * Which tenant this data dir is signed in to. A human session's token carries
 * the tenant id (`sub`); a service credential carries its owner only after a
 * token mint stored it. No tenant means no mapping can be read or written.
 */
export async function resolveMappingIdentity(
  dataDirOverride?: string,
): Promise<{ ok: true; identity: MappingIdentity } | { ok: false; reason: string }> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    const datahub = credentials?.datahub;
    if (datahub) {
      const claims = decodeAccessTokenClaims(datahub.access_token);
      const id = claims.user_id ?? datahub.user_id;
      if (!id) return { ok: false, reason: 'the signed-in session carries no tenant id' };
      return {
        ok: true,
        identity: { tenant: `user:${id}`, actor: claims.actor ?? datahub.person_label, automation: false },
      };
    }
    const service = credentials?.service;
    if (service) {
      const attr = await readServiceAttributionCache(service.client_id, dataDirOverride);
      if (!attr.owner_user_id) {
        return { ok: false, reason: 'the service credential has not reported its owning tenant yet' };
      }
      return {
        ok: true,
        identity: { tenant: `user:${attr.owner_user_id}`, actor: service.label ?? service.client_id, automation: true },
      };
    }
    return { ok: false, reason: 'not signed in to MixShift' };
  } catch (err) {
    return { ok: false, reason: `could not read the sign-in: ${(err as Error).message}` };
  }
}

/** What `dsp readiness` should use for this data dir. Never throws. */
export async function creativeMapForReadiness(dataDirOverride?: string): Promise<CreativeMapInput> {
  const who = await resolveMappingIdentity(dataDirOverride);
  if (!who.ok) return { status: 'unavailable', reason: who.reason };
  const loaded = await loadCreativeMap(dataDirOverride);
  if (!loaded.ok) return { status: 'unavailable', reason: loaded.reason };
  return { status: 'ok', tenant: who.identity.tenant, entries: loaded.entries };
}

/**
 * The ad ids a committed dsp.create_ads made: success[].ad.adId and
 * partialSuccess[].ad.adId (created, with some fields refused). error[] rows
 * made nothing. Ids are kept as strings (they exceed safe integers).
 */
export function createdAdIds(payload: unknown): string[] {
  const out: string[] = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const p = payload as Record<string, unknown>;
  for (const key of ['success', 'partialSuccess']) {
    const list = p[key];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const ad = (row as Record<string, unknown> | null)?.ad as Record<string, unknown> | undefined;
      const id = ad?.adId;
      const s = typeof id === 'string' ? id : typeof id === 'number' && Number.isFinite(id) ? String(id) : undefined;
      if (s && NUMERIC_ID.test(s) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Build the plugin_build entries for one committed dsp.create_ads. Pure, so the
 * command and its test agree on exactly what is recorded.
 */
export function buildEntriesFromCreate(input: {
  tenant: string;
  actor?: string;
  advertiserId: string;
  orderId: string;
  payload: unknown;
  auditId?: string;
  now?: Date;
}): CreativeMappingEntry[] {
  const at = (input.now ?? new Date()).toISOString();
  return createdAdIds(input.payload).map((creativeId) => ({
    tenant: input.tenant,
    advertiser_id: input.advertiserId,
    order_id: input.orderId,
    creative_id: creativeId,
    source: 'plugin_build' as const,
    recorded_at: at,
    ...(input.actor ? { recorded_by: input.actor } : {}),
    ...(input.auditId && /^[A-Za-z0-9_-]{1,128}$/.test(input.auditId) ? { audit_id: input.auditId } : {}),
  }));
}

export function isNumericId(s: string | undefined): s is string {
  return typeof s === 'string' && NUMERIC_ID.test(s);
}
