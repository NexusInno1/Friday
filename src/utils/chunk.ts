/**
 * Detects if the given text ends inside an unclosed markdown code fence (```).
 * If inside, returns the language identifier of the active code fence.
 * If not inside, returns null.
 */
export function getOpenCodeFence(text: string): string | null {
  const fenceRegex = /^\s*```([a-zA-Z0-9_-]*)/gm;
  let match: RegExpExecArray | null;
  let isOpen = false;
  let currentLang = "";

  while ((match = fenceRegex.exec(text)) !== null) {
    if (!isOpen) {
      isOpen = true;
      currentLang = match[1] || "";
    } else {
      isOpen = false;
      currentLang = "";
    }
  }

  return isOpen ? currentLang : null;
}

/**
 * Splits a long text message into chunks of up to `maxLength` characters,
 * preferring boundaries in order:
 * 1. Double newlines (paragraphs)
 * 2. Single newlines (lines)
 * 3. Spaces (words)
 * 4. Hard character limit (fallback)
 *
 * Ensures that if a chunk boundary falls inside a markdown code block,
 * the code block is cleanly closed at the end of the chunk and reopened
 * at the beginning of the next chunk.
 */
export function chunkMessage(text: string, maxLength = 4000): string[] {
  if (!text || text.length === 0) {
    return [];
  }
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

    let cutIndex = -1;
    let skipCount = 0;
    let boundaryType: "paragraph" | "line" | "space" | "hard" = "hard";

    // Try finding double newline
    const lastDoubleNewline = candidate.lastIndexOf("\n\n");
    if (lastDoubleNewline > 0) {
      cutIndex = lastDoubleNewline;
      skipCount = 2;
      boundaryType = "paragraph";
    } else {
      // Try finding single newline
      const lastNewline = candidate.lastIndexOf("\n");
      if (lastNewline > 0) {
        cutIndex = lastNewline;
        skipCount = 1;
        boundaryType = "line";
      } else {
        // Try finding space
        const lastSpace = candidate.lastIndexOf(" ");
        if (lastSpace > 0) {
          cutIndex = lastSpace;
          skipCount = 1;
          boundaryType = "space";
        } else {
          // Hard cut
          cutIndex = maxLength;
          skipCount = 0;
          boundaryType = "hard";
        }
      }
    }

    let chunk = remaining.slice(0, cutIndex);
    let nextRemaining = remaining.slice(cutIndex + skipCount);
    if (boundaryType === "paragraph" || boundaryType === "line") {
      nextRemaining = nextRemaining.trimStart();
    }

    // Check if chunk ends inside an open code fence
    const openLang = getOpenCodeFence(chunk);
    if (openLang !== null) {
      chunk = chunk + "\n```";
      nextRemaining = "```" + openLang + "\n" + nextRemaining;
    }

    chunks.push(chunk);
    remaining = nextRemaining;
  }

  return chunks;
}
