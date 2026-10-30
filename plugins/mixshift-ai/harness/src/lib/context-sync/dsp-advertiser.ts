/**
 * Declaring a DSP advertiser on a brand's context.yaml (mx-ops#205).
 *
 * MixShift files a DSP change on a brand only when exactly one brand's
 * context declares the advertiser as a QUOTED digit string. This module is the
 * pure half of `mixshift context dsp-advertiser assign`: pick the account
 * entry, edit the YAML in place (comments and layout preserved, the id written
 * as a double-quoted scalar), and prove with the plugin's own schema that the
 * result still validates and the id survived as a string. It never touches the
 * disk or the network; the command does the lookup, pull, write and push.
 */

import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import type { Document } from 'yaml';
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
}

export type PlanRefusalReason =
  | 'unreadable_yaml'
  | 'no_accounts'
  | 'account_required'
  | 'account_not_found'
  | 'existing_value_invalid'
  | 'result_invalid';

export type PlanResult =
  | {
      ok: true;
      /** The new file text (equal to the input when nothing changes). */
      content: string;
      /** True when the file text changes. */
      changed: boolean;
      account: AccountChoice;
      /** 'added' | 'converted' | 'appended' | 'already_in_file'. */
      edit: 'added' | 'converted' | 'appended' | 'already_in_file';
      removed_lines: string[];
      added_lines: string[];
    }
  | {
      ok: false;
      reason: PlanRefusalReason;
      message: string;
      /** account_required / account_not_found: the choices to ask about. */
      accounts?: AccountChoice[];
    };

function describeAccount(a: AccountChoice): string {
  const parts = [`seller_id ${a.seller_id}`];
  if (a.amazon_seller_id) parts.push(`amazon_seller_id ${a.amazon_seller_id}`);
  if (a.seller_name) parts.push(a.seller_name);
  if (a.marketplace) parts.push(a.marketplace);
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
  };
}

function quoted(doc: Document, id: string): unknown {
  const node = doc.createNode(id) as { type?: string };
  node.type = 'QUOTE_DOUBLE';
  return node;
}

function setCollectionFlow(seq: YAMLSeq): void {
  seq.flow = true;
}

/** Digit-string items of a key's value, or null when anything else is there. */
function existingIds(value: unknown): string[] | null {
  if (isScalar(value)) {
    return typeof value.value === 'string' && isValidDspAdvertiserId(value.value)
      ? [value.value]
      : null;
  }
  if (isSeq(value)) {
    const out: string[] = [];
    for (const item of value.items) {
      if (!isScalar(item) || typeof item.value !== 'string' || !isValidDspAdvertiserId(item.value)) {
        return null;
      }
      out.push(item.value);
    }
    return out;
  }
  return null;
}

function diffLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added.push(l);
  }
  const countB = new Map<string, number>();
  for (const l of b) countB.set(l, (countB.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of a) {
    const n = countB.get(l) ?? 0;
    if (n > 0) countB.set(l, n - 1);
    else removed.push(l);
  }
  return { removed, added };
}

/**
 * Plan the edit. `accountSelector` is the user's `--account` value, matched
 * against each entry's seller_id or amazon_seller_id.
 */
export function planDspAssignment(
  content: string,
  advertiserId: string,
  accountSelector?: string,
): PlanResult {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      reason: 'unreadable_yaml',
      message: `context.yaml is not valid YAML: ${doc.errors[0]?.message ?? 'parse error'}`,
    };
  }
  const accountsNode = doc.get('accounts', true);
  const items = isSeq(accountsNode) ? accountsNode.items.filter(isMap) : [];
  if (items.length === 0) {
    return {
      ok: false,
      reason: 'no_accounts',
      message:
        'This brand has no accounts[] entry in its context.yaml yet. Set the brand up first ' +
        '(the mx-brand-context skill), then declare the DSP advertiser.',
    };
  }
  const choices = items.map(accountChoiceOf);

  let target: YAMLMap;
  if (accountSelector !== undefined) {
    const idx = choices.findIndex(
      (c) => String(c.seller_id) === accountSelector || c.amazon_seller_id === accountSelector,
    );
    if (idx < 0) {
      return {
        ok: false,
        reason: 'account_not_found',
        message:
          `No account on this brand matches --account ${accountSelector}. Accounts:\n` +
          describeAccounts(choices),
        accounts: choices,
      };
    }
    target = items[idx] as YAMLMap;
  } else if (items.length === 1) {
    target = items[0] as YAMLMap;
  } else {
    return {
      ok: false,
      reason: 'account_required',
      message:
        'This brand has several accounts, and the advertiser belongs on one of them. Ask the ' +
        'user which one, then pass --account <seller id>. Accounts:\n' +
        describeAccounts(choices),
      accounts: choices,
    };
  }
  const account = accountChoiceOf(target);

  const listValue = target.get('dsp_advertiser_ids', true);
  const singleValue = target.get('dsp_advertiser_id', true);
  const hasList = target.has('dsp_advertiser_ids');
  const hasSingle = target.has('dsp_advertiser_id');

  const listIds = hasList ? existingIds(listValue) : [];
  const singleIds = hasSingle ? existingIds(singleValue) : [];
  if (listIds === null || singleIds === null) {
    return {
      ok: false,
      reason: 'existing_value_invalid',
      message:
        'The account already has a DSP advertiser value that is not a quoted string of digits ' +
        '(an unquoted id declares nothing). Fix that line by hand first; nothing was changed.',
    };
  }

  let edit: 'added' | 'converted' | 'appended' | 'already_in_file';
  if (listIds.includes(advertiserId) || singleIds.includes(advertiserId)) {
    edit = 'already_in_file';
  } else if (hasList && isSeq(listValue)) {
    listValue.add(quoted(doc, advertiserId));
    edit = 'appended';
  } else if (hasList) {
    // `dsp_advertiser_ids:` with an empty value: give it a list.
    const seq = new YAMLSeq();
    seq.add(quoted(doc, advertiserId));
    setCollectionFlow(seq);
    target.set('dsp_advertiser_ids', seq);
    edit = 'appended';
  } else if (hasSingle) {
    // Rename the key in place (position and comments stay) and hold both ids.
    const pair = target.items.find((p) => isScalar(p.key) && p.key.value === 'dsp_advertiser_id');
    const seq = new YAMLSeq();
    seq.add(quoted(doc, singleIds[0] as string));
    seq.add(quoted(doc, advertiserId));
    setCollectionFlow(seq);
    if (pair && isScalar(pair.key)) {
      pair.key.value = 'dsp_advertiser_ids';
      pair.value = seq;
    }
    edit = 'converted';
  } else {
    target.set('dsp_advertiser_id', quoted(doc, advertiserId));
    edit = 'added';
  }

  const next = edit === 'already_in_file' ? content : doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const verdict = verifyResult(next, advertiserId, account);
  if (verdict !== null) return { ok: false, reason: 'result_invalid', message: verdict };
  const { removed, added } = diffLines(content, next);
  return {
    ok: true,
    content: next,
    changed: next !== content,
    account,
    edit,
    removed_lines: removed,
    added_lines: added,
  };
}

/** null when the edited text validates and the id survived as a string. */
function verifyResult(next: string, advertiserId: string, account: AccountChoice): string | null {
  let parsed: unknown;
  try {
    parsed = normalizeLegacyTacosFields(parseYaml(next));
  } catch (err) {
    return `The edited context.yaml no longer parses (${err instanceof Error ? err.message : String(err)}). Nothing was written.`;
  }
  const result = contextSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join('.') : '(root)';
    return (
      `The edited context.yaml does not pass the brand context schema (${where}: ` +
      `${first?.message ?? 'invalid'}). Nothing was written.`
    );
  }
  const accounts = (parsed as { accounts?: Array<Record<string, unknown>> }).accounts ?? [];
  const match = accounts.find(
    (a) =>
      a.seller_id === account.seller_id &&
      (account.amazon_seller_id === undefined || a.amazon_seller_id === account.amazon_seller_id),
  );
  const raw = match?.dsp_advertiser_ids;
  const single = match?.dsp_advertiser_id;
  const survived =
    single === advertiserId || (Array.isArray(raw) && raw.some((v) => v === advertiserId));
  if (!survived) {
    return 'The advertiser id did not survive as a quoted string in the edited file. Nothing was written.';
  }
  return null;
}
