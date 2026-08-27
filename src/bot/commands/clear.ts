import type { Context } from "grammy";
import { clearConversation } from "../../services/context.service.js";

export async function handleClear(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    await clearConversation(chatId);
    await ctx
      .reply("🧹 **Conversation context cleared.** Starting fresh, Boss!", {
        parse_mode: "Markdown",
      })
      .catch(async () => {
        await ctx.reply("🧹 Conversation context cleared. Starting fresh, Boss!");
      });
  } catch (error) {
    await ctx.reply(
      `⚠️ Failed to clear context: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
