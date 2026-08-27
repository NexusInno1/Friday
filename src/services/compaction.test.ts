import { describe, it, expect } from "vitest";
import { cleanJsonText } from "./compaction.service.js";

describe("cleanJsonText", () => {
  it("cleans markdown code block with json tag", () => {
    const raw = "```json\n[{\"content\": \"test\", \"importance\": 3, \"tags\": [\"work\"]}]\n```";
    const cleaned = cleanJsonText(raw);
    expect(cleaned).toBe("[{\"content\": \"test\", \"importance\": 3, \"tags\": [\"work\"]}]");
    expect(JSON.parse(cleaned)).toEqual([
      { content: "test", importance: 3, tags: ["work"] },
    ]);
  });

  it("cleans markdown code block without json tag", () => {
    const raw = "```\n[{\"content\": \"fact\", \"importance\": 5, \"tags\": []}]\n```";
    const cleaned = cleanJsonText(raw);
    expect(cleaned).toBe("[{\"content\": \"fact\", \"importance\": 5, \"tags\": []}]");
    expect(JSON.parse(cleaned)).toEqual([
      { content: "fact", importance: 5, tags: [] },
    ]);
  });

  it("handles raw JSON without code blocks", () => {
    const raw = "[{\"content\": \"fact\", \"importance\": 4, \"tags\": [\"life\"]}]";
    const cleaned = cleanJsonText(raw);
    expect(cleaned).toBe(raw);
    expect(JSON.parse(cleaned)).toEqual([
      { content: "fact", importance: 4, tags: ["life"] },
    ]);
  });

  it("handles empty array string", () => {
    const raw = "```json\n[]\n```";
    const cleaned = cleanJsonText(raw);
    expect(JSON.parse(cleaned)).toEqual([]);
  });
});
