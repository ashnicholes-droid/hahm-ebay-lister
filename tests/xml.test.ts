import { describe, expect, it } from "vitest";
import {
  decodeXmlText,
  escapeXml,
  tradingAck,
  xmlBlocks,
  xmlNumber,
  xmlText,
  xmlTextAll,
} from "@/lib/ebay/xml";

describe("reading eBay's XML", () => {
  it("pulls a tag's text", () => {
    expect(xmlText("<a><ItemID>1234</ItemID></a>", "ItemID")).toBe("1234");
  });

  it("returns empty for a missing tag rather than throwing", () => {
    expect(xmlText("<a></a>", "ItemID")).toBe("");
  });

  it("handles a self-closing tag", () => {
    expect(xmlText("<a><Title/></a>", "Title")).toBe("");
  });

  it("ignores attributes on the opening tag", () => {
    expect(xmlText('<Amount currencyID="USD">45.00</Amount>', "Amount")).toBe("45.00");
  });

  it("unwraps CDATA, which eBay uses for titles", () => {
    const xml = "<Title><![CDATA[Lodge 12\" Skillet <Pre-Seasoned> & Ready]]></Title>";
    expect(xmlText(xml, "Title")).toBe('Lodge 12" Skillet <Pre-Seasoned> & Ready');
  });

  it("decodes the standard entities", () => {
    expect(decodeXmlText("Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;x&apos;")).toBe(
      `Tom & Jerry <3 "hi" 'x'`
    );
  });

  it("decodes numeric character references", () => {
    expect(decodeXmlText("caf&#233; &#x2014; bar")).toBe("café — bar");
  });

  it("does not confuse a tag with one that shares its prefix", () => {
    // ItemID vs ItemIDList: a sloppy pattern matches both.
    expect(xmlText("<ItemIDList>99</ItemIDList><ItemID>7</ItemID>", "ItemID")).toBe("7");
  });

  it("finds every repeated block", () => {
    const xml = "<Item><ItemID>1</ItemID></Item><Item><ItemID>2</ItemID></Item>";
    const blocks = xmlBlocks(xml, "Item");
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => xmlText(b, "ItemID"))).toEqual(["1", "2"]);
  });

  it("collects repeated values", () => {
    expect(xmlTextAll("<S>a</S><S>b</S>", "S")).toEqual(["a", "b"]);
  });
});

describe("numbers", () => {
  it("reads a plain number", () => {
    expect(xmlNumber("<WatchCount>12</WatchCount>", "WatchCount")).toBe(12);
  });

  it("reads a currency amount with its symbol stripped", () => {
    expect(xmlNumber('<Amount currencyID="USD">45.50</Amount>', "Amount")).toBe(45.5);
  });

  it("distinguishes absent from zero", () => {
    // "eBay didn't say" and "nobody is watching" are different facts, and
    // showing the second for the first is how a seller writes an item off.
    expect(xmlNumber("<a></a>", "WatchCount")).toBeNull();
    expect(xmlNumber("<WatchCount>0</WatchCount>", "WatchCount")).toBe(0);
  });

  it("returns null for something that isn't a number", () => {
    expect(xmlNumber("<WatchCount>lots</WatchCount>", "WatchCount")).toBeNull();
  });
});

describe("Trading acknowledgements", () => {
  it("accepts Success", () => {
    expect(tradingAck("<r><Ack>Success</Ack></r>").ok).toBe(true);
  });

  it("accepts Warning, which is a success with commentary", () => {
    // eBay returns Warning constantly for deprecated fields. Treating it as a
    // failure would break the whole view over a notice.
    const r = tradingAck("<r><Ack>Warning</Ack></r>");
    expect(r.ok).toBe(true);
  });

  it("rejects Failure and reports why", () => {
    const xml = `<r><Ack>Failure</Ack><Errors>
      <ShortMessage>Invalid token</ShortMessage>
      <LongMessage>The auth token is invalid or expired.</LongMessage>
      <ErrorCode>931</ErrorCode>
      <SeverityCode>Error</SeverityCode>
    </Errors></r>`;
    const r = tradingAck(xml);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toEqual({
      code: "931",
      message: "The auth token is invalid or expired.",
      severity: "Error",
    });
  });

  it("reports every error, not just the first", () => {
    const xml = `<r><Ack>Failure</Ack>
      <Errors><ErrorCode>1</ErrorCode><ShortMessage>a</ShortMessage></Errors>
      <Errors><ErrorCode>2</ErrorCode><ShortMessage>b</ShortMessage></Errors></r>`;
    expect(tradingAck(xml).errors.map((e) => e.code)).toEqual(["1", "2"]);
  });

  it("treats an unparseable body as a failure rather than a silent success", () => {
    expect(tradingAck("<html>502 Bad Gateway</html>").ok).toBe(false);
  });
});

describe("writing eBay's XML", () => {
  it("escapes everything that would break a request body", () => {
    expect(escapeXml(`Tom & Jerry <b>"x"</b> 'y'`)).toBe(
      "Tom &amp; Jerry &lt;b&gt;&quot;x&quot;&lt;/b&gt; &apos;y&apos;"
    );
  });

  it("round-trips through decode", () => {
    const original = `Lodge 12" Skillet <Pre-Seasoned> & Ready`;
    expect(decodeXmlText(escapeXml(original))).toBe(original);
  });
});
