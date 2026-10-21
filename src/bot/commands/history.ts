import type { Context } from "grammy";
import { searchChatHistory } from "../../services/session.service.js";
import { env } from "../../config/env.js";

function escapeMarkdownText(text: string): string {
  return text.replace(/([_*[\]`])/g, "\\$1");
}

export async function handleHistory(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const { USER_TIMEZONE } = env();
  const rawQuery = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!rawQuery) {
    await ctx
      .reply(
        "🔍 **Conversation History Search**\n\n" +
          "Search through all past chats, decisions, and instructions:\n" +
          "• Usage: `/history <query>`\n" +
          "• Example: `/history Railway deployment port`\n" +
          "• Example: `/history Supabase pgvector schema`",
        { parse_mode: "Markdown" }
      )
      .catch(async () => {
        await ctx.reply(
          "🔍 Conversation History Search\n\nUsage: /history <query>\nExample: /history Railway deployment"
        );
      });
    return;
  }

  try {
    const results = await searchChatHistory(chatId, rawQuery, 6);

    if (results.length === 0) {
      await ctx
        .reply(
          `🔍 **No historical messages found matching:** _${escapeMarkdownText(rawQuery)}_`,
          { parse_mode: "Markdown" }
        )
        .catch(async () => {
          await ctx.reply(`🔍 No historical messages found matching: "${rawQuery}"`);
        });
      return;
    }

    const header = `🔍 **History Matches for "${escapeMarkdownText(rawQuery)}" (${results.length}):**`;
    await ctx.reply(header, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.reply(`🔍 History Matches for "${rawQuery}" (${results.length}):`);
    });

    for (const match of results) {
      const sessionTitle = escapeMarkdownText(match.sessionTitle ?? "Untitled Session");
      const roleLabel = match.role === "user" ? "👤 Boss" : "🤖 FRIDAY";
      const dateStr = match.createdAt
        ? new Date(match.createdAt).toLocaleDateString("en-US", {
            timeZone: USER_TIMEZONE,
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";

      // Truncate long content to 250 chars for clean chat preview
      const contentExcerpt =
        match.content.length > 280
          ? `${match.content.slice(0, 277)}...`
          : match.content;

      const card =
        `🧵 **${sessionTitle}**\n` +
        `🏷️ ${roleLabel} • 🕒 \`${dateStr}\`\n\n` +
        `> ${escapeMarkdownText(contentExcerpt)}`;

      await ctx
        .reply(card, { parse_mode: "Markdown" })
        .catch(async () => {
          await ctx.reply(
            `[${sessionTitle}] ${roleLabel} (${dateStr}):\n${contentExcerpt}`
          );
        });
    }
  } catch (err) {
    console.error("[bot:history] Error searching history:", err);
    await ctx.reply(
      `⚠️ Failed to search conversation history: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
