import { NextRequest, NextResponse } from "next/server";
import { ebayConnectionKey, getEbayConnection } from "@/lib/ebay/client-connections";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";

export async function requireEbayAccessToken(
  req: NextRequest,
  body: { workMode?: "store" | "client"; clientId?: string | null }
): Promise<string | NextResponse> {
  const workMode = body.workMode ?? "store";
  let sealed: string | null | undefined;
  if (workMode === "client") {
    const connectionKey = ebayConnectionKey("client", body.clientId ?? null);
    if (!connectionKey) {
      return NextResponse.json(
        { ok: false, error: "Selecciona un cliente antes de continuar." },
        { status: 400 }
      );
    }
    sealed = await getEbayConnection(connectionKey);
    if (!sealed) {
      return NextResponse.json(
        { ok: false, error: "Ese cliente no está conectado a eBay." },
        { status: 401 }
      );
    }
  } else {
    sealed = req.cookies.get(EBAY_COOKIE)?.value;
  }
  const token = await accessTokenFromCookie(sealed);
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "eBay no está conectado. Conecta la cuenta y vuelve a intentar." },
      { status: 401 }
    );
  }
  return token;
}
