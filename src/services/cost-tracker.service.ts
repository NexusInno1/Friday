import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { sendCriticalAlert } from "./alert.service.js";

export type TrackedResource = "llm" | "tavily";

interface DailyUsageRecord {
  date: string;
  llm: number;
  tavily: number;
  warnedLlm80: boolean;
  warnedTavily80: boolean;
}

let _currentUsage: DailyUsageRecord = {
  date: "",
  llm: 0,
  tavily: 0,
  warnedLlm80: false,
  warnedTavily80: false,
};

function getTodayDateStr(): string {
  try {
    const tz = env().USER_TIMEZONE || "Asia/Kolkata";
    return new Date().toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

function ensureCurrentDate(): void {
  const today = getTodayDateStr();
  if (_currentUsage.date !== today) {
    _currentUsage = {
      date: today,
      llm: 0,
      tavily: 0,
      warnedLlm80: false,
      warnedTavily80: false,
    };
  }
}

export function resetDailyUsage(): void {
  _currentUsage = {
    date: getTodayDateStr(),
    llm: 0,
    tavily: 0,
    warnedLlm80: false,
    warnedTavily80: false,
  };
}

export function getDailyUsage(resource: TrackedResource): { count: number; cap: number; percentage: number } {
  ensureCurrentDate();
  const cap = resource === "llm" ? env().DAILY_LLM_CALL_CAP : env().DAILY_TAVILY_CALL_CAP;
  const count = _currentUsage[resource];
  const percentage = cap > 0 ? (count / cap) * 100 : 0;
  return { count, cap, percentage };
}

export async function checkAndIncrementUsage(
  resource: TrackedResource
): Promise<{ allowed: boolean; count: number; cap: number; percentage: number; error?: string }> {
  ensureCurrentDate();
  const cap = resource === "llm" ? env().DAILY_LLM_CALL_CAP : env().DAILY_TAVILY_CALL_CAP;
  const currentCount = _currentUsage[resource];

  if (currentCount >= cap) {
    logger.warn("quota_exceeded", { resource, count: currentCount, cap });
    await sendCriticalAlert(
      "quota_exceeded",
      new Error(`Daily ${resource.toUpperCase()} call cap (${cap}) reached. Further calls refused.`),
      { resource, count: currentCount, cap }
    );
    return {
      allowed: false,
      count: currentCount,
      cap,
      percentage: 100,
      error: `Daily ${resource.toUpperCase()} call limit of ${cap} reached. Service is paused until tomorrow to prevent unexpected costs.`,
    };
  }

  // Increment usage
  _currentUsage[resource] += 1;
  const newCount = _currentUsage[resource];
  const percentage = (newCount / cap) * 100;

  // Check 80% warning threshold
  const warnedFlag = resource === "llm" ? _currentUsage.warnedLlm80 : _currentUsage.warnedTavily80;
  if (!warnedFlag && percentage >= 80) {
    if (resource === "llm") _currentUsage.warnedLlm80 = true;
    else _currentUsage.warnedTavily80 = true;

    logger.warn("quota_warning", { resource, count: newCount, cap, percentage: Math.round(percentage) });
    await sendCriticalAlert(
      "quota_warning",
      new Error(`Daily ${resource.toUpperCase()} usage reached ${Math.round(percentage)}% (${newCount}/${cap}).`),
      { resource, count: newCount, cap, percentage: Math.round(percentage) }
    );
  }

  return { allowed: true, count: newCount, cap, percentage };
}
