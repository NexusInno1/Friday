import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import { AssistantEngine, resolveGeminiModel } from "./agent.service.js";
import type { LanguageModelV1 } from "@ai-sdk/provider";

describe("AssistantEngine", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
  });

  it("migrates retired Gemini 2.0 configuration to the supported model", () => {
    expect(resolveGeminiModel("gemini-2.0-flash")).toBe("gemini-2.5-flash");
    expect(resolveGeminiModel("gemini-2.0-flash-lite")).toBe("gemini-2.5-flash");
    expect(resolveGeminiModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("handles conversational turn, saves context, and returns response", async () => {
    const mockModel: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "mock-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "I am FRIDAY, your personal assistant.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() {
        throw new Error("Not implemented");
      },
    };

    const engine = new AssistantEngine({ store, model: mockModel as any });

    const reply = await engine.reply(12345, "Who are you?");
    expect(reply).toBe("I am FRIDAY, your personal assistant.");

    // Check conversation and messages stored
    const convId = await store.getOrCreateConversation(12345);
    const msgs = await store.getContextMessages(convId);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "user", content: "Who are you?" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "I am FRIDAY, your personal assistant." });
  });

  it("guarantees non-empty fallback response if model returns blank text", async () => {
    const mockModel: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "mock-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "   ",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 0 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() {
        throw new Error("Not implemented");
      },
    };

    const engine = new AssistantEngine({ store, model: mockModel as any });

    const reply = await engine.reply(12345, "Do something");
    expect(reply).toBe("✓ Done, Boss.");
  });

  it("incorporates custom_instructions from user profile into system prompt", async () => {
    let capturedPrompt = "";
    const mockModel: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "mock-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate(options: any) {
        capturedPrompt = JSON.stringify(options);
        return {
          text: "Instructions applied.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() {
        throw new Error("Not implemented");
      },
    };

    const { env } = await import("../config/env.js");
    await store.upsertUserProfile({
      id: env().TELEGRAM_ALLOWED_USER_ID,
      custom_instructions: "Speak like a Victorian gentleman.",
    });

    const engine = new AssistantEngine({ store, model: mockModel as any });
    const reply = await engine.reply(12345, "Hello");
    expect(reply).toBe("Instructions applied.");
    expect(capturedPrompt).toContain("Speak like a Victorian gentleman.");
  });

  it("executes multi-step tool call and stores resulting state", async () => {
    let callCount = 0;
    const mockModel: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "mock-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call-1",
                toolName: "store_memory",
                args: JSON.stringify({
                  content: "User prefers dark roast coffee",
                  tags: ["preference"],
                  importance: 4,
                }),
              },
            ],
            finishReason: "tool-calls",
            usage: { promptTokens: 10, completionTokens: 10 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        return {
          text: "I have recorded that you prefer dark roast coffee, Boss.",
          finishReason: "stop",
          usage: { promptTokens: 15, completionTokens: 10 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() {
        throw new Error("Not implemented");
      },
    };

    const engine = new AssistantEngine({ store, model: mockModel as any });
    const reply = await engine.reply(12345, "Remember that I prefer dark roast coffee");

    expect(reply).toBe("I have recorded that you prefer dark roast coffee, Boss.");
    expect(callCount).toBe(2);

    const { env } = await import("../config/env.js");
    const memories = await store.listMemories(env().TELEGRAM_ALLOWED_USER_ID);
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe("User prefers dark roast coffee");
  });

  it("uses primary model when healthy and does not append fallback badge", async () => {
    const mockPrimary: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "primary-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "Primary response",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const mockFallback: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "fallback-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "Fallback response",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const engine = new AssistantEngine({
      store,
      model: mockPrimary as any,
      fallbacks: [{ provider: "Groq", modelName: "llama-3.3-70b-versatile", model: mockFallback as any }],
    });

    const reply = await engine.reply(12345, "Hello");
    expect(reply).toBe("Primary response");
    expect(reply).not.toContain("fallback");
  });

  it("fails over to Groq on primary retriable 503 error and appends badge", async () => {
    const mockPrimary: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "primary-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        throw new Error("503 Service Unavailable: Gemini overloaded");
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const mockGroq: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "groq-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "Response generated via Groq",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const engine = new AssistantEngine({
      store,
      model: mockPrimary as any,
      fallbacks: [{ provider: "Groq", modelName: "llama-3.3-70b-versatile", model: mockGroq as any }],
    });

    const reply = await engine.reply(12345, "Hello after outage");
    expect(reply).toBe("Response generated via Groq\n\n_(⚡ Served via Groq fallback)_");
  });

  it("executes multi-tier failover if both primary and first fallback fail", async () => {
    const mockPrimary: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "primary-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        throw new Error("429 Too Many Requests");
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const mockGroq: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "groq-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        throw new Error("500 Groq cluster error");
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const mockOpenAI: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "openai-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        return {
          text: "Response generated via OpenAI",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const engine = new AssistantEngine({
      store,
      model: mockPrimary as any,
      fallbacks: [
        { provider: "Groq", modelName: "llama-3.3-70b-versatile", model: mockGroq as any },
        { provider: "OpenAI", modelName: "gpt-4o", model: mockOpenAI as any },
      ],
    });

    const reply = await engine.reply(12345, "Hello multi-tier");
    expect(reply).toBe("Response generated via OpenAI\n\n_(⚡ Served via OpenAI fallback)_");
  });

  it("does not invoke fallbacks on non-retriable client errors", async () => {
    const mockPrimary: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "primary-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        throw new Error("400 Bad Request: Invalid payload structure");
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    let fallbackCalled = false;
    const mockGroq: LanguageModelV1 = {
      specificationVersion: "v1",
      modelId: "groq-model",
      provider: "mock",
      defaultObjectGenerationMode: "json",
      async doGenerate() {
        fallbackCalled = true;
        return {
          text: "Should not be called",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
      async doStream() { throw new Error("Not implemented"); },
    };

    const engine = new AssistantEngine({
      store,
      model: mockPrimary as any,
      fallbacks: [{ provider: "Groq", modelName: "llama-3.3-70b-versatile", model: mockGroq as any }],
    });

    await expect(engine.reply(12345, "Bad request")).rejects.toThrow("400 Bad Request");
    expect(fallbackCalled).toBe(false);
  });
});
