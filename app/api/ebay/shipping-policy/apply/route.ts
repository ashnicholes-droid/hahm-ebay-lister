import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { SHIPPING_POLICY_APPLY_BATCH } from "@/lib/ebay/clothing-shipping-policy";
import { applyClothingShippingPolicy } from "@/lib/ebay/clothing-shipping-sync";
import { requireEbayAccessToken } from "@/lib/ebay/route-access";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { workMode?: "store" | "client"; clientId?: string | null; itemIds?: unknown };
  try {
    body = (await req.json()) as {
      workMode?: "store" | "client";
      clientId?: string | null;
      itemIds?: unknown;
    };
  } catch {
    return NextResponse.json({ ok: false, error: "Solicitud inválida." }, { status: 400 });
  }

  const itemIds = Array.isArray(body.itemIds)
    ? body.itemIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!itemIds.length) {
    return NextResponse.json({ ok: false, error: "No hay listings para actualizar." }, { status: 400 });
  }
  if (itemIds.length > SHIPPING_POLICY_APPLY_BATCH) {
    return NextResponse.json(
      { ok: false, error: `Envía como máximo ${SHIPPING_POLICY_APPLY_BATCH} listings por lote.` },
      { status: 400 }
    );
  }

  const token = await requireEbayAccessToken(req, body);
  if (token instanceof NextResponse) return token;

  try {
    const result = await applyClothingShippingPolicy(token, itemIds);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[ebay/shipping-policy] apply", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "No se pudo actualizar." },
      { status: 422 }
    );
  }
}
