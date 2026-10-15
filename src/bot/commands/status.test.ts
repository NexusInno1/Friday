import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStatus } from "./status.js";
import { InMemoryDataStore } from "../../db/in-memory-datastore.js";
import { setDataStore } from "../../db/datastore-provider.js";
import { env, setEnv } from "../../config/env.js";
import type { Context } from "grammy";

describe("handleStatus command", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
    setDataStore(store);
    setEnv({
      ...env(),
      GROQ_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      DEFAULT_LLM_PROVIDER: "gemini",
    });
  });

  it("reports fallbacks as Not Configured when keys are missing", async () => {
    let sentMessage = "";
    const ctx = {
      reply: vi.fn(async (text: string) => {
        sentMessage = text;
        return {};
      }),
    } as unknown as Context;

    await handleStatus(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    expect(sentMessage).toContain("• **Fallbacks**: Groq (Not Configured), OpenAI (Not Configured)");
    expect(sentMessage).toContain("• **AI Provider**: `gemini`");
    expect(sentMessage).toContain("• **Status**: 🟢 All Systems Operational");
  });

  it("reports fallbacks as Ready when respective API keys are present", async () => {
    setEnv({
      ...env(),
      GROQ_API_KEY: "gsk_test_key_123",
      OPENAI_API_KEY: "sk-proj-test_key_456",
    });

    let sentMessage = "";
    const ctx = {
      reply: vi.fn(async (text: string) => {
        sentMessage = text;
        return {};
      }),
    } as unknown as Context;

    await handleStatus(ctx);

    expect(sentMessage).toContain("• **Fallbacks**: Groq (Ready), OpenAI (Ready)");
  });

  it("reports correct model label when provider is groq", async () => {
    setEnv({
      ...env(),
      DEFAULT_LLM_PROVIDER: "groq",
      GROQ_MODEL: "llama-3.3-70b-versatile",
      GROQ_API_KEY: "gsk_test_key_123",
    });

    let sentMessage = "";
    const ctx = {
      reply: vi.fn(async (text: string) => {
        sentMessage = text;
        return {};
      }),
    } as unknown as Context;

    await handleStatus(ctx);

    expect(sentMessage).toContain("• **AI Provider**: `groq` (llama-3.3-70b-versatile)");
    expect(sentMessage).toContain("• **Fallbacks**: Groq (Ready), OpenAI (Not Configured)");
  });

  it("reports degraded status if database throws an error", async () => {
    vi.spyOn(store, "getMemoryCount").mockRejectedValueOnce(new Error("Connection refused"));

    let sentMessage = "";
    const ctx = {
      reply: vi.fn(async (text: string) => {
        sentMessage = text;
        return {};
      }),
    } as unknown as Context;

    await handleStatus(ctx);

    expect(sentMessage).toContain("⚠️ Degraded (Database Unreachable)");
    expect(sentMessage).toContain("🔴 Disconnected (Connection refused)");
  });
});
