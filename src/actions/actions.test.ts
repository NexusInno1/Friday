import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  computeSnoozedTime,
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
  checkMemoryContradiction,
  generateEmbedding,
  EMBEDDING_MODEL,
  webSearchAction,
  rememberAction,
  recallMemoriesAction,
} from "./actions.js";
import { setAlertDispatcher, resetAlertRateLimits } from "../services/alert.service.js";
import { resetDailyUsage } from "../services/cost-tracker.service.js";
import { env, setEnv } from "../config/env.js";
import type { LanguageModelV1 } from "@ai-sdk/provider";

describe("Core Actions", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
  });

  describe("Embedding Configuration", () => {
    it("uses the supported gemini-embedding-2 model", () => {
      expect(EMBEDDING_MODEL).toBe("gemini-embedding-2");
    });
  });

  describe("computeSnoozedTime", () => {
    it("adds minutes correctly", () => {
      const base = "2026-08-28T10:00:00.000Z";
      expect(computeSnoozedTime(base, 15)).toBe("2026-08-28T10:15:00.000Z");
      expect(computeSnoozedTime(base, 60)).toBe("2026-08-28T11:00:00.000Z");
    });

    it("throws error for non-positive minutes", () => {
      expect(() => computeSnoozedTime("2026-08-28T10:00:00.000Z", 0)).toThrow(/positive/i);
    });
  });

  describe("Reminder Actions", () => {
    it("creates, snoozes, and cancels a reminder", async () => {
      const triggerAt = "2026-08-28T12:00:00.000Z";
      const reminder = await createReminderAction(
        {
          userId: 100,
          chatId: 100,
          message: "Buy groceries",
          triggerAt,
        },
        store
      );

      expect(reminder.id).toBeDefined();
      expect(reminder.message).toBe("Buy groceries");

      // Snooze +15m
      const { reminder: snoozed, newTriggerAt } = await snoozeReminderAction(
        reminder.id,
        15,
        100,
        store
      );
      expect(newTriggerAt).toBe("2026-08-28T12:15:00.000Z");
      expect(snoozed.trigger_at).toBe("2026-08-28T12:15:00.000Z");

      // Cancel
      const cancelled = await cancelReminderAction(reminder.id, 100, store);
      expect(cancelled.success).toBe(true);

      const activeList = await store.listActiveReminders(100);
      expect(activeList.length).toBe(0);
    });

    it("accepts valid cron expression for recurring reminder", async () => {
      const reminder = await createReminderAction(
        {
          userId: 100,
          chatId: 100,
          message: "Standup meeting",
          triggerAt: "2026-08-28T09:00:00.000Z",
          isRecurring: true,
          cronExpression: "0 9 * * 1-5",
        },
        store
      );

      expect(reminder.is_recurring).toBe(true);
      expect(reminder.cron_expression).toBe("0 9 * * 1-5");
    });

    it("rejects invalid cron expression on creation", async () => {
      await expect(
        createReminderAction(
          {
            userId: 100,
            chatId: 100,
            message: "Bad cron test",
            triggerAt: "2026-08-28T09:00:00.000Z",
            isRecurring: true,
            cronExpression: "invalid-cron-expr",
          },
          store
        )
      ).rejects.toThrow(/Invalid cron expression/);
    });

    it("rejects missing cron expression when isRecurring is true", async () => {
      await expect(
        createReminderAction(
          {
            userId: 100,
            chatId: 100,
            message: "Missing cron test",
            triggerAt: "2026-08-28T09:00:00.000Z",
            isRecurring: true,
          },
          store
        )
      ).rejects.toThrow(/Recurring reminders require a valid cron expression/);
    });
  });

  describe("updateBriefingTimeAction", () => {
    it("normalizes and persists briefing time", async () => {
      const res = await updateBriefingTimeAction("8:30am", 100, store);
      expect(res.success).toBe(true);
      expect(res.time).toBe("08:30");

      const profile = await store.getUserProfile(100);
      expect(profile?.briefing_time).toBe("08:30");
    });
  });

  describe("checkMemoryContradiction", () => {
    it("returns true immediately if statements are identical", async () => {
      const isContradict = await checkMemoryContradiction(
        "User lives in Berlin",
        "User lives in Berlin"
      );
      expect(isContradict).toBe(true);
    });

    it("returns true when model classifies statements as CONTRADICT", async () => {
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          return {
            text: "CONTRADICT",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() {
          throw new Error("Not implemented");
        },
      };

      const result = await checkMemoryContradiction(
        "User lives in New York",
        "User moved to London",
        mockModel as any
      );
      expect(result).toBe(true);
    });

    it("returns false when model classifies statements as COMPATIBLE", async () => {
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          return {
            text: "COMPATIBLE",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() {
          throw new Error("Not implemented");
        },
      };

      const result = await checkMemoryContradiction(
        "User likes coffee",
        "User likes tea",
        mockModel as any
      );
      expect(result).toBe(false);
    });

    it("fails safely and returns false if model throws an error", async () => {
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          throw new Error("API rate limit exceeded");
        },
        async doStream() {
          throw new Error("Not implemented");
        },
      };

      const result = await checkMemoryContradiction(
        "User prefers dark mode",
        "User switched to light theme",
        mockModel as any
      );
      expect(result).toBe(false);
    });
  });

  describe("webSearchAction", () => {
    it("rejects empty query", async () => {
      await expect(webSearchAction("   ")).rejects.toThrow(/Search query cannot be empty/);
    });

    it("sends topic='news' and days=1 by default when searching news", async () => {
      const originalFetch = globalThis.fetch;
      let capturedBody: any = null;

      globalThis.fetch = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          json: async () => ({
            answer: "Summary of AI news",
            results: [
              {
                title: "Test News Article",
                url: "https://example.com/news",
                content: "Breaking tech content",
                published_date: "Sun, 13 Sep 2026 12:00:00 GMT",
              },
            ],
          }),
        } as any;
      };

      try {
        const result = await webSearchAction("AI breakthroughs", {
          topic: "news",
          maxResults: 3,
        });

        expect(capturedBody).toBeDefined();
        expect(capturedBody.topic).toBe("news");
        expect(capturedBody.days).toBe(1);
        expect(capturedBody.max_results).toBe(3);
        expect(result.results.length).toBe(1);
        expect(result.results[0].publishedDate).toBe("Sun, 13 Sep 2026 12:00:00 GMT");
        expect(result.results[0].title).toBe("Test News Article");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Embedding Failure Alerting & Error Paths", () => {
    it("logs error, alerts, and throws when embedding fails in rememberAction", async () => {
      resetAlertRateLimits();
      const mockDispatcher = {
        sendAlert: vi.fn().mockResolvedValue(undefined),
      };
      setAlertDispatcher(mockDispatcher);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND generativelanguage.googleapis.com"));

      try {
        await expect(
          rememberAction("Important preference", ["pref"], 3, store, 100)
        ).rejects.toThrow(/Embedding generation failed/);

        expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
        const alertMsg = (mockDispatcher.sendAlert as any).mock.calls[0][0];
        expect(alertMsg).toContain("CRITICAL ALERT: embedding_failure");
      } finally {
        globalThis.fetch = originalFetch;
        setAlertDispatcher(null);
      }
    });

    it("logs error, alerts, and throws when embedding fails in recallMemoriesAction", async () => {
      resetAlertRateLimits();
      const mockDispatcher = {
        sendAlert: vi.fn().mockResolvedValue(undefined),
      };
      setAlertDispatcher(mockDispatcher);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

      try {
        await expect(
          recallMemoriesAction("What is my name?", 5, store, 100)
        ).rejects.toThrow(/Embedding recall failed/);

        expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
        const alertMsg = (mockDispatcher.sendAlert as any).mock.calls[0][0];
        expect(alertMsg).toContain("CRITICAL ALERT: embedding_failure");
      } finally {
        globalThis.fetch = originalFetch;
        setAlertDispatcher(null);
      }
    });
  });

  describe("checkMemoryContradiction", () => {
    it("returns true on exact string match without calling model", async () => {
      const isMatch = await checkMemoryContradiction("User lives in Tokyo", "User lives in Tokyo");
      expect(isMatch).toBe(true);
    });

    it("evaluates model response and returns true when contradiction indicated", async () => {
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          return {
            text: "CONTRADICT - the user moved from Tokyo to Kyoto",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() { throw new Error("Not implemented"); },
      };

      const result = await checkMemoryContradiction(
        "User lives in Tokyo",
        "User moved to Kyoto",
        mockModel as any
      );
      expect(result).toBe(true);
    });

    it("evaluates model response and returns false when not a contradiction", async () => {
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          return {
            text: "NO - the user likes both coffee and tea",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() { throw new Error("Not implemented"); },
      };

      const result = await checkMemoryContradiction(
        "User drinks coffee",
        "User drinks tea",
        mockModel as any
      );
      expect(result).toBe(false);
    });

    it("safely skips contradiction check and returns false when LLM spending cap is reached", async () => {
      resetDailyUsage();
      const originalEnv = env();
      setEnv({
        ...originalEnv,
        DAILY_LLM_CALL_CAP: 0, // Zero cap to force immediate quota limit
      });

      let modelCalled = false;
      const mockModel: LanguageModelV1 = {
        specificationVersion: "v1",
        modelId: "mock-model",
        provider: "mock",
        defaultObjectGenerationMode: "json",
        async doGenerate() {
          modelCalled = true;
          return {
            text: "YES",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 2 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
        async doStream() { throw new Error("Not implemented"); },
      };

      try {
        const result = await checkMemoryContradiction(
          "User works at Google",
          "User works at OpenAI",
          mockModel as any
        );
        expect(result).toBe(false);
        expect(modelCalled).toBe(false);
      } finally {
        setEnv(originalEnv);
        resetDailyUsage();
      }
    });
  });

  describe("generateEmbedding Header & API Key Security", () => {
    it("transmits GEMINI_API_KEY via x-goog-api-key header and never in URL query parameter", async () => {
      const originalFetch = globalThis.fetch;
      const secretKey = "test-secret-gemini-key-12345";
      const originalEnv = env();
      setEnv({
        ...originalEnv,
        GEMINI_API_KEY: secretKey,
      });

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        capturedUrl = url;
        capturedHeaders = init?.headers ?? {};
        return {
          ok: true,
          json: async () => ({
            embedding: { values: [0.1, 0.2, 0.3] },
          }),
        };
      });

      try {
        const embedding = await generateEmbedding("Test text for embedding");
        expect(embedding).toEqual([0.1, 0.2, 0.3]);
        expect(capturedUrl).not.toContain("?key=");
        expect(capturedUrl).not.toContain(secretKey);
        expect(capturedHeaders["x-goog-api-key"]).toBe(secretKey);
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(originalEnv);
      }
    });

    it("redacts GEMINI_API_KEY in error details if API returns error body containing the key", async () => {
      const originalFetch = globalThis.fetch;
      const secretKey = "test-secret-gemini-key-99999";
      const originalEnv = env();
      setEnv({
        ...originalEnv,
        GEMINI_API_KEY: secretKey,
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => `Invalid request for api_key=${secretKey} on resource`,
      });

      try {
        await expect(generateEmbedding("Sample text")).rejects.toThrowError(
          expect.not.stringContaining(secretKey)
        );
        try {
          await generateEmbedding("Sample text");
        } catch (err) {
          expect((err as Error).message).toContain("[REDACTED]");
          expect((err as Error).message).not.toContain(secretKey);
        }
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(originalEnv);
      }
    });

    it("redacts GEMINI_API_KEY from network error messages if thrown", async () => {
      const originalFetch = globalThis.fetch;
      const secretKey = "test-secret-gemini-key-88888";
      const originalEnv = env();
      setEnv({
        ...originalEnv,
        GEMINI_API_KEY: secretKey,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(
        new Error(`Connection reset while transmitting credentials ${secretKey}`)
      );

      try {
        await expect(generateEmbedding("Sample text")).rejects.toThrowError(
          expect.not.stringContaining(secretKey)
        );
        try {
          await generateEmbedding("Sample text");
        } catch (err) {
          expect((err as Error).message).toContain("[REDACTED]");
          expect((err as Error).message).not.toContain(secretKey);
          if ((err as Error).stack) {
            expect((err as Error).stack).not.toContain(secretKey);
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(originalEnv);
      }
    });

    it("redacts GEMINI_API_KEY from non-Error string throws", async () => {
      const originalFetch = globalThis.fetch;
      const secretKey = "test-secret-gemini-key-string-99999";
      const originalEnv = env();
      setEnv({
        ...originalEnv,
        GEMINI_API_KEY: secretKey,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(`Raw network string failure with ${secretKey}`);

      try {
        await expect(generateEmbedding("Sample text")).rejects.toThrowError("[REDACTED]");
        try {
          await generateEmbedding("Sample text");
        } catch (err) {
          expect((err as Error).message).not.toContain(secretKey);
        }
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(originalEnv);
      }
    });
  });
});

