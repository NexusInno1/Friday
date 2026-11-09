import type { Bot } from "grammy";
import { deleteMemory } from "../../services/memory.service.js";
import { confirmPendingMemory, rejectPendingMemory } from "../../services/memory-guard.service.js";
import { getDataStore } from "../../db/datastore-provider.js";

export function registerMemoryCallbacks(bot: Bot): void {
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
      await ctx.answerCallbackQuery({ text: "Failed to delete memory." }).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: "Failed to confirm memory." }).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: "Failed to reject memory." }).catch(() => {});
    }
  });
}
