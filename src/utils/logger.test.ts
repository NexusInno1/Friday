import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "./logger.js";

describe("logger", () => {
  let logSpy: any;
  let warnSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs structured JSON to console.log for info level", () => {
    logger.info("llm_request_completed", { model: "gemini-2.5-flash", tokens: 120 });
    expect(logSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(logSpy.mock.calls[0][0]);
    expect(logged.level).toBe("info");
    expect(logged.event).toBe("llm_request_completed");
    expect(logged.model).toBe("gemini-2.5-flash");
    expect(logged.tokens).toBe(120);
    expect(logged.timestamp).toBeDefined();
  });

  it("outputs structured JSON to console.warn for warn level", () => {
    logger.warn("model_failover", { from: "gemini", to: "groq", reason: "503 error" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(logged.level).toBe("warn");
    expect(logged.event).toBe("model_failover");
    expect(logged.from).toBe("gemini");
  });

  it("outputs structured JSON to console.error for error level", () => {
    logger.error("all_models_down", { message: "All tiers exhausted" });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(logged.level).toBe("error");
    expect(logged.event).toBe("all_models_down");
  });
});
