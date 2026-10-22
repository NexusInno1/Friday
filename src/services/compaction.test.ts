import { describe, it, expect } from "vitest";
import {
  cleanJsonText,
  FactItemSchema,
  FactExtractionResponseSchema,
} from "./compaction.service.js";

describe("cleanJsonText", () => {
  it("cleans markdown code block with json tag", () => {
    const raw = "```json\n[{\"content\": \"test\", \"importance\": 3, \"tags\": [\"work\"]}]\n```";
    const cleaned = cleanJsonText(raw);
    expect(cleaned).toBe("[{\"content\": \"test\", \"importance\": 3, \"tags\": [\"work\"]}]");
    expect(JSON.parse(cleaned)).toEqual([
      { content: "test", importance: 3, tags: ["work"] },
    ]);
  });

  it("cleans markdown code block with preamble and postscript commentary", () => {
    const raw = "Here are the extracted facts:\n```json\n[{\"content\": \"test\", \"importance\": 3, \"tags\": [\"work\"]}]\n```\nHope this helps!";
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

  it("extracts JSON array surrounded by conversational text without code blocks", () => {
    const raw = "Certainly! Here are the extracted facts:\n[{\"content\": \"Likes green tea\", \"importance\": 3, \"tags\": [\"tea\"]}]\nLet me know if you need anything else.";
    const cleaned = cleanJsonText(raw);
    expect(JSON.parse(cleaned)).toEqual([
      { content: "Likes green tea", importance: 3, tags: ["tea"] },
    ]);
  });

  it("extracts JSON object surrounded by conversational text without code blocks", () => {
    const raw = "Facts extracted:\n{\"facts\": [{\"content\": \"Works remotely\", \"importance\": 4, \"tags\": [\"work\"]}]}\nEnd of extraction.";
    const cleaned = cleanJsonText(raw);
    expect(JSON.parse(cleaned)).toEqual({
      facts: [{ content: "Works remotely", importance: 4, tags: ["work"] }],
    });
  });
});

describe("FactItemSchema and FactExtractionResponseSchema", () => {
  it("normalizes diverse LLM output variations (string numbers, aliases, comma tags)", () => {
    const rawFacts = [
      { content: "Prefers espresso", importance: "5", tags: ["coffee", "routine"] },
      { fact: "Has a dog named Max", importance: 4.2, tags: "pets, animals" },
      { statement: "Uses Neovim for editing", importance: null, tags: null },
    ];

    const parsed = FactExtractionResponseSchema.parse(rawFacts);
    expect(parsed).toEqual([
      { content: "Prefers espresso", importance: 5, tags: ["coffee", "routine"] },
      { content: "Has a dog named Max", importance: 4, tags: ["pets", "animals"] },
      { content: "Uses Neovim for editing", importance: 3, tags: [] },
    ]);
  });

  it("parses wrapped { facts: [...] } object response", () => {
    const wrapped = {
      facts: [
        { content: "Lives in Bengaluru", importance: 3, tags: ["location"] },
      ],
    };

    const parsed = FactExtractionResponseSchema.parse(wrapped);
    expect(parsed).toEqual([
      { content: "Lives in Bengaluru", importance: 3, tags: ["location"] },
    ]);
  });

  it("rejects items without any content, fact, or statement", () => {
    const invalid = [{ importance: 4, tags: ["work"] }];
    const result = FactExtractionResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
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

  it("processes multiple distinct old conversations without starving behind the first one", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convA = "conv-A";
    const convB = "conv-B";

    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;
    // Conv A has 60 old messages
    for (let i = 0; i < 60; i++) {
      const id = `a-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convA,
        role: "user",
        content: `Msg A ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    // Conv B has 20 old messages
    for (let i = 0; i < 20; i++) {
      const id = `b-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convB,
        role: "user",
        content: `Msg B ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + (60 + i) * 1000).toISOString(),
      });
    }

    const mockExtractor = async (msgs: Array<{ id: string; role: string; content: string; created_at: string }>) => ({
      success: true,
      facts: [{ content: `Fact from batch of ${msgs.length}`, importance: 3, tags: [] }],
    });

    const result = await runFactCompaction(store, mockExtractor);

    expect(result.conversationsProcessed).toBe(2);
    expect(result.messagesDeleted).toBe(70);
  });

  it("quarantines a conversation after 3 consecutive failures to unblock others", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction, resetCompactionQuarantine } = await import("./compaction.service.js");
    resetCompactionQuarantine();

    const store = new InMemoryDataStore();
    const poisonConv = "conv-poison";
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;

    store.messages.set("poison-msg", {
      id: "poison-msg",
      conversation_id: poisonConv,
      role: "user",
      content: "Poison message",
      tool_name: null,
      tool_call_id: null,
      tokens_used: null,
      created_at: new Date(baseTime).toISOString(),
    });

    const mockExtractor = async () => ({ success: false, facts: [] });

    // Run 1, 2, 3: Poison fails
    await runFactCompaction(store, mockExtractor);
    await runFactCompaction(store, mockExtractor);
    await runFactCompaction(store, mockExtractor);

    // Run 4: Poison is quarantined and skipped
    const run4 = await runFactCompaction(store, mockExtractor);
    expect(run4.conversationsProcessed).toBe(0);
  });

  it("aborts deletion when 0 facts are extracted from existing old messages", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convId = "conv-empty-facts";
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const id = `msg-empty-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    // Extractor reports success: true, but facts: []
    const emptyFactsExtractor = async () => ({
      success: true,
      facts: [],
    });

    const result = await runFactCompaction(store, emptyFactsExtractor);
    expect(result.factsExtracted).toBe(0);
    expect(result.messagesDeleted).toBe(0);
    // Messages must NOT have been deleted
    expect(store.messages.size).toBe(5);
  });

  it("supports non-destructive soft-delete with options: { softDelete: true }", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");
    const store = new InMemoryDataStore();
    const convId = "conv-soft-delete";
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 4; i++) {
      const id = `msg-soft-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Soft delete message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    const mockExtractor = async () => ({
      success: true,
      facts: [{ content: "Extracted fact from soft delete test", importance: 4, tags: ["test"] }],
    });

    const result = await runFactCompaction(store, mockExtractor, { softDelete: true });
    expect(result.factsExtracted).toBe(1);
    expect(result.messagesDeleted).toBe(4);
    // All 4 messages still exist in datastore!
    expect(store.messages.size).toBe(4);

    // Each message has compacted_at set
    for (let i = 0; i < 4; i++) {
      const msg = store.messages.get(`msg-soft-${i}`);
      expect(msg?.compacted_at).toBeDefined();
    }

    // Future getOldMessages call excludes compacted messages
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oldConvs = await store.getOldMessages(cutoffDate);
    expect(oldConvs.length).toBe(0);

    // getContextMessages excludes compacted messages
    const activeMsgs = await store.getContextMessages(convId);
    expect(activeMsgs.length).toBe(0);
  });

  it("aborts compaction run early and does NOT quarantine conversation on abortedDueToQuota", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction, resetCompactionQuarantine } = await import("./compaction.service.js");
    resetCompactionQuarantine();

    const store = new InMemoryDataStore();
    const convId = "conv-quota";
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 3; i++) {
      const id = `msg-quota-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Quota msg ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    const quotaExtractor = async () => ({
      success: false,
      facts: [],
      abortedDueToQuota: true,
    });

    // Run 1: Should abort early without deleting
    const res1 = await runFactCompaction(store, quotaExtractor);
    expect(res1.conversationsProcessed).toBe(0);
    expect(res1.messagesDeleted).toBe(0);
    expect(store.messages.size).toBe(3);

    // If quota frees up on run 2, it should succeed immediately (not quarantined!)
    const normalExtractor = async () => ({
      success: true,
      facts: [{ content: "Success after quota reset", importance: 3, tags: [] }],
    });

    const res2 = await runFactCompaction(store, normalExtractor);
    expect(res2.conversationsProcessed).toBe(1);
    expect(res2.messagesDeleted).toBe(3);
    expect(store.messages.size).toBe(0);
  });

  it("marks messages compacted in soft-delete mode even when 0 facts are extracted without deleting rows", async () => {
    const { InMemoryDataStore } = await import("../db/in-memory-datastore.js");
    const { runFactCompaction } = await import("./compaction.service.js");

    const store = new InMemoryDataStore();
    const convId = "conv-soft-zero-facts";
    const baseTime = Date.now() - 35 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 3; i++) {
      const id = `msg-zero-${i}`;
      store.messages.set(id, {
        id,
        conversation_id: convId,
        role: "user",
        content: `Small talk message ${i}`,
        tool_name: null,
        tool_call_id: null,
        tokens_used: null,
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    const emptyFactsExtractor = async () => ({
      success: true,
      facts: [],
    });

    const res = await runFactCompaction(store, emptyFactsExtractor, { softDelete: true });
    expect(res.conversationsProcessed).toBe(1);
    expect(res.factsExtracted).toBe(0);
    expect(res.messagesDeleted).toBe(3); // 3 messages marked compacted
    expect(store.messages.size).toBe(3); // Rows NOT deleted from datastore

    // Verify each message has compacted_at set
    for (let i = 0; i < 3; i++) {
      expect(store.messages.get(`msg-zero-${i}`)?.compacted_at).toBeDefined();
    }
  });
});
