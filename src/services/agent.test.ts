import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import { AssistantEngine } from "./agent.service.js";
import type { LanguageModelV1 } from "@ai-sdk/provider";

describe("AssistantEngine", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
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
});
