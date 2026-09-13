import type { Context, NextFunction } from "grammy";

/**
 * Chat-scope guard: FRIDAY is an executive 1:1 assistant.
 * Only accepts updates originating from private 1:1 chats.
 * Silently drops updates from groups, supergroups, and channels
 * without calling downstream middlewares or leaking bot existence.
 */
export async function chatScopeMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  if (ctx.chat?.type !== "private") {
    console.warn(
      `[chat-scope] Silently dropping update from non-private chat type: ${
        ctx.chat?.type ?? "unknown"
      } (chat ID: ${ctx.chat?.id ?? "unknown"})`
    );
    return;
  }

  await next();
}
