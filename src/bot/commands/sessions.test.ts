import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessions } from "./sessions.js";
import { InMemoryDataStore } from "../../db/in-memory-datastore.js";
import { setDataStore } from "../../db/datastore-provider.js";
import { env, setEnv } from "../../config/env.js";
import type { Context } from "grammy";

describe("handleSessions command", () => {
  let store: InMemoryDataStore;
  const chatId = 888999;

  beforeEach(() => {
    store = new InMemoryDataStore();
    setDataStore(store);
    setEnv({
      ...env(),
      TELEGRAM_ALLOWED_USER_ID: chatId,
    });
  });

  it("replies with empty state when no sessions exist", async () => {
    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      chat: { id: chatId },
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleSessions(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    expect(replies[0].text).toContain("No conversation sessions found yet");
  });

  it("lists sessions with active badge, message counts, and inline buttons", async () => {
    // Session 1: Active
    const conv1 = await store.getOrCreateConversation(chatId);
    await store.saveMessage(conv1, "user", "Hello first thread");
    await store.updateSessionTitle(conv1, "First Project Discussion");

    // Session 2: Archived
    await store.clearConversation(chatId);
    const conv2 = await store.getOrCreateConversation(chatId);
    await store.saveMessage(conv2, "user", "Hello second thread");
    await store.updateSessionTitle(conv2, "Second Project Discussion");

    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      chat: { id: chatId },
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleSessions(ctx);

    // 1 header + 2 session cards
    expect(replies.length).toBe(3);
    expect(replies[0].text).toContain("Your Conversation Sessions (2)");

    // Active session (conv2) has [Active] badge and no Switch button
    const activeCard = replies.find((r) => r.text.includes("Second Project Discussion"));
    expect(activeCard).toBeDefined();
    expect(activeCard?.text).toContain("[Active]");

    const activeButtons = activeCard?.options?.reply_markup?.inline_keyboard?.[0] ?? [];
    const hasSwitchOnActive = activeButtons.some((b: any) => b.text.includes("Switch"));
    expect(hasSwitchOnActive).toBe(false);

    // Archived session (conv1) has [Archived] badge and HAS Switch button
    const archivedCard = replies.find((r) => r.text.includes("First Project Discussion"));
    expect(archivedCard).toBeDefined();
    expect(archivedCard?.text).toContain("[Archived]");

    const archivedButtons = archivedCard?.options?.reply_markup?.inline_keyboard?.[0] ?? [];
    const hasSwitchOnArchived = archivedButtons.some((b: any) => b.text.includes("Switch"));
    expect(hasSwitchOnArchived).toBe(true);
    expect(archivedButtons.some((b: any) => b.text.includes("View"))).toBe(true);
    expect(archivedButtons.some((b: any) => b.text.includes("Delete"))).toBe(true);
  });
});
