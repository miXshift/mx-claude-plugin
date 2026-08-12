/**
 * Read-side accessor for a brand's sub-brand binding (mx-ops#6 P1;
 * docs/subbrand-architecture.md §2.1 in mx-legacy-auth).
 *
 * A binding is a normal, optional block on Tier-3 context.yaml (see
 * lib/context/schema.ts's bindingSchema) — this module just isolates the
 * "does this brand have one, and what is it" question so callers don't
 * each re-derive it from a full validateBrandContext() call.
 */

import { validateBrandContext } from '../context/load.js';
import type { BindingBlock } from '../context/schema.js';

/**
 * Read one brand's local context.yaml and return its `binding` block, or
 * null when the brand has no context, fails validation, or has no binding
 * (the overwhelming majority of brands — binding is opt-in and identifies a
 * sub-brand specifically). Never throws: a missing/invalid context is
 * indistinguishable from "not a sub-brand" for this accessor's purpose.
 */
export async function resolveBinding(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<BindingBlock | null> {
  const result = await validateBrandContext(brandSlug, dataDirOverride);
  if (!result.ok) return null;
  return result.context.binding ?? null;
}

/** True iff the brand has a binding at all (any fields; kind need not be set
 *  yet — see the schema's forward/partial-fill tolerance). Convenience for
 *  callers that only need the boolean (e.g. "is this a sub-brand?"). */
export async function isSubBrand(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<boolean> {
  return (await resolveBinding(brandSlug, dataDirOverride)) !== null;
}
