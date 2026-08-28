import { generateText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../config/env.js";
import { buildSystemPrompt } from "../config/persona.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { formatMemoryLines } from "./memory.service.js";
import { recallMemoriesAction } from "../actions/actions.js";
import { createTools } from "../tools/registry.js";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 60_000;

export function getModel(): LanguageModel {
  const { DEFAULT_LLM_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY } = env();

  if (DEFAULT_LLM_PROVIDER === "openai" && OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
    return openai("gpt-4o");
  }

  const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
  return google("gemini-2.0-flash");
}

export interface AssistantEngineOptions {
  store?: DataStore;
  model?: LanguageModel;
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
 * - Output formatting fallback guarantees
 */
export class AssistantEngine {
  private store: DataStore;
  private model: LanguageModel;
  private maxSteps: number;
  private timeoutMs: number;

  constructor(options: AssistantEngineOptions = {}) {
    this.store = options.store ?? getDataStore();
    this.model = options.model ?? getModel();
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

    const systemPrompt =
      buildSystemPrompt() + (memoryContextString ? `\n\n${memoryContextString}` : "");

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
    const scopedTools = createTools({ chatId, store: this.store });

    // 7. Setup cancelable timeout controller
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`LLM response timed out after ${this.timeoutMs / 1000}s`));
    }, this.timeoutMs);

    try {
      const result = await generateText({
        model: this.model,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: "user", content: `<user_message>\n${userMessage}\n</user_message>` },
        ],
        tools: scopedTools,
        maxSteps: this.maxSteps,
        abortSignal: abortController.signal,
      });

      const responseText = result.text.trim() || "✓ Done, Boss.";

      // 8. Persist assistant response with token metrics
      await this.store.saveMessage(conversationId, "assistant", responseText, {
        tokensUsed: result.usage?.totalTokens,
      });

      return responseText;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

let _defaultEngine: AssistantEngine | null = null;

export function getAssistantEngine(): AssistantEngine {
  if (!_defaultEngine) {
    _defaultEngine = new AssistantEngine();
  }
  return _defaultEngine;
}

export function setAssistantEngine(engine: AssistantEngine): void {
  _defaultEngine = engine;
}

/**
 * Convenience entrypoint for running the default assistant engine.
 */
export async function runAgent(chatId: number, userMessage: string): Promise<string> {
  return getAssistantEngine().reply(chatId, userMessage);
}
