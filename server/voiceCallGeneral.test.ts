import { describe, expect, it, vi } from "vitest";
import { answerGeneralCallQuestion, isGeneralCallQuestion } from "./voiceCallGeneral";
import { invokeLLM } from "./_core/llm";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));

describe("general live-call questions", () => {
  it("keeps CRM reads and changes on their grounded provider path", () => {
    for (const prompt of [
      "What is the status of my Salesforce deal?",
      "Who is my contact Maya?",
      "How many open tasks do I have?",
      "Explain the last note on this account",
      "Can you explain and delete my record?",
      "Who is Maya Chen?",
      "Tell me about Maya Chen",
    ]) expect(isGeneralCallQuestion(prompt)).toBe(false);
  });

  it("recognizes ordinary questions without treating them as CRM commands", () => {
    expect(isGeneralCallQuestion("Why is the sky blue?")).toBe(true);
    expect(isGeneralCallQuestion("Tell me about photosynthesis")).toBe(true);
    expect(isGeneralCallQuestion("Bagaimana pelangi terbentuk?")).toBe(true);
  });

  it("asks the local model for a brief spoken answer without CRM data", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ message: { content: "Because shorter blue wavelengths scatter more strongly." } }] } as never);
    expect(await answerGeneralCallQuestion("Why is the sky blue?", "en")).toContain("blue wavelengths");
    expect(invokeLLM).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ role: "system" }), { role: "user", content: "Why is the sky blue?" }],
    }));
  });
});
