import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { listRecentSessions } from "../../services/session.service.js";
import { env } from "../../config/env.js";

function escapeMarkdownText(text: string): string {
  return text.replace(/([_*[\]`])/g, "\\$1");
}

export async function handleSessions(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const { USER_TIMEZONE } = env();

  try {
    const sessions = await listRecentSessions(chatId, 6);

    if (sessions.length === 0) {
      await ctx
        .reply(
          "💬 **No conversation sessions found yet.**\nStart chatting or ask me anything to begin a new thread, Boss!",
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.reply(
            "💬 No conversation sessions found yet.\nStart chatting or ask me anything to begin a new thread, Boss!"
          );
        });
      return;
    }

    await ctx
      .reply(
        `🧵 **Your Conversation Sessions (${sessions.length})**\n_Select an archived thread to switch into, or view its transcript:_`,
        { parse_mode: "Markdown" }
      )
      .catch(async () => {
        await ctx.reply(`🧵 Your Conversation Sessions (${sessions.length})`);
      });

    for (const session of sessions) {
      const statusBadge = session.isActive ? "🟢 **[Active]**" : "⚪ _[Archived]_";
      const title = escapeMarkdownText(session.title ?? "Untitled Session");
      const msgCount = session.messageCount ?? 0;
      const dateStr = session.updatedAt
        ? new Date(session.updatedAt).toLocaleDateString("en-US", {
            timeZone: USER_TIMEZONE,
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";

      const text = `${statusBadge} **${title}**\n📊 ${msgCount} msgs • 🕒 ${dateStr}`;

      const keyboard = new InlineKeyboard();
      if (!session.isActive) {
        keyboard.text("🔄 Switch", `session:switch:${session.id}`);
      }
      keyboard
        .text("📜 View", `session:view:${session.id}`)
        .text("🗑️ Delete", `session:delete:${session.id}`);

      await ctx
        .reply(text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        })
        .catch(async () => {
          await ctx.reply(
            `${session.isActive ? "[Active]" : "[Archived]"} ${session.title ?? "Untitled Session"}\n${msgCount} msgs • ${dateStr}`,
            { reply_markup: keyboard }
          );
        });
    }
  } catch (err) {
    console.error("[bot:sessions] Error loading sessions:", err);
    await ctx.reply(
      `⚠️ Failed to load sessions: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
