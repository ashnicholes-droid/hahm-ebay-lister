// Writing the seller-only note on a live listing.
//
// This app has no database, and adding one to store a single number per listing
// would be the wrong trade. eBay already keeps a private note per item — visible
// only to the seller who wrote it, returned by GetMyeBaySelling when asked, and
// carried by the listing itself. Cost basis lives there (see lib/costBasis.ts
// for the encoding), which means it survives this app, syncs across devices for
// free, and is readable in Seller Hub if this app ever goes away.
//
// SetUserNotes is a Trading call. It takes the whole note, so writing a cost
// means reading the current note first and merging — never blind-overwriting
// something the seller typed.

import { EBAY_TRADING } from "./config";
import { TradingApiError } from "./listings";
import { escapeXml, tradingAck } from "./xml";
import { MAX_NOTE_LENGTH } from "@/lib/costBasis";

/**
 * Replace the private note on one listing.
 *
 * An empty note is a delete, which is what eBay's Action=Delete is for; sending
 * an empty <NoteText> with Action=AddOrUpdate is rejected.
 */
export async function setUserNotes(
  accessToken: string,
  itemId: string,
  note: string
): Promise<{ ok: true; warnings: string[] }> {
  const text = note.trim().slice(0, MAX_NOTE_LENGTH);
  const action = text ? "AddOrUpdate" : "Delete";

  const body = `<?xml version="1.0" encoding="utf-8"?>
<SetUserNotesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Action>${action}</Action>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <NoteText>${escapeXml(text)}</NoteText>
</SetUserNotesRequest>`;

  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": "SetUserNotes",
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "Content-Type": "text/xml",
    },
    body,
  });

  const xml = await resp.text();
  const ack = tradingAck(xml);
  if (!ack.ok) {
    const first = ack.errors[0];
    throw new TradingApiError(
      first?.message || `eBay returned ${ack.ack} (HTTP ${resp.status}).`,
      first?.code || String(resp.status)
    );
  }

  return {
    ok: true,
    warnings: ack.ack === "Warning" ? ack.errors.map((e) => e.message) : [],
  };
}
