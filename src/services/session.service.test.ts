import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  maybeAutoTitleSession,
  listRecentSessions,
  getActiveSession,
  switchSession,
  archiveActiveSession,
  searchChatHistory,
} from "./session.service.js";
import { resetDailyUsage } from "./cost-tracker.service.js";
import { env, setEnv } from "../config/env.js";

describe("session.service", () => {
  let store: InMemoryDataStore;
  const testChatId = 987654;

  beforeEach(() => {
    store = new InMemoryDataStore();
    resetDailyUsage();
  });

  describe("maybeAutoTitleSession", () => {
    it("returns null if conversation has fewer than 2 messages", async () => {
      const convId = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(convId, "user", "Hello there");

      const title = await maybeAutoTitleSession(convId, store);
      expect(title).toBeNull();
    });

    it("skips auto-titling and returns null when LLM spending cap is reached", async () => {
      const convId = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(convId, "user", "How do I deploy with Docker?");
      await store.saveMessage(convId, "assistant", "Use a multi-stage Dockerfile.");

      const originalEnv = env();
      setEnv({
        ...originalEnv,
        DAILY_LLM_CALL_CAP: 0,
      });

      try {
        const title = await maybeAutoTitleSession(convId, store);
        expect(title).toBeNull();
      } finally {
        setEnv(originalEnv);
        resetDailyUsage();
      }
    });

    it("auto-titles session and persists title to datastore when messages exist and cap is available", async () => {
      const convId = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(convId, "user", "Help me build an Express REST API with TypeScript");
      await store.saveMessage(convId, "assistant", "Start with npm init and install express.");

      const mockModel = {
        specificationVersion: "v1" as const,
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json" as const,
        async doGenerate() {
          return {
            text: "Express TypeScript API Setup",
            finishReason: "stop" as const,
            usage: { promptTokens: 15, completionTokens: 4 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() { throw new Error("Not implemented"); },
      };

      const title = await maybeAutoTitleSession(convId, store, mockModel as any);
      expect(title).toBe("Express TypeScript API Setup");

      const activeSession = await store.getActiveSession(testChatId);
      expect(activeSession?.title).toBe("Express TypeScript API Setup");
    });

    it("returns existing title immediately and skips LLM call when session already has a title", async () => {
      const convId = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(convId, "user", "Message 1");
      await store.saveMessage(convId, "assistant", "Message 2");
      await store.updateSessionTitle(convId, "Existing Topic Title");

      const generateSpy = vi.fn();
      const mockModel = {
        specificationVersion: "v1" as const,
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json" as const,
        doGenerate: generateSpy,
        async doStream() { throw new Error("Not implemented"); },
      };

      const title = await maybeAutoTitleSession(convId, store, mockModel as any);
      expect(title).toBe("Existing Topic Title");
      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  describe("Session management functions", () => {
    it("lists, switches, archives, and searches sessions", async () => {
      const conv1 = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(conv1, "user", "First session about PostgreSQL");
      await store.updateSessionTitle(conv1, "Postgres Setup");

      await archiveActiveSession(testChatId, store);
      const conv2 = await store.getOrCreateConversation(testChatId);
      await store.saveMessage(conv2, "user", "Second session about Redis");
      await store.updateSessionTitle(conv2, "Redis Caching");

      // List
      const sessions = await listRecentSessions(testChatId, 10, store);
      expect(sessions.length).toBe(2);

      // Get Active
      const active = await getActiveSession(testChatId, store);
      expect(active?.id).toBe(conv2);
      expect(active?.title).toBe("Redis Caching");

      // Switch
      const switched = await switchSession(testChatId, conv1, store);
      expect(switched.id).toBe(conv1);
      const newActive = await getActiveSession(testChatId, store);
      expect(newActive?.id).toBe(conv1);

      // Search
      const searchResults = await searchChatHistory(testChatId, "PostgreSQL", 5, store);
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].content).toContain("PostgreSQL");
    });
  });
});
