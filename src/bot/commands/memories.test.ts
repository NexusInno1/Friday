import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMemories } from "./memories.js";
import { InMemoryDataStore } from "../../db/in-memory-datastore.js";
import { setDataStore } from "../../db/datastore-provider.js";
import { env, setEnv } from "../../config/env.js";
import type { Context } from "grammy";

describe("handleMemories command", () => {
  let store: InMemoryDataStore;
  const userId = 12345;

  beforeEach(() => {
    store = new InMemoryDataStore();
    setDataStore(store);
    setEnv({
      ...env(),
      TELEGRAM_ALLOWED_USER_ID: userId,
    });
  });

  it("replies with empty state when no memories exist", async () => {
    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      match: "",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleMemories(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    expect(replies[0].text).toContain("No memories stored yet");
  });

  it("lists memories with delete buttons when memories are present", async () => {
    await store.storeMemory(userId, "Favorite beverage is Green Tea", ["drink"], 3, null);
    await store.storeMemory(userId, "Prefers dark mode in IDE", ["settings"], 4, null);

    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      match: "",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleMemories(ctx);

    expect(replies.length).toBe(3); // 1 header + 2 memory messages
    expect(replies[0].text).toContain("Stored Long-Term Memories (2)");

    // Check replies contain memories and delete buttons
    const memoryTexts = [replies[1].text, replies[2].text];
    expect(memoryTexts.some((t) => t.includes("Favorite beverage is Green Tea"))).toBe(true);
    expect(memoryTexts.some((t) => t.includes("Prefers dark mode in IDE"))).toBe(true);

    expect(replies[1].options?.reply_markup?.inline_keyboard).toBeDefined();
    const btn = replies[1].options.reply_markup.inline_keyboard[0][0];
    expect(btn.text).toBe("❌ Delete");
    expect(btn.callback_data).toMatch(/^memory:delete:/);
  });

  it("filters memories by keyword query when query is passed in command", async () => {
    await store.storeMemory(userId, "Server port is 8080", ["infrastructure"], 3, null);
    await store.storeMemory(userId, "Likes Mexican food", ["food"], 2, null);

    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      match: "Server",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleMemories(ctx);

    expect(replies[0].text).toContain("Memories Matching:");
    expect(replies[0].text).toContain("Server");
    expect(replies.length).toBe(2); // header + 1 matching item
    expect(replies[1].text).toContain("Server port is 8080");
  });

  it("replies with no matching memories when query yields 0 results", async () => {
    await store.storeMemory(userId, "Likes Mexican food", ["food"], 2, null);

    const replies: Array<{ text: string; options?: any }> = [];
    const ctx = {
      match: "Kubernetes",
      reply: vi.fn(async (text: string, options?: any) => {
        replies.push({ text, options });
        return {};
      }),
    } as unknown as Context;

    await handleMemories(ctx);

    expect(replies[0].text).toContain("No memories found matching:");
    expect(replies[0].text).toContain("Kubernetes");
  });
});
