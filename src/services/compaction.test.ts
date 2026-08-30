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

describe("DataStore message deletion safety", () => {
  it("deletes only specified message IDs and retains the rest", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const store = new InMemoryDataStore();
    const convId = await store.getOrCreateConversation(12345);

    // Save 5 messages
    await store.saveMessage(convId, "user", "Message 1");
    await store.saveMessage(convId, "assistant", "Message 2");
    await store.saveMessage(convId, "user", "Message 3");
    await store.saveMessage(convId, "assistant", "Message 4");
    await store.saveMessage(convId, "user", "Message 5");

    const allMessages = Array.from(store.messages.values());
    expect(allMessages.length).toBe(5);

    // Delete only the first 2 message IDs
    const idsToDelete = [allMessages[0].id, allMessages[1].id];
    const deletedCount = await store.deleteMessagesByIds(idsToDelete);

    expect(deletedCount).toBe(2);
    expect(store.messages.size).toBe(3);
    expect(store.messages.has(allMessages[0].id)).toBe(false);
    expect(store.messages.has(allMessages[1].id)).toBe(false);
    expect(store.messages.has(allMessages[2].id)).toBe(true);
    expect(store.messages.has(allMessages[3].id)).toBe(true);
    expect(store.messages.has(allMessages[4].id)).toBe(true);
  });
});
