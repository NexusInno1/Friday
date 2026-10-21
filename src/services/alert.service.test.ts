import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendCriticalAlert,
  setAlertDispatcher,
  resetAlertRateLimits,
  type AlertDispatcher,
} from "./alert.service.js";

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
});
