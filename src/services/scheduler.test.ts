import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  ProactiveScheduler,
  InMemoryDispatcher,
} from "./scheduler.service.js";

describe("ProactiveScheduler", () => {
  let store: InMemoryDataStore;
  let dispatcher: InMemoryDispatcher;
  let scheduler: ProactiveScheduler;

  beforeEach(() => {
    store = new InMemoryDataStore();
    dispatcher = new InMemoryDispatcher();
    scheduler = new ProactiveScheduler({ store, dispatcher });
  });

  it("checks and dispatches due reminders with interactive action buttons", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Call the dentist",
      triggerAt: pastTime,
    });

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(1);

    expect(dispatcher.dispatched.length).toBe(1);
    expect(dispatcher.dispatched[0].chatId).toBe(12345);
    expect(dispatcher.dispatched[0].text).toContain("Call the dentist");
    expect(dispatcher.dispatched[0].buttons?.length).toBe(3);

    // Verify reminder marked as completed
    const active = await store.listActiveReminders(12345);
    expect(active.length).toBe(0);
  });

  it("snoozes a reminder through scheduler interface", async () => {
    const triggerAt = "2026-08-28T10:00:00.000Z";
    const reminder = await store.createReminder({
      userId: 123456789,
      chatId: 123456789,
      message: "Take a break",
      triggerAt,
    });

    const result = await scheduler.snooze(reminder.id, 15);
    expect(result.newTriggerAt).toBe("2026-08-28T10:15:00.000Z");
  });

  it("cancels a reminder through scheduler interface", async () => {
    const reminder = await store.createReminder({
      userId: 123456789,
      chatId: 123456789,
      message: "Cancel this",
      triggerAt: new Date().toISOString(),
    });

    const success = await scheduler.cancel(reminder.id);
    expect(success).toBe(true);
  });

  it("claims due reminder with lease and prevents double-claim under concurrent execution", async () => {
    const nowIso = new Date().toISOString();
    const pastTime = new Date(Date.now() - 5000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Concurrent test reminder",
      triggerAt: pastTime,
    });

    // Worker 1 claims with 2-minute lease
    const claimedWorker1 = await store.claimDueReminders(nowIso, 120_000);
    expect(claimedWorker1.length).toBe(1);
    expect(claimedWorker1[0].id).toBe(reminder.id);
    expect(claimedWorker1[0].delivery_attempts).toBe(1);
    expect(claimedWorker1[0].lease_until).toBeDefined();

    // Worker 2 attempts to claim concurrently at the same timestamp
    const claimedWorker2 = await store.claimDueReminders(nowIso, 120_000);
    expect(claimedWorker2.length).toBe(0);

    // After lease expires (121 seconds later), Worker 2 can reclaim it
    const futureIso = new Date(Date.now() + 125_000).toISOString();
    const reclaimed = await store.claimDueReminders(futureIso, 120_000);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(reminder.id);
    expect(reclaimed[0].delivery_attempts).toBe(2);
  });

  it("retains lease and does not complete reminder when delivery fails", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Flaky network reminder",
      triggerAt: pastTime,
    });

    // Make dispatcher throw to simulate network failure
    dispatcher.sendMessage = async () => {
      throw new Error("Telegram network timeout");
    };

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(0);

    // Verify reminder is NOT completed and still has active lease
    const rawReminder = await store.getReminder(reminder.id, 12345);
    expect(rawReminder?.is_completed).toBe(false);
    expect(rawReminder?.lease_until).not.toBeNull();
    expect(rawReminder?.delivery_attempts).toBe(1);
  });

  it("cancels reminder when delivery attempts reach MAX_DELIVERY_ATTEMPTS", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Poison reminder",
      triggerAt: pastTime,
    });

    // Simulate reminder having already been attempted 4 times
    await store.updateReminder(reminder.id, { delivery_attempts: 4 });

    dispatcher.sendMessage = async () => {
      throw new Error("Permanent chat failure");
    };

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(0);

    const updated = await store.getReminder(reminder.id, 12345);
    expect(updated?.is_cancelled).toBe(true);
    expect(updated?.lease_until).toBeNull();
    expect(updated?.delivery_attempts).toBe(5);
  });
});
