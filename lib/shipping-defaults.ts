import type { AccountOptions } from "./ebay/publish";
import type { ShippingSelection } from "./validation";
const keys = {
  fulfillmentPolicyId: "fulfillment",
  paymentPolicyId: "payment",
  returnPolicyId: "returns",
  locationKey: "locations",
} as const;
const names = {
  fulfillmentPolicyId: "USPS Ground Advantage ($7.95), 2 day handling",
  paymentPolicyId: "Managed Payments",
  returnPolicyId: "Returns Accepted,Seller,30 Days,Money Back#1",
  locationKey: "Hustle at Home Mom HQ",
};
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export function applyShippingDefaults(
  current: Partial<ShippingSelection>,
  options: AccountOptions,
): Partial<ShippingSelection> {
  const next = { ...current };
  for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
    if (next[key]) continue;
    const matches = options[keys[key]].filter((o) =>
      key === "locationKey"
        ? normalize(o.name.split("·")[0]) === normalize(names[key])
        : normalize(o.name) === normalize(names[key]),
    );
    if (matches.length === 1) next[key] = matches[0].id;
  }
  return next;
}
