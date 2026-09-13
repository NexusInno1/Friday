import { describe, it, expect } from "vitest";
import { EnvSchema, env } from "./env.js";

describe("EnvSchema - TELEGRAM_WEBHOOK_SECRET and WEBHOOK_URL rules", () => {
  const baseValidEnv = {
    TELEGRAM_BOT_TOKEN: "123456789:ABCDEF_mock_token_for_test",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    DEFAULT_LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: "mock_gemini_key",
    TAVILY_API_KEY: "mock_tavily_key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock_supabase_key",
    USER_TIMEZONE: "Asia/Kolkata",
    USER_NAME: "Boss",
    BRIEFING_TIME: "07:00",
  };

  it("passes when WEBHOOK_URL is not configured (Long Polling mode)", () => {
    const result = EnvSchema.safeParse(baseValidEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WEBHOOK_URL).toBeUndefined();
      expect(result.data.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    }
  });

  it("passes when WEBHOOK_URL is empty string and secret is omitted", () => {
    const result = EnvSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_URL: "",
      TELEGRAM_WEBHOOK_SECRET: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WEBHOOK_URL).toBeUndefined();
      expect(result.data.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    }
  });

  it("passes when WEBHOOK_URL is not set even if TELEGRAM_WEBHOOK_SECRET is short", () => {
    const result = EnvSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_URL: "",
      TELEGRAM_WEBHOOK_SECRET: "short",
    });
    expect(result.success).toBe(true);
  });

  it("fails when WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is missing", () => {
    const result = EnvSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_URL: "https://friday.up.railway.app",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("TELEGRAM_WEBHOOK_SECRET"));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("TELEGRAM_WEBHOOK_SECRET is required and must be at least 16 characters");
    }
  });

  it("fails when WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is less than 16 characters", () => {
    const result = EnvSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_URL: "https://friday.up.railway.app",
      TELEGRAM_WEBHOOK_SECRET: "short_secret_15",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("TELEGRAM_WEBHOOK_SECRET"));
      expect(issue).toBeDefined();
    }
  });

  it("succeeds when WEBHOOK_URL is set and TELEGRAM_WEBHOOK_SECRET is 16 characters or longer", () => {
    const result = EnvSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_URL: "https://friday.up.railway.app",
      TELEGRAM_WEBHOOK_SECRET: "super_secret_webhook_token_12345",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WEBHOOK_URL).toBe("https://friday.up.railway.app");
      expect(result.data.TELEGRAM_WEBHOOK_SECRET).toBe("super_secret_webhook_token_12345");
    }
  });

  it("returns a mock secret of at least 16 characters in test fallback mode", () => {
    const loadedEnv = env();
    expect(loadedEnv.TELEGRAM_WEBHOOK_SECRET).toBeDefined();
    expect((loadedEnv.TELEGRAM_WEBHOOK_SECRET?.length ?? 0)).toBeGreaterThanOrEqual(16);
  });
});
