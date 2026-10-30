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

import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import type { Document, Pair } from 'yaml';
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
  | 'account_required'
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

function quoted(doc: Document, id: string): unknown {
  const node = doc.createNode(id) as { type?: string };
  node.type = 'QUOTE_DOUBLE';
  return node;
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
  | { ok: true; doc: Document; items: YAMLMap[]; flow: boolean }
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
  return { ok: true, doc, items, flow };
}

const FLOW_MESSAGE =
  "This brand's accounts are written in flow style (inline braces or brackets). The DSP " +
  'advertiser declaration has to sit on its own line, and MixShift does not read it from an ' +
  'inline account. Nothing was changed. Rewrite the accounts as a normal indented list ' +
  '(one key per line), then run this again.';

/**
 * Pick the account entry: `--account` (seller_id or amazon_seller_id), else
 * the one with role primary, else the only account, else refuse with the
 * list. The service attributes per brand and ignores the account, so a typical
 * brand needs no question.
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
  if (items.length === 1) return { ok: true, target: items[0] as YAMLMap };
  const primaries = choices.map((c, i) => (c.role === 'primary' ? i : -1)).filter((i) => i >= 0);
  if (primaries.length === 1) return { ok: true, target: items[primaries[0] as number] as YAMLMap };
  return {
    ok: false,
    result: {
      ok: false,
      reason: 'account_required',
      message:
        'This brand has several accounts and none is the single primary one. Ask the user which ' +
        'account the advertiser sits under, then pass --account <seller id>. Accounts:\n' +
        describeAccounts(choices),
      accounts: choices,
    },
  };
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * Plan declaring `advertiserId` on the brand. Proves the new text with the
 * gateway's parser: its ids must equal the old ids plus this one, nothing
 * else turned on or off.
 */
export function planDspAssignment(
  content: string,
  advertiserId: string,
  accountSelector?: string,
): PlanResult {
  const parsed = parseAccounts(content);
  if (!parsed.ok) return parsed.result;
  const { doc, items, flow } = parsed;
  if (items.length === 0) {
    return {
      ok: false,
      reason: 'no_accounts',
      message:
        'This brand has no accounts[] entry in its context.yaml yet. Set the brand up first ' +
        '(the mx-brand-context skill), then declare the DSP advertiser.',
    };
  }
  if (flow) return { ok: false, reason: 'flow_style_account', message: FLOW_MESSAGE };

  const choices = items.map(accountChoiceOf);
  const chosen = chooseAccount(items, choices, accountSelector);
  if (!chosen.ok) return chosen.result;
  const target = chosen.target;
  const account = accountChoiceOf(target);

  const oldIds = gatewayParseDspAdvertiserIds(content);
  if (oldIds.includes(advertiserId)) {
    return {
      ok: true,
      content,
      changed: false,
      account,
      edit: 'already_in_file',
      removed_lines: [],
      added_lines: [],
    };
  }

  const hasList = target.has('dsp_advertiser_ids');
  const hasSingle = target.has('dsp_advertiser_id');
  const listValue = target.get('dsp_advertiser_ids', true);
  const singleValue = target.get('dsp_advertiser_id', true);
  const list: ValueState = hasList ? valueState(listValue, false) : { kind: 'empty' };
  const single: ValueState = hasSingle ? valueState(singleValue, true) : { kind: 'empty' };
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
    return {
      ok: false,
      reason: 'result_not_recognized',
      message:
        'The file lists this advertiser in a form MixShift does not read (for example a list ' +
        'split over several lines inside brackets). Nothing was changed. Rewrite that list as ' +
        'one line or a normal indented list, then run this again.',
    };
  }

  let edit: PlanEdit;
  if (list.kind === 'ids' && isSeq(listValue)) {
    listValue.add(quoted(doc, advertiserId));
    edit = 'appended';
  } else if (single.kind === 'ids') {
    const pair = target.items.find(
      (p: Pair) => isScalar(p.key) && p.key.value === 'dsp_advertiser_id',
    );
    const seq = new YAMLSeq();
    seq.add(quoted(doc, single.ids[0] as string));
    seq.add(quoted(doc, advertiserId));
    seq.flow = true;
    if (pair && isScalar(pair.key)) {
      pair.key.value = 'dsp_advertiser_ids';
      pair.value = seq;
    }
    if (hasList) target.delete('dsp_advertiser_ids'); // an empty leftover key
    edit = 'converted';
  } else if (hasSingle) {
    // An empty scalar key (null, ~, blank): give it the id in place.
    target.set('dsp_advertiser_id', quoted(doc, advertiserId));
    if (hasList) target.delete('dsp_advertiser_ids');
    edit = 'replaced_empty';
  } else if (hasList) {
    const seq = new YAMLSeq();
    seq.add(quoted(doc, advertiserId));
    seq.flow = true;
    target.set('dsp_advertiser_ids', seq);
    edit = 'replaced_empty';
  } else {
    target.set('dsp_advertiser_id', quoted(doc, advertiserId));
    edit = 'added';
  }

  const next = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const verdict = verifyResult(next, [...oldIds, advertiserId]);
  if (verdict) return { ok: false, reason: verdict.reason, message: verdict.message };
  const { removed, added } = diffLines(content, next);
  return { ok: true, content: next, changed: next !== content, account, edit, removed_lines: removed, added_lines: added };
}

/**
 * Plan removing `advertiserId` from every account of this brand that declares
 * it. A list that keeps ids stays a list. Proved against the gateway's parser:
 * the new ids must equal the old ids minus this one.
 */
export function planDspUnassignment(content: string, advertiserId: string): PlanResult {
  const parsed = parseAccounts(content);
  if (!parsed.ok) return parsed.result;
  const { doc, items } = parsed;
  const oldIds = gatewayParseDspAdvertiserIds(content);
  if (!oldIds.includes(advertiserId)) {
    return { ok: true, content, changed: false, account: null, edit: 'not_declared', removed_lines: [], added_lines: [] };
  }
  let account: AccountChoice | null = null;
  for (const item of items) {
    const single = item.get('dsp_advertiser_id', true);
    if (isScalar(single) && single.value === advertiserId) {
      item.delete('dsp_advertiser_id');
      account = accountChoiceOf(item);
    }
    const list = item.get('dsp_advertiser_ids', true);
    if (isSeq(list)) {
      const keep = list.items.filter((n) => !(isScalar(n) && n.value === advertiserId));
      if (keep.length !== list.items.length) {
        account = accountChoiceOf(item);
        if (keep.length === 0) item.delete('dsp_advertiser_ids');
        else list.items = keep;
      }
    }
  }
  const next = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const verdict = verifyResult(
    next,
    oldIds.filter((v) => v !== advertiserId),
  );
  if (verdict) return { ok: false, reason: verdict.reason, message: verdict.message };
  const { removed, added } = diffLines(content, next);
  return { ok: true, content: next, changed: next !== content, account, edit: 'removed', removed_lines: removed, added_lines: added };
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
