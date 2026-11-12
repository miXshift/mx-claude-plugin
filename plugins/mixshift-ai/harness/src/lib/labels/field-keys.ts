/**
 * The label field keys, in one place with no imports, so the telemetry redactor can keep a field key (and
 * nothing else) from a labels command line without pulling in the labels client. change-input.test.ts pins
 * this list to the fields the commands accept.
 */
export const LABEL_FIELD_KEYS: readonly string[] = [
  'item_group',
  'nickname',
  'brand',
  'parent_asin',
  'label_1',
  'label_2',
  'tag_1',
  'tag_2',
  'tag_3',
  'tag_4',
  'manager',
  'objective',
];
