import { describe, it, expect } from "vitest";
import { chunkMessage } from "./chunk.js";

describe("chunkMessage", () => {
  it("returns single chunk if text is within limit", () => {
    const text = "Short message within 4000 characters.";
    const chunks = chunkMessage(text, 4000);
    expect(chunks).toEqual([text]);
  });

  it("splits along double-newline paragraph boundaries when possible", () => {
    const p1 = "A".repeat(3000);
    const p2 = "B".repeat(2000);
    const text = `${p1}\n\n${p2}`;

    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(p2);
  });

  it("splits along single-newline line boundaries if a single paragraph exceeds limit", () => {
    const l1 = "Line 1: " + "C".repeat(2500);
    const l2 = "Line 2: " + "D".repeat(2000);
    const text = `${l1}\n${l2}`;

    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(l1);
    expect(chunks[1]).toBe(l2);
  });

  it("splits long words/strings hard at maxLength if no whitespace exists", () => {
    const unbroken = "E".repeat(5000);
    const chunks = chunkMessage(unbroken, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(2000);
    expect(chunks[2].length).toBe(1000);
  });
});
