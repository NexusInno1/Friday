import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkAndIncrementUsage,
  getDailyUsage,
  resetDailyUsage,
} from "./cost-tracker.service.js";
import * as alertService from "./alert.service.js";
import { env } from "../config/env.js";

describe("CostTrackerService", () => {
  beforeEach(() => {
    resetDailyUsage();
    vi.restoreAllMocks();
  });

  it("increments usage normally below warning threshold", async () => {
    const res = await checkAndIncrementUsage("llm");
    expect(res.allowed).toBe(true);
    expect(res.count).toBe(1);

    const usage = getDailyUsage("llm");
    expect(usage.count).toBe(1);
    expect(usage.cap).toBe(env().DAILY_LLM_CALL_CAP);
  });

  it("triggers 80% warning alert when threshold is crossed", async () => {
    const alertSpy = vi.spyOn(alertService, "sendCriticalAlert").mockResolvedValue(true);
    const cap = env().DAILY_LLM_CALL_CAP;
    const threshold = Math.ceil(cap * 0.8);

    for (let i = 0; i < threshold - 1; i++) {
      await checkAndIncrementUsage("llm");
    }
    expect(alertSpy).not.toHaveBeenCalled();

    // Crossing 80% should trigger warning
    const resThreshold = await checkAndIncrementUsage("llm");
    expect(resThreshold.allowed).toBe(true);
    expect(resThreshold.count).toBe(threshold);
    expect(alertSpy).toHaveBeenCalledWith(
      "quota_warning",
      expect.any(Error),
      expect.objectContaining({ resource: "llm", count: threshold, cap })
    );

    // Subsequent call should not trigger alert again (only once per day)
    alertSpy.mockClear();
    await checkAndIncrementUsage("llm");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("gracefully refuses and triggers quota_exceeded alert when 100% cap is reached", async () => {
    const alertSpy = vi.spyOn(alertService, "sendCriticalAlert").mockResolvedValue(true);
    const cap = env().DAILY_TAVILY_CALL_CAP;

    for (let i = 0; i < cap; i++) {
      const res = await checkAndIncrementUsage("tavily");
      expect(res.allowed).toBe(true);
    }

    alertSpy.mockClear();

    // cap + 1 call should be refused
    const resOver = await checkAndIncrementUsage("tavily");
    expect(resOver.allowed).toBe(false);
    expect(resOver.error).toContain(`Daily TAVILY call limit of ${cap} reached`);
    expect(alertSpy).toHaveBeenCalledWith(
      "quota_exceeded",
      expect.any(Error),
      expect.objectContaining({ resource: "tavily", count: cap, cap })
    );
  });
});
