import { describe, expect, it } from "vitest";
import { speechChunks } from "../shared/speech";

describe("bounded speech requests", () => {
  it("preserves long words, punctuation and multiline Salesforce task descriptions", () => {
    const input = `First task. ${"x".repeat(2200)}\nSecond task?\n${"Follow up tomorrow. ".repeat(120)}`;
    const chunks = speechChunks(input);
    expect(
      chunks.every(chunk => chunk.length > 0 && chunk.length <= 1000)
    ).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(input.replace(/\s/g, ""));
  });
  it("does not split an emoji between UTF-16 halves", () => {
    const input = "a".repeat(999) + "😀" + "b".repeat(1100);
    const chunks = speechChunks(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
});
