import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { analyzePhotos } from "@/lib/services/analyze";
export const maxDuration = 300;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return analyzePhotos(await req.json().catch(() => null));
}
