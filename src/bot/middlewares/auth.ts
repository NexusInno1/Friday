import type { Context, NextFunction } from "grammy";
import { env } from "../../config/env.js";

/**
 * Single-owner whitelist middleware.
 * Blocks any user whose Telegram user ID doesn't match TELEGRAM_ALLOWED_USER_ID.
 * Logs unauthorized attempts for auditing.
 */
export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const allowedUserId = env().TELEGRAM_ALLOWED_USER_ID;
  const userId = ctx.from?.id;

  if (!userId || userId !== allowedUserId) {
    console.warn(
      `[auth] Blocked unauthorized access attempt from user ID: ${userId ?? "unknown"}`
    );
    // Silent rejection — don't reveal the bot exists to unauthorized users
    return;
  }

  // Chat-scope guard: FRIDAY is an executive 1:1 assistant.
  // Reject groups, supergroups, and channels to prevent accidental memory/data disclosure.
  if (ctx.chat && ctx.chat.type !== "private") {
    console.warn(
      `[auth] Blocked request from non-private chat type: ${ctx.chat.type} (chat ID: ${ctx.chat.id})`
    );
    return;
  }

  await next();
}
