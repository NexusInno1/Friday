import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import type { Reminder } from "../db/schema.js";
import {
  computeSnoozedTime,
  createReminderAction,
  snoozeReminderAction,
  cancelReminderAction,
  listRemindersAction,
} from "../actions/actions.js";

export { computeSnoozedTime };

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

export async function createReminder(params: {
  userId?: number;
  chatId: number;
  message: string;
  triggerAt: string;
  isRecurring?: boolean;
  cronExpression?: string | null;
}): Promise<Reminder> {
  return createReminderAction(params);
}

export async function listActiveReminders(
  userId?: number,
  limit = 20
): Promise<Reminder[]> {
  const targetUser = userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const store = getDataStore();
  return listRemindersAction(targetUser, limit, store);
}
