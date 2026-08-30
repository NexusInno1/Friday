import { describe, it, expect, vi, beforeEach } from "vitest";
import { authMiddleware } from "./auth.js";
import { setEnv, env } from "../../config/env.js";
import type { Context, NextFunction } from "grammy";

describe("authMiddleware", () => {
  beforeEach(() => {
    setEnv({
      ...env(),
      TELEGRAM_ALLOWED_USER_ID: 12345,
    });
  });

  it("allows requests from the allowed user in private chat", async () => {
    const ctx = {
      from: { id: 12345 },
      chat: { id: 12345, type: "private" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("blocks requests from unauthorized user IDs", async () => {
    const ctx = {
      from: { id: 99999 },
      chat: { id: 99999, type: "private" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks requests when from is missing", async () => {
    const ctx = {
      from: undefined,
      chat: { id: 12345, type: "private" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks requests from the allowed user in a group chat to prevent context leakage", async () => {
    const ctx = {
      from: { id: 12345 },
      chat: { id: -100123456789, type: "group" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks requests from the allowed user in a supergroup chat", async () => {
    const ctx = {
      from: { id: 12345 },
      chat: { id: -100987654321, type: "supergroup" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks requests from a channel", async () => {
    const ctx = {
      from: { id: 12345 },
      chat: { id: -100111222333, type: "channel" },
    } as unknown as Context;

    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });
});
