import { expect, it } from "vitest";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import { shippingSchema } from "@/lib/validation";
const options = {
  fulfillment: [
    { id: "usual", name: "USPS Ground Advantage ($7.95), 2 day handling" },
    { id: "heavy", name: "Heavy shipping" },
  ],
  payment: [{ id: "payment", name: "Managed Payments" }],
  returns: [
    { id: "return", name: "Returns Accepted,Seller,30 Days,Money Back#1" },
  ],
  locations: [{ id: "origin", name: "Hustle at Home Mom HQ · 84095 · US" }],
};
it("uses verified account IDs for the requested defaults, without overwriting overrides", () => {
  const defaults = applyShippingDefaults({}, options);
  expect(defaults).toEqual({
    fulfillmentPolicyId: "usual",
    paymentPolicyId: "payment",
    returnPolicyId: "return",
    locationKey: "origin",
  });
  expect(
    applyShippingDefaults({ fulfillmentPolicyId: "heavy" }, options)
      .fulfillmentPolicyId,
  ).toBe("heavy");
  expect(
    applyShippingDefaults({}, { ...options, fulfillment: [] }),
  ).not.toHaveProperty("fulfillmentPolicyId");
});
it("allows absent measurements and rejects partial or invalid provided measurements", () => {
  const defaults = applyShippingDefaults({}, options);
  expect(shippingSchema.safeParse(defaults).success).toBe(true);
  expect(shippingSchema.safeParse({ ...defaults, weightOz: 0 }).success).toBe(
    false,
  );
  expect(shippingSchema.safeParse({ ...defaults, lengthIn: 10 }).success).toBe(
    false,
  );
  expect(shippingSchema.safeParse({ ...defaults, weightOz: 8 }).success).toBe(
    true,
  );
});
