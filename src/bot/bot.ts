import { Bot } from "grammy";
import { env } from "../config/env.js";
import { chatScopeMiddleware } from "./middlewares/chat-scope.js";
import { authMiddleware } from "./middlewares/auth.js";
import { errorHandler } from "./middlewares/error.js";
import { handleStart } from "./commands/start.js";
import { handleHelp } from "./commands/help.js";
import { handleReminders } from "./commands/reminders.js";
import { handleRemember } from "./commands/remember.js";
import { handleMemories } from "./commands/memories.js";
import { handleSearch } from "./commands/search.js";
import { handleStatus } from "./commands/status.js";
import { handleClear } from "./commands/clear.js";
import { handleBriefing } from "./commands/briefing.js";
import { handleSessions } from "./commands/sessions.js";
import { handleHistory } from "./commands/history.js";
import { getAssistantEngine, AssistantEngine } from "../services/agent.service.js";
import { getScheduler, ProactiveScheduler, TelegramDispatcher } from "../services/scheduler.service.js";
import { registerCallbacks } from "./callbacks/index.js";
import { chunkMessage } from "../utils/chunk.js";

export interface BotFactoryOptions {
  token?: string;
  assistantEngine?: AssistantEngine;
  scheduler?: ProactiveScheduler;
}

export function createBot(options: BotFactoryOptions = {}): Bot {
  const token = options.token ?? env().TELEGRAM_BOT_TOKEN;
  const bot = new Bot(token);
  const engine = options.assistantEngine ?? getAssistantEngine();
  const scheduler = options.scheduler ?? getScheduler();

  // Wire dispatcher to engine so interactive confirmations (e.g. memory guard) reach Telegram
  const dispatcher = new TelegramDispatcher(bot);
  engine.setDispatcher(dispatcher);

  // Global error boundary
  bot.catch(errorHandler);

  // Ingress chat-scope guard (drops non-private chats)
  bot.use(chatScopeMiddleware);

  // Security whitelist middleware (ADR-0001)
  bot.use(authMiddleware);

  // Direct slash commands
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("briefing", handleBriefing);
  bot.command("reminders", handleReminders);
  bot.command("remember", handleRemember);
  bot.command("memories", handleMemories);
  bot.command("search", handleSearch);
  bot.command("status", handleStatus);
  bot.command("clear", handleClear);
  bot.command("sessions", handleSessions);
  bot.command("history", handleHistory);

  // Interactive callback query handlers (modularized in ./callbacks/)
  registerCallbacks(bot, scheduler);

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
      const response = await engine.reply(chatId, text);

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
    } finally {
      clearInterval(interval);
    }
  });

  return bot;
}
