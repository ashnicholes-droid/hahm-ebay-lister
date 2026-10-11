import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { previewClothingShippingPolicies } from "@/lib/ebay/clothing-shipping-sync";
import { requireEbayAccessToken } from "@/lib/ebay/route-access";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { workMode?: "store" | "client"; clientId?: string | null };
  try {
    body = (await req.json()) as { workMode?: "store" | "client"; clientId?: string | null };
  } catch {
    body = {};
  }

  const token = await requireEbayAccessToken(req, body);
  if (token instanceof NextResponse) return token;

  try {
    const preview = await previewClothingShippingPolicies(token);
    return NextResponse.json(preview);
  } catch (error) {
    console.error("[ebay/shipping-policy] preview", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        ok: false,
        dryRun: true,
        error: error instanceof Error ? error.message : "No se pudo revisar los listings.",
      },
      { status: 422 }
    );
  }
}
