import { generateText, type LanguageModel } from "ai";
import { env } from "../config/env.js";
import { buildSystemPrompt } from "../config/persona.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { DataStore } from "../db/datastore.js";
import { formatMemoryLines } from "./memory.service.js";
import { recallMemoriesAction } from "../actions/actions.js";
import { createTools } from "../tools/registry.js";
import {
  getModel,
  resolveGeminiModel,
  getFallbackChain,
  isRetriableModelError,
  type FallbackModelDescriptor,
} from "./model.service.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STEPS = 10;

export { getModel, resolveGeminiModel, getFallbackChain, isRetriableModelError, type FallbackModelDescriptor };

export interface AssistantEngineOptions {
  store?: DataStore;
  model?: LanguageModel;
  fallbacks?: FallbackModelDescriptor[];
  maxSteps?: number;
  timeoutMs?: number;
}

/**
 * Deep Module: AssistantEngine
 *
 * Encapsulates the entire conversational reasoning turn:
 * - Conversation lifecycle and message persistence
 * - Context window sliding and token accounting
 * - Semantic long-term memory grounding
 * - Multi-step tool execution loop with cancelable timeout
 * - Outage resilience and tiered multi-model failover (Groq, OpenAI)
 * - Output formatting fallback guarantees
 */
export class AssistantEngine {
  private store: DataStore;
  private model: LanguageModel;
  private fallbacks: FallbackModelDescriptor[];
  private maxSteps: number;
  private timeoutMs: number;

  constructor(options: AssistantEngineOptions = {}) {
    this.store = options.store ?? getDataStore();
    this.model = options.model ?? getModel();
    this.fallbacks = options.fallbacks ?? getFallbackChain();
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Processes a single turn of user interaction and generates the assistant's reply.
   */
  async reply(chatId: number, userMessage: string): Promise<string> {
    // 1. Resolve or create active conversation
    const conversationId = await this.store.getOrCreateConversation(chatId);

    // 2. Save incoming user message
    await this.store.saveMessage(conversationId, "user", userMessage);

    // 3. Retrieve sliding context messages
    const history = await this.store.getContextMessages(conversationId);

    // 4. Ground context with relevant long-term memories
    let memoryContextString = "";
    try {
      const memories = await recallMemoriesAction(
        userMessage,
        5,
        this.store,
        env().TELEGRAM_ALLOWED_USER_ID
      );
      if (memories.length > 0) {
        const lines = formatMemoryLines(memories);
        memoryContextString = `## Relevant memories about the user:\n${lines}`;
      }
    } catch (err) {
      console.warn("[engine] Memory grounding failed:", err);
    }

    let customInstructions: string | null = null;
    try {
      const profile = await this.store.getUserProfile(env().TELEGRAM_ALLOWED_USER_ID);
      customInstructions = profile?.custom_instructions ?? null;
    } catch (err) {
      console.warn("[engine] Failed to load user profile instructions:", err);
    }

    const systemPrompt =
      buildSystemPrompt({ now: new Date(), customInstructions }) +
      (memoryContextString ? `\n\n${memoryContextString}` : "");

    // 5. Build messages array with security <user_message> tags
    const previousMessages = history.slice(0, -1);
    const messages: Array<{ role: "user" | "assistant"; content: string }> =
      previousMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content:
            m.role === "user"
              ? `<user_message>\n${m.content}\n</user_message>`
              : m.content,
        }));

    // 6. Instantiate tools scoped to this turn
    const scopedTools = createTools({
      chatId,
      userId: env().TELEGRAM_ALLOWED_USER_ID,
      store: this.store,
    });

    // 7. Generation executor with cancelable timeout controller
    const runGeneration = async (
      modelToUse: LanguageModel
    ): Promise<{ text: string; tokensUsed?: number }> => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort(new Error(`LLM response timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);

      try {
        const result = await generateText({
          model: modelToUse,
          system: systemPrompt,
          messages: [
            ...messages,
            { role: "user", content: `<user_message>\n${userMessage}\n</user_message>` },
          ],
          tools: scopedTools,
          maxSteps: this.maxSteps,
          abortSignal: abortController.signal,
        });

        return {
          text: result.text.trim() || "✓ Done, Boss.",
          tokensUsed: result.usage?.totalTokens,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let responseText = "";
    let tokensUsed: number | undefined;

    try {
      const res = await runGeneration(this.model);
      responseText = res.text;
      tokensUsed = res.tokensUsed;
    } catch (primaryErr) {
      if (this.fallbacks.length > 0 && isRetriableModelError(primaryErr)) {
        console.warn(
          `[agent:failover] Primary model failed with retriable error: ${
            primaryErr instanceof Error ? primaryErr.message : primaryErr
          }. Attempting tiered failover...`
        );

        let failoverSucceeded = false;
        let lastErr = primaryErr;

        for (const fallback of this.fallbacks) {
          try {
            console.log(
              `[agent:failover] Attempting failover to ${fallback.provider} (${fallback.modelName})...`
            );
            const res = await runGeneration(fallback.model);
            responseText = `${res.text}\n\n_(⚡ Served via ${fallback.provider} fallback)_`;
            tokensUsed = res.tokensUsed;
            failoverSucceeded = true;
            break;
          } catch (fallbackErr) {
            console.warn(
              `[agent:failover] Fallback to ${fallback.provider} failed: ${
                fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
              }`
            );
            lastErr = fallbackErr;
          }
        }

        if (!failoverSucceeded) {
          throw lastErr;
        }
      } else {
        throw primaryErr;
      }
    }

    // 8. Persist assistant response with token metrics
    await this.store.saveMessage(conversationId, "assistant", responseText, {
      tokensUsed,
    });

    return responseText;
  }
}

let _defaultEngine: AssistantEngine | null = null;

export function getAssistantEngine(): AssistantEngine {
  if (!_defaultEngine) {
    _defaultEngine = new AssistantEngine();
  }
  return _defaultEngine;
}
