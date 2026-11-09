import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCallbacks } from "./index.js";
import { InMemoryDataStore } from "../../db/in-memory-datastore.js";
import { setDataStore } from "../../db/datastore-provider.js";
import { ProactiveScheduler, InMemoryDispatcher } from "../../services/scheduler.service.js";
import { env, setEnv } from "../../config/env.js";

describe("Bot Callbacks Registration", () => {
  let store: InMemoryDataStore;
  let scheduler: ProactiveScheduler;
  const handlers: Map<RegExp, (ctx: any) => Promise<void>> = new Map();
  const userId = 12345;

  const fakeBot: any = {
    callbackQuery: vi.fn((regex: RegExp, handler: (ctx: any) => Promise<void>) => {
      handlers.set(regex, handler);
    }),
  };

  beforeEach(() => {
    handlers.clear();
    setEnv({
      ...env(),
      TELEGRAM_ALLOWED_USER_ID: userId,
    });
    store = new InMemoryDataStore();
    setDataStore(store);
    scheduler = new ProactiveScheduler({ store, dispatcher: new InMemoryDispatcher() });
  });

  it("registers all 8 interactive callback query handlers", () => {
    registerCallbacks(fakeBot, scheduler);

    expect(fakeBot.callbackQuery).toHaveBeenCalledTimes(8);

    const patterns = Array.from(handlers.keys()).map((r) => r.source);
    expect(patterns.some((p) => p.includes("snooze"))).toBe(true);
    expect(patterns.some((p) => p.includes("cancel"))).toBe(true);
    expect(patterns.some((p) => p.includes("memory:delete"))).toBe(true);
    expect(patterns.some((p) => p.includes("confirm_mem"))).toBe(true);
    expect(patterns.some((p) => p.includes("reject_mem"))).toBe(true);
    expect(patterns.some((p) => p.includes("session:switch"))).toBe(true);
    expect(patterns.some((p) => p.includes("session:view"))).toBe(true);
    expect(patterns.some((p) => p.includes("session:delete"))).toBe(true);
  });

  it("handles reminder snooze callback query successfully", async () => {
    registerCallbacks(fakeBot, scheduler);

    const snoozeRegex = Array.from(handlers.keys()).find((r) => r.source.includes("snooze"))!;
    const snoozeHandler = handlers.get(snoozeRegex)!;

    const future = new Date(Date.now() + 10000).toISOString();
    const reminder = await store.createReminder({
      userId,
      chatId: userId,
      message: "Take pills",
      triggerAt: future,
    });

    const ctx = {
      match: ["snooze:fake:15", reminder.id, "15"],
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue({}),
    };

    await snoozeHandler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Snoozed for 15 minutes!",
    });
    expect(ctx.editMessageText).toHaveBeenCalled();
  });
});
