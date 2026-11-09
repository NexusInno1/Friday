import { env } from "../config/env.js";

/**
 * Redacts any known sensitive credentials, API keys, and webhook secrets from a string.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let sanitized = text;

  try {
    const config = env();
    const sensitiveValues = [
      config.GEMINI_API_KEY,
      config.TAVILY_API_KEY,
      config.TELEGRAM_BOT_TOKEN,
      config.SUPABASE_SERVICE_ROLE_KEY,
      config.GROQ_API_KEY,
      config.OPENAI_API_KEY,
      config.TELEGRAM_WEBHOOK_SECRET,
    ].filter(
      (v): v is string =>
        typeof v === "string" && v.length >= 8 && !v.startsWith("mock_")
    );

    for (const secret of sensitiveValues) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  } catch {
    // If env is not initialized yet or in early startup
  }

  return sanitized;
}

/**
 * Escapes characters with special meaning in SQL LIKE / ILIKE patterns (%, _, \).
 */
export function escapeSqlWildcards(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}
