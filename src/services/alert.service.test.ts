import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendCriticalAlert,
  setAlertDispatcher,
  resetAlertRateLimits,
  type AlertDispatcher,
} from "./alert.service.js";
import { env, setEnv } from "../config/env.js";

describe("AlertService", () => {
  let mockDispatcher: AlertDispatcher;

  beforeEach(() => {
    resetAlertRateLimits();
    mockDispatcher = {
      sendAlert: vi.fn().mockResolvedValue(undefined),
    };
    setAlertDispatcher(mockDispatcher);
  });

  it("dispatches critical alert on embedding failure", async () => {
    const error = new Error("Google Embedding API 404 Model Not Found");
    await sendCriticalAlert("embedding_failure", error, { query: "test query" });

    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
    const alertMessage = (mockDispatcher.sendAlert as any).mock.calls[0][0];
    expect(alertMessage).toContain("CRITICAL ALERT: embedding_failure");
    expect(alertMessage).toContain("Google Embedding API 404 Model Not Found");
  });

  it("rate limits identical alert types within the window", async () => {
    const error = new Error("Failed");
    await sendCriticalAlert("embedding_failure", error);
    await sendCriticalAlert("embedding_failure", error);
    await sendCriticalAlert("embedding_failure", error);

    // Only 1 should be dispatched due to rate limiting
    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("allows different alert types through independently", async () => {
    await sendCriticalAlert("embedding_failure", new Error("Embed error"));
    await sendCriticalAlert("all_models_down", new Error("Models down"));

    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(2);
  });

  it("does not lock out alerts when dispatcher is null, permitting alert once dispatcher is set", async () => {
    setAlertDispatcher(null);
    const sentBefore = await sendCriticalAlert("embedding_failure", new Error("Initial failure"));
    expect(sentBefore).toBe(false);

    // Now set dispatcher; alert should NOT be suppressed by rate limit
    setAlertDispatcher(mockDispatcher);
    const sentAfter = await sendCriticalAlert("embedding_failure", new Error("Subsequent failure"));
    expect(sentAfter).toBe(true);
    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("does not lock out alerts when dispatch throws, allowing immediate retry", async () => {
    mockDispatcher.sendAlert = vi.fn().mockRejectedValueOnce(new Error("Network glitch")).mockResolvedValueOnce(undefined);

    const firstAttempt = await sendCriticalAlert("all_models_down", new Error("Outage"));
    expect(firstAttempt).toBe(false);

    // Immediate retry should NOT be suppressed because first attempt failed
    const retryAttempt = await sendCriticalAlert("all_models_down", new Error("Outage retry"));
    expect(retryAttempt).toBe(true);
    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(2);
  });

  it("automatically redacts sensitive API keys from error messages and details", async () => {
    const realKey = "sk_live_secret_real_key_123456";
    setEnv({
      ...env(),
      GEMINI_API_KEY: realKey,
    });

    const error = new Error(`Connection failed with key: ${realKey}`);
    await sendCriticalAlert("embedding_failure", error, { keyAttempted: realKey });

    expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
    const alertMessage = (mockDispatcher.sendAlert as any).mock.calls[0][0];
    expect(alertMessage).not.toContain(realKey);
    expect(alertMessage).toContain("[REDACTED]");
  });
});
