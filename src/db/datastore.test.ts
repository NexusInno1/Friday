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

  it("preserves historical conversation messages when clearing active conversation", async () => {
    // Simulate an older conversation from 3 days ago
    const oldConvId = "old-conv-123";
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    store.conversations.set(oldConvId, {
      id: oldConvId,
      telegram_chat_id: 123,
      title: null,
      summary: null,
      is_active: false,
      created_at: oldDate,
      updated_at: oldDate,
    });
    store.messages.set("old-msg-1", {
      id: "old-msg-1",
      conversation_id: oldConvId,
      role: "user",
      content: "Historical fact worth keeping",
      tool_name: null,
      tool_call_id: null,
      tokens_used: null,
      created_at: oldDate,
    });

    // Create current active conversation
    const activeConvId = await store.getOrCreateConversation(123);
    await store.saveMessage(activeConvId, "user", "Ephemeral query");

    // Clear active conversation
    await store.clearConversation(123);

    // Active conversation is cleared
    const activeMsgs = await store.getContextMessages(activeConvId);
    expect(activeMsgs).toEqual([]);

    // Historical conversation messages are preserved for compaction
    const oldMsgs = await store.getConversationMessagesBefore(
      oldConvId,
      new Date().toISOString()
    );
    expect(oldMsgs.length).toBe(1);
    expect(oldMsgs[0].content).toBe("Historical fact worth keeping");
  });

  it("bridges dialogue context across 24h inactivity window from prior conversation", async () => {
    // Yesterday's conversation (26 hours ago)
    const yesterdayConvId = "conv-yesterday";
    const yesterdayDate = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    store.conversations.set(yesterdayConvId, {
      id: yesterdayConvId,
      telegram_chat_id: 456,
      title: null,
      summary: null,
      is_active: true,
      created_at: yesterdayDate,
      updated_at: yesterdayDate,
    });
    store.messages.set("msg-y1", {
      id: "msg-y1",
      conversation_id: yesterdayConvId,
      role: "user",
      content: "Let's work on project Apollo",
      tool_name: null,
      tool_call_id: null,
      tokens_used: null,
      created_at: yesterdayDate,
    });
    store.messages.set("msg-y2", {
      id: "msg-y2",
      conversation_id: yesterdayConvId,
      role: "assistant",
      content: "Understood, project Apollo initialized.",
      tool_name: null,
      tool_call_id: null,
      tokens_used: null,
      created_at: yesterdayDate,
    });

    // Today's interaction (> 24h later) creates a new conversation
    const todayConvId = await store.getOrCreateConversation(456);
    expect(todayConvId).not.toBe(yesterdayConvId);
    expect(store.conversations.get(yesterdayConvId)?.is_active).toBe(false);
    expect(store.conversations.get(todayConvId)?.is_active).toBe(true);

    await store.saveMessage(todayConvId, "user", "What was the project name again?");

    // Context retrieval should bridge yesterday's messages in front of today's message
    const msgs = await store.getContextMessages(todayConvId, 10);
    expect(msgs.length).toBe(3);
    expect(msgs[0]).toEqual({ role: "user", content: "Let's work on project Apollo" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "Understood, project Apollo initialized." });
    expect(msgs[2]).toEqual({ role: "user", content: "What was the project name again?" });
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

  it("deletes messages by specific IDs and leaves other messages intact", async () => {
    const convId = await store.getOrCreateConversation(12345);
    await store.saveMessage(convId, "user", "Message 1");
    await store.saveMessage(convId, "assistant", "Message 2");
    await store.saveMessage(convId, "user", "Message 3");

    const messagesBefore = await store.getConversationMessagesBefore(
      convId,
      new Date(Date.now() + 10000).toISOString()
    );
    expect(messagesBefore.length).toBe(3);

    const deleted = await store.deleteMessagesByIds([messagesBefore[0].id, messagesBefore[2].id]);
    expect(deleted).toBe(2);

    const messagesAfter = await store.getConversationMessagesBefore(
      convId,
      new Date(Date.now() + 10000).toISOString()
    );
    expect(messagesAfter.length).toBe(1);
    expect(messagesAfter[0].id).toBe(messagesBefore[1].id);
  });

  it("claims due reminders with lease and increments delivery_attempts", async () => {
    const pastTime = new Date(Date.now() - 5000).toISOString();
    const reminder = await store.createReminder({
      userId: 200,
      chatId: 200,
      message: "Lease test reminder",
      triggerAt: pastTime,
    });

    const nowIso = new Date().toISOString();
    const claimed = await store.claimDueReminders(nowIso, 60_000);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(reminder.id);
    expect(claimed[0].delivery_attempts).toBe(1);
    expect(claimed[0].lease_until).toBeDefined();

    // Immediate second claim with active lease yields 0
    const secondClaim = await store.claimDueReminders(nowIso, 60_000);
    expect(secondClaim.length).toBe(0);
  });

  describe("Session Management & History Search", () => {
    it("lists sessions and tracks active session", async () => {
      const chatId = 777;
      const convId1 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(convId1, "user", "Hello in session 1");
      await store.saveMessage(convId1, "assistant", "Response in session 1");
      await store.updateSessionTitle(convId1, "Docker Setup");

      const activeSession = await store.getActiveSession(chatId);
      expect(activeSession).not.toBeNull();
      expect(activeSession?.id).toBe(convId1);
      expect(activeSession?.title).toBe("Docker Setup");
      expect(activeSession?.messageCount).toBe(2);

      const sessions = await store.listSessions(chatId);
      expect(sessions.length).toBe(1);
      expect(sessions[0].title).toBe("Docker Setup");
      expect(sessions[0].isActive).toBe(true);
    });

    it("archives current session and starts a new session", async () => {
      const chatId = 888;
      const convId1 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(convId1, "user", "Session 1 query");
      await store.updateSessionTitle(convId1, "Session One");

      // Archive session (as /clear would do)
      await store.clearConversation(chatId);

      // Next getOrCreateConversation starts a new active session
      const convId2 = await store.getOrCreateConversation(chatId);
      expect(convId2).not.toBe(convId1);

      await store.saveMessage(convId2, "user", "Session 2 query");
      await store.updateSessionTitle(convId2, "Session Two");

      const sessions = await store.listSessions(chatId);
      expect(sessions.length).toBe(2);

      const active = await store.getActiveSession(chatId);
      expect(active?.id).toBe(convId2);
      expect(active?.title).toBe("Session Two");
    });

    it("switches active session back to a previous session", async () => {
      const chatId = 999;
      const conv1 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(conv1, "user", "Talking about Python");
      await store.updateSessionTitle(conv1, "Python Project");

      await store.clearConversation(chatId);

      const conv2 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(conv2, "user", "Talking about Rust");
      await store.updateSessionTitle(conv2, "Rust Project");

      // Switch back to Python session
      const switched = await store.switchActiveSession(chatId, conv1);
      expect(switched.id).toBe(conv1);
      expect(switched.title).toBe("Python Project");

      const active = await store.getActiveSession(chatId);
      expect(active?.id).toBe(conv1);

      // Verify getOrCreateConversation returns conv1 now
      const resumedConv = await store.getOrCreateConversation(chatId);
      expect(resumedConv).toBe(conv1);
    });

    it("searches message history across sessions", async () => {
      const chatId = 1000;
      const conv1 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(conv1, "user", "What is the Railway deployment port?");
      await store.saveMessage(conv1, "assistant", "Use port 8080 for Railway.");
      await store.updateSessionTitle(conv1, "Railway Config");

      await store.clearConversation(chatId);

      const conv2 = await store.getOrCreateConversation(chatId);
      await store.saveMessage(conv2, "user", "How do I setup PostgreSQL Supabase?");
      await store.saveMessage(conv2, "assistant", "Use pgvector and Supabase CLI.");
      await store.updateSessionTitle(conv2, "Supabase Setup");

      // Search for "Railway"
      const railwayResults = await store.searchMessageHistory(chatId, "Railway");
      expect(railwayResults.length).toBe(2);
      expect(railwayResults[0].sessionTitle).toBe("Railway Config");
      expect(railwayResults.some((r) => r.content.includes("8080"))).toBe(true);

      // Search for "pgvector"
      const pgResults = await store.searchMessageHistory(chatId, "pgvector");
      expect(pgResults.length).toBe(1);
      expect(pgResults[0].sessionTitle).toBe("Supabase Setup");

      // Scoped search to specific conversation
      const scoped = await store.searchMessageHistory(chatId, "Railway", { conversationId: conv2 });
      expect(scoped.length).toBe(0);
    });

    it("retrieves full session messages and deletes a session", async () => {
      const chatId = 1001;
      const convId = await store.getOrCreateConversation(chatId);
      await store.saveMessage(convId, "user", "Step 1");
      await store.saveMessage(convId, "assistant", "Step 2");

      const msgs = await store.getSessionMessages(convId);
      expect(msgs.length).toBe(2);
      expect(msgs[0].content).toBe("Step 1");
      expect(msgs[1].content).toBe("Step 2");

      await store.deleteSession(convId);
      const afterMsgs = await store.getSessionMessages(convId);
      expect(afterMsgs.length).toBe(0);

      const sessions = await store.listSessions(chatId);
      expect(sessions.length).toBe(0);
    });

    it("prevents session proliferation by atomically deactivating older active sessions", async () => {
      const chatId = 2002;
      // Conv 1
      const conv1 = await store.getOrCreateConversation(chatId);
      const active1 = await store.getActiveSession(chatId);
      expect(active1?.id).toBe(conv1);
      expect(active1?.isActive).toBe(true);

      // Force conv1 to be older than 24h to trigger new conversation creation
      const oldTime = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
      const rawConv1 = store.conversations.get(conv1)!;
      rawConv1.created_at = oldTime;
      rawConv1.updated_at = oldTime;

      // Conv 2 is created
      const conv2 = await store.getOrCreateConversation(chatId);
      expect(conv2).not.toBe(conv1);

      // Verify Conv 1 was deactivated
      expect(rawConv1.is_active).toBe(false);

      // Verify only Conv 2 is active
      const activeSessions = Array.from(store.conversations.values()).filter(
        (c) => c.telegram_chat_id === chatId && c.is_active
      );
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].id).toBe(conv2);
    });

    it("filters out compacted messages from getContextMessages while keeping them searchable in history", async () => {
      const chatId = 3003;
      const convId = await store.getOrCreateConversation(chatId);

      await store.saveMessage(convId, "user", "Message 1 - durable instruction");
      await store.saveMessage(convId, "assistant", "Message 2 - ack");
      await store.saveMessage(convId, "user", "Message 3 - recent query");

      const msgs = Array.from(store.messages.values()).filter((m) => m.conversation_id === convId);
      expect(msgs.length).toBe(3);

      // Mark first two messages as compacted
      const compactedIds = [msgs[0].id, msgs[1].id];
      const count = await store.markMessagesCompacted(compactedIds);
      expect(count).toBe(2);

      // getContextMessages should now only return Message 3
      const contextMsgs = await store.getContextMessages(convId);
      expect(contextMsgs.length).toBe(1);
      expect(contextMsgs[0].content).toBe("Message 3 - recent query");

      // But searchMessageHistory should still find Message 1
      const searchResults = await store.searchMessageHistory(chatId, "durable");
      expect(searchResults.length).toBe(1);
      expect(searchResults[0].content).toContain("durable instruction");
    });

    it("retrieves a session by conversation ID with getSession", async () => {
      const chatId = 4004;
      const convId = await store.getOrCreateConversation(chatId);
      await store.saveMessage(convId, "user", "Session test msg");
      await store.updateSessionTitle(convId, "Custom Topic");

      const session = await store.getSession(convId);
      expect(session).not.toBeNull();
      expect(session?.id).toBe(convId);
      expect(session?.telegramChatId).toBe(chatId);
      expect(session?.title).toBe("Custom Topic");
      expect(session?.messageCount).toBe(1);

      const nonExistent = await store.getSession("non-existent-id");
      expect(nonExistent).toBeNull();
    });

    it("maintains single active conversation invariant across multiple sessions", async () => {
      const chatId = 555;
      const conv1 = await store.getOrCreateConversation(chatId);
      expect(store.conversations.get(conv1)?.is_active).toBe(true);

      // Simulate 25 hours passing
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      store.conversations.get(conv1)!.updated_at = staleDate;

      // Creating conversation after 24h archives the stale one
      const conv2 = await store.getOrCreateConversation(chatId);
      expect(conv2).not.toBe(conv1);
      expect(store.conversations.get(conv1)?.is_active).toBe(false);
      expect(store.conversations.get(conv2)?.is_active).toBe(true);

      const activeSessions = (await store.listSessions(chatId)).filter((s) => s.isActive);
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].id).toBe(conv2);
    });
  });
});

