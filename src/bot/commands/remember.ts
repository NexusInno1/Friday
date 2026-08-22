import type { Context } from "grammy";
import { storeMemory } from "../../services/memory.service.js";

export async function handleRemember(ctx: Context): Promise<void> {
  const text = ctx.match;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    await ctx.reply(
      "💡 **Usage**: `/remember <fact to remember>`\n\nExample: `/remember Favorite coffee is Flat White with oat milk`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    await storeMemory(text.trim(), ["user_note"], 3);
    await ctx.reply(`✓ **Saved to long-term memory:**\n"${text.trim()}"`, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    await ctx.reply(
      `⚠️ Could not store memory: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
