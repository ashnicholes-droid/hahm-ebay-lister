import { NextRequest, NextResponse } from "next/server";
import { secretEqual } from "@/lib/secret";
import type { InboundEmail } from "@/lib/vinted/email";
import { handleVintedSaleEmail } from "@/lib/vinted/handle-inbound";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TEXT_LIMIT = 100_000;

interface HeaderField {
  Name?: string;
  Value?: string;
}

interface InboundPayload {
  messageId?: unknown;
  MessageID?: unknown;
  from?: unknown;
  From?: unknown;
  subject?: unknown;
  Subject?: unknown;
  text?: unknown;
  TextBody?: unknown;
  html?: unknown;
  HtmlBody?: unknown;
  date?: unknown;
  Date?: unknown;
  dryRun?: unknown;
  Headers?: HeaderField[];
}

function configuredSecret(): string {
  return process.env.VINTED_INBOUND_SECRET?.trim() ?? "";
}

function authorized(req: NextRequest, secret: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const preserved = (req.headers.get("x-cron-secret") ?? "").trim();
  if (bearer && secretEqual(bearer, secret)) return true;
  return Boolean(preserved) && secretEqual(preserved, secret);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "";
}

function headerValue(headers: HeaderField[] | undefined, name: string): string {
  const found = headers?.find((header) => header.Name?.toLowerCase() === name.toLowerCase());
  return found?.Value?.trim() ?? "";
}

function emailFromPayload(payload: InboundPayload): InboundEmail {
  return {
    from: asText(payload.from) || asText(payload.From),
    subject: asText(payload.subject) || asText(payload.Subject),
    text: asText(payload.text) || asText(payload.TextBody),
    html: asText(payload.html) || asText(payload.HtmlBody),
    messageId: (asText(payload.messageId) || asText(payload.MessageID) || headerValue(payload.Headers, "Message-ID")).trim(),
    date: (asText(payload.date) || asText(payload.Date)).trim(),
  };
}

export async function POST(req: NextRequest) {
  const secret = configuredSecret();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Inbound email is not configured." }, { status: 503 });
  }
  if (!authorized(req, secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const dryRun = payload.dryRun === true || payload.dryRun === "true";
  try {
    const result = await handleVintedSaleEmail(emailFromPayload(payload), { dryRun });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (error) {
    console.error("[vinted/inbound]", error instanceof Error ? error.name : "Error");
    return NextResponse.json({ ok: false, error: "Could not process the email." }, { status: 500 });
  }
}
