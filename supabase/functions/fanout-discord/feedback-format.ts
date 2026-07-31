// Keep feedback delivery under Discord's embed limits while preserving every
// character in the telemetry record across ordered message parts.
export const FEEDBACK_DESCRIPTION_CHUNK = 3500;

export interface FeedbackPart {
  feedbackId: number;
  text: string;
  number: number;
  total: number;
}

function splitDiscordDescription(
  message: string,
  max = FEEDBACK_DESCRIPTION_CHUNK,
): string[] {
  if (!message) return [''];

  const chunks: string[] = [];
  let start = 0;
  while (start < message.length) {
    let end = Math.min(start + max, message.length);
    // Do not divide a UTF-16 surrogate pair between Discord messages.
    if (end < message.length && /[\uD800-\uDBFF]/.test(message.charAt(end - 1))) end--;
    chunks.push(message.slice(start, end));
    start = end;
  }
  return chunks;
}

export function feedbackParts(eventId: number, message: string): FeedbackPart[] {
  const chunks = splitDiscordDescription(message);
  return chunks.map((text, index) => ({
    feedbackId: eventId,
    text,
    number: index + 1,
    total: chunks.length,
  }));
}
