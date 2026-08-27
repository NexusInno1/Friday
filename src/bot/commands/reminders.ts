import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { listActiveReminders } from "../../services/reminder.service.js";
import { env } from "../../config/env.js";

export async function handleReminders(ctx: Context): Promise<void> {
  const { TELEGRAM_ALLOWED_USER_ID, USER_TIMEZONE } = env();

  try {
    const reminders = await listActiveReminders(TELEGRAM_ALLOWED_USER_ID, 25);

    if (reminders.length === 0) {
      await ctx.reply("📋 **No active reminders.** All caught up, Boss!");
      return;
    }

    await ctx.reply(`📋 **Active Reminders (${reminders.length})**:`, {
      parse_mode: "Markdown",
    });

    for (const reminder of reminders) {
      const timeStr = new Date(reminder.trigger_at).toLocaleString("en-IN", {
        timeZone: USER_TIMEZONE,
        dateStyle: "medium",
        timeStyle: "short",
      });

      const keyboard = new InlineKeyboard()
        .text("⏰ +15m", `snooze:${reminder.id}:15`)
        .text("⏰ +1h", `snooze:${reminder.id}:60`)
        .text("❌ Cancel", `cancel:${reminder.id}`);

      const recurringBadge = reminder.is_recurring ? " 🔁" : "";

      await ctx
        .reply(
          `• **${reminder.message}**${recurringBadge}\n  📅 Scheduled for: \`${timeStr}\``,
          {
            parse_mode: "Markdown",
            reply_markup: keyboard,
          }
        )
        .catch(async () => {
          await ctx.reply(
            `• ${reminder.message}${recurringBadge}\n  Scheduled for: ${timeStr}`,
            { reply_markup: keyboard }
          );
        });
    }
  } catch (error) {
    await ctx.reply(
      `⚠️ Failed to load reminders: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
