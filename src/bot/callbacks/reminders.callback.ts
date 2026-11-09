import type { Bot } from "grammy";
import { env } from "../../config/env.js";
import type { ProactiveScheduler } from "../../services/scheduler.service.js";

export function registerReminderCallbacks(bot: Bot, scheduler: ProactiveScheduler): void {
  bot.callbackQuery(/^snooze:([a-f0-9-]+):(\d+)$/i, async (ctx) => {
    const reminderId = ctx.match[1];
    const minutes = Number(ctx.match[2]);

    try {
      const { reminder, newTriggerAt } = await scheduler.snooze(reminderId, minutes);

      await ctx.answerCallbackQuery({
        text: `Snoozed for ${minutes} minutes!`,
      });
      const timeStr = new Date(newTriggerAt).toLocaleTimeString("en-IN", {
        timeZone: env().USER_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      await ctx
        .editMessageText(
          `⏰ **Snoozed**: ${reminder.message}\nNew time: \`${timeStr}\``,
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.editMessageText(
            `⏰ Snoozed: ${reminder.message}\nNew time: ${timeStr}`
          );
        });
    } catch (err) {
      console.error("[bot:snooze] Error snoozing reminder:", err);
      await ctx.answerCallbackQuery({ text: "Failed to snooze." }).catch(() => {});
    }
  });

  bot.callbackQuery(/^cancel:([a-f0-9-]+)$/i, async (ctx) => {
    const reminderId = ctx.match[1];

    try {
      await scheduler.cancel(reminderId);

      await ctx.answerCallbackQuery({ text: "Reminder cancelled." });
      await ctx
        .editMessageText("❌ **Reminder cancelled.**", {
          parse_mode: "Markdown",
        })
        .catch(async () => {
          await ctx.editMessageText("❌ Reminder cancelled.");
        });
    } catch (err) {
      console.error("[bot:cancel] Error cancelling reminder:", err);
      await ctx.answerCallbackQuery({ text: "Failed to cancel." }).catch(() => {});
    }
  });
}
