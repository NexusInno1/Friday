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

describe("runFactCompaction safety & bounds", () => {
  it("compacts and deletes only the fetched batch of 50 messages, leaving other 50 untouched", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convId = await store.getOrCreateConversation(12345);

    // Seed 100 messages older than 30 days
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const id = `msg-${i.toString().padStart(3, "0")}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Old message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    expect(store.messages.size).toBe(100);

    const mockExtractor = async (msgs: Array<{ id: string; role: string; content: string; created_at: string }>) => {
      expect(msgs.length).toBe(50);
      return {
        success: true,
        facts: [
          { content: "User works at Acme Corp", importance: 4, tags: ["career"] },
        ],
      };
    };

    const result = await runFactCompaction(store, mockExtractor);

    expect(result.factsExtracted).toBe(1);
    expect(result.messagesDeleted).toBe(50);
    expect(store.messages.size).toBe(50);

    // The first 50 messages (msg-000 to msg-049) should be deleted
    for (let i = 0; i < 50; i++) {
      const id = `msg-${i.toString().padStart(3, "0")}`;
      expect(store.messages.has(id)).toBe(false);
    }

    // The remaining 50 messages (msg-050 to msg-099) must remain intact
    for (let i = 50; i < 100; i++) {
      const id = `msg-${i.toString().padStart(3, "0")}`;
      expect(store.messages.has(id)).toBe(true);
    }

    // Verify fact was stored in memories
    expect(store.memories.size).toBe(1);
    const storedMemory = Array.from(store.memories.values())[0];
    expect(storedMemory.content).toBe("User works at Acme Corp");
    expect(storedMemory.tags).toContain("compacted");
  });

  it("aborts deletion when LLM extraction fails", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convId = await store.getOrCreateConversation(12345);

    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const id = `msg-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Old message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    const failingExtractor = async () => ({
      success: false,
      facts: [],
    });

    const result = await runFactCompaction(store, failingExtractor);

    expect(result.factsExtracted).toBe(0);
    expect(result.messagesDeleted).toBe(0);
    expect(store.messages.size).toBe(10);
  });

  it("aborts deletion when fact storage fails", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convId = await store.getOrCreateConversation(12345);

    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const id = `msg-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Old message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    // Force storeMemory to fail
    store.storeMemory = async () => {
      throw new Error("Simulated storage write error");
    };

    const successfulExtractor = async () => ({
      success: true,
      facts: [{ content: "Some fact", importance: 3, tags: [] }],
    });

    const result = await runFactCompaction(store, successfulExtractor);

    expect(result.factsExtracted).toBe(0);
    expect(result.messagesDeleted).toBe(0);
    expect(store.messages.size).toBe(10);
  });
});
