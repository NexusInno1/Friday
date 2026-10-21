export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export const logger = {
  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    const jsonStr = JSON.stringify(record);
    if (level === "error") {
      console.error(jsonStr);
    } else if (level === "warn") {
      console.warn(jsonStr);
    } else {
      console.log(jsonStr);
    }
  },

  info(event: string, data?: Record<string, unknown>): void {
    this.log("info", event, data);
  },

  warn(event: string, data?: Record<string, unknown>): void {
    this.log("warn", event, data);
  },

  error(event: string, data?: Record<string, unknown>): void {
    this.log("error", event, data);
  },

  debug(event: string, data?: Record<string, unknown>): void {
    this.log("debug", event, data);
  },
};
