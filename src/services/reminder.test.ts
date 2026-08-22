import { describe, it, expect } from "vitest";
import { computeSnoozedTime } from "./reminder.service.js";

describe("computeSnoozedTime", () => {
  it("adds specified minutes to an ISO trigger timestamp", () => {
    const baseTime = "2026-08-22T10:00:00.000Z";
    
    const snoozed15 = computeSnoozedTime(baseTime, 15);
    expect(snoozed15).toBe("2026-08-22T10:15:00.000Z");

    const snoozed60 = computeSnoozedTime(baseTime, 60);
    expect(snoozed60).toBe("2026-08-22T11:00:00.000Z");
  });

  it("throws error for non-positive snooze minutes", () => {
    const baseTime = "2026-08-22T10:00:00.000Z";
    expect(() => computeSnoozedTime(baseTime, 0)).toThrow(/positive/i);
    expect(() => computeSnoozedTime(baseTime, -10)).toThrow(/positive/i);
  });
});
