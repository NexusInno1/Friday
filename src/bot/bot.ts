import { Bot } from "grammy";
import { env } from "../config/env.js";
import { authMiddleware } from "./middlewares/auth.js";
import { errorHandler } from "./middlewares/error.js";
import { handleStart } from "./commands/start.js";
import { handleHelp } from "./commands/help.js";
import { handleReminders } from "./commands/reminders.js";
import { handleRemember } from "./commands/remember.js";
import { handleSearch } from "./commands/search.js";
import { handleStatus } from "./commands/status.js";
import { handleClear } from "./commands/clear.js";
import { handleBriefing } from "./commands/briefing.js";
import { runAgent } from "../services/agent.service.js";
import { snoozeReminder, cancelReminder } from "../services/reminder.service.js";
import { chunkMessage } from "../utils/chunk.js";

export function createBot(): Bot {
  const { TELEGRAM_BOT_TOKEN } = env();
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Global error boundary
  bot.catch(errorHandler);

  // Security whitelist middleware
  bot.use(authMiddleware);

  // Direct slash commands
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("briefing", handleBriefing);
  bot.command("reminders", handleReminders);
  bot.command("remember", handleRemember);
  bot.command("search", handleSearch);
  bot.command("status", handleStatus);
  bot.command("clear", handleClear);

  // Callback query handlers for interactive reminder buttons
  bot.callbackQuery(/^snooze:([a-f0-9-]+):(\d+)$/i, async (ctx) => {
    const reminderId = ctx.match[1];
    const minutes = Number(ctx.match[2]);

    try {
      const { reminder, newTriggerAt } = await snoozeReminder(reminderId, minutes);

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
      await ctx.answerCallbackQuery({ text: "Failed to snooze." });
    }
  });

  bot.callbackQuery(/^cancel:([a-f0-9-]+)$/i, async (ctx) => {
    const reminderId = ctx.match[1];

    try {
      await cancelReminder(reminderId);

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
      await ctx.answerCallbackQuery({ text: "Failed to cancel." });
    }
  });

  // Natural language message handler (core reasoning loop)
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    // Send continuous typing indicator while agent processes
    await ctx.replyWithChatAction("typing").catch(() => {});
    const interval = setInterval(() => {
      void ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      const response = await runAgent(chatId, text);
      clearInterval(interval);

      const chunks = chunkMessage(response, 4000);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true },
          });
        } catch {
          // Markdown parse failure fallback
          await ctx.reply(chunk, {
            link_preview_options: { is_disabled: true },
          });
        }
      }
    } catch (error) {
      clearInterval(interval);
      console.error("[bot:agent] Failed to generate response:", error);
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      await ctx
        .reply(
          `⚠️ **Encountered an issue processing that:** ${errMsg}\n\nPlease try again or ask with more specifics, Boss.`,
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.reply(
            `⚠️ Encountered an issue processing that: ${errMsg}\n\nPlease try again or ask with more specifics, Boss.`
          );
        });
    }
  });

  return bot;
}
