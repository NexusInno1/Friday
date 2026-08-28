import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "./in-memory-datastore.js";

describe("InMemoryDataStore", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
  });

  it("creates and retrieves active conversation", async () => {
    const convId1 = await store.getOrCreateConversation(12345);
    const convId2 = await store.getOrCreateConversation(12345);
    expect(convId1).toBe(convId2);

    const convId3 = await store.getOrCreateConversation(99999);
    expect(convId3).not.toBe(convId1);
  });

  it("stores and retrieves sliding context window of messages", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "Hello");
    await store.saveMessage(convId, "assistant", "Hi there!");
    await store.saveMessage(convId, "user", "How are you?");

    const msgs = await store.getContextMessages(convId, 2);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "assistant", content: "Hi there!" });
    expect(msgs[1]).toEqual({ role: "user", content: "How are you?" });
  });

  it("clears conversation messages", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "Secret info");

    await store.clearConversation(123);
    const msgs = await store.getContextMessages(convId);
    expect(msgs).toEqual([]);
  });

  it("matches memories using cosine similarity", async () => {
    const embeddingA = [1, 0, 0];
    const embeddingB = [0.99, 0.01, 0];
    const embeddingC = [0, 1, 0];

    await store.storeMemory(100, "Memory A", ["test"], 3, embeddingA);
    await store.storeMemory(100, "Memory C", ["other"], 1, embeddingC);

    const matches = await store.matchMemories(100, embeddingB, 0.8, 5);
    expect(matches.length).toBe(1);
    expect(matches[0].content).toBe("Memory A");
    expect(matches[0].similarity).toBeGreaterThan(0.9);
  });

  it("searches memories by keyword fallback", async () => {
    await store.storeMemory(100, "TypeScript is awesome", ["tech"], 5, null);
    await store.storeMemory(100, "Likes coffee with oat milk", ["food"], 3, null);

    const results = await store.searchMemoriesKeyword(100, "coffee", 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Likes coffee with oat milk");
  });

  it("marks superseded memories inactive", async () => {
    const mem1 = await store.storeMemory(100, "Old preference", [], 3, null);
    const mem2 = await store.storeMemory(100, "New preference", [], 3, null);

    await store.markMemoriesSuperseded([mem1.id], mem2.id);

    const activeMemories = await store.listMemories(100);
    expect(activeMemories.length).toBe(1);
    expect(activeMemories[0].content).toBe("New preference");
  });

  it("handles reminder lifecycle (create, due query, update)", async () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const futureTime = new Date(Date.now() + 60000).toISOString();

    const dueReminder = await store.createReminder({
      userId: 100,
      chatId: 100,
      message: "Due task",
      triggerAt: pastTime,
    });

    await store.createReminder({
      userId: 100,
      chatId: 100,
      message: "Future task",
      triggerAt: futureTime,
    });

    const dueList = await store.getDueReminders(new Date().toISOString());
    expect(dueList.length).toBe(1);
    expect(dueList[0].id).toBe(dueReminder.id);

    await store.updateReminder(dueReminder.id, { is_completed: true });
    const remainingDue = await store.getDueReminders(new Date().toISOString());
    expect(remainingDue.length).toBe(0);
  });
});
