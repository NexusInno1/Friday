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
});
