import { describe, it, expect } from "vitest";
import { chunkMessage, getOpenCodeFence } from "./chunk.js";

describe("getOpenCodeFence", () => {
  it("returns null for text without any code fences", () => {
    expect(getOpenCodeFence("Hello world\nThis is plain text.")).toBeNull();
  });

  it("returns null when all code fences are properly closed", () => {
    const text = "```typescript\nconst x = 1;\n```\nSome other text\n```python\nprint(1)\n```";
    expect(getOpenCodeFence(text)).toBeNull();
  });

  it("returns language identifier when code fence is unclosed", () => {
    const text = "```typescript\nconst x = 1;\nconsole.log(x);";
    expect(getOpenCodeFence(text)).toBe("typescript");
  });

  it("returns empty string when unclosed code fence has no language specifier", () => {
    const text = "```\nraw text block without language";
    expect(getOpenCodeFence(text)).toBe("");
  });
});

describe("chunkMessage", () => {
  it("returns empty array for empty string", () => {
    expect(chunkMessage("")).toEqual([]);
  });

  it("returns single chunk if text is within limit", () => {
    const text = "Short message within 4000 characters.";
    const chunks = chunkMessage(text, 4000);
    expect(chunks).toEqual([text]);
  });

  it("splits along double-newline paragraph boundaries when possible", () => {
    const p1 = "A".repeat(3000);
    const p2 = "B".repeat(2000);
    const text = `${p1}\n\n${p2}`;

    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(p2);
  });

  it("splits along single-newline line boundaries if a single paragraph exceeds limit", () => {
    const l1 = "Line 1: " + "C".repeat(2500);
    const l2 = "Line 2: " + "D".repeat(2000);
    const text = `${l1}\n${l2}`;

    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(l1);
    expect(chunks[1]).toBe(l2);
  });

  it("splits long words/strings hard at maxLength if no whitespace exists", () => {
    const unbroken = "E".repeat(5000);
    const chunks = chunkMessage(unbroken, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(2000);
    expect(chunks[2].length).toBe(1000);
  });

  it("preserves closing and reopening code fences when split inside a code block", () => {
    const codeLine = "  const value = 42;\n";
    // Construct a long code block that will exceed 500 characters
    const fullCode = "```typescript\n" + codeLine.repeat(40) + "```";

    const chunks = chunkMessage(fullCode, 400);
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk must be closed cleanly
    expect(chunks[0].startsWith("```typescript\n")).toBe(true);
    expect(chunks[0].endsWith("\n```")).toBe(true);

    // Second chunk must reopen the fence with the same language
    expect(chunks[1].startsWith("```typescript\n")).toBe(true);

    // All chunks should have balanced code fences
    for (const chunk of chunks) {
      expect(getOpenCodeFence(chunk)).toBeNull();
    }
  });
});
