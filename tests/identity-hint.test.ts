import { describe, expect, it } from "vitest";
import { buildIdentityHint, buildProfiledAnalysisPrompt } from "@/lib/prompts";

// The hint has to pull in two directions at once, and both matter.
//
// It must be authoritative, or the model reverts to the visual guess that was
// wrong — which is the entire failure this feature exists to fix. But it must
// NOT license invention: condition, flaws and measurements still have to come
// from the photographs, or the accuracy check downstream stops meaning
// anything and the seller ships a listing describing features nobody saw.

describe("buildIdentityHint", () => {
  it("is empty for an empty hint, so ordinary analysis is untouched", () => {
    expect(buildIdentityHint("")).toBe("");
    expect(buildIdentityHint("   ")).toBe("");
  });

  it("carries the seller's words verbatim", () => {
    expect(buildIdentityHint("Pyrex Cinderella 441 mixing bowl")).toContain(
      "Pyrex Cinderella 441 mixing bowl"
    );
  });

  it("tells the model not to revert to its own guess", () => {
    const h = buildIdentityHint("Wedgwood Jasperware");
    expect(h).toMatch(/ESTABLISHED FACT/);
    expect(h).toMatch(/do NOT revert to your own visual guess/i);
  });

  it("still requires condition and measurements to come from the photos", () => {
    const h = buildIdentityHint("Wedgwood Jasperware");
    expect(h).toMatch(/CONDITION[\s\S]*from what the photos actually show/i);
    expect(h).toMatch(/MEASUREMENTS[\s\S]*visible in the photos/i);
  });

  it("forbids inventing features typical of the identified item", () => {
    // The dangerous failure mode: told "Nikon F3", the model describes a
    // shutter dial and a lens cap it never saw.
    expect(buildIdentityHint("Nikon F3")).toMatch(
      /Do not claim a feature, marking, accessory or inclusion you cannot see/i
    );
  });

  it("says what to do when photos and hint plainly disagree", () => {
    expect(buildIdentityHint("Nikon F3")).toMatch(/contradict/i);
  });

  it("bounds a long hint rather than letting it dominate the prompt", () => {
    const h = buildIdentityHint("x".repeat(1000));
    expect(h).toContain("x".repeat(300));
    expect(h).not.toContain("x".repeat(301));
  });
});

describe("buildProfiledAnalysisPrompt", () => {
  it("appends nothing when there's no hint", () => {
    const plain = buildProfiledAnalysisPrompt("hard_goods");
    expect(plain).toBe(buildProfiledAnalysisPrompt("hard_goods", ""));
    expect(plain).not.toMatch(/ESTABLISHED FACT/);
  });

  it("keeps the profile addon AND the hint — they answer different questions", () => {
    const withHint = buildProfiledAnalysisPrompt("jewelry", "14K gold signet ring");
    const withoutHint = buildProfiledAnalysisPrompt("jewelry");
    expect(withHint.startsWith(withoutHint)).toBe(true);
    expect(withHint).toMatch(/14K gold signet ring/);
  });

  it("puts the hint last, so it outranks the general instructions above it", () => {
    const p = buildProfiledAnalysisPrompt("hard_goods", "Sunbeam Mixmaster");
    expect(p.indexOf("Sunbeam Mixmaster")).toBeGreaterThan(p.indexOf("Return ONLY valid JSON"));
  });
});
