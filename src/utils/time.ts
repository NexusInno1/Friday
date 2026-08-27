/**
 * Parses and normalizes various time formats into 24-hour HH:MM format.
 * Supports:
 * - 24-hour: "07:00", "18:30", "7:00", "8:30"
 * - 12-hour: "8:30am", "8:30 AM", "08:30 am", "7pm", "7 PM", "12:00am", "12:30pm"
 */
export function parseTimeString(input: string): string {
  const trimmed = input.trim();

  // 1. Try 12-hour AM/PM format (e.g., "8:30am", "8:30 AM", "8.30am", "7pm", "7 PM")
  const ampmRegex = /^(\d{1,2})(?:[:.]([0-5]\d))?\s*(am|pm)$/i;
  const ampmMatch = trimmed.match(ampmRegex);

  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const period = ampmMatch[3].toLowerCase();

    if (hour < 1 || hour > 12) {
      throw new Error(`Invalid time format: hour must be between 1 and 12 for AM/PM format.`);
    }

    if (period === "am") {
      if (hour === 12) hour = 0;
    } else if (period === "pm") {
      if (hour !== 12) hour += 12;
    }

    const hh = hour.toString().padStart(2, "0");
    const mm = minute.toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // 2. Try 24-hour format (e.g., "08:30", "8:30", "08.30", "19:00", "23:59")
  const hour24Regex = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;
  const hour24Match = trimmed.match(hour24Regex);

  if (hour24Match) {
    const hh = hour24Match[1].padStart(2, "0");
    const mm = hour24Match[2];
    return `${hh}:${mm}`;
  }

  throw new Error(
    `Invalid time format: "${input}". Please use HH:MM (e.g. 08:30, 19:00) or AM/PM (e.g. 8:30am, 7pm).`
  );
}

/**
 * Computes the ISO string representing 23:59:59.999 in the target timezone for a given date.
 */
export function getEndOfDayISO(timezone: string, baseDate: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(baseDate);
  const year = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const month = parseInt(parts.find((p) => p.type === "month")!.value, 10);
  const day = parseInt(parts.find((p) => p.type === "day")!.value, 10);

  // Target time in local values: year, month, day, 23:59:59.999
  const targetUtcEstimate = Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  // Check what local time targetUtcEstimate corresponds to in the target timezone
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const tzParts = tzFormatter.formatToParts(new Date(targetUtcEstimate));
  const tzYear = parseInt(tzParts.find((p) => p.type === "year")!.value, 10);
  const tzMonth = parseInt(tzParts.find((p) => p.type === "month")!.value, 10);
  const tzDay = parseInt(tzParts.find((p) => p.type === "day")!.value, 10);
  const tzHour = parseInt(tzParts.find((p) => p.type === "hour")!.value, 10);
  const tzMinute = parseInt(tzParts.find((p) => p.type === "minute")!.value, 10);
  const tzSecond = parseInt(tzParts.find((p) => p.type === "second")!.value, 10);

  const tzAsUtcMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, tzSecond, 999);
  const offsetMs = tzAsUtcMs - targetUtcEstimate;

  const exactUtcMs = targetUtcEstimate - offsetMs;
  return new Date(exactUtcMs).toISOString();
}
