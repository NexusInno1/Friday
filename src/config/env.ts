import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_ID: z
    .string()
    .min(1, "TELEGRAM_ALLOWED_USER_ID is required")
    .transform(Number),

  // AI Provider
  DEFAULT_LLM_PROVIDER: z.enum(["gemini", "openai"]).default("gemini"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  OPENAI_API_KEY: z.string().optional(),

  // Tavily
  TAVILY_API_KEY: z.string().min(1, "TAVILY_API_KEY is required"),

  // Supabase
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),

  // System Settings
  USER_TIMEZONE: z.string().default("Asia/Kolkata"),
  USER_NAME: z.string().default("Boss"),
  BRIEFING_TIME: z.string().default("07:00"), // HH:MM in USER_TIMEZONE

  // Deployment
  WEBHOOK_URL: z
    .string()
    .optional()
    .transform((val) => (val === "" ? undefined : val))
    .pipe(z.string().url().optional()), // only validate as URL if actually set
  WEBHOOK_PORT: z.string().transform(Number).default("3000"),
  HEALTH_PORT: z
    .string()
    .default(process.env.PORT ?? "8080")
    .transform(Number),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env;

/**
 * Validates and returns the environment configuration.
 * Throws with a clear error message listing all missing/invalid vars.
 * Must be called as the very first thing in index.ts.
 */
export function validateEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(
      `\n❌ FRIDAY failed to start — invalid environment configuration:\n\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.\n`
    );
    process.exit(1);
  }

  _env = result.data;
  return _env;
}

export function setEnv(mockEnv: Env): void {
  _env = mockEnv;
}

export function env(): Env {
  if (!_env) {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      _env = {
        TELEGRAM_BOT_TOKEN: "mock_telegram_token",
        TELEGRAM_ALLOWED_USER_ID: 123456789,
        DEFAULT_LLM_PROVIDER: "gemini",
        GEMINI_API_KEY: "mock_gemini_key",
        OPENAI_API_KEY: undefined,
        TAVILY_API_KEY: "mock_tavily_key",
        SUPABASE_URL: "https://mock.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
        USER_TIMEZONE: "Asia/Kolkata",
        USER_NAME: "Boss",
        BRIEFING_TIME: "07:00",
        WEBHOOK_URL: undefined,
        WEBHOOK_PORT: 3000,
        HEALTH_PORT: 8080,
        NODE_ENV: "test",
      };
      return _env;
    }
    throw new Error("env() called before validateEnv(). Call validateEnv() first in index.ts.");
  }
  return _env;
}
