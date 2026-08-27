import { describe, it, expect } from "vitest";
import { parseTimeString, getEndOfDayISO } from "./time.js";

describe("parseTimeString", () => {
  it("parses 24-hour format HH:MM correctly", () => {
    expect(parseTimeString("07:00")).toBe("07:00");
    expect(parseTimeString("18:45")).toBe("18:45");
    expect(parseTimeString("00:00")).toBe("00:00");
    expect(parseTimeString("23:59")).toBe("23:59");
  });

  it("normalizes single-digit hour 24-hour format H:MM to HH:MM", () => {
    expect(parseTimeString("7:00")).toBe("07:00");
    expect(parseTimeString("8:30")).toBe("08:30");
  });

  it("parses 12-hour AM/PM formats correctly", () => {
    expect(parseTimeString("8:30am")).toBe("08:30");
    expect(parseTimeString("8:30 AM")).toBe("08:30");
    expect(parseTimeString("08:30 am")).toBe("08:30");
    expect(parseTimeString("12:00am")).toBe("00:00");
    expect(parseTimeString("12:30am")).toBe("00:30");
    expect(parseTimeString("12:00pm")).toBe("12:00");
    expect(parseTimeString("12:45 PM")).toBe("12:45");
    expect(parseTimeString("7pm")).toBe("19:00");
    expect(parseTimeString("7 PM")).toBe("19:00");
    expect(parseTimeString("7am")).toBe("07:00");
    expect(parseTimeString("11:59 pm")).toBe("23:59");
    expect(parseTimeString("8.30am")).toBe("08:30");
    expect(parseTimeString("8.30 AM")).toBe("08:30");
  });

  it("parses 24-hour formats with dot separator correctly", () => {
    expect(parseTimeString("08.30")).toBe("08:30");
    expect(parseTimeString("19.45")).toBe("19:45");
  });

  it("throws clear error on invalid time formats", () => {
    expect(() => parseTimeString("invalid")).toThrow(/Invalid time format/i);
    expect(() => parseTimeString("25:00")).toThrow(/Invalid time format/i);
    expect(() => parseTimeString("12:60")).toThrow(/Invalid time format/i);
    expect(() => parseTimeString("13:00pm")).toThrow(/Invalid time format/i);
  });
});

describe("getEndOfDayISO", () => {
  it("computes the ISO string representing 23:59:59.999 in specified timezone", () => {
    const fixedDate = new Date("2026-08-22T10:00:00.000Z");
    const endOfDayIST = getEndOfDayISO("Asia/Kolkata", fixedDate);
    
    // In Asia/Kolkata (UTC+5:30), for date 2026-08-22, 23:59:59.999 IST corresponds to 18:29:59.999 UTC
    expect(endOfDayIST).toBe("2026-08-22T18:29:59.999Z");
  });

  it("handles UTC timezone", () => {
    const fixedDate = new Date("2026-08-22T10:00:00.000Z");
    const endOfDayUTC = getEndOfDayISO("UTC", fixedDate);
    expect(endOfDayUTC).toBe("2026-08-22T23:59:59.999Z");
  });
});
