import { describe, expect, it } from "vitest";
import { isAllowedModel } from "@/lib/models";
import { withThinkingHeadroom } from "@/lib/ai-usage";

const base = {
  max_tokens: 300,
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("Claude 5.x models", () => {
  it("allows the 5.x models in the selector allowlist", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-5",
      "claude-sonnet-5",
    ]) {
      expect(isAllowedModel(id)).toBe(true);
    }
  });

  it("still rejects the premium fable tier", () => {
    expect(isAllowedModel("claude-fable-5-1")).toBe(false);
  });

  it("adds thinking headroom and low effort for 5.x models", () => {
    const out = withThinkingHeadroom({ ...base, model: "claude-opus-5-5" });
    expect(out.max_tokens).toBe(8300);
    expect((out as unknown as { output_config: unknown }).output_config).toEqual({ effort: "low" });
  });

  it("leaves 4.x requests unchanged", () => {
    const params = { ...base, model: "claude-opus-4-8" };
    expect(withThinkingHeadroom(params)).toBe(params);
  });
});
