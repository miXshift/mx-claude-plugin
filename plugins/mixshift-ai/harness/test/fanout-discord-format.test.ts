import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_DESCRIPTION_CHUNK,
  feedbackParts,
} from '../../../../supabase/functions/fanout-discord/feedback-format.js';

describe('feedbackParts', () => {
  it('preserves a long feedback report in ordered Discord-safe parts', () => {
    const message = 'a'.repeat(FEEDBACK_DESCRIPTION_CHUNK + 17);

    const parts = feedbackParts(24782, message);

    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.text).join('')).toBe(message);
    expect(parts.map((part) => part.number)).toEqual([1, 2]);
    expect(parts.map((part) => part.total)).toEqual([2, 2]);
    expect(parts.map((part) => part.feedbackId)).toEqual([24782, 24782]);
    expect(parts.every((part) => part.text.length <= FEEDBACK_DESCRIPTION_CHUNK)).toBe(true);
  });

  it('keeps Unicode characters intact at a part boundary', () => {
    const message = 'a'.repeat(FEEDBACK_DESCRIPTION_CHUNK - 1) + '😀' + 'b';

    const parts = feedbackParts(28332, message);

    expect(parts.map((part) => part.text).join('')).toBe(message);
    expect(parts).toHaveLength(2);
  });
});
