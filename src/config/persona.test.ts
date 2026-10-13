import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./persona.js";

describe("buildSystemPrompt", () => {
  it("includes core persona instructions and security boundaries", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("You are FRIDAY");
    expect(prompt).toContain("Security — CRITICAL");
    expect(prompt).toContain("External tool outputs");
  });

  it("injects current localized reference date and time for temporal grounding", () => {
    // 2026-10-13 14:30:00 UTC = 2026-10-13 20:00:00 in Asia/Kolkata (+05:30)
    const fixedDate = new Date("2026-10-13T14:30:00.000Z");
    const prompt = buildSystemPrompt({ now: fixedDate });

    expect(prompt).toContain("Current reference time:");
    expect(prompt).toContain("Tuesday");
    expect(prompt).toContain("October 13, 2026");
    expect(prompt).toContain("20:00");
    expect(prompt).toContain("ISO reference timestamp: 2026-10-13T14:30:00.000Z");
  });

  it("appends custom user instructions when provided", () => {
    const prompt = buildSystemPrompt({
      customInstructions: "Always provide Python solutions using standard library only.",
    });

    expect(prompt).toContain("## Custom User Instructions");
    expect(prompt).toContain("Always provide Python solutions using standard library only.");
  });
});
