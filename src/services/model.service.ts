import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, DEFAULT_OPENAI_MODEL, env } from "../config/env.js";

const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
]);

export interface FallbackModelDescriptor {
  provider: string;
  modelName: string;
  model: LanguageModel;
}

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

export function getModel(providerOverride?: "gemini" | "groq" | "openai"): LanguageModel {
  const {
    DEFAULT_LLM_PROVIDER,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    GROQ_API_KEY,
    GEMINI_MODEL,
    GROQ_MODEL,
  } = env();
  const provider = providerOverride ?? DEFAULT_LLM_PROVIDER;

  if (provider === "groq" && GROQ_API_KEY) {
    const groq = createOpenAI({
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: GROQ_API_KEY,
    });
    return groq(GROQ_MODEL || DEFAULT_GROQ_MODEL);
  }

  if (provider === "openai" && OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
    const modelId = OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    return openai(modelId);
  }

  const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });
  return google(resolveGeminiModel(GEMINI_MODEL));
}

/**
 * Returns available fallback models in priority order:
 * 1. Groq (llama-3.3-70b-versatile) if GROQ_API_KEY is configured
 * 2. OpenAI (gpt-4o) if OPENAI_API_KEY is configured
 */
export function getFallbackChain(primaryProvider?: string): FallbackModelDescriptor[] {
  const { DEFAULT_LLM_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL, GROQ_API_KEY, GROQ_MODEL } = env();
  const primary = primaryProvider ?? DEFAULT_LLM_PROVIDER;
  const fallbacks: FallbackModelDescriptor[] = [];

  // Tier 2: Groq (if key present and not primary)
  if (primary !== "groq" && GROQ_API_KEY) {
    const groq = createOpenAI({
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: GROQ_API_KEY,
    });
    fallbacks.push({
      provider: "Groq",
      modelName: GROQ_MODEL || DEFAULT_GROQ_MODEL,
      model: groq(GROQ_MODEL || DEFAULT_GROQ_MODEL),
    });
  }

  // Tier 3: OpenAI (if key present and not primary)
  if (primary !== "openai" && OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
    const modelName = OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    fallbacks.push({
      provider: "OpenAI",
      modelName,
      model: openai(modelName),
    });
  }

  return fallbacks;
}

/**
 * Classifies whether an LLM error represents a transient outage or quota issue
 * that warrants attempting failover to a secondary provider.
 */
export function isRetriableModelError(error: unknown): boolean {
  if (!error) return false;
  const errMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // HTTP status codes or error messages associated with rate limits, timeouts, and outages
  if (
    errMsg.includes("429") ||
    errMsg.includes("rate limit") ||
    errMsg.includes("resource exhausted") ||
    errMsg.includes("quota") ||
    errMsg.includes("500") ||
    errMsg.includes("502") ||
    errMsg.includes("503") ||
    errMsg.includes("504") ||
    errMsg.includes("service unavailable") ||
    errMsg.includes("bad gateway") ||
    errMsg.includes("gateway timeout") ||
    errMsg.includes("fetch failed") ||
    errMsg.includes("etimedout") ||
    errMsg.includes("econnreset") ||
    errMsg.includes("enotfound") ||
    errMsg.includes("abort") ||
    errMsg.includes("timed out")
  ) {
    return true;
  }

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 429 || (typeof status === "number" && status >= 500 && status <= 504)) {
      return true;
    }
  }

  return false;
}
