import { Cron } from "croner";
import { env } from "../config/env.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { Reminder } from "../db/schema.js";

// ─── Reminder Pure Logic & Calculations ──────────────────────────────────────

export function computeSnoozedTime(
  currentTriggerAt: string,
  minutes: number,
  baseTimeMs?: number
): string {
  if (minutes <= 0) {
    throw new Error("Snooze duration must be a positive number of minutes.");
  }
  const date = new Date(currentTriggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${currentTriggerAt}`);
  }
  const base = baseTimeMs !== undefined ? Math.max(baseTimeMs, date.getTime()) : date.getTime();
  return new Date(base + minutes * 60 * 1000).toISOString();
}

// ─── Reminder Core Actions ───────────────────────────────────────────────────

export async function createReminderAction(
  params: {
    userId?: number;
    chatId: number;
    message: string;
    triggerAt: string;
    isRecurring?: boolean;
    cronExpression?: string | null;
  },
  store: DataStore = getDataStore()
): Promise<Reminder> {
  const userId = params.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const date = new Date(params.triggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(
      `Invalid trigger date/time format: "${params.triggerAt}". Expected a valid ISO 8601 datetime string.`
    );
  }

  if (!params.message || !params.message.trim()) {
    throw new Error("Reminder message cannot be empty.");
  }

  if (params.isRecurring || params.cronExpression) {
    if (!params.cronExpression || !params.cronExpression.trim()) {
      throw new Error("Recurring reminders require a valid cron expression.");
    }
    try {
      new Cron(params.cronExpression.trim());
    } catch {
      throw new Error(
        `Invalid cron expression: "${params.cronExpression}". Expected a valid 5-part cron format (e.g. "0 9 * * 1-5").`
      );
    }
  }

  return store.createReminder({
    userId,
    chatId: params.chatId,
    message: params.message.trim(),
    triggerAt: date.toISOString(),
    isRecurring: params.isRecurring ?? false,
    cronExpression: params.cronExpression?.trim() ?? null,
  });
}

export async function snoozeReminderAction(
  reminderId: string,
  minutes: number,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore(),
  baseTimeMs?: number
): Promise<{ reminder: Reminder; newTriggerAt: string }> {
  const reminder = await store.getReminder(reminderId, userId);
  if (!reminder) {
    throw new Error("Reminder not found.");
  }
  if (reminder.is_cancelled) {
    throw new Error("Cannot snooze a cancelled reminder.");
  }

  const effectiveBase = baseTimeMs ?? Date.now();
  const newTriggerAt = computeSnoozedTime(reminder.trigger_at, minutes, effectiveBase);
  const updated = await store.updateReminder(reminderId, {
    trigger_at: newTriggerAt,
    is_completed: false,
    lease_until: null,
    sent_at: null,
  });

  return { reminder: updated, newTriggerAt };
}

export async function cancelReminderAction(
  reminderId: string,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore()
): Promise<{ success: boolean; cancelledId: string }> {
  const reminder = await store.getReminder(reminderId, userId);
  if (!reminder) {
    throw new Error("Reminder not found.");
  }

  await store.updateReminder(reminderId, {
    is_cancelled: true,
    lease_until: null,
  });
  return { success: true, cancelledId: reminderId };
}

export async function listRemindersAction(
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  limit: number = 20,
  store: DataStore = getDataStore()
): Promise<Reminder[]> {
  return store.listActiveReminders(userId, limit);
}

// ─── Ergonomic Facade Aliases ────────────────────────────────────────────────

export async function snoozeReminder(
  reminderId: string,
  minutes: number,
  userId?: number
): Promise<{ reminder: Reminder; newTriggerAt: string }> {
  const targetUser = userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  return snoozeReminderAction(reminderId, minutes, targetUser);
}

export async function cancelReminder(
  reminderId: string,
  userId?: number
): Promise<{ success: boolean; cancelledId: string }> {
  const targetUser = userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  return cancelReminderAction(reminderId, targetUser);
}

export const createReminder = createReminderAction;

export async function listActiveReminders(
  userId?: number,
  limit = 20
): Promise<Reminder[]> {
  const targetUser = userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const store = getDataStore();
  return listRemindersAction(targetUser, limit, store);
}
