import type { Bot } from "grammy";
import { switchSession, deleteSession } from "../../services/session.service.js";
import { getDataStore } from "../../db/datastore-provider.js";
import { chunkMessage } from "../../utils/chunk.js";

export function registerSessionCallbacks(bot: Bot): void {
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
      await ctx.answerCallbackQuery({ text: "Failed to switch session." }).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: "Failed to load session transcript." }).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: "Failed to delete session." }).catch(() => {});
    }
  });
}
