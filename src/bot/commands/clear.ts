import type { Context } from "grammy";
import { clearConversation } from "../../services/context.service.js";

export async function handleClear(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    await clearConversation(chatId);
    await ctx
      .reply(
        "🧹 **Session archived.** Starting fresh with a new thread, Boss!\n\n_Past conversations are preserved and accessible via `/sessions` and `/history`._",
        {
          parse_mode: "Markdown",
        }
      )
      .catch(async () => {
        await ctx.reply(
          "🧹 Session archived. Starting fresh with a new thread, Boss!\n\nPast conversations are preserved and accessible via /sessions and /history."
        );
      });
  } catch (error) {
    await ctx.reply(
      `⚠️ Failed to clear context: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
