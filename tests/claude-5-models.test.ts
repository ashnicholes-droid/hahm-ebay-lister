import { describe, expect, it } from "vitest";
import { isAllowedModel, resolveEffort, thinksByDefault } from "@/lib/models";
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
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("leaves 4.x requests unchanged", () => {
    const params = { ...base, model: "claude-opus-4-8" };
    expect(withThinkingHeadroom(params)).toBe(params);
  });
});

describe("listing effort", () => {
  it("keeps an existing output_config format when adding effort", () => {
    const format = { type: "json_schema" as const, schema: { type: "object" } };
    const out = withThinkingHeadroom({
      ...base,
      model: "claude-opus-5-5",
      output_config: { format },
    });
    expect(out.output_config).toEqual({ format, effort: "low" });
  });

  it("honours a caller-chosen medium effort with more headroom", () => {
    const out = withThinkingHeadroom({
      ...base,
      model: "claude-opus-5-5",
      output_config: { effort: "medium" },
    });
    expect(out.output_config?.effort).toBe("medium");
    expect(out.max_tokens).toBe(12300);
  });

  it("only accepts low or medium from the client", () => {
    expect(resolveEffort("medium")).toBe("medium");
    expect(resolveEffort("max")).toBe("low");
    expect(resolveEffort(undefined)).toBe("low");
  });

  it("offers effort only for 5.x models", () => {
    expect(thinksByDefault("claude-opus-5-5")).toBe(true);
    expect(thinksByDefault("claude-opus-4-8")).toBe(false);
  });
});
