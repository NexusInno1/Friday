import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleHistory } from "./history.js";
import { InMemoryDataStore } from "../../db/in-memory-datastore.js";
import { setDataStore } from "../../db/datastore-provider.js";
import { env, setEnv } from "../../config/env.js";
import type { Context } from "grammy";

describe("handleHistory command", () => {
  let store: InMemoryDataStore;
  const chatId = 555666;

  beforeEach(() => {
    store = new InMemoryDataStore();
    setDataStore(store);
    setEnv({
      ...env(),
      TELEGRAM_ALLOWED_USER_ID: chatId,
    });
  });

  it("shows usage instructions when query is empty", async () => {
    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      chat: { id: chatId },
      match: "",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleHistory(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    expect(replies[0].text).toContain("Conversation History Search");
    expect(replies[0].text).toContain("/history <query>");
  });

  it("returns not found message when query has no matching messages", async () => {
    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      chat: { id: chatId },
      match: "Quantum Computing Algorithms",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleHistory(ctx);

    expect(replies[0].text).toContain("No historical messages found matching");
  });

  it("returns matching cards when query finds historical turns", async () => {
    const conv1 = await store.getOrCreateConversation(chatId);
    await store.saveMessage(conv1, "user", "What is the secret deployment webhook URL?");
    await store.saveMessage(conv1, "assistant", "The deployment webhook endpoint is /api/webhook.");
    await store.updateSessionTitle(conv1, "Webhook Setup");

    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      chat: { id: chatId },
      match: "webhook",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleHistory(ctx);

    expect(replies.length).toBeGreaterThan(1); // 1 header + match cards
    expect(replies[0].text).toContain('History Matches for "webhook"');

    const cardTexts = replies.slice(1).map((r) => r.text);
    expect(cardTexts.some((c) => c.includes("Webhook Setup"))).toBe(true);
    expect(cardTexts.some((c) => c.includes("/api/webhook"))).toBe(true);
  });
});
