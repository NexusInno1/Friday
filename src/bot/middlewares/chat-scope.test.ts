import { describe, it, expect, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { chatScopeMiddleware } from "./chat-scope.js";

describe("chatScopeMiddleware", () => {
  it("calls next() when chat type is private", async () => {
    const ctx = {
      chat: { id: 123456789, type: "private" },
    } as unknown as Context;
    const next = vi.fn().mockResolvedValue(undefined) as NextFunction;

    await chatScopeMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("silently drops updates from group chats without calling next()", async () => {
    const ctx = {
      chat: { id: -100123456789, type: "group" },
    } as unknown as Context;
    const next = vi.fn().mockResolvedValue(undefined) as NextFunction;

    await chatScopeMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("silently drops updates from supergroup chats without calling next()", async () => {
    const ctx = {
      chat: { id: -100987654321, type: "supergroup" },
    } as unknown as Context;
    const next = vi.fn().mockResolvedValue(undefined) as NextFunction;

    await chatScopeMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("silently drops updates from channel chats without calling next()", async () => {
    const ctx = {
      chat: { id: -100555555555, type: "channel" },
    } as unknown as Context;
    const next = vi.fn().mockResolvedValue(undefined) as NextFunction;

    await chatScopeMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("silently drops updates when ctx.chat is undefined", async () => {
    const ctx = {} as unknown as Context;
    const next = vi.fn().mockResolvedValue(undefined) as NextFunction;

    await chatScopeMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });
});
