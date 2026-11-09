import type { Bot } from "grammy";
import type { ProactiveScheduler } from "../../services/scheduler.service.js";
import { registerReminderCallbacks } from "./reminders.callback.js";
import { registerMemoryCallbacks } from "./memories.callback.js";
import { registerSessionCallbacks } from "./sessions.callback.js";

export function registerCallbacks(bot: Bot, scheduler: ProactiveScheduler): void {
  registerReminderCallbacks(bot, scheduler);
  registerMemoryCallbacks(bot);
  registerSessionCallbacks(bot);
}

export * from "./reminders.callback.js";
export * from "./memories.callback.js";
export * from "./sessions.callback.js";
