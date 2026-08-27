import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import type { Reminder } from "../db/schema.js";

/**
 * Pure function to calculate a snoozed trigger timestamp.
 */
export function computeSnoozedTime(currentTriggerAt: string, minutes: number): string {
  if (minutes <= 0) {
    throw new Error("Snooze duration must be a positive number of minutes.");
  }
  const date = new Date(currentTriggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${currentTriggerAt}`);
  }
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

/**
 * Snoozes a reminder by updating its trigger_at and resetting is_completed to false.
 */
export async function snoozeReminder(
  reminderId: string,
  minutes: number,
  userId?: number
): Promise<{ reminder: Reminder; newTriggerAt: string }> {
  const db = getSupabaseClient();
  const allowedUserId = userId ?? env().TELEGRAM_ALLOWED_USER_ID;

  const { data: reminder, error: fetchError } = await db
    .from("reminders")
    .select()
    .eq("id", reminderId)
    .eq("user_id", allowedUserId)
    .single();

  if (fetchError || !reminder) {
    throw new Error("Reminder not found.");
  }

  const newTriggerAt = computeSnoozedTime(reminder.trigger_at, minutes);

  const { data: updated, error: updateError } = await db
    .from("reminders")
    .update({
      trigger_at: newTriggerAt,
      is_completed: false,
    })
    .eq("id", reminderId)
    .select()
    .single();

  if (updateError || !updated) {
    throw new Error(`Failed to snooze reminder: ${updateError?.message ?? "unknown error"}`);
  }

  return { reminder: updated, newTriggerAt };
}

/**
 * Cancels a reminder by setting is_cancelled to true.
 */
export async function cancelReminder(
  reminderId: string,
  userId?: number
): Promise<{ success: boolean; cancelledId: string }> {
  const db = getSupabaseClient();
  const allowedUserId = userId ?? env().TELEGRAM_ALLOWED_USER_ID;

  const { error } = await db
    .from("reminders")
    .update({ is_cancelled: true })
    .eq("id", reminderId)
    .eq("user_id", allowedUserId);

  if (error) {
    throw new Error(`Failed to cancel reminder: ${error.message}`);
  }

  return { success: true, cancelledId: reminderId };
}

/**
 * Creates a reminder with appropriate telegram_chat_id.
 */
export async function createReminder(params: {
  userId?: number;
  chatId: number;
  message: string;
  triggerAt: string;
  isRecurring?: boolean;
  cronExpression?: string | null;
}): Promise<Reminder> {
  const db = getSupabaseClient();
  const userId = params.userId ?? env().TELEGRAM_ALLOWED_USER_ID;

  const date = new Date(params.triggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(
      `Invalid trigger date/time format: "${params.triggerAt}". Expected a valid ISO 8601 datetime string (e.g. 2026-08-27T18:00:00+05:30).`
    );
  }

  const { data, error } = await db
    .from("reminders")
    .insert({
      user_id: userId,
      telegram_chat_id: params.chatId,
      message: params.message,
      trigger_at: date.toISOString(),
      is_recurring: params.isRecurring ?? false,
      cron_expression: params.cronExpression ?? null,
      is_completed: false,
      is_cancelled: false,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create reminder: ${error?.message ?? "unknown error"}`);
  }

  return data;
}

/**
 * Lists active (pending) reminders for a user.
 */
export async function listActiveReminders(
  userId?: number,
  limit = 20
): Promise<Reminder[]> {
  const db = getSupabaseClient();
  const allowedUserId = userId ?? env().TELEGRAM_ALLOWED_USER_ID;

  const { data, error } = await db
    .from("reminders")
    .select()
    .eq("user_id", allowedUserId)
    .eq("is_cancelled", false)
    .eq("is_completed", false)
    .order("trigger_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list reminders: ${error.message}`);
  }

  return data ?? [];
}
