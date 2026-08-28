import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ebayBases,
  ebayEnvLabel,
  ebayItemUrl,
  normalizeEbayEnv,
  type EbayEnv,
} from "@/lib/ebay/environment";
import { CORE_SCOPES, EBAY_OPTIONAL_SCOPES } from "@/lib/ebay/scopes";

// Pointing a second deployment at eBay's sandbox, so a dev environment can't
// end real listings, send offers to real buyers, or mark real orders shipped.
//
// Two failure modes are worth more than the rest put together, and both are
// silent:
//   • production quietly running against the sandbox — listings appear to
//     publish and then don't exist
//   • sandbox quietly behaving like production — which is the thing this whole
//     switch exists to prevent

describe("choosing an environment", () => {
  it("defaults to production for anything that isn't the word sandbox", () => {
    // Production is the default because a typo must never silently point a
    // LIVE deployment at the sandbox.
    for (const v of [undefined, "", "  ", "prod", "sandbx", "SANDBOXES", "true", "1"]) {
      expect(normalizeEbayEnv(v)).toBe("production");
    }
  });

  it("accepts the word regardless of case or padding", () => {
    for (const v of ["sandbox", "SANDBOX", " Sandbox ", "sAnDbOx"]) {
      expect(normalizeEbayEnv(v)).toBe("sandbox");
    }
  });
});

describe("the hosts each environment uses", () => {
  const prod = ebayBases("production");
  const sand = ebayBases("sandbox");

  it("points production at the live hosts", () => {
    expect(prod.tokenUrl).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    expect(prod.oauthUrl).toBe("https://auth.ebay.com/oauth2/authorize");
    expect(prod.trading).toBe("https://api.ebay.com/ws/api.dll");
    expect(prod.media).toBe("https://apim.ebay.com/commerce/media/v1_beta");
    expect(prod.itemPrefix).toBe("https://www.ebay.com/itm/");
  });

  it("moves every single endpoint to sandbox, leaving none behind", () => {
    // The one that matters. A host left hardcoded is a call that reaches the
    // real account from a deployment believed to be safe — which is worse than
    // having no sandbox mode at all, because it comes with false confidence.
    for (const [key, value] of Object.entries(sand)) {
      if (key === "env") continue;
      expect(String(value)).toMatch(/\.sandbox\.ebay\.com/);
    }
  });

  it("changes only the hostname, never the path", () => {
    const paths = (b: object) =>
      Object.entries(b)
        .filter(([k]) => k !== "env")
        .map(([k, v]) => [k, new URL(String(v)).pathname]);
    expect(paths(sand)).toEqual(paths(prod));
  });

  it("uses the right host family for each service", () => {
    expect(sand.oauthUrl).toContain("auth.sandbox.ebay.com");
    expect(sand.media).toContain("apim.sandbox.ebay.com");
    expect(sand.itemPrefix).toContain("www.sandbox.ebay.com");
    expect(sand.inventory).toContain("api.sandbox.ebay.com");
  });
});

describe("OAuth scopes are identifiers, not endpoints", () => {
  // The trap this switch could easily have fallen into. Scope strings LOOK
  // like URLs and are spelled api.ebay.com in BOTH environments. Rewriting them
  // to the sandbox host gets the entire authorize request rejected with
  // invalid_scope — a failure this codebase has already been bitten by once.
  it("keeps every scope on api.ebay.com", () => {
    const all = [...CORE_SCOPES, ...EBAY_OPTIONAL_SCOPES.map((o) => o.scope)];
    expect(all.length).toBeGreaterThan(0);
    for (const scope of all) {
      expect(scope).toMatch(/^https:\/\/api\.ebay\.com\/oauth\/api_scope/);
      expect(scope).not.toContain("sandbox");
    }
  });

  it("does not expose scopes through the base list, where they'd get rewritten", () => {
    const bases: object = ebayBases("sandbox");
    for (const v of Object.values(bases)) {
      expect(String(v)).not.toContain("api_scope");
    }
  });
});

describe("linking to a published listing", () => {
  it("sends a sandbox listing to the sandbox site", () => {
    // A sandbox listing 404s on www.ebay.com, which reads as a failed publish
    // when the publish actually worked.
    expect(ebayItemUrl("1234567890", "sandbox")).toBe(
      "https://www.sandbox.ebay.com/itm/1234567890"
    );
    expect(ebayItemUrl("1234567890", "production")).toBe("https://www.ebay.com/itm/1234567890");
  });
});

describe("saying which one you're on", () => {
  it("labels both environments unambiguously", () => {
    expect(ebayEnvLabel("sandbox")).toBe("eBay Sandbox");
    expect(ebayEnvLabel("production")).toBe("eBay Production");
  });

  it("reports the environment it was built for", () => {
    for (const env of ["production", "sandbox"] as EbayEnv[]) {
      expect(ebayBases(env).env).toBe(env);
    }
  });
});

describe("the wiring, not just the rules", () => {
  // The pure function above can be perfect while config.ts still hands the
  // modules a production URL. This loads the real config the way the app does.
  const load = async (env?: string) => {
    vi.resetModules();
    if (env === undefined) delete process.env.EBAY_ENV;
    else process.env.EBAY_ENV = env;
    return import("@/lib/ebay/config");
  };

  afterEach(() => {
    delete process.env.EBAY_ENV;
    vi.resetModules();
  });

  it("hands every module a sandbox URL when EBAY_ENV=sandbox", async () => {
    const c = await load("sandbox");
    for (const url of [
      c.EBAY_OAUTH_URL,
      c.EBAY_TOKEN_URL,
      c.EBAY_INV_BASE,
      c.EBAY_ACC_BASE,
      c.EBAY_META_BASE,
      c.EBAY_TAX_BASE,
      c.EBAY_FUL_BASE,
      c.EBAY_ANALYTICS_BASE,
      c.EBAY_MARKETING_BASE,
      c.EBAY_NEGOTIATION_BASE,
      c.EBAY_BROWSE_SEARCH,
      c.EBAY_MEDIA_BASE,
      c.EBAY_TRADING,
      c.EBAY_ITEM_PREFIX,
    ]) {
      expect(url).toMatch(/\.sandbox\.ebay\.com/);
    }
    expect(c.IS_SANDBOX).toBe(true);
  });

  it("stays on production when the variable is unset", async () => {
    const c = await load(undefined);
    expect(c.IS_SANDBOX).toBe(false);
    expect(c.EBAY_TRADING).toBe("https://api.ebay.com/ws/api.dll");
  });

  it("lets EBAY_MEDIA_BASE still win, since that host is the unproven one", async () => {
    vi.resetModules();
    process.env.EBAY_ENV = "sandbox";
    process.env.EBAY_MEDIA_BASE = "https://example.test/media";
    const c = await import("@/lib/ebay/config");
    expect(c.EBAY_MEDIA_BASE).toBe("https://example.test/media");
    delete process.env.EBAY_MEDIA_BASE;
  });
});
