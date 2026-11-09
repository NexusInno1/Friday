import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import {
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  computeSnoozedTime,
} from "./actions/actions.js";
import { ProactiveScheduler, InMemoryDispatcher } from "./services/scheduler.service.js";

describe("Challenger 3 Empirical Verification: Reminder States & Snooze Lifecycle", () => {
  let store: InMemoryDataStore;
  let dispatcher: InMemoryDispatcher;
  let scheduler: ProactiveScheduler;

  beforeEach(() => {
    store = new InMemoryDataStore();
    dispatcher = new InMemoryDispatcher();
    scheduler = new ProactiveScheduler({ store, dispatcher });
  });

  // State 1: Future Scheduled Reminder
  it("State 1 [Future Scheduled]: snoozes cleanly and is claimed by scheduler when snoozed time arrives", async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const reminder = await createReminderAction(
      {
        userId: 1,
        chatId: 100,
        message: "Future scheduled reminder",
        triggerAt: futureTime,
      },
      store
    );

    expect(reminder.is_completed).toBe(false);
    expect(reminder.sent_at).toBeFalsy();

    // Snooze by 15m
    const snoozeRes = await snoozeReminderAction(reminder.id, 15, 1, store);
    const expectedTime = new Date(new Date(futureTime).getTime() + 15 * 60 * 1000).toISOString();
    expect(snoozeRes.newTriggerAt).toBe(expectedTime);
    expect(snoozeRes.reminder.is_completed).toBe(false);

    // Time before snooze trigger: should NOT be claimed
    const notDueYet = new Date(new Date(futureTime).getTime() + 10 * 60 * 1000).toISOString();
    const claimedEarly = await store.claimDueReminders(notDueYet, 120_000);
    expect(claimedEarly.length).toBe(0);

    // Time after snooze trigger: MUST be claimed
    const dueTime = new Date(new Date(futureTime).getTime() + 20 * 60 * 1000).toISOString();
    const claimed = await store.claimDueReminders(dueTime, 120_000);
    expect(claimed.map((r) => r.id)).toContain(reminder.id);
  });

  // State 2: Overdue Undelivered Reminder
  it("State 2 [Overdue Undelivered]: snoozes relative to current time and is claimed when snoozed time arrives", async () => {
    const pastTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const reminder = await createReminderAction(
      {
        userId: 1,
        chatId: 100,
        message: "Overdue undelivered reminder",
        triggerAt: pastTime,
      },
      store
    );

    expect(reminder.is_completed).toBe(false);
    expect(reminder.delivery_attempts).toBe(0);
    expect(reminder.sent_at).toBeFalsy();

    const beforeSnooze = Date.now();
    const snoozeRes = await snoozeReminderAction(reminder.id, 15, 1, store);
    const afterSnooze = Date.now();

    const newTriggerMs = new Date(snoozeRes.newTriggerAt).getTime();
    expect(newTriggerMs).toBeGreaterThanOrEqual(beforeSnooze + 15 * 60 * 1000);
    expect(newTriggerMs).toBeLessThanOrEqual(afterSnooze + 15 * 60 * 1000);

    // Immediate check (now): must NOT be claimed (past re-trigger loop prevention)
    const claimedImmediate = await store.claimDueReminders(new Date().toISOString(), 120_000);
    expect(claimedImmediate.map((r) => r.id)).not.toContain(reminder.id);

    // When 15 minutes pass: MUST be claimed
    const futureTime = new Date(Date.now() + 16 * 60 * 1000).toISOString();
    const claimedLater = await store.claimDueReminders(futureTime, 120_000);
    expect(claimedLater.map((r) => r.id)).toContain(reminder.id);
  });

  // State 3: Past Delivered Reminder (The Adversarial Challenge)
  it("State 3 [Past Delivered]: when a delivered reminder is snoozed, sent_at MUST be cleared so scheduler can re-claim it", async () => {
    const dueTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago
    const reminder = await createReminderAction(
      {
        userId: 1,
        chatId: 100,
        message: "Delivered reminder to be snoozed",
        triggerAt: dueTime,
      },
      store
    );

    // Initial delivery by scheduler
    const count = await scheduler.checkDueReminders();
    expect(count).toBe(1);
    expect(dispatcher.dispatched.length).toBe(1);

    const delivered = await store.getReminder(reminder.id, 1);
    expect(delivered?.is_completed).toBe(true);
    expect(delivered?.sent_at).toBeTruthy(); // sent_at is populated upon delivery

    // User taps snooze (+15m)
    const snoozeRes = await snoozeReminderAction(reminder.id, 15, 1, store);
    expect(snoozeRes.reminder.is_completed).toBe(false);

    // CRITICAL ADVERSARIAL ASSERTION:
    // When a delivered reminder is snoozed, its sent_at must be reset to null (or cleared),
    // because claimDueReminders filters out reminders where sent_at is not null!
    const isSentAtCleared = snoozeRes.reminder.sent_at === null;

    // Verify claimDueReminders after snooze interval
    const afterSnoozeInterval = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const claimedAfterSnooze = await store.claimDueReminders(afterSnoozeInterval, 120_000);
    
    // THIS CURRENTLY FAILS: claimedAfterSnooze is [] because sent_at is not null!
    expect(claimedAfterSnooze.map((r) => r.id)).toContain(reminder.id);
    expect(isSentAtCleared).toBe(true);
  });

  // Proof of Remediation: If sent_at is cleared on snooze, claimDueReminders succeeds
  it("State 3 Remediation Proof: clearing sent_at on snooze allows scheduler to re-claim delivered reminder", async () => {
    const dueTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const reminder = await createReminderAction(
      {
        userId: 1,
        chatId: 100,
        message: "Delivered reminder with remediation proof",
        triggerAt: dueTime,
      },
      store
    );

    // Initial delivery
    await scheduler.checkDueReminders();
    const delivered = await store.getReminder(reminder.id, 1);
    expect(delivered?.is_completed).toBe(true);
    expect(delivered?.sent_at).toBeTruthy();

    // Snooze and explicitly clear sent_at (the required fix)
    const newTriggerAt = computeSnoozedTime(reminder.trigger_at, 15, Date.now());
    const remediatedReminder = await store.updateReminder(reminder.id, {
      trigger_at: newTriggerAt,
      is_completed: false,
      lease_until: null,
      sent_at: null,
    });

    expect(remediatedReminder.sent_at).toBeNull();
    expect(remediatedReminder.is_completed).toBe(false);

    // Verify claimDueReminders after snooze interval
    const afterSnoozeInterval = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const claimedAfterSnooze = await store.claimDueReminders(afterSnoozeInterval, 120_000);
    expect(claimedAfterSnooze.map((r) => r.id)).toContain(reminder.id);
  });

  // State 4: Cancelled Reminder
  it("State 4 [Cancelled Reminder]: snoozing a cancelled reminder leaves is_cancelled true or throws", async () => {
    const reminder = await createReminderAction(
      {
        userId: 1,
        chatId: 100,
        message: "Cancelled reminder test",
        triggerAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      store
    );

    await cancelReminderAction(reminder.id, 1, store);
    const cancelled = await store.getReminder(reminder.id, 1);
    expect(cancelled?.is_cancelled).toBe(true);

    // Snoozing a cancelled reminder
    await expect(snoozeReminderAction(reminder.id, 15, 1, store)).rejects.toThrow(
      "Cannot snooze a cancelled reminder."
    );
    
    // When snoozed, is_cancelled is STILL true, meaning it will never be claimed
    expect((await store.getReminder(reminder.id, 1))?.is_cancelled).toBe(true);

    // Verify claimDueReminders after future time
    const futureTime = new Date(Date.now() + 7200 * 1000).toISOString();
    const claimed = await store.claimDueReminders(futureTime, 120_000);
    expect(claimed.map((r) => r.id)).not.toContain(reminder.id);
  });
});
