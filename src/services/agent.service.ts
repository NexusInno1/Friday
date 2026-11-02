import { generateText, type LanguageModel } from "ai";
import { env, DEFAULT_GEMINI_MODEL } from "../config/env.js";
import { buildSystemPrompt } from "../config/persona.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { DataStore } from "../db/datastore.js";
import { formatMemoryLines } from "./memory.service.js";
import { recallMemoriesAction } from "../actions/actions.js";
import { createTools, createSimplifiedTools } from "../tools/registry.js";
import {
  getModel,
  resolveGeminiModel,
  getFallbackChain,
  isRetriableModelError,
  type FallbackModelDescriptor,
} from "./model.service.js";
import { maybeAutoTitleSession } from "./session.service.js";
import { logger } from "../utils/logger.js";
import { sendCriticalAlert } from "./alert.service.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";
import type { NotificationDispatcher } from "./scheduler.service.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STEPS = 10;

export { getModel, resolveGeminiModel, getFallbackChain, isRetriableModelError, type FallbackModelDescriptor };

/**
 * Strips delimiter breakout tags from user-provided content before prompt interpolation.
 */
export function sanitizeUserContent(content: string): string {
  return content.replace(/<\s*\/?\s*user_message(?:\s+[^>]*)?>/gi, "");
}

export interface AssistantEngineOptions {
  store?: DataStore;
  model?: LanguageModel;
  fallbacks?: FallbackModelDescriptor[];
  maxSteps?: number;
  timeoutMs?: number;
  dispatcher?: NotificationDispatcher;
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
  private dispatcher: NotificationDispatcher | null = null;

  constructor(options: AssistantEngineOptions = {}) {
    this.store = options.store ?? getDataStore();
    this.model = options.model ?? getModel();
    this.fallbacks = options.fallbacks ?? getFallbackChain();
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dispatcher = options.dispatcher ?? null;
  }

  setDispatcher(dispatcher: NotificationDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /**
   * Processes a single turn of user interaction and generates the assistant's reply.
   */
  async reply(chatId: number, userMessage: string): Promise<string> {
    // 0. Enforce daily LLM usage limits (Item 6)
    const usageCheck = await checkAndIncrementUsage("llm");
    if (!usageCheck.allowed) {
      return (
        usageCheck.error ??
        "⚠️ Daily AI generation limit reached. To prevent unexpected costs, further responses are paused until tomorrow, Boss."
      );
    }

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
              ? `<user_message>\n${sanitizeUserContent(m.content)}\n</user_message>`
              : m.content,
        }));

    const turnState = { usedWebSearch: false };

    // 6. Instantiate tools scoped to this turn
    const scopedTools = createTools({
      chatId,
      userId: env().TELEGRAM_ALLOWED_USER_ID,
      store: this.store,
      dispatcher: this.dispatcher ?? undefined,
      turnState,
    });

    // 7. Generation executor with cancelable timeout controller
    const runGeneration = async (
      modelToUse: LanguageModel,
      toolsToUse: any = scopedTools
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
            { role: "user", content: `<user_message>\n${sanitizeUserContent(userMessage)}\n</user_message>` },
          ],
          tools: toolsToUse,
          maxSteps: this.maxSteps,
          abortSignal: abortController.signal,
          onStepFinish: (step) => {
            if (step.toolCalls && step.toolCalls.length > 0) {
              for (const tc of step.toolCalls) {
                logger.info("tool_call", {
                  toolName: tc.toolName,
                  toolCallId: tc.toolCallId,
                  args: (tc as any).args ?? {},
                });
              }
            }
          },
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
    const startTime = Date.now();

    try {
      const res = await runGeneration(this.model);
      responseText = res.text;
      tokensUsed = res.tokensUsed;
      logger.info("llm_request_completed", {
        provider: env().DEFAULT_LLM_PROVIDER,
        model: env().GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
        tokensUsed,
        durationMs: Date.now() - startTime,
        isFallback: false,
      });
    } catch (primaryErr) {
      if (this.fallbacks.length > 0 && isRetriableModelError(primaryErr)) {
        const primaryReason = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        logger.warn("model_failover", {
          fromProvider: env().DEFAULT_LLM_PROVIDER,
          fromModel: env().GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
          reason: primaryReason,
        });

        let failoverSucceeded = false;
        let lastErr = primaryErr;

        for (const fallback of this.fallbacks) {
          const fallbackStart = Date.now();
          try {
            logger.info("model_fallback_attempt", {
              provider: fallback.provider,
              model: fallback.modelName,
            });

            let res: { text: string; tokensUsed?: number };

            // Item 5: Groq (Llama) retry / simpler schema resilience
            if (fallback.provider.toLowerCase().includes("groq")) {
              try {
                res = await runGeneration(fallback.model);
              } catch (groqErr) {
                logger.warn("groq_retry_with_simpler_schema", {
                  model: fallback.modelName,
                  reason: groqErr instanceof Error ? groqErr.message : String(groqErr),
                });
                const simplified = createSimplifiedTools({
                  chatId,
                  userId: env().TELEGRAM_ALLOWED_USER_ID,
                  store: this.store,
                  dispatcher: this.dispatcher ?? undefined,
                  turnState,
                });
                res = await runGeneration(fallback.model, simplified);
              }
            } else {
              res = await runGeneration(fallback.model);
            }

            responseText = `${res.text}\n\n_(⚡ Served via ${fallback.provider} fallback)_`;
            tokensUsed = res.tokensUsed;
            failoverSucceeded = true;

            logger.info("llm_request_completed", {
              provider: fallback.provider,
              model: fallback.modelName,
              tokensUsed,
              durationMs: Date.now() - fallbackStart,
              isFallback: true,
              fallbackReason: primaryReason,
            });
            break;
          } catch (fallbackErr) {
            logger.warn("model_fallback_failed", {
              provider: fallback.provider,
              model: fallback.modelName,
              error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            });
            lastErr = fallbackErr;
          }
        }

        if (!failoverSucceeded) {
          logger.error("all_models_down", {
            error: lastErr instanceof Error ? lastErr.message : String(lastErr),
            attempted: [env().DEFAULT_LLM_PROVIDER, ...this.fallbacks.map((f) => f.provider)],
          });
          await sendCriticalAlert("all_models_down", lastErr, {
            attempted: [env().DEFAULT_LLM_PROVIDER, ...this.fallbacks.map((f) => f.provider)],
          });
          throw lastErr;
        }
      } else {
        logger.error("llm_request_failed", {
          provider: env().DEFAULT_LLM_PROVIDER,
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
        await sendCriticalAlert("all_models_down", primaryErr, {
          provider: env().DEFAULT_LLM_PROVIDER,
        });
        throw primaryErr;
      }
    }

    // 8. Persist assistant response with token metrics
    await this.store.saveMessage(conversationId, "assistant", responseText, {
      tokensUsed,
    });

    // 9. Asynchronously auto-title conversation session if untitled
    void maybeAutoTitleSession(conversationId, this.store).catch((err) => {
      console.warn("[agent:session] Background auto-titling error:", err);
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
