import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { researchListing } from "@/lib/services/research";
export const maxDuration = 30;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return researchListing(await req.json().catch(() => ({})));
}
