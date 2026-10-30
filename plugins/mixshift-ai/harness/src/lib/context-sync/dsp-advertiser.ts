/**
 * Declaring a DSP advertiser on a brand's context.yaml (mx-ops#205).
 *
 * MixShift files a DSP change on a brand only when exactly one brand's
 * context declares the advertiser as a QUOTED digit string. This module is the
 * pure half of `mixshift context dsp-advertiser assign|unassign`: pick the
 * account entry, edit the YAML in place (comments and layout preserved, the id
 * written as a double-quoted scalar), and prove the result with the schema AND
 * with the gateway's own reading of the file. It never touches the disk or the
 * network; the command does the lookup, pull, write and push.
 */

import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';
import type { Document, Pair } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { contextSchema, normalizeLegacyTacosFields } from '../context/schema.js';

export const DSP_ADVERTISER_ID_PATTERN = /^\d{1,64}$/;

export function isValidDspAdvertiserId(id: string): boolean {
  return DSP_ADVERTISER_ID_PATTERN.test(id);
}

export interface AccountChoice {
  seller_id: number | string;
  amazon_seller_id?: string;
  seller_name?: string;
  marketplace?: string;
  role?: string;
}

/**
 * The gateway's reading of a context.yaml, ported in behavior.
 *
 * Ported from mx-gateway `extractDspAdvertiserIds` (src/context/store.ts) as of
 * origin/main e42b4a853266d4269d770f17b9740b48ac544a82. It is line-based and
 * accepts only QUOTED digit strings: a scalar `dsp_advertiser_id: "<id>"`, a
 * one-line flow list `dsp_advertiser_ids: ["<id>", ...]`, or a block list
 * (blank and comment lines allowed between items; a bad item ends the list).
 * Anything else declares nothing (the gateway also logs a warning; not ported).
 * `assign` and `unassign` prove their edit against THIS function, not only
 * against a YAML parser, because it is what decides which brand a DSP change is
 * filed on. Keep it in step with the gateway; the parity tests pin the shapes.
 */
export function gatewayParseDspAdvertiserIds(content: string): string[] {
  const ids: string[] = [];
  const token = (raw: string): string | null => {
    const m = /^(["'])(\d{1,64})\1$/.exec(raw.trim());
    return m ? (m[2] as string) : null;
  };
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const sm = /^[ \t]*-?[ \t]*dsp_advertiser_id:[ \t]*([^#\r\n]*?)[ \t]*(?:#[^\r\n]*)?\r?$/.exec(line);
    if (sm) {
      const t = token(sm[1] as string);
      if (t) ids.push(t);
      continue;
    }
    const km = /^[ \t]*-?[ \t]*dsp_advertiser_ids:[ \t]*(.*?)[ \t]*(?:#.*)?\r?$/.exec(line);
    if (!km) continue;
    const rest = (km[1] as string).trim();
    if (rest.startsWith('[') && rest.endsWith(']')) {
      for (const part of rest.slice(1, -1).split(',')) {
        if (part.trim() === '') continue;
        const t = token(part);
        if (t) ids.push(t);
      }
    } else if (rest === '') {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] as string;
        if (/^[ \t]*(?:#.*)?\r?$/.test(next)) continue;
        const im = /^[ \t]*-[ \t]+([^#\r\n]*?)[ \t]*(?:#.*)?\r?$/.exec(next);
        if (!im) break;
        const t = token(im[1] as string);
        if (t) ids.push(t);
        else break;
      }
    }
  }
  return ids;
}

export type PlanRefusalReason =
  | 'unreadable_yaml'
  | 'no_accounts'
  | 'unexpected_change'
  | 'existing_context_invalid'
  | 'account_not_found'
  | 'flow_style_account'
  | 'existing_value_invalid'
  | 'result_not_recognized'
  | 'result_invalid';

export type PlanEdit =
  | 'added'
  | 'converted'
  | 'appended'
  | 'replaced_empty'
  | 'already_in_file'
  | 'removed'
  | 'not_declared';

export type PlanResult =
  | {
      ok: true;
      /** The new file text (equal to the input when nothing changes). */
      content: string;
      changed: boolean;
      account: AccountChoice | null;
      edit: PlanEdit;
      removed_lines: string[];
      added_lines: string[];
    }
  | {
      ok: false;
      reason: PlanRefusalReason;
      message: string;
      accounts?: AccountChoice[];
    };

function describeAccount(a: AccountChoice): string {
  const parts = [`seller_id ${a.seller_id}`];
  if (a.amazon_seller_id) parts.push(`amazon_seller_id ${a.amazon_seller_id}`);
  if (a.seller_name) parts.push(a.seller_name);
  if (a.marketplace) parts.push(a.marketplace);
  if (a.role) parts.push(`role ${a.role}`);
  return parts.join(', ');
}

export function describeAccounts(accounts: AccountChoice[]): string {
  return accounts.map((a) => `  - ${describeAccount(a)}`).join('\n');
}

function accountChoiceOf(map: YAMLMap): AccountChoice {
  const json = map.toJSON() as Record<string, unknown>;
  return {
    seller_id: (typeof json.seller_id === 'number' || typeof json.seller_id === 'string'
      ? json.seller_id
      : '?') as number | string,
    ...(typeof json.amazon_seller_id === 'string' ? { amazon_seller_id: json.amazon_seller_id } : {}),
    ...(typeof json.seller_name === 'string' ? { seller_name: json.seller_name } : {}),
    ...(typeof json.marketplace === 'string' ? { marketplace: json.marketplace } : {}),
    ...(typeof json.role === 'string' ? { role: json.role } : {}),
  };
}

type ValueState = { kind: 'empty' } | { kind: 'ids'; ids: string[] } | { kind: 'invalid' };

/** null, ~, an empty value and an empty list all mean "not declared". */
function valueState(value: unknown, allowScalar: boolean): ValueState {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (isScalar(value)) {
    if (value.value === null || value.value === undefined) return { kind: 'empty' };
    if (allowScalar && typeof value.value === 'string' && isValidDspAdvertiserId(value.value)) {
      return { kind: 'ids', ids: [value.value] };
    }
    return { kind: 'invalid' };
  }
  if (isSeq(value)) {
    if (value.items.length === 0) return { kind: 'empty' };
    const out: string[] = [];
    for (const item of value.items) {
      if (!isScalar(item) || typeof item.value !== 'string' || !isValidDspAdvertiserId(item.value)) {
        return { kind: 'invalid' };
      }
      out.push(item.value);
    }
    return { kind: 'ids', ids: out };
  }
  return { kind: 'invalid' };
}

function diffLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const only = (x: string[], y: string[]): string[] => {
    const count = new Map<string, number>();
    for (const l of y) count.set(l, (count.get(l) ?? 0) + 1);
    const out: string[] = [];
    for (const l of x) {
      const n = count.get(l) ?? 0;
      if (n > 0) count.set(l, n - 1);
      else out.push(l);
    }
    return out;
  };
  return { added: only(b, a), removed: only(a, b) };
}

type Parsed =
  | { ok: true; doc: Document; items: YAMLMap[]; flow: boolean; caps: number[] }
  | { ok: false; result: PlanResult };

function parseAccounts(content: string): Parsed {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'unreadable_yaml',
        message: `context.yaml is not valid YAML: ${doc.errors[0]?.message ?? 'parse error'}`,
      },
    };
  }
  const accountsNode = doc.get('accounts', true);
  const seq = isSeq(accountsNode) ? accountsNode : null;
  const items = seq ? seq.items.filter(isMap) : [];
  const flow = Boolean(seq?.flow) || items.some((m) => m.flow === true);
  // Where each account ends: the start of the next account's line, or the end of the list.
  const caps = items.map((_, i) => {
    const next = items[i + 1]?.items[0]?.key as { range?: [number, number, number] } | undefined;
    if (next?.range) return content.lastIndexOf('\n', next.range[0] - 1) + 1;
    const r = (seq as { range?: [number, number, number] } | null)?.range;
    return r ? r[1] : content.length;
  });
  return { ok: true, doc, items, flow, caps };
}

const FLOW_MESSAGE =
  "This brand's accounts are written in flow style (inline braces or brackets). The DSP " +
  'advertiser declaration has to sit on its own line, and MixShift does not read it from an ' +
  'inline account. Nothing was changed. Rewrite the accounts as a normal indented list ' +
  '(one key per line), then run this again.';

/**
 * Pick the account entry: `--account` (seller_id or amazon_seller_id), else
 * the single account with role primary, else the first account. The service
 * attributes per brand and ignores the account, so this is never a question.
 */
function chooseAccount(
  items: YAMLMap[],
  choices: AccountChoice[],
  selector?: string,
): { ok: true; target: YAMLMap } | { ok: false; result: PlanResult } {
  if (selector !== undefined) {
    const idx = choices.findIndex(
      (c) => String(c.seller_id) === selector || c.amazon_seller_id === selector,
    );
    if (idx < 0) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: 'account_not_found',
          message: `No account on this brand matches --account ${selector}. Accounts:\n${describeAccounts(choices)}`,
          accounts: choices,
        },
      };
    }
    return { ok: true, target: items[idx] as YAMLMap };
  }
  const primaries = choices.map((c, i) => (c.role === 'primary' ? i : -1)).filter((i) => i >= 0);
  if (primaries.length === 1) return { ok: true, target: items[primaries[0] as number] as YAMLMap };
  return { ok: true, target: items[0] as YAMLMap };
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

// ---------------------------------------------------------------------------
// Surgical text edits. The file is never re-serialized: only the DSP line(s)
// change, every other byte (numbers, quoting, indentation, line endings) stays.
// ---------------------------------------------------------------------------

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

class Text {
  readonly eol: string;
  constructor(readonly s: string) {
    this.eol = s.includes('\r\n') ? '\r\n' : '\n';
  }
  /** Start offset of the line holding offset `off`. */
  ls(off: number): number {
    return this.s.lastIndexOf('\n', off - 1) + 1;
  }
  /** Offset just past the line holding `off` (including its terminator). */
  lend(off: number): number {
    const i = this.s.indexOf('\n', off);
    return i < 0 ? this.s.length : i + 1;
  }
  /** The line's text without its terminator. */
  body(lineStart: number): string {
    const e = this.lend(lineStart);
    return this.s.slice(lineStart, e).replace(/\r?\n$/, '');
  }
  /** The line's terminator ('' on an unterminated last line). */
  term(lineStart: number): string {
    return /\r?\n$/.exec(this.s.slice(lineStart, this.lend(lineStart)))?.[0] ?? '';
  }
}

function apply(content: string, edits: TextEdit[]): string {
  let out = content;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

const q = (id: string): string => `"${id}"`;

type Range3 = [number, number, number];

interface PairLines {
  /** Offset of the key itself (after any "- " of a first key). */
  ks: number;
  /** Offset of the start of the key's line. */
  start: number;
  /** Offset just past the last line the pair occupies. */
  end: number;
  /** Start offset of the last item line of a block list (when there is one). */
  lastItemLine: number | null;
  /** The flow list spans several lines. */
  multiLineFlow: boolean;
}

/**
 * Where a pair sits in the text. The end is the line of the last real content:
 * capped at `cap` (the start of the next account), then trailing blank and
 * comment-only lines are trimmed off, because the parser's range can run over
 * them.
 */
function pairLines(t: Text, pair: Pair, cap: number): PairLines {
  const key = pair.key as { range?: Range3 };
  const ks = key.range?.[0] ?? 0;
  const start = t.ls(ks);
  let e = key.range?.[1] ?? ks;
  let lastItemLine: number | null = null;
  let multiLineFlow = false;
  const v = pair.value as { range?: Range3 } | null;
  if (isSeq(pair.value) && v?.range) {
    if (pair.value.flow) {
      multiLineFlow = t.ls(v.range[0]) !== t.ls(Math.max(v.range[0], v.range[1] - 1));
      e = Math.max(e, v.range[1]);
    } else if (pair.value.items.length > 0) {
      const last = pair.value.items[pair.value.items.length - 1] as { range?: Range3 };
      if (last.range) {
        lastItemLine = t.ls(last.range[0]);
        e = Math.max(e, last.range[1]);
      }
    }
  } else if (v?.range) {
    e = Math.max(e, v.range[1]);
  }
  e = Math.min(e, cap);
  const keyLineEnd = t.lend(ks);
  let end = Math.max(keyLineEnd, t.lend(Math.max(ks, e - 1)));
  while (end > keyLineEnd) {
    const prevStart = t.ls(end - 1);
    if (/^\s*(#.*)?$/.test(t.body(prevStart))) end = prevStart;
    else break;
  }
  return { ks, start, end, lastItemLine, multiLineFlow };
}

/** The key's own indentation as spaces (a "- " before a first key counts as spaces). */
function keyIndent(t: Text, map: YAMLMap): string {
  const first = map.items[0]?.key as { range?: Range3 } | undefined;
  const off = first?.range?.[0] ?? 0;
  return ' '.repeat(off - t.ls(off));
}

function findPair(map: YAMLMap, name: string): Pair | undefined {
  return map.items.find((p: Pair) => isScalar(p.key) && p.key.value === name);
}

/** The comment (with its leading space) at the end of a line, or ''. */
function trailingComment(line: string): string {
  return /(\s+#.*)$/.exec(line)?.[1] ?? '';
}

function listLine(ids: string[], comment: string): string {
  return `dsp_advertiser_ids: [${ids.map(q).join(', ')}]${comment}`;
}

/**
 * Remove a pair. An ordinary key loses its whole lines. A key that sits right
 * after the account's "- " (a first key) is removed from the key's own offset
 * up to the next key, so the dash stays and the item stays valid.
 */
function removePair(t: Text, map: YAMLMap, pair: Pair, pl: PairLines): TextEdit {
  const prefix = t.s.slice(pl.start, pl.ks);
  if (!prefix.includes('-')) return { start: pl.start, end: pl.end, text: '' };
  const next = map.items[map.items.indexOf(pair) + 1]?.key as { range?: Range3 } | undefined;
  const nks = next?.range?.[0];
  return { start: pl.ks, end: nks !== undefined && nks >= pl.end ? nks : pl.end, text: '' };
}

const MULTI_LINE_FLOW_MESSAGE =
  'The file lists advertisers in a form MixShift does not read (a list split over several lines ' +
  'inside brackets). Nothing was changed. Rewrite that list as one line or a normal indented ' +
  'list, then run this again.';

const DSP_LINE = /^\s*-?\s*dsp_advertiser_ids?:/;
const DSP_ITEM = /^\s*-\s*(["'])\d{1,64}\1\s*(#.*)?$/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;
const dashed = (l: string): boolean => /^\s*-/.test(l);
const stripLead = (l: string): string => l.replace(/^[ \t]*(?:-[ \t]+)?/, '');

/**
 * Every changed line must be a DSP line, or a quoted-digit item under one. The
 * only other change allowed is on unassign of a first key: the lines after it
 * may move their indentation or take over the "- ". A DSP line may never lose
 * or gain its dash on assign.
 */
function onlyDspLines(removed: string[], added: string[], op: 'assign' | 'unassign'): boolean {
  const isDsp = (l: string): boolean => DSP_LINE.test(l) || DSP_ITEM.test(l);
  const remDsp = removed.filter(isDsp);
  const addDsp = added.filter(isDsp);
  let remOther = removed.filter((l) => !isDsp(l));
  const addOther = added.filter((l) => !isDsp(l));
  const remDashed = remDsp.filter((l) => DSP_LINE.test(l) && dashed(l)).length;
  const addDashed = addDsp.filter((l) => DSP_LINE.test(l) && dashed(l)).length;
  if (op === 'assign') {
    if (remOther.length > 0 || addOther.length > 0 || remDashed !== addDashed) return false;
    return true;
  }
  if (addDashed > remDashed) return false;
  remOther = remOther.filter((l) => !BLANK_OR_COMMENT.test(l));
  if (remOther.length !== addOther.length) return false;
  const a = remOther.map(stripLead).sort();
  const b = addOther.map(stripLead).sort();
  return a.every((l, i) => l === b[i]);
}

type Plain = Record<string, unknown>;
const accountsOf = (o: unknown): Plain[] => {
  const a = (o as Plain | null)?.accounts;
  return Array.isArray(a) ? (a as Plain[]) : [];
};
const validIdsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter(
    (x): x is string => typeof x === 'string' && isValidDspAdvertiserId(x),
  );
const dspIdsOf = (a: Plain): string[] => [
  ...validIdsOf(a.dsp_advertiser_id),
  ...(Array.isArray(a.dsp_advertiser_ids) ? validIdsOf(a.dsp_advertiser_ids) : []),
];

/**
 * Structural proof, read by the YAML parser and not by lines: with every DSP key
 * taken out of every account, the old and new documents are identical, and the
 * DSP values are exactly what the operation should have made them. Any
 * splicing slip fails closed here.
 */
function structuralProblem(
  before: string,
  after: string,
  op: 'assign' | 'unassign',
  id: string,
  targetIdx: number,
): string | null {
  let o: unknown;
  let n: unknown;
  try {
    o = parseYaml(before);
    n = parseYaml(after);
  } catch {
    return 'does not parse';
  }
  const strip = (doc: unknown): unknown => {
    const c = structuredClone(doc);
    for (const a of accountsOf(c)) {
      if (a && typeof a === 'object') {
        delete a.dsp_advertiser_id;
        delete a.dsp_advertiser_ids;
      }
    }
    return c;
  };
  if (!isDeepStrictEqual(strip(o), strip(n))) return 'something other than the DSP keys changed';
  const oa = accountsOf(o);
  const na = accountsOf(n);
  if (oa.length !== na.length) return 'the number of accounts changed';
  for (let i = 0; i < oa.length; i++) {
    const before_ = oa[i] as Plain;
    const after_ = na[i] as Plain;
    const old = dspIdsOf(before_);
    let expected = old;
    let touched = false;
    if (op === 'assign' && i === targetIdx) {
      expected = [...old, id];
      touched = true;
    } else if (op === 'unassign' && old.includes(id)) {
      expected = old.filter((v) => v !== id);
      touched = true;
    }
    if (!sameSet(dspIdsOf(after_), expected)) return `account ${i + 1} holds the wrong DSP advertisers`;
    if (!touched) {
      const raw = (a: Plain): unknown => [a.dsp_advertiser_id, a.dsp_advertiser_ids];
      if (!isDeepStrictEqual(raw(before_), raw(after_))) return `account ${i + 1} changed`;
    }
  }
  return null;
}

/** null when the ORIGINAL file already passes the schema; else which field fails. */
function existingContextProblem(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = normalizeLegacyTacosFields(parseYaml(content));
  } catch (err) {
    return `it does not parse (${err instanceof Error ? err.message : String(err)})`;
  }
  const r = contextSchema.safeParse(parsed);
  if (r.success) return null;
  const first = r.error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join('.') : '(root)';
  return `${where}: ${first?.message ?? 'invalid'}`;
}

function existingInvalid(problem: string): PlanResult {
  return {
    ok: false,
    reason: 'existing_context_invalid',
    message:
      `This brand's context.yaml already fails the brand context schema (${problem}). Nothing was ` +
      'changed. Fix that first (the mx-brand-context skill, or `mixshift brand validate`), then run this again.',
  };
}

function finish(
  content: string,
  edits: TextEdit[],
  expected: string[],
  account: AccountChoice | null,
  edit: PlanEdit,
  ctx: { op: 'assign' | 'unassign'; id: string; targetIdx: number },
): PlanResult {
  const next = apply(content, edits);
  const { removed, added } = diffLines(content, next);
  const unexpected = (why: string): PlanResult => ({
    ok: false,
    reason: 'unexpected_change',
    message:
      `The planned edit would change more than the DSP advertiser lines (${why}). Nothing was ` +
      "written. Check this brand's DSP advertiser lines by hand.",
  });
  if (!onlyDspLines(removed, added, ctx.op)) return unexpected('a line that is not a DSP line');
  const structural = structuralProblem(content, next, ctx.op, ctx.id, ctx.targetIdx);
  if (structural) return unexpected(structural);
  const verdict = verifyResult(next, expected);
  if (verdict) return { ok: false, reason: verdict.reason, message: verdict.message };
  return { ok: true, content: next, changed: next !== content, account, edit, removed_lines: removed, added_lines: added };
}

/**
 * Plan declaring `advertiserId` on the brand, by inserting, replacing or
 * removing only the DSP line(s) inside the chosen account. Proved three ways:
 * the changed lines are DSP lines, the parsed documents differ only in the DSP
 * values, and the gateway's reader sees old ids plus this one.
 */
export function planDspAssignment(
  content: string,
  advertiserId: string,
  accountSelector?: string,
): PlanResult {
  const parsed = parseAccounts(content);
  if (!parsed.ok) return parsed.result;
  const { items, flow, caps } = parsed;
  if (items.length === 0) {
    return {
      ok: false,
      reason: 'no_accounts',
      message:
        'This brand has no accounts[] entry in its context.yaml yet. Set the brand up first ' +
        '(the mx-brand-context skill), then declare the DSP advertiser.',
    };
  }
  const problem = existingContextProblem(content);
  if (problem) return existingInvalid(problem);
  if (flow) return { ok: false, reason: 'flow_style_account', message: FLOW_MESSAGE };

  const choices = items.map(accountChoiceOf);
  const chosen = chooseAccount(items, choices, accountSelector);
  if (!chosen.ok) return chosen.result;
  const target = chosen.target;
  const targetIdx = items.indexOf(target);
  const cap = caps[targetIdx] as number;
  const account = accountChoiceOf(target);

  const oldIds = gatewayParseDspAdvertiserIds(content);
  if (oldIds.includes(advertiserId)) {
    return { ok: true, content, changed: false, account, edit: 'already_in_file', removed_lines: [], added_lines: [] };
  }

  const t = new Text(content);
  const indent = keyIndent(t, target);
  const singlePair = findPair(target, 'dsp_advertiser_id');
  const listPair = findPair(target, 'dsp_advertiser_ids');
  const list: ValueState = listPair ? valueState(listPair.value, false) : { kind: 'empty' };
  const single: ValueState = singlePair ? valueState(singlePair.value, true) : { kind: 'empty' };
  if (list.kind === 'invalid' || single.kind === 'invalid') {
    return {
      ok: false,
      reason: 'existing_value_invalid',
      message:
        'The account already has a DSP advertiser value that is not a quoted string of digits ' +
        '(an unquoted id, or a single value under dsp_advertiser_ids, declares nothing). Fix that ' +
        'line by hand first; nothing was changed.',
    };
  }
  const yamlIds = [...(list.kind === 'ids' ? list.ids : []), ...(single.kind === 'ids' ? single.ids : [])];
  if (yamlIds.includes(advertiserId)) {
    return { ok: false, reason: 'result_not_recognized', message: MULTI_LINE_FLOW_MESSAGE };
  }

  const edits: TextEdit[] = [];
  let edit: PlanEdit;
  const replacePair = (pl: PairLines, text: string): void => {
    // From the key's own offset, so a first key keeps its "- "; keep the line's terminator.
    edits.push({ start: pl.ks, end: pl.end, text: text + t.term(t.ls(pl.end - 1)) });
  };

  if (listPair && list.kind === 'ids' && isSeq(listPair.value)) {
    const pl = pairLines(t, listPair, cap);
    if (listPair.value.flow) {
      if (pl.multiLineFlow) return { ok: false, reason: 'result_not_recognized', message: MULTI_LINE_FLOW_MESSAGE };
      replacePair(pl, listLine([...list.ids, advertiserId], trailingComment(t.body(pl.start))));
    } else {
      const lastLine = pl.lastItemLine as number;
      const prefix = /^[ \t]*-[ \t]+/.exec(t.body(lastLine))?.[0] ?? `${indent}- `;
      const at = t.lend(lastLine);
      const needsEol = t.term(lastLine) === '';
      edits.push({ start: at, end: at, text: `${needsEol ? t.eol : ''}${prefix}${q(advertiserId)}${needsEol ? '' : t.eol}` });
    }
    edit = 'appended';
  } else if (singlePair && single.kind === 'ids') {
    const pl = pairLines(t, singlePair, cap);
    replacePair(pl, listLine([single.ids[0] as string, advertiserId], trailingComment(t.body(pl.start))));
    if (listPair) edits.push(removePair(t, target, listPair, pairLines(t, listPair, cap))); // an empty leftover key
    edit = 'converted';
  } else if (singlePair) {
    // An empty scalar key (null, ~, blank): give it the id in place.
    const pl = pairLines(t, singlePair, cap);
    replacePair(pl, `dsp_advertiser_id: ${q(advertiserId)}${trailingComment(t.body(pl.start))}`);
    if (listPair) edits.push(removePair(t, target, listPair, pairLines(t, listPair, cap)));
    edit = 'replaced_empty';
  } else if (listPair) {
    const pl = pairLines(t, listPair, cap);
    replacePair(pl, listLine([advertiserId], trailingComment(t.body(pl.start))));
    edit = 'replaced_empty';
  } else {
    const last = target.items[target.items.length - 1] as Pair;
    const at = pairLines(t, last, cap).end;
    const unterminated = t.term(t.ls(at - 1)) === '';
    edits.push({
      start: at,
      end: at,
      text: unterminated
        ? `${t.eol}${indent}dsp_advertiser_id: ${q(advertiserId)}`
        : `${indent}dsp_advertiser_id: ${q(advertiserId)}${t.eol}`,
    });
    edit = 'added';
  }
  return finish(content, edits, [...oldIds, advertiserId], account, edit, {
    op: 'assign',
    id: advertiserId,
    targetIdx,
  });
}

/**
 * Plan removing `advertiserId` from every account of this brand that declares
 * it, by removing or rewriting only the DSP line(s). A list that keeps ids
 * stays a list. Proved like assign, with new ids = old ids minus this one.
 */
export function planDspUnassignment(content: string, advertiserId: string): PlanResult {
  const parsed = parseAccounts(content);
  if (!parsed.ok) return parsed.result;
  const { items, caps } = parsed;
  const problem = existingContextProblem(content);
  if (problem) return existingInvalid(problem);
  const oldIds = gatewayParseDspAdvertiserIds(content);
  if (!oldIds.includes(advertiserId)) {
    return { ok: true, content, changed: false, account: null, edit: 'not_declared', removed_lines: [], added_lines: [] };
  }
  const t = new Text(content);
  const edits: TextEdit[] = [];
  let account: AccountChoice | null = null;
  for (let ai = 0; ai < items.length; ai++) {
    const item = items[ai] as YAMLMap;
    const cap = caps[ai] as number;
    const singlePair = findPair(item, 'dsp_advertiser_id');
    if (singlePair && isScalar(singlePair.value) && singlePair.value.value === advertiserId) {
      edits.push(removePair(t, item, singlePair, pairLines(t, singlePair, cap)));
      account = accountChoiceOf(item);
    }
    const listPair = findPair(item, 'dsp_advertiser_ids');
    if (!listPair || !isSeq(listPair.value)) continue;
    const seq = listPair.value;
    // Only a list that holds the id is touched.
    if (!seq.items.some((n) => isScalar(n) && n.value === advertiserId)) continue;
    const kept = seq.items.filter((n) => !(isScalar(n) && n.value === advertiserId));
    if (!kept.every((n) => isScalar(n) && typeof n.value === 'string' && isValidDspAdvertiserId(n.value))) {
      return {
        ok: false,
        reason: 'existing_value_invalid',
        message:
          'A DSP advertiser list on this brand holds a value that is not a quoted string of digits. ' +
          'Fix that line by hand first; nothing was changed.',
      };
    }
    account = accountChoiceOf(item);
    const pl = pairLines(t, listPair, cap);
    if (kept.length === 0) {
      edits.push(removePair(t, item, listPair, pl));
    } else if (seq.flow) {
      if (pl.multiLineFlow) return { ok: false, reason: 'result_not_recognized', message: MULTI_LINE_FLOW_MESSAGE };
      const ids = kept.map((n) => (n as { value: string }).value);
      edits.push({
        start: pl.ks,
        end: pl.end,
        text: listLine(ids, trailingComment(t.body(pl.start))) + t.term(t.ls(pl.end - 1)),
      });
    } else {
      // Block list: drop just the matching item line(s).
      for (const n of seq.items) {
        const node = n as { value?: unknown; range?: Range3 };
        if (node.value === advertiserId && node.range) {
          edits.push({ start: t.ls(node.range[0]), end: t.lend(node.range[0]), text: '' });
        }
      }
    }
  }
  return finish(content, edits, oldIds.filter((v) => v !== advertiserId), account, 'removed', {
    op: 'unassign',
    id: advertiserId,
    targetIdx: -1,
  });
}

/** null when the edited text validates and the gateway reads exactly `expected`. */
function verifyResult(
  next: string,
  expected: string[],
): { reason: PlanRefusalReason; message: string } | null {
  let parsed: unknown;
  try {
    parsed = normalizeLegacyTacosFields(parseYaml(next));
  } catch (err) {
    return {
      reason: 'result_invalid',
      message: `The edited context.yaml no longer parses (${err instanceof Error ? err.message : String(err)}). Nothing was written.`,
    };
  }
  const result = contextSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join('.') : '(root)';
    return {
      reason: 'result_invalid',
      message:
        `The edited context.yaml does not pass the brand context schema (${where}: ` +
        `${first?.message ?? 'invalid'}). Nothing was written.`,
    };
  }
  if (!sameSet(gatewayParseDspAdvertiserIds(next), expected)) {
    return {
      reason: 'result_not_recognized',
      message:
        'After the edit, the way MixShift reads the advertiser ids would not be exactly what was ' +
        'asked for (an id would be missed, or another one switched on). Nothing was written. ' +
        "Check this brand's DSP advertiser lines by hand.",
    };
  }
  return null;
}
