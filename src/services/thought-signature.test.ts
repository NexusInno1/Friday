import { describe, it, expect, vi } from "vitest";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";

describe("Google Generative AI Thought Signature Preservation", () => {
  it("preserves model thoughtSignature across multi-step tool calls", async () => {
    let capturedStep2Parts: any[] | null = null;
    const testSignature = "SIGNATURE_TEST_CRYPTO_TOKEN_9999";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any, options: any) => {
      const body = JSON.parse(options.body);
      const hasToolResponse = body.contents.some((c: any) =>
        c.parts?.some((p: any) => "functionResponse" in p)
      );

      if (!hasToolResponse) {
        // Step 1: Return a tool call with an encrypted thoughtSignature from Gemini
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        name: "web_search",
                        args: { query: "AI news" },
                      },
                      thoughtSignature: testSignature,
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } else {
        // Step 2: Capture what was echoed back to Gemini
        capturedStep2Parts = body.contents[1].parts;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Search finished." }],
                },
                finishReason: "STOP",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }) as any;

    try {
      const google = createGoogleGenerativeAI({ apiKey: "mock-api-key" });
      const result = await generateText({
        model: google("gemini-3.5-flash-lite"),
        prompt: "Check latest news",
        tools: {
          web_search: tool({
            description: "Search web",
            parameters: z.object({ query: z.string() }),
            execute: async () => ({ results: ["news result 1"] }),
          }),
        },
        maxSteps: 2,
      });

      expect(result.text).toBe("Search finished.");
      expect(capturedStep2Parts).not.toBeNull();
      expect(capturedStep2Parts![0].functionCall.name).toBe("web_search");
      // Must preserve the exact cryptographic token, not skip or strip it
      expect(capturedStep2Parts![0].thoughtSignature).toBe(testSignature);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
