import type { BotError, Context } from "grammy";
import { getSupabaseClient } from "../../db/supabase.js";
import { env } from "../../config/env.js";

/**
 * Global error handler for grammY bot.
 * Catches unhandled errors, logs them to console & Supabase activity_logs,
 * and sends a polite recovery message to the user in FRIDAY persona.
 */
export async function errorHandler(err: BotError<Context>): Promise<void> {
  const ctx = err.ctx;
  const error = err.error;
  const userId = ctx.from?.id;

  console.error(`[bot:error] Error while handling update ${ctx.update.update_id}:`, error);

  // Log error to Supabase
  try {
    const db = getSupabaseClient();
    await db.from("activity_logs").insert({
      user_id: userId ?? null,
      event_type: "bot_error",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      payload: { update_id: ctx.update.update_id },
    });
  } catch (dbErr) {
    console.error("[bot:error] Failed to log error to Supabase:", dbErr);
  }

  // Notify user if it's the whitelisted owner
  if (userId === env().TELEGRAM_ALLOWED_USER_ID) {
    const errDetail = error instanceof Error ? error.message : String(error);
    try {
      await ctx.reply(
        `⚠️ **Apologies, Boss.** Encountered an internal glitch processing that request:\n\`${errDetail}\`\n\nDiagnostics have been logged.`,
        { parse_mode: "Markdown" }
      );
    } catch {
      try {
        await ctx.reply(
          `⚠️ Apologies, Boss. Encountered an internal glitch processing that request: ${errDetail}\nDiagnostics have been logged.`
        );
      } catch {
        // Ignore delivery errors in error handler
      }
    }
  }
}
