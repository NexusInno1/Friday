import { env } from "../config/env.js";
import { redactSecrets } from "../utils/sanitize.js";

export type CriticalAlertType =
  | "embedding_failure"
  | "scheduler_failed"
  | "all_models_down"
  | "quota_warning"
  | "quota_exceeded";

export interface AlertDispatcher {
  sendAlert(message: string): Promise<void>;
}

let _alertDispatcher: AlertDispatcher | null = null;
const _lastAlertTimestamps = new Map<CriticalAlertType, number>();
const DEFAULT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function setAlertDispatcher(dispatcher: AlertDispatcher | null): void {
  _alertDispatcher = dispatcher;
}

export function resetAlertRateLimits(): void {
  _lastAlertTimestamps.clear();
}

/**
 * Dispatches a rate-limited critical alert to the owner via Telegram.
 * Automatically sanitizes all error messages and context objects to prevent secret leakage.
 */
export async function sendCriticalAlert(
  type: CriticalAlertType,
  error: unknown,
  details?: Record<string, unknown>,
  windowMs: number = DEFAULT_RATE_LIMIT_WINDOW_MS
): Promise<boolean> {
  const now = Date.now();
  const lastSent = _lastAlertTimestamps.get(type) ?? 0;

  if (now - lastSent < windowMs) {
    console.warn(`[alert:suppressed] ${type} alert suppressed by rate limit (${Math.round((windowMs - (now - lastSent)) / 1000)}s remaining)`);
    return false;
  }

  const rawErrorMessage = error instanceof Error ? error.message : String(error);
  const errorMessage = redactSecrets(rawErrorMessage);
  const rawContextStr = details ? `\n\nContext:\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`` : "";
  const contextStr = redactSecrets(rawContextStr);
  const alertText = `🚨 **CRITICAL ALERT: ${type}**\n\n${errorMessage}${contextStr}`;

  console.error(`[alert:${type}]`, errorMessage, details ? redactSecrets(JSON.stringify(details)) : "");

  if (_alertDispatcher) {
    try {
      await _alertDispatcher.sendAlert(alertText);
      _lastAlertTimestamps.set(type, now);
      return true;
    } catch (dispatchErr) {
      console.error("[alert] Failed to send alert message via dispatcher:", dispatchErr);
      return false;
    }
  }

  return false;
}
