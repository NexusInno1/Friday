import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  computeSnoozedTime,
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
} from "./actions.js";

describe("Core Actions", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
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
});
