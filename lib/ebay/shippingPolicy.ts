// Changing how postage is arranged when a listing is relisted.
//
// On eBay's Inventory API, shipping is not a field on a listing — it is a
// business POLICY referenced by the offer. So "switch this to free shipping"
// means swapping `listingPolicies.fulfillmentPolicyId` on the offer, and the
// choices available are whatever policies the seller has actually created in
// eBay → Account → Business policies. This app cannot invent one.
//
// That constraint shapes the whole feature. A free-vs-paid toggle would be a
// lie for a seller with three paid policies at different rates, and would fail
// outright for a seller with no free policy at all. So the seller picks a real
// policy by name, grouped by what it costs the buyer, and "keep the current
// one" is the default — a relist is already destructive enough without a
// shipping change nobody asked for riding along.
//
// Pure and client-safe: no process.env, no eBay import, so the relist panel can
// group and describe policies without a round trip and the rules are testable.

/** One of the seller's fulfillment policies, as the UI needs to show it. */
export interface ShippingPolicyOption {
  id: string;
  name: string;
  /** True when the buyer pays nothing for domestic postage. */
  free: boolean;
  /** How the buyer is charged: a fixed amount, or a rate from their address. */
  costType: "flat" | "calculated" | "unknown";
  /** The fixed amount, when there is one. */
  flatCost: number | null;
  /** Which service an override attaches to. Null means none can. */
  domesticPriority: number | null;
}

/**
 * What a policy actually does, for the dropdown label.
 *
 * The names sellers give policies describe handling time ("1 Day Handling") far
 * more often than they describe cost, so a list of names alone is unusable for
 * choosing between fixed and calculated postage — which was exactly the
 * complaint that produced this function.
 */
export function policyLabel(p: ShippingPolicyOption): string {
  if (p.free) return `${p.name} — free to the buyer`;
  if (p.costType === "flat") {
    return p.flatCost === null
      ? `${p.name} — flat rate`
      : `${p.name} — flat $${p.flatCost.toFixed(2)}`;
  }
  if (p.costType === "calculated") return `${p.name} — calculated at checkout`;
  return p.name;
}

/** The three kinds a seller is actually choosing between. */
export type PolicyKind = "free" | "flat" | "calculated";

export function policyKind(p: ShippingPolicyOption): PolicyKind {
  if (p.free) return "free";
  return p.costType === "flat" ? "flat" : "calculated";
}

/**
 * What the seller chose in the relist panel.
 *
 * "keep" is deliberately distinct from "the id that happens to be current":
 * keeping means the offer's policy is not written at all, which is one fewer
 * way for a relist to fail after the listing is already down.
 */
export type ShippingChoice = { kind: "keep" } | { kind: "policy"; id: string };

export const KEEP_SHIPPING: ShippingChoice = { kind: "keep" };

/** How a listing's current postage reads, from the Trading API. */
export type CurrentArrangement = "free" | "flat" | "calculated" | "unknown";

/**
 * Policies split into the two groups a seller actually thinks in.
 *
 * Named lists rather than a boolean, because the seller is choosing between
 * "Free shipping" and "Flat $6.50" and "Calculated" — real things they set up —
 * not between two abstractions.
 */
export function groupPolicies(policies: ShippingPolicyOption[]): {
  free: ShippingPolicyOption[];
  flat: ShippingPolicyOption[];
  calculated: ShippingPolicyOption[];
} {
  return {
    free: policies.filter((p) => policyKind(p) === "free"),
    flat: policies.filter((p) => policyKind(p) === "flat"),
    calculated: policies.filter((p) => policyKind(p) === "calculated"),
  };
}

/** Plain words for what a listing's postage does today. */
export function describeArrangement(
  arrangement: CurrentArrangement,
  cost: number | null,
  service?: string
): string {
  const svc = service ? ` (${service})` : "";
  switch (arrangement) {
    case "free":
      return `Free to the buyer${svc} — you pay the postage`;
    case "flat":
      return cost === null
        ? `Buyer pays a flat rate${svc}`
        : `Buyer pays $${cost.toFixed(2)}${svc}`;
    case "calculated":
      return `Buyer pays a calculated rate${svc}, quoted from their address`;
    default:
      return "eBay didn't say how postage is arranged on this listing";
  }
}

/**
 * Whether switching to this policy actually changes anything for the buyer.
 *
 * Used to warn before a relist that pays for nothing: ending a listing costs
 * its watchers and its search age, and doing that to arrive at the same postage
 * it already had is a bad trade the seller should get to reconsider.
 */
export function changesArrangement(
  current: CurrentArrangement,
  choice: ShippingChoice,
  policies: ShippingPolicyOption[]
): boolean {
  if (choice.kind === "keep") return false;
  const picked = policies.find((p) => p.id === choice.id);
  if (!picked) return true; // unknown policy — assume it differs rather than reassure
  if (current === "unknown") return true;
  // Compare all THREE kinds, not just free-vs-paid. The earlier version folded
  // flat and calculated together, so moving a calculated listing onto a
  // flat-rate policy — the single most common reason to open this panel — was
  // reported as "wouldn't change anything about postage". It changes plenty.
  const currentKind: PolicyKind =
    current === "free" ? "free" : current === "flat" ? "flat" : "calculated";
  return policyKind(picked) !== currentKind;
}

export interface ShippingChoiceCheck {
  ok: boolean;
  error?: string;
  /** Present and safe to send when ok. Absent means "don't write the policy". */
  fulfillmentPolicyId?: string;
}

/**
 * Validate a choice against the policies the account really has.
 *
 * A policy id that isn't in the seller's own list is refused rather than sent.
 * eBay would reject it anyway — but by then the listing is already ended, and
 * the failure lands in the worst possible place.
 */
export function validateShippingChoice(
  choice: ShippingChoice,
  policies: ShippingPolicyOption[]
): ShippingChoiceCheck {
  if (choice.kind === "keep") return { ok: true };
  const id = String(choice.id ?? "").trim();
  if (!id) return { ok: true };
  if (!policies.some((p) => p.id === id)) {
    return {
      ok: false,
      error:
        "That shipping policy isn't on your eBay account any more. Reload the page and pick again.",
    };
  }
  return { ok: true, fulfillmentPolicyId: id };
}

/**
 * What the seller keeps at a given price under a given arrangement.
 *
 * The reason anyone changes this. Free shipping lowers eBay's fee — the fee is
 * charged on the order total, and a free-shipping order total is smaller — but
 * you pay the postage out of the sale price, which almost always costs more
 * than the fee saved. Seeing both numbers is what turns "should I offer free
 * shipping?" from a vibe into arithmetic.
 *
 * Postage is the seller's own estimate; when it isn't known, this says so
 * rather than quietly reporting the fee saving as if it were profit.
 */
export function netUnder(
  price: number,
  free: boolean,
  postage: number | null,
  fee: (orderTotal: number) => number
): { net: number | null; note: string } {
  if (!Number.isFinite(price) || price <= 0) {
    return { net: null, note: "Set a price to compare." };
  }
  if (free) {
    if (postage === null) {
      return {
        net: null,
        note: "You'd pay the postage, and this listing has no weight recorded to estimate it.",
      };
    }
    return {
      net: round2(price - fee(price) - postage),
      note: `Buyer pays $${price.toFixed(2)}. You pay ~$${postage.toFixed(2)} postage.`,
    };
  }
  // Buyer-paid: eBay charges its fee on price + postage, and the postage passes
  // straight through to the carrier, so it cancels out of the seller's pocket.
  if (postage === null) {
    return {
      net: round2(price - fee(price)),
      note: "Buyer pays postage on top, and eBay's fee applies to that too.",
    };
  }
  return {
    net: round2(price - fee(price + postage)),
    note: `Buyer pays $${price.toFixed(2)} + ~$${postage.toFixed(2)} postage.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
