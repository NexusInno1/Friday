import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import {
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  computeSnoozedTime,
} from "./actions/actions.js";
import { ProactiveScheduler, InMemoryDispatcher } from "./services/scheduler.service.js";

describe("Challenger 4 Empirical Gate: Comprehensive 4-State Lifecycle & Multi-Cycle Re-Claiming", () => {
  let store: InMemoryDataStore;
  let dispatcher: InMemoryDispatcher;
  let scheduler: ProactiveScheduler;

  beforeEach(() => {
    store = new InMemoryDataStore();
    dispatcher = new InMemoryDispatcher();
    scheduler = new ProactiveScheduler({ store, dispatcher });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // State 1: Future Scheduled Reminders
  // ─────────────────────────────────────────────────────────────────────────────
  describe("State 1: Future Scheduled Reminder", () => {
    it("preserves sent_at as null, resets lease, advances trigger from scheduled time, and is claimed when due", async () => {
      const now = Date.now();
      const futureTime = new Date(now + 2 * 60 * 60 * 1000).toISOString(); // +2 hours

      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Future meeting reminder",
          triggerAt: futureTime,
        },
        store
      );

      expect(reminder.is_completed).toBe(false);
      expect(reminder.is_cancelled).toBe(false);
      expect(reminder.sent_at).toBeFalsy();

      // Snooze by 30 minutes
      const snoozeRes = await snoozeReminderAction(reminder.id, 30, 1, store, now);
      const expectedTime = new Date(new Date(futureTime).getTime() + 30 * 60 * 1000).toISOString();

      expect(snoozeRes.newTriggerAt).toBe(expectedTime);
      expect(snoozeRes.reminder.is_completed).toBe(false);
      expect(snoozeRes.reminder.is_cancelled).toBe(false);
      expect(snoozeRes.reminder.sent_at).toBeNull();
      expect(snoozeRes.reminder.lease_until).toBeNull();

      // Time before snoozed trigger (+2h 15m) -> should NOT be claimed
      const beforeTrigger = new Date(now + 135 * 60 * 1000).toISOString();
      const claimedEarly = await store.claimDueReminders(beforeTrigger, 60_000);
      expect(claimedEarly.length).toBe(0);

      // Time after snoozed trigger (+2h 35m) -> MUST be claimed
      const afterTrigger = new Date(now + 155 * 60 * 1000).toISOString();
      const claimed = await store.claimDueReminders(afterTrigger, 60_000);
      expect(claimed.length).toBe(1);
      expect(claimed[0].id).toBe(reminder.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // State 2: Overdue Undelivered Reminders
  // ─────────────────────────────────────────────────────────────────────────────
  describe("State 2: Overdue Undelivered Reminder", () => {
    it("anchors snooze to current time (not ancient past), avoiding immediate re-trigger loops", async () => {
      const ancientPast = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 hours ago
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Overdue task from yesterday",
          triggerAt: ancientPast,
        },
        store
      );

      expect(reminder.is_completed).toBe(false);
      expect(reminder.sent_at).toBeFalsy();

      const t0 = Date.now();
      const snoozeRes = await snoozeReminderAction(reminder.id, 15, 1, store);
      const t1 = Date.now();

      const newTriggerMs = new Date(snoozeRes.newTriggerAt).getTime();
      expect(newTriggerMs).toBeGreaterThanOrEqual(t0 + 15 * 60 * 1000);
      expect(newTriggerMs).toBeLessThanOrEqual(t1 + 15 * 60 * 1000);
      expect(snoozeRes.reminder.sent_at).toBeNull();
      expect(snoozeRes.reminder.is_completed).toBe(false);

      // Instant check at t1: Must NOT be claimed (loop prevention verified!)
      const immediateClaim = await store.claimDueReminders(new Date(t1).toISOString(), 60_000);
      expect(immediateClaim.map((r) => r.id)).not.toContain(reminder.id);

      // Check after 16 minutes: Must be claimed
      const futureCheck = new Date(t1 + 16 * 60 * 1000).toISOString();
      const laterClaim = await store.claimDueReminders(futureCheck, 60_000);
      expect(laterClaim.map((r) => r.id)).toContain(reminder.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // State 3: Past Delivered Reminders & Multi-Cycle Re-Claiming
  // ─────────────────────────────────────────────────────────────────────────────
  describe("State 3: Past Delivered Reminder (Lifecycle & Multi-Cycle Snooze)", () => {
    it("delivers, snoozes, re-claims, re-delivers, and supports secondary snooze cycles cleanly", async () => {
      const now = Date.now();
      const dueTime = new Date(now - 10 * 60 * 1000).toISOString(); // 10m ago

      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Recurring alarm test",
          triggerAt: dueTime,
        },
        store
      );

      // ── Cycle 1 Delivery ──
      const count1 = await scheduler.checkDueReminders();
      expect(count1).toBe(1);
      expect(dispatcher.dispatched.length).toBe(1);
      expect(dispatcher.dispatched[0].text).toContain("Recurring alarm test");

      const delivered1 = await store.getReminder(reminder.id, 1);
      expect(delivered1?.is_completed).toBe(true);
      expect(delivered1?.sent_at).toBeTruthy();
      expect(delivered1?.lease_until).toBeNull();

      // ── Cycle 1 Snooze (+15m) ──
      const snooze1 = await snoozeReminderAction(reminder.id, 15, 1, store, now);
      expect(snooze1.reminder.is_completed).toBe(false);
      expect(snooze1.reminder.sent_at).toBeNull(); // CRITICAL FIX VERIFIED
      expect(snooze1.reminder.lease_until).toBeNull();

      // Scheduler at +5m: should NOT re-deliver
      // Mock store.claimDueReminders time via passing to store
      const notDueYetIso = new Date(now + 5 * 60 * 1000).toISOString();
      const claimedEarly = await store.claimDueReminders(notDueYetIso, 60_000);
      expect(claimedEarly.length).toBe(0);

      // Scheduler at +20m: MUST claim due reminder
      const dueIso = new Date(now + 20 * 60 * 1000).toISOString();
      const claimedForCycle2 = await store.claimDueReminders(dueIso, 120_000);
      expect(claimedForCycle2.length).toBe(1);
      expect(claimedForCycle2[0].id).toBe(reminder.id);
      expect(claimedForCycle2[0].delivery_attempts).toBe(2);

      // Simulate completion of cycle 2 delivery
      await store.updateReminder(reminder.id, {
        is_completed: true,
        lease_until: null,
      });

      const delivered2 = await store.getReminder(reminder.id, 1);
      expect(delivered2?.is_completed).toBe(true);
      expect(delivered2?.sent_at).toBeTruthy();

      // ── Cycle 2 Secondary Snooze (+60m) ──
      const snooze2 = await snoozeReminderAction(reminder.id, 60, 1, store, now + 20 * 60 * 1000);
      expect(snooze2.reminder.is_completed).toBe(false);
      expect(snooze2.reminder.sent_at).toBeNull(); // CRITICAL FIX VERIFIED AGAIN

      // Verify re-claim for Cycle 3 after +85m
      const cycle3Iso = new Date(now + 85 * 60 * 1000).toISOString();
      const claimedForCycle3 = await store.claimDueReminders(cycle3Iso, 120_000);
      expect(claimedForCycle3.length).toBe(1);
      expect(claimedForCycle3[0].id).toBe(reminder.id);
      expect(claimedForCycle3[0].delivery_attempts).toBe(3);
    });

    it("clears an active scheduler lease when user snoozes during in-flight delivery window", async () => {
      const now = Date.now();
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "In-flight leased reminder",
          triggerAt: new Date(now - 1000).toISOString(),
        },
        store
      );

      // Claim reminder with 5-minute lease
      const claimed = await store.claimDueReminders(new Date().toISOString(), 300_000);
      expect(claimed.length).toBe(1);
      expect(claimed[0].lease_until).toBeTruthy();

      // User snoozes while lease is still active
      const snoozed = await snoozeReminderAction(reminder.id, 15, 1, store, now);
      expect(snoozed.reminder.lease_until).toBeNull();
      expect(snoozed.reminder.sent_at).toBeNull();
      expect(snoozed.reminder.is_completed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // State 4: Cancelled Reminders
  // ─────────────────────────────────────────────────────────────────────────────
  describe("State 4: Cancelled Reminder", () => {
    it("rejects snoozing a cancelled reminder and prevents scheduler claims under all circumstances", async () => {
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Cancelled reminder",
          triggerAt: new Date(Date.now() + 60 * 1000).toISOString(),
        },
        store
      );

      // Cancel reminder
      await cancelReminderAction(reminder.id, 1, store);
      const inStore = await store.getReminder(reminder.id, 1);
      expect(inStore?.is_cancelled).toBe(true);

      // Attempt to snooze -> must throw explicit descriptive error
      await expect(snoozeReminderAction(reminder.id, 15, 1, store)).rejects.toThrow(
        "Cannot snooze a cancelled reminder."
      );

      // Assert reminder remains cancelled and uncompleted
      const afterAttempt = await store.getReminder(reminder.id, 1);
      expect(afterAttempt?.is_cancelled).toBe(true);

      // Advance time by 2 hours: scheduler must never claim
      const farFuture = new Date(Date.now() + 120 * 60 * 1000).toISOString();
      const claimed = await store.claimDueReminders(farFuture, 60_000);
      expect(claimed.map((r) => r.id)).not.toContain(reminder.id);
    });

    it("rejects snoozing a delivered-then-cancelled reminder", async () => {
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Delivered then cancelled",
          triggerAt: new Date(Date.now() - 5000).toISOString(),
        },
        store
      );

      // Deliver
      await scheduler.checkDueReminders();
      const delivered = await store.getReminder(reminder.id, 1);
      expect(delivered?.is_completed).toBe(true);

      // User cancels
      await cancelReminderAction(reminder.id, 1, store);

      // Snooze attempt
      await expect(snoozeReminderAction(reminder.id, 15, 1, store)).rejects.toThrow(
        "Cannot snooze a cancelled reminder."
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Boundary & Error Handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Boundary & Error Handling", () => {
    it("rejects non-positive snooze durations", async () => {
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Invalid minutes test",
          triggerAt: new Date(Date.now() + 60 * 1000).toISOString(),
        },
        store
      );

      await expect(snoozeReminderAction(reminder.id, 0, 1, store)).rejects.toThrow(
        "Snooze duration must be a positive number of minutes."
      );
      await expect(snoozeReminderAction(reminder.id, -5, 1, store)).rejects.toThrow(
        "Snooze duration must be a positive number of minutes."
      );
    });

    it("rejects unknown reminder IDs or wrong user IDs", async () => {
      await expect(
        snoozeReminderAction("00000000-0000-0000-0000-000000000000", 15, 1, store)
      ).rejects.toThrow("Reminder not found.");

      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Wrong user test",
          triggerAt: new Date(Date.now() + 60 * 1000).toISOString(),
        },
        store
      );

      // User 999 cannot snooze User 1's reminder
      await expect(snoozeReminderAction(reminder.id, 15, 999, store)).rejects.toThrow(
        "Reminder not found."
      );
    });
  });
});
