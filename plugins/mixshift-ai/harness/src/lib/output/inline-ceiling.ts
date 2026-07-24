/**
 * Client-side context ceiling for inline query results.
 *
 * The gateway rejects a single request only when it clears its 50k-row / 10 MB
 * caps (see data/query-runner.ts). But a result that clears those caps can
 * still be far too large to hand an LLM verbatim: 45,000 narrow rows serialize
 * to a few MB and, dumped into `data query`'s inline JSON `rows` array plus a
 * full markdown table, flood the model's context.
 *
 * This decides — purely, off the already-buffered rows — whether a single-shot
 * result is small enough to render inline, or should instead spill to a CSV and
 * come back as a compact handle (row_count, columns, out_path) plus a short
 * preview. The ceiling sits WELL below the gateway cap so the model gets a
 * handle+preview long before it would get 45k rows.
 *
 * Escape hatches (surfaced as `--inline` / `--rows N` on `data query`):
 *   - `inline: true`  → render everything inline, no ceiling (power users who
 *     really want the full set in context).
 *   - `rows: N`       → raise the row ceiling to N. Passing it is an explicit
 *     size decision, so the byte ceiling is turned off too (the user owns the
 *     size via the row count). The default path (neither flag) keeps BOTH the
 *     row and byte guards.
 *
 * Pure and dependency-free so it unit-tests without a live query.
 */

/** Default inline row ceiling: at or below this many rows we render inline,
 *  above it we spill. Chosen well under the 50k gateway row cap so a large but
 *  cap-clearing result never floods context. */
export const DEFAULT_INLINE_ROW_CEILING = 500;

/** Default inline byte ceiling: even a modest row count can be wide/heavy, so a
 *  result serializing over this many bytes spills regardless of row count. Held
 *  far under the gateway's 10 MB response cap. */
export const INLINE_BYTE_CEILING = 512 * 1024;

/** How many rows the compact handle carries as a preview when spilling. Small
 *  by design: the point is a taste, not the data — the full set is in the file.
 *  Never exceeds the effective row ceiling (a `--rows 5` spill previews ≤ 5). */
export const INLINE_PREVIEW_ROWS = 20;

export interface InlineDeliveryPlan {
  /** `inline`: render every buffered row. `spill`: write the full set to a file
   *  and return the compact handle + `preview`. */
  mode: 'inline' | 'spill';
  /** Why we spilled — surfaced in the handle so the model can explain it.
   *  Undefined when `mode === 'inline'`. */
  reason?: 'row_ceiling' | 'byte_ceiling';
  /** The effective row ceiling applied (Infinity when `inline: true`). */
  rowCeiling: number;
  /** Output column names (from the first row); empty for a 0-row result. */
  columns: string[];
  /** Preview slice for the handle; empty when `mode === 'inline'`. */
  preview: Array<Record<string, unknown>>;
}

export interface InlineCeilingOptions {
  /** Render everything inline regardless of size (the `--inline` escape hatch). */
  inline?: boolean;
  /** Raise the row ceiling to this many rows (the `--rows N` escape hatch).
   *  Passing it also disables the byte ceiling — see the module doc. Ignored
   *  when `inline` is set. A non-positive value is treated as absent. */
  rows?: number;
}

/**
 * Decide how to deliver a single-shot result that already fits in memory.
 *
 * The row check is applied first and short-circuits BEFORE serializing, so an
 * obviously-over-ceiling result never pays to JSON.stringify tens of thousands
 * of rows just to be told to spill. The byte check runs only when the result is
 * within the row ceiling AND the byte guard is active (default path only).
 */
export function planInlineDelivery(
  rows: Array<Record<string, unknown>>,
  opts: InlineCeilingOptions = {},
): InlineDeliveryPlan {
  const inline = opts.inline === true;
  const explicitRows =
    typeof opts.rows === 'number' && Number.isFinite(opts.rows) && opts.rows > 0
      ? Math.floor(opts.rows)
      : undefined;

  const rowCeiling = inline ? Infinity : explicitRows ?? DEFAULT_INLINE_ROW_CEILING;
  // The byte guard is a heuristic for the DEFAULT path only. `--inline` opts out
  // entirely; `--rows N` is an explicit size decision, so we trust the row count.
  const byteGuardActive = !inline && explicitRows === undefined;

  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

  const spill = (reason: 'row_ceiling' | 'byte_ceiling'): InlineDeliveryPlan => {
    const previewCount = Math.min(
      INLINE_PREVIEW_ROWS,
      Number.isFinite(rowCeiling) ? rowCeiling : INLINE_PREVIEW_ROWS,
      rows.length,
    );
    return { mode: 'spill', reason, rowCeiling, columns, preview: rows.slice(0, previewCount) };
  };

  if (rows.length > rowCeiling) return spill('row_ceiling');
  if (byteGuardActive) {
    const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    if (bytes > INLINE_BYTE_CEILING) return spill('byte_ceiling');
  }
  return { mode: 'inline', rowCeiling, columns, preview: [] };
}

// ---------------------------------------------------------------------------
// Text-document ceiling (the report-document analogue)
// ---------------------------------------------------------------------------

/** Default byte ceiling for an INLINE report document (`report get` with no
 *  `--out`). A decoded doc over this spills to a file and comes back as a handle
 *  + short preview instead of dumping the whole TSV/JSON into context. Held far
 *  under the 25 MB inline-decode cap. */
export const DEFAULT_INLINE_DOC_BYTE_CEILING = 256 * 1024;

/** How many leading lines the report-document handle carries as a preview. */
export const INLINE_DOC_PREVIEW_LINES = 40;

/**
 * Decide whether an already-decoded report document is small enough to print
 * inline, or should spill to a file and return a handle. `inline: true` forces
 * inline; otherwise the byte count is compared to the ceiling.
 */
export function planInlineDocument(
  bytes: number,
  opts: { inline?: boolean } = {},
): { mode: 'inline' | 'spill'; ceiling: number } {
  const ceiling = opts.inline === true ? Infinity : DEFAULT_INLINE_DOC_BYTE_CEILING;
  return { mode: bytes > ceiling ? 'spill' : 'inline', ceiling };
}

/**
 * First `maxLines` lines of `text` for a document preview, plus whether it was
 * truncated. Splits on `\n`; a trailing newline does not count as an extra
 * empty line. Pure — no I/O.
 */
export function previewLines(
  text: string,
  maxLines: number = INLINE_DOC_PREVIEW_LINES,
): { preview: string; truncated: boolean; totalLines: number } {
  // Normalize a single trailing newline so it doesn't inflate the line count.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return { preview: '', truncated: false, totalLines: 0 };
  const lines = body.split('\n');
  const truncated = lines.length > maxLines;
  return {
    preview: lines.slice(0, maxLines).join('\n'),
    truncated,
    totalLines: lines.length,
  };
}
