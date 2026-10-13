import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { DEFAULT_GEMINI_MODEL, env } from "../config/env.js";

const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
]);

/**
 * Resolves the configured Gemini model while keeping deployments alive when
 * an old environment variable still names a shut-down 2.0 model.
 */
export function resolveGeminiModel(configuredModel?: string): string {
  const model = configuredModel?.trim() || DEFAULT_GEMINI_MODEL;

  if (RETIRED_GEMINI_MODELS.has(model)) {
    console.warn(
      `[model] ${model} is retired; using ${DEFAULT_GEMINI_MODEL}. Update GEMINI_MODEL in the deployment environment.`
    );
    return DEFAULT_GEMINI_MODEL;
  }

  return model;
}

export function getModel(): LanguageModel {
  const { DEFAULT_LLM_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY, GEMINI_MODEL } = env();

  if (DEFAULT_LLM_PROVIDER === "openai" && OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
    return openai("gpt-4o");
  }

  const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
  return google(resolveGeminiModel(GEMINI_MODEL));
}
