import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { listMemories, searchMemories } from "../../services/memory.service.js";
import { env } from "../../config/env.js";

function escapeMarkdownText(text: string): string {
  return text.replace(/([_*[\]`])/g, "\\$1");
}

export async function handleMemories(ctx: Context): Promise<void> {
  const { USER_TIMEZONE } = env();
  const rawQuery = typeof ctx.match === "string" ? ctx.match.trim() : "";

  try {
    const isSearch = rawQuery.length > 0;
    const memories = isSearch
      ? await searchMemories(rawQuery, 10)
      : await listMemories(10);

    if (memories.length === 0) {
      if (isSearch) {
        await ctx.reply(
          `🧠 **No memories found matching:** _${escapeMarkdownText(rawQuery)}_`,
          { parse_mode: "Markdown" }
        ).catch(async () => {
          await ctx.reply(`🧠 No memories found matching: "${rawQuery}"`);
        });
      } else {
        await ctx.reply(
          "🧠 **No memories stored yet.**\nUse `/remember <fact>` to save personal preferences or notes, Boss!",
          { parse_mode: "Markdown" }
        ).catch(async () => {
          await ctx.reply("🧠 No memories stored yet.\nUse /remember <fact> to save personal preferences or notes, Boss!");
        });
      }
      return;
    }

    const header = isSearch
      ? `🧠 **Memories Matching:** _${escapeMarkdownText(rawQuery)}_ (${memories.length})`
      : `🧠 **Stored Long-Term Memories (${memories.length})**:`;

    await ctx.reply(header, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.reply(isSearch ? `🧠 Memories Matching: "${rawQuery}" (${memories.length})` : `🧠 Stored Long-Term Memories (${memories.length}):`);
    });

    for (const mem of memories) {
      const dateStr = mem.created_at
        ? new Date(mem.created_at).toLocaleDateString("en-US", {
            timeZone: USER_TIMEZONE,
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";

      const tagsBadge = mem.tags && mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : "";
      const dateSuffix = dateStr ? `  📅 Saved: \`${dateStr}\`` : "";
      const keyboard = new InlineKeyboard().text("❌ Delete", `memory:delete:${mem.id}`);

      const escapedContent = escapeMarkdownText(mem.content);
      const text = `• **${escapedContent}**${tagsBadge}\n${dateSuffix}`;

      await ctx
        .reply(text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        })
        .catch(async () => {
          await ctx.reply(`• ${mem.content}${tagsBadge}\n  Saved: ${dateStr}`, {
            reply_markup: keyboard,
          });
        });
    }
  } catch (error) {
    console.error("[bot:memories] Error fetching memories:", error);
    await ctx.reply(
      `⚠️ Failed to load memories: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
