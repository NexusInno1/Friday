import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  computeSnoozedTime,
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
  checkMemoryContradiction,
  EMBEDDING_MODEL,
} from "./actions.js";
import type { LanguageModelV1 } from "@ai-sdk/provider";

describe("Core Actions", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
  });

  describe("Embedding Configuration", () => {
    it("uses the supported text-embedding-004 model", () => {
      expect(EMBEDDING_MODEL).toBe("text-embedding-004");
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
});
