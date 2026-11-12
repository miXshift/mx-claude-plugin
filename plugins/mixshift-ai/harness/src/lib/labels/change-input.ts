/**
 * Local input rules for `mixshift labels preview`: the label fields, a value check that mirrors what the
 * service will store, `--set` / `--clear` flags, and the CSV file for a bulk change. Pure functions: no
 * network, no files. Everything here is a courtesy that catches a mistake with a row number before a
 * request is made; the service checks every value again and is the authority.
 *
 * CSV format (one change set is built per distinct combination of values):
 *
 *   asin,item_group,tag_1
 *   B0EXAMPLE01,Water Bottles,Spring
 *   B0EXAMPLE02,Water Bottles,<clear>
 *   B0EXAMPLE03,,Spring
 *
 *   - Line 1 is a header. The first column is the identity: `asin` (items) or `campaign_id`
 *     (campaigns); `id` works for either. Every other column is a label field key from
 *     `mixshift labels fields`.
 *   - An empty cell leaves that field alone. `<clear>` removes the label. Anything else is the
 *     new value (leading and trailing spaces are trimmed; case is kept).
 *   - Commas separate cells; a cell with a comma or a quote is wrapped in double quotes, and a
 *     quote inside it is doubled. UTF-8, with or without a byte-order mark.
 *   - At most CHANGE_SET_MAX rows, each id once.
 */

import { CHANGE_SET_MAX } from './write-client.js';
import type { LabelEntity } from './client.js';

/**
 * The most change sets one file may make (one per distinct combination of values). An organization may hold 25
 * uncommitted previews in all, so a file is held to 10: one file cannot use up the allowance that other work,
 * an undo, or a second file needs.
 */
export const FILE_GROUPS_MAX = 10;

/** The marker that clears a label in a CSV cell (and the only value that cannot be set from a file). */
export const CLEAR_MARKER = '<clear>';

interface FieldLimit {
  readonly max: number;
  readonly unit: 'characters' | 'bytes';
}

const TEXT_BYTES = 65_535;
const chars = (max: number): FieldLimit => ({ max, unit: 'characters' });
const bytes = (max: number): FieldLimit => ({ max, unit: 'bytes' });

/** The label fields of each entity, with the most the service stores in each (items: seller and vendor share the strictest common limit). */
const FIELD_LIMITS: Record<LabelEntity, Readonly<Record<string, FieldLimit>>> = {
  item: {
    item_group: chars(250),
    nickname: bytes(TEXT_BYTES),
    brand: chars(250),
    parent_asin: chars(250),
    label_1: bytes(TEXT_BYTES),
    label_2: bytes(TEXT_BYTES),
    tag_1: chars(250),
    tag_2: chars(250),
    tag_3: chars(250),
    tag_4: chars(250),
  },
  campaign: {
    item_group: chars(250),
    brand: chars(200),
    label_1: chars(200),
    label_2: chars(200),
    tag_1: chars(200),
    tag_2: chars(200),
    tag_3: chars(200),
    tag_4: chars(200),
    manager: chars(200),
    objective: chars(200),
  },
};

export const fieldKeysFor = (entity: LabelEntity): string[] => Object.keys(FIELD_LIMITS[entity]);

/** Control, bidirectional and zero-width characters, tab and line breaks included: a label is one line of plain text. */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

export type ValueCheck = { ok: true; value: string } | { ok: false; message: string };

/** One new value for a field, after the trim rule. A blank is not a value: to remove a label, clear it. */
export function checkLabelValue(entity: LabelEntity, field: string, raw: string): ValueCheck {
  const limit = FIELD_LIMITS[entity][field];
  if (!limit) return { ok: false, message: `${field} is not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (run \`mixshift labels fields\` for the keys)` };
  const value = raw.trim();
  if (value === '') return { ok: false, message: `a value cannot be blank (to remove the label, clear it)` };
  if (UNSAFE_TEXT.test(value)) return { ok: false, message: 'a label is plain text on one line: no tabs, line breaks or control characters' };
  const size = limit.unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : [...value].length;
  if (size > limit.max) return { ok: false, message: `the value is longer than the ${limit.max} ${limit.unit} ${field} holds` };
  return { ok: true, value };
}

/**
 * Does a value start with a character a spreadsheet reads as a formula (= + - @)? The service stores such a value
 * as given through the API (`--set`), but says a FILE import must reject or neutralize it before it reaches a cell a
 * person opens in a spreadsheet. A file is rejected here, with its line.
 */
export function startsLikeFormula(value: string): boolean {
  return /^[=+\-@]/.test(value);
}

/** An id of this entity as the service takes it: ASINs upper-cased, campaign ids as 1 to 20 digits. */
export function checkEntityId(entity: LabelEntity, raw: string): { ok: true; id: string } | { ok: false; message: string } {
  const id = raw.trim();
  if (id === '') return { ok: false, message: 'the id is empty' };
  if (entity === 'campaign') {
    return /^[0-9]{1,20}$/.test(id) ? { ok: true, id } : { ok: false, message: 'a campaign id is the Amazon campaign id: 1 to 20 digits' };
  }
  if (id.length > 250 || UNSAFE_TEXT.test(id) || /\s/.test(id)) return { ok: false, message: 'an item id is an ASIN, with no spaces or control characters' };
  return { ok: true, id: id.toUpperCase() };
}

export type FieldSet = Record<string, string | null>;

/**
 * `--set field=value` (repeatable) and `--clear field` (repeatable) into the service's `set` map:
 * a value, or null to clear. A field named twice, or both set and cleared, is refused.
 */
export function parseSetFlags(entity: LabelEntity, sets: readonly string[], clears: readonly string[]): { ok: true; set: FieldSet } | { ok: false; message: string } {
  const set: FieldSet = {};
  for (const item of sets) {
    const eq = item.indexOf('=');
    if (eq <= 0) return { ok: false, message: '--set takes field=value, for example --set item_group="Water Bottles".' };
    const field = item.slice(0, eq).trim().toLowerCase();
    if (!FIELD_LIMITS[entity][field]) return { ok: false, message: `--set ${field}: ${field} is not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).` };
    if (field in set) return { ok: false, message: `${field} is named more than once.` };
    const checked = checkLabelValue(entity, field, item.slice(eq + 1));
    if (!checked.ok) return { ok: false, message: `--set ${field}: ${checked.message}.` };
    set[field] = checked.value;
  }
  for (const raw of clears) {
    const field = raw.trim().toLowerCase();
    if (!FIELD_LIMITS[entity][field]) return { ok: false, message: `--clear ${field}: ${field} is not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).` };
    if (field in set) return { ok: false, message: `${field} is named more than once (set and cleared, or cleared twice).` };
    set[field] = null;
  }
  return { ok: true, set };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

interface CsvRecord {
  /** 1-based line the record starts on (what an editor shows). */
  line: number;
  cells: string[];
}

/** RFC 4180 CSV: quoted cells may hold commas, doubled quotes and line breaks. Blank lines are skipped. */
export function parseCsv(text: string): { ok: true; records: CsvRecord[] } | { ok: false; message: string } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let quotedCell = false;
  let line = 1;
  let startLine = 1;
  let pending = false; // anything seen on this record
  const endCell = () => {
    cells.push(cell);
    cell = '';
    quotedCell = false;
  };
  const endRecord = () => {
    if (pending) {
      const wasQuoted = quotedCell;
      endCell();
      if (!(cells.length === 1 && cells[0] === '' && !wasQuoted)) records.push({ line: startLine, cells });
    }
    cells = [];
    pending = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
      if (!pending) {
        pending = true;
        startLine = line;
      }
      continue;
    }
    if (ch === '"') return { ok: false, message: `line ${line}: a quote in the middle of a cell. Wrap the whole cell in double quotes and double any quote inside it.` };
    if (ch === ',') {
      if (!pending) {
        pending = true;
        startLine = line;
      }
      endCell();
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      continue;
    }
    if (!pending) {
      pending = true;
      startLine = line;
    }
    if (quotedCell) return { ok: false, message: `line ${line}: text after a closing quote. Check the quotes in that row.` };
    cell += ch;
  }
  if (inQuotes) return { ok: false, message: `line ${startLine}: a quoted cell is never closed.` };
  endRecord();
  return { ok: true, records };
}

export interface CsvGroup {
  /** The ids that share this exact set of changes, in file order. */
  ids: string[];
  set: FieldSet;
  /** The file's line numbers, parallel to `ids`. */
  lines: number[];
}

export type CsvResult =
  | { ok: true; rows: number; fields: string[]; groups: CsvGroup[] }
  | { ok: false; errors: string[]; more: number };

/** Most errors listed before "and N more". */
const ERROR_LIST_MAX = 20;

const identityHeader = (entity: LabelEntity): readonly string[] => (entity === 'item' ? ['asin', 'id'] : ['campaign_id', 'id']);

/**
 * Validate a change file against the rules above and group its rows. Every problem found is reported
 * with its line number (up to ERROR_LIST_MAX), so one run shows what to fix, not one error at a time.
 * Nothing is built when anything is wrong.
 */
export function parseChangeCsv(text: string, entity: LabelEntity): CsvResult {
  const errors: string[] = [];
  const fail = (): CsvResult => ({ ok: false, errors: errors.slice(0, ERROR_LIST_MAX), more: Math.max(0, errors.length - ERROR_LIST_MAX) });

  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.message], more: 0 };
  const [header, ...rows] = parsed.records;
  if (!header) return { ok: false, errors: ['The file is empty. It needs a header line, then one row per item or campaign.'], more: 0 };

  const names = header.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (names.length === 1 && header.cells[0]!.includes(';')) {
    return { ok: false, errors: ['Line 1: cells are separated by semicolons. Save the file with commas (in a spreadsheet: CSV UTF-8, comma delimited).'], more: 0 };
  }
  const allowedIdentity = identityHeader(entity);
  if (!allowedIdentity.includes(names[0]!)) {
    errors.push(`Line ${header.line}: the first column must be ${entity === 'item' ? '"asin"' : '"campaign_id"'} (or "id"), the item or campaign each row changes; it is "${names[0]}".`);
  }
  const fields = names.slice(1);
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (f === '') errors.push(`Line ${header.line}: column ${i + 2} has no name.`);
    else if (!FIELD_LIMITS[entity][f]) errors.push(`Line ${header.line}: "${header.cells[i + 1]!.trim()}" is not a label field of ${entity === 'item' ? 'items' : 'campaigns'} (keys: ${fieldKeysFor(entity).join(', ')}).`);
    else if (seen.has(f)) errors.push(`Line ${header.line}: the column ${f} appears twice.`);
    seen.add(f);
  });
  if (fields.length === 0) errors.push(`Line ${header.line}: the file has an id column and no label columns. Add at least one field key as a column.`);
  if (rows.length === 0 && errors.length === 0) errors.push('The file has a header and no rows.');
  if (rows.length > CHANGE_SET_MAX) {
    errors.push(
      `The file has ${rows.length} rows, and one change set holds at most ${CHANGE_SET_MAX} items or campaigns. Split it into files of at most ${CHANGE_SET_MAX} rows and preview each one.`,
    );
  }
  if (errors.length > 0) return fail();

  const idLine = new Map<string, number>();
  const groups = new Map<string, CsvGroup>();
  for (const rec of rows) {
    if (rec.cells.length !== names.length) {
      errors.push(`Line ${rec.line}: ${rec.cells.length} cell${rec.cells.length === 1 ? '' : 's'}, but the header has ${names.length}.`);
      continue;
    }
    const id = checkEntityId(entity, rec.cells[0]!);
    if (!id.ok) {
      errors.push(`Line ${rec.line}: ${id.message}.`);
      continue;
    }
    const first = idLine.get(id.id);
    if (first !== undefined) {
      errors.push(`Line ${rec.line}: this id already appears on line ${first}. Each item or campaign goes in once.`);
      continue;
    }
    idLine.set(id.id, rec.line);
    const set: FieldSet = {};
    let bad = false;
    fields.forEach((f, i) => {
      const raw = rec.cells[i + 1]!.trim();
      if (raw === '') return;
      if (raw.toLowerCase() === CLEAR_MARKER) {
        set[f] = null;
        return;
      }
      if (startsLikeFormula(raw)) {
        errors.push(`Line ${rec.line}, ${f}: a value in a file cannot start with = + - or @ (a spreadsheet would read it as a formula). Change the value, or set it with BTlabels preview --setBT instead.`.replace(/BT/g, '`'));
        bad = true;
        return;
      }
      const checked = checkLabelValue(entity, f, raw);
      if (!checked.ok) {
        errors.push(`Line ${rec.line}, ${f}: ${checked.message}.`);
        bad = true;
      } else set[f] = checked.value;
    });
    if (bad) continue;
    if (Object.keys(set).length === 0) {
      errors.push(`Line ${rec.line}: every label cell is empty, so this row changes nothing. Fill a cell, or remove the row.`);
      continue;
    }
    const key = JSON.stringify(Object.keys(set).sort().map((k) => [k, set[k]]));
    const group = groups.get(key) ?? { ids: [], set, lines: [] };
    group.ids.push(id.id);
    group.lines.push(rec.line);
    groups.set(key, group);
  }
  if (errors.length > 0) return fail();
  if (groups.size > FILE_GROUPS_MAX) {
    errors.push(
      `This file makes ${groups.size} different combinations of values, and each combination is its own change set; one file may make at most ${FILE_GROUPS_MAX} (an organization may hold 25 uncommitted previews in all, and one file should not use them up). Files work best when many rows share the same values. Give more rows the same values, or split the file.`,
    );
    return fail();
  }
  return { ok: true, rows: rows.length, fields, groups: [...groups.values()] };
}
