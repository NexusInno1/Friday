import { describe, it, expect } from "vitest";
import { formatMemoryLines } from "./memory.service.js";

describe("formatMemoryLines", () => {
  it("formats memory items with importance tags and ISO date prefix", () => {
    const mockMemories = [
      {
        id: "1",
        user_id: 123,
        content: "Prefers TypeScript and strict ESM",
        tags: ["tech"],
        embedding: null,
        importance: 5,
        created_at: "2026-08-22T10:00:00.000Z",
        updated_at: "2026-08-22T10:00:00.000Z",
      },
      {
        id: "2",
        user_id: 123,
        content: "Likes morning coffee at 8:00 AM",
        tags: ["routine"],
        embedding: null,
        importance: 3,
        created_at: "2026-08-21T05:00:00.000Z",
        updated_at: "2026-08-21T05:00:00.000Z",
      },
    ];

    const result = formatMemoryLines(mockMemories);
    expect(result).toBe(
      `- [importance: 5] Prefers TypeScript and strict ESM (saved: 2026-08-22)\n` +
      `- [importance: 3] Likes morning coffee at 8:00 AM (saved: 2026-08-21)`
    );
  });

  it("returns empty string when given empty list", () => {
    expect(formatMemoryLines([])).toBe("");
  });
});
