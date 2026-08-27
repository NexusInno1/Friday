import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../config/env.js";
import { buildSystemPrompt } from "../config/persona.js";
import {
  getOrCreateConversation,
  getContextMessages,
  saveMessage,
} from "./context.service.js";
import { buildMemoryContext } from "./memory.service.js";
import { createTools } from "../tools/registry.js";

const MAX_STEPS = 10; // Max tool-call iterations per response
const TIMEOUT_MS = 60_000; // 60s LLM timeout

export function getModel() {
  const { DEFAULT_LLM_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY } = env();

  if (DEFAULT_LLM_PROVIDER === "openai" && OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
    return openai("gpt-4o");
  }

  const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
  return google("gemini-2.0-flash");
}

/**
 * Core FRIDAY agent loop.
 * Takes a user message, builds context, runs the Vercel AI SDK generateText
 * with tool-calling enabled (up to MAX_STEPS iterations), and returns the
 * final text response.
 */
export async function runAgent(
  chatId: number,
  userMessage: string
): Promise<string> {
  // 1. Resolve active conversation once for this turn
  const conversationId = await getOrCreateConversation(chatId);

  // 2. Save the incoming user message
  await saveMessage(conversationId, "user", userMessage);

  // 3. Build context window using resolved conversationId
  const history = await getContextMessages(conversationId);

  // 4. Inject relevant memories into system prompt
  const memoryContext = await buildMemoryContext(userMessage);
  const systemPrompt =
    buildSystemPrompt() + (memoryContext ? `\n\n${memoryContext}` : "");

  // 5. Build messages array for Vercel AI SDK
  // Exclude the last message (the current user message) since we pass it separately
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

  // 6. Instantiate tools scoped to this chatId
  const scopedTools = createTools({ chatId });

  // 7. Setup AbortController for cancelable timeout without leaking timers
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort(new Error("LLM response timed out after 60s"));
  }, TIMEOUT_MS);

  try {
    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [
        ...messages,
        { role: "user", content: `<user_message>\n${userMessage}\n</user_message>` },
      ],
      tools: scopedTools,
      maxSteps: MAX_STEPS,
      abortSignal: abortController.signal,
    });

    const responseText = result.text.trim() || "✓ Done, Boss.";

    // 8. Save assistant response
    await saveMessage(conversationId, "assistant", responseText, {
      tokensUsed: result.usage?.totalTokens,
    });

    return responseText;
  } finally {
    clearTimeout(timeoutId);
  }
}
