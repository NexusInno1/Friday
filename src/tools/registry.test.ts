import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import { createTools } from "./registry.js";

describe("Tool Registry - Scoping & Injection", () => {
  let store: InMemoryDataStore;
  const testUserId = 777888;
  const testChatId = 777888;

  beforeEach(() => {
    store = new InMemoryDataStore();
  });

  it("scopes store_memory and recall_memory to injected store and userId", async () => {
    const tools = createTools({
      chatId: testChatId,
      userId: testUserId,
      store,
    });

    // Execute store_memory
    const storeRes = await tools.store_memory.execute(
      {
        content: "Prefers dark chocolate over milk chocolate",
        tags: ["food"],
        importance: 4,
      },
      { toolCallId: "test_call_1", messages: [] }
    );

    expect(storeRes).toEqual({
      success: true,
      stored: "Prefers dark chocolate over milk chocolate",
    });

    // Verify persisted directly into the injected store
    const storedList = await store.listMemories(testUserId);
    expect(storedList.length).toBe(1);
    expect(storedList[0].content).toBe("Prefers dark chocolate over milk chocolate");
    expect(storedList[0].user_id).toBe(testUserId);

    // Execute recall_memory via tool
    const recallRes = await tools.recall_memory.execute(
      { query: "chocolate", limit: 5 },
      { toolCallId: "test_call_2", messages: [] }
    );

    expect(recallRes.found).toBe(true);
    expect(recallRes.memories.length).toBe(1);
    expect(recallRes.memories[0].content).toBe("Prefers dark chocolate over milk chocolate");
  });

  it("scopes set_briefing_time to injected store and userId", async () => {
    const tools = createTools({
      chatId: testChatId,
      userId: testUserId,
      store,
    });

    const res = await tools.set_briefing_time.execute(
      { time: "08:15" },
      { toolCallId: "test_call_3", messages: [] }
    );

    expect(res.success).toBe(true);
    expect(res.new_briefing_time).toBe("08:15");

    // Verify stored in user profile in the injected store
    const profile = await store.getUserProfile(testUserId);
    expect(profile?.briefing_time).toBe("08:15");
  });

  it("scopes reminder lifecycle tools to injected store and userId", async () => {
    const tools = createTools({
      chatId: testChatId,
      userId: testUserId,
      store,
    });

    // Create reminder
    const triggerAt = "2026-10-15T09:00:00.000Z";
    const createRes = await tools.create_reminder.execute(
      {
        message: "Prepare quarterly presentation",
        trigger_at: triggerAt,
        is_recurring: false,
      },
      { toolCallId: "test_call_4", messages: [] }
    );

    expect(createRes.success).toBe(true);
    expect(createRes.id).toBeDefined();

    // List reminders
    const listRes = await tools.list_reminders.execute(
      {},
      { toolCallId: "test_call_5", messages: [] }
    );
    expect(listRes.reminders.length).toBe(1);
    expect(listRes.reminders[0].message).toBe("Prepare quarterly presentation");
    expect(listRes.reminders[0].user_id).toBe(testUserId);

    // Snooze reminder
    const snoozeRes = await tools.snooze_reminder.execute(
      { reminder_id: createRes.id, minutes: 30 },
      { toolCallId: "test_call_6", messages: [] }
    );
    expect(snoozeRes.success).toBe(true);
    expect(snoozeRes.new_trigger_at).toBe("2026-10-15T09:30:00.000Z");

    // Cancel reminder
    const cancelRes = await tools.cancel_reminder.execute(
      { reminder_id: createRes.id },
      { toolCallId: "test_call_7", messages: [] }
    );
    expect(cancelRes.success).toBe(true);

    const afterCancel = await tools.list_reminders.execute(
      {},
      { toolCallId: "test_call_8", messages: [] }
    );
    expect(afterCancel.reminders.length).toBe(0);
  });
});
