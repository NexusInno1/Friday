/**
 * Splits a long text message into chunks of up to `maxLength` characters,
 * preferring boundaries in order:
 * 1. Double newlines (paragraphs)
 * 2. Single newlines (lines)
 * 3. Spaces (words)
 * 4. Hard character limit (fallback)
 */
export function chunkMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const candidate = remaining.slice(0, maxLength);

    // Try finding double newline
    const lastDoubleNewline = candidate.lastIndexOf("\n\n");
    if (lastDoubleNewline > 0) {
      chunks.push(remaining.slice(0, lastDoubleNewline));
      remaining = remaining.slice(lastDoubleNewline + 2).trimStart();
      continue;
    }

    // Try finding single newline
    const lastNewline = candidate.lastIndexOf("\n");
    if (lastNewline > 0) {
      chunks.push(remaining.slice(0, lastNewline));
      remaining = remaining.slice(lastNewline + 1).trimStart();
      continue;
    }

    // Try finding space
    const lastSpace = candidate.lastIndexOf(" ");
    if (lastSpace > 0) {
      chunks.push(remaining.slice(0, lastSpace));
      remaining = remaining.slice(lastSpace + 1);
      continue;
    }

    // Fallback: hard cut
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
}
