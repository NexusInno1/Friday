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
import { deleteMemory } from "../services/memory.service.js";
import { confirmPendingMemory, rejectPendingMemory } from "../services/memory-guard.service.js";
import { switchSession, deleteSession } from "../services/session.service.js";
import { getDataStore } from "../db/datastore-provider.js";
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

  // Callback query handlers for interactive reminder buttons
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
      await ctx.answerCallbackQuery({ text: "Failed to snooze." });
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
      await ctx.answerCallbackQuery({ text: "Failed to cancel." });
    }
  });

  // Callback query handler for interactive memory deletion
  bot.callbackQuery(/^memory:delete:([a-f0-9-]+)$/i, async (ctx) => {
    const memoryId = ctx.match[1];

    try {
      await deleteMemory(memoryId);

      await ctx.answerCallbackQuery({ text: "Memory deleted." });
      await ctx
        .editMessageText("❌ **Memory deleted.**", {
          parse_mode: "Markdown",
        })
        .catch(async () => {
          await ctx.editMessageText("❌ Memory deleted.");
        });
    } catch (err) {
      console.error("[bot:memory_delete] Error deleting memory:", err);
      await ctx.answerCallbackQuery({ text: "Failed to delete memory." });
    }
  });

  // Callback query handlers for memory confirmation guard
  bot.callbackQuery(/^confirm_mem:([a-f0-9-]+)$/i, async (ctx) => {
    const memoryId = ctx.match[1];
    const store = getDataStore();
    try {
      const saved = await confirmPendingMemory(memoryId, store);
      if (!saved) {
        await ctx.answerCallbackQuery({ text: "Memory confirmation expired or already processed." });
        await ctx
          .editMessageText("⚠️ **Memory confirmation expired or already processed.**", {
            parse_mode: "Markdown",
          })
          .catch(async () => {
            await ctx.editMessageText("⚠️ Memory confirmation expired or already processed.");
          });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Memory confirmed and saved!" });
      await ctx
        .editMessageText(
          `✅ **Memory Approved & Saved (Source: Web)**\n\n> "${saved.content}"`,
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.editMessageText(`✅ Memory Approved & Saved: ${saved.content}`);
        });
    } catch (err) {
      console.error("[bot:confirm_mem] Error confirming memory:", err);
      await ctx.answerCallbackQuery({ text: "Failed to confirm memory." });
    }
  });

  bot.callbackQuery(/^reject_mem:([a-f0-9-]+)$/i, async (ctx) => {
    const memoryId = ctx.match[1];
    try {
      const rejected = rejectPendingMemory(memoryId);
      await ctx.answerCallbackQuery({ text: rejected ? "Memory discarded." : "Already handled." });
      await ctx
        .editMessageText("❌ **Memory discarded.** Untrusted web content will not be remembered.", {
          parse_mode: "Markdown",
        })
        .catch(async () => {
          await ctx.editMessageText("❌ Memory discarded. Untrusted web content will not be remembered.");
        });
    } catch (err) {
      console.error("[bot:reject_mem] Error rejecting memory:", err);
      await ctx.answerCallbackQuery({ text: "Failed to reject memory." });
    }
  });

  // Callback query handlers for session management
  bot.callbackQuery(/^session:switch:([a-f0-9-]+)$/i, async (ctx) => {
    const sessionId = ctx.match[1];
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const switched = await switchSession(chatId, sessionId);
      await ctx.answerCallbackQuery({ text: "Session switched!" });
      const title = switched.title ?? "Untitled Session";
      await ctx
        .editMessageText(
          `🔄 **Switched active session to:** *${title}*\nContext restored. You can continue this discussion now, Boss!`,
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.editMessageText(
            `🔄 Switched active session to: ${title}\nContext restored. You can continue this discussion now, Boss!`
          );
        });
    } catch (err) {
      console.error("[bot:session_switch] Error switching session:", err);
      await ctx.answerCallbackQuery({ text: "Failed to switch session." });
    }
  });

  bot.callbackQuery(/^session:view:([a-f0-9-]+)$/i, async (ctx) => {
    const sessionId = ctx.match[1];
    const store = getDataStore();

    try {
      const messages = await store.getSessionMessages(sessionId, 10);
      await ctx.answerCallbackQuery();

      if (messages.length === 0) {
        await ctx.reply("📜 _This session contains no messages._", { parse_mode: "Markdown" });
        return;
      }

      const turns = messages
        .map((m) => {
          const role = m.role === "user" ? "👤 **Boss**" : "🤖 **FRIDAY**";
          const snippet = m.content.length > 300 ? `${m.content.slice(0, 297)}...` : m.content;
          return `${role}:\n${snippet}`;
        })
        .join("\n\n---\n\n");

      const header = `📜 **Transcript Preview (Last ${messages.length} messages):**\n\n${turns}`;
      const chunks = chunkMessage(header, 4000);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(async () => {
          await ctx.reply(chunk);
        });
      }
    } catch (err) {
      console.error("[bot:session_view] Error viewing session:", err);
      await ctx.answerCallbackQuery({ text: "Failed to load session transcript." });
    }
  });

  bot.callbackQuery(/^session:delete:([a-f0-9-]+)$/i, async (ctx) => {
    const sessionId = ctx.match[1];

    try {
      await deleteSession(sessionId);
      await ctx.answerCallbackQuery({ text: "Session deleted." });
      await ctx
        .editMessageText("🗑️ **Session and its messages deleted.**", {
          parse_mode: "Markdown",
        })
        .catch(async () => {
          await ctx.editMessageText("🗑️ Session and its messages deleted.");
        });
    } catch (err) {
      console.error("[bot:session_delete] Error deleting session:", err);
      await ctx.answerCallbackQuery({ text: "Failed to delete session." });
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
      const response = await engine.reply(chatId, text);
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
