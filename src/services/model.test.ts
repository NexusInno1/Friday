import { describe, it, expect, beforeEach } from "vitest";
import {
  isRetriableModelError,
  getFallbackChain,
  resolveGeminiModel,
  getModel,
} from "./model.service.js";
import { env, setEnv, DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL } from "../config/env.js";

describe("model.service", () => {
  const baseEnv = env();

  beforeEach(() => {
    setEnv({ ...baseEnv });
  });

  describe("resolveGeminiModel", () => {
    it("preserves modern Gemini 2.5 Flash model", () => {
      expect(resolveGeminiModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    });

    it("migrates retired 2.0 models to default Flash", () => {
      expect(resolveGeminiModel("gemini-2.0-flash")).toBe(DEFAULT_GEMINI_MODEL);
      expect(resolveGeminiModel("gemini-2.0-flash-lite")).toBe(DEFAULT_GEMINI_MODEL);
    });
  });

  describe("isRetriableModelError", () => {
    it("returns true for 429 rate limit or quota exceeded", () => {
      expect(isRetriableModelError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isRetriableModelError(new Error("Resource exhausted: quota exceeded"))).toBe(true);
      expect(isRetriableModelError({ status: 429 })).toBe(true);
    });

    it("returns true for 5xx upstream outages", () => {
      expect(isRetriableModelError(new Error("500 Internal Server Error"))).toBe(true);
      expect(isRetriableModelError(new Error("503 Service Unavailable"))).toBe(true);
      expect(isRetriableModelError(new Error("502 Bad Gateway"))).toBe(true);
      expect(isRetriableModelError(new Error("504 Gateway Timeout"))).toBe(true);
      expect(isRetriableModelError({ status: 503 })).toBe(true);
    });

    it("returns true for network connection failures and timeouts", () => {
      expect(isRetriableModelError(new Error("fetch failed"))).toBe(true);
      expect(isRetriableModelError(new Error("connect ETIMEDOUT"))).toBe(true);
      expect(isRetriableModelError(new Error("read ECONNRESET"))).toBe(true);
      expect(isRetriableModelError(new Error("LLM response timed out after 60s"))).toBe(true);
      expect(isRetriableModelError(new Error("This operation was aborted"))).toBe(true);
    });

    it("returns false for non-retriable client and syntax errors", () => {
      expect(isRetriableModelError(new Error("400 Bad Request: Invalid tool parameter"))).toBe(false);
      expect(isRetriableModelError(new Error("SyntaxError: Unexpected token"))).toBe(false);
      expect(isRetriableModelError(null)).toBe(false);
      expect(isRetriableModelError(undefined)).toBe(false);
    });
  });

  describe("getFallbackChain", () => {
    it("returns empty array when no fallback keys are set", () => {
      setEnv({
        ...baseEnv,
        DEFAULT_LLM_PROVIDER: "gemini",
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      });

      const chain = getFallbackChain();
      expect(chain).toEqual([]);
    });

    it("returns Groq and OpenAI when both keys are present", () => {
      setEnv({
        ...baseEnv,
        DEFAULT_LLM_PROVIDER: "gemini",
        GROQ_API_KEY: "gsk_test_key",
        GROQ_MODEL: "llama-3.3-70b-versatile",
        OPENAI_API_KEY: "sk-openai-key",
      });

      const chain = getFallbackChain();
      expect(chain.length).toBe(2);
      expect(chain[0].provider).toBe("Groq");
      expect(chain[0].modelName).toBe("llama-3.3-70b-versatile");
      expect(chain[1].provider).toBe("OpenAI");
      expect(chain[1].modelName).toBe("gpt-4o");
    });

    it("excludes Groq from fallback chain if Groq is primary provider", () => {
      setEnv({
        ...baseEnv,
        DEFAULT_LLM_PROVIDER: "groq",
        GROQ_API_KEY: "gsk_test_key",
        OPENAI_API_KEY: "sk-openai-key",
      });

      const chain = getFallbackChain("groq");
      expect(chain.length).toBe(1);
      expect(chain[0].provider).toBe("OpenAI");
    });
  });

  describe("getModel", () => {
    it("initializes Groq model when provider is groq and key is provided", () => {
      setEnv({
        ...baseEnv,
        DEFAULT_LLM_PROVIDER: "groq",
        GROQ_API_KEY: "gsk_mock_groq_key",
      });

      const model = getModel("groq");
      expect(model).toBeDefined();
      expect(model.modelId).toBe(DEFAULT_GROQ_MODEL);
    });
  });
});
