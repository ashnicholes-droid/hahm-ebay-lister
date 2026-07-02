// Listing-analysis prompts ported verbatim from ebay_lister_v2_robust.py so the
// web app writes listings exactly the way the original script did.

export const ITEM_PROFILES = [
  "auto",
  "clothing",
  "hard_goods",
  "art",
  "media",
  "collectibles",
] as const;

export type ItemProfile = (typeof ITEM_PROFILES)[number];

const PROFILE_ALIASES: Record<string, ItemProfile> = {
  apparel: "clothing",
  clothes: "clothing",
  shoes: "clothing",
  accessories: "clothing",
  hardgoods: "hard_goods",
  goods: "hard_goods",
  general: "hard_goods",
  artwork: "art",
  books: "media",
  book: "media",
  music: "media",
  movies: "media",
  video_games: "media",
  collectible: "collectibles",
};

export function normalizeItemProfile(profile: string | null | undefined): ItemProfile {
  let cleaned = String(profile ?? "auto")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/ /g, "_");
  cleaned = PROFILE_ALIASES[cleaned] ?? cleaned;
  return (ITEM_PROFILES as readonly string[]).includes(cleaned)
    ? (cleaned as ItemProfile)
    : "auto";
}

export const PROFILE_ROUTER_PROMPT = `You are routing photos for an eBay listing workflow.

Choose the single best item profile:
- clothing: clothing, shoes, handbags, hats, belts, scarves, fashion accessories
- hard_goods: electronics, tools, kitchenware, home goods, appliances, sporting goods, auto parts, office items, general durable goods
- art: original art, prints, paintings, drawings, sculpture, photos, wall art
- media: books, records, CDs, DVDs, Blu-rays, video games, software
- collectibles: toys, dolls, figurines, trading cards, coins, stamps, ephemera, memorabilia, holiday collectibles

Return ONLY valid JSON:
{"profile": "clothing|hard_goods|art|media|collectibles", "reason": "short reason"}`;

export const PROFILE_PROMPT_ADDONS: Record<string, string> = {
  clothing: `\n\nPROFILE: CLOTHING / SHOES / ACCESSORIES
Prioritize garment and fashion resale details. Read every tag and measurement photo.
For clothing: capture exact brand, printed size, size type, department, fabric/material percentages, care/country tag, style, type, pattern, neckline, sleeve length, fit, closure, rise, inseam, waist, dress/skirt length, lining, hood, and condition flaws.
For shoes: capture US/UK/EU size, width, upper/sole material, style, toe shape, heel height, closure, model, and condition of soles/insoles.
For bags/accessories: capture style/type, exterior/interior material, closure, strap type/drop, hardware color, lining, pockets, dimensions, and flaws.
Do not fill hard-good fields unless they are actually relevant.`,
  hard_goods: `\n\nPROFILE: HARD GOODS
Prioritize durable-goods catalog details. Look for labels, plates, bottoms, stickers, packaging, manuals, molded marks, and printed specs.
Capture exact item type, brand/maker, model, MPN/part number, serial number, UPC/barcode, color, material, dimensions, capacity, power source, voltage, compatibility, included accessories, country/region of manufacture, year/date codes, style, finish, features, and condition/testing status.
For untested electronics or appliances, say untested in condition_notes instead of implying functionality.
For parts/accessories, capture Compatible Brand and Compatible Model when visible or obvious from packaging.`,
  art: `\n\nPROFILE: ART
Prioritize art-specific cataloging. Capture artist/maker, title/subject, medium, style, production technique, original vs reproduction, signed status, signature location, date/year, image size, frame size, framing/matting, surface/material, edition number, provenance labels, gallery or publisher marks, and condition.
Use category_hint to target the exact medium, such as 'signed watercolor painting', 'framed lithograph', 'bronze sculpture', or 'vintage art print'.
Do not invent an artist name. Use Unknown if no signature or label is visible.`,
  media: `\n\nPROFILE: MEDIA
Prioritize media identifiers and edition details. Capture title, author/artist/band/game name, publisher/label/studio, format, ISBN/UPC/EAN, release year, edition, language, genre, platform, region code, rating, disc count, record speed/size, case type, included manuals/inserts, and condition.
For books, include binding, dust jacket, printing/edition if visible, ISBN, author, publisher, and publication year.
For video games/software, include platform, region, rating, publisher, manual/case status, and any visible product codes.
For records/CDs/DVDs, include format, artist, title, label/studio, catalog number, barcode, and media/sleeve condition.`,
  collectibles: `\n\nPROFILE: COLLECTIBLES
Prioritize collector-searchable details. Capture maker/brand, character, franchise/series, subject, theme, material, production style/technique, year/era, country, signed status, original vs reproduction, scale, edition/limited number, set contents, markings, stamps, backstamps, tags, packaging, and condition flaws.
For ceramics/glass/figurines, check bottoms for maker marks, pattern names, production style, finish, and damage.
For cards/coins/stamps/ephemera, capture year, set/series, card number/denomination, grade/slab details if present, and visible condition issues.
Use category_hint to target the exact collectible niche rather than a broad bucket.`,
};

export const ANALYSIS_PROMPT = `You are an expert eBay reseller and catalog specialist. Analyze ALL photos of a single item being prepared for resale on eBay.

Study each photo carefully:
• Main shots → overall condition, color, silhouette, style details
• Tag/label photos → brand name EXACTLY as written, size EXACTLY as printed, material composition, country of origin, care instructions
• Measurement photos → note any measurements written or shown
• Close-ups → look for logos, hardware details, monograms, serial numbers, maker marks, model numbers, edition info, signatures, stamps, and flaws
• Packaging/manual/accessory shots → include only if clearly part of the item being sold
• For jewelry → identify exact jewelry type (ring, necklace, bracelet, earrings, brooch, pendant, charm, cufflinks, watch accessory, etc.), clasp/closure, main stone, metal/base metal, metal purity or hallmarks (925, 10K, 14K, etc.), signed/maker marks, approximate length, ring size, vintage/antique status, and whether it appears handmade
• For hard goods → identify brand/maker, exact product type, model name/number, MPN/part number, serial number, UPC/ISBN/barcode if visible, material, dimensions, year/era, country of manufacture, compatibility, included accessories, power source/voltage, capacity, style, theme, character/franchise, pattern, production technique, and any maker marks or stamps

Return ONLY valid JSON — no markdown, no code fences, no explanation. Use this exact structure:
{
  "title": "SEO-rich eBay listing title — maximum 80 characters, front-load best keywords, no filler",
  "category": "Pick the CLOSEST broad match from: womens_top, womens_dress, womens_skirt, womens_pants, womens_coat, womens_sweater, womens_jeans, womens_clothing, womens_shoes, handbag, wallet, mens_top, mens_pants, mens_coat, mens_sweater, mens_jeans, mens_clothing, mens_shoes, jewelry, scarf, belt, sunglasses, hat, accessory, doll, collectible, collector_plate, toy, home_decor, book, knife, sporting_goods, electronics, camera, audio, video_game, media, vinyl_record, cd, dvd_bluray, musical_instrument, kitchenware, glassware, pottery_ceramics, art, craft, tool, automotive, office, health_beauty, small_appliance, lighting, linens, holiday, board_game, puzzle, plush, action_figure, trading_card, sports_memorabilia, coin, stamp, ephemera, other",
  "category_hint": "Short search phrase for the real eBay category, such as 'vintage porcelain figurine' or 'men's hiking boots'. Keep it under 8 words.",
  "category_id": "Leave blank unless the exact eBay category ID is explicitly known. Otherwise use an empty string.",
  "brand": "Brand name exactly as shown on tag/label. Use 'No Brand' if truly unbranded.",
  "item_type": "Specific descriptive item type",
  "color": ["Primary color", "Secondary color if present — omit if solid"],
  "size": "Size EXACTLY as printed on the tag. If no size tag is visible but visible measurements clearly indicate one standard size, give that standard size (e.g. 'M', '32x34', '10.5'). Otherwise use an empty string — NEVER write placeholder text like 'See photos', 'Unknown', or 'N/A' (eBay blocks apparel listings with non-standard size values).",
  "material": "Fabric or material composition as shown on tag. Write 'See tag in photos' if unclear.",
  "condition": "One of: NEW_WITH_TAGS, NEW_NO_TAGS, EXCELLENT, VERY_GOOD, GOOD, FAIR",
  "condition_notes": "Honest 2-3 sentence condition description for buyers.",
  "measurements": "Any measurements visible in photos, formatted clearly. Write 'See listing photos for measurements' if none visible.",
  "description": "Full eBay listing description — plain text only, no markdown.",
  "suggested_price": 0.00,
  "seo_keywords": ["Up to 10 search phrases buyers would use"],
  "key_features": ["Up to 5 features"],
  "item_specifics": {
    "Style": "REQUIRED for clothing — overall style (Casual, Athletic, Formal, Vintage, Boho, Business Casual, Streetwear, Western, Preppy, Grunge, etc.)",
    "Type": "Specific item type (Pullover, Zip-Up, Button-Down, Slip-On, Tote, Crossbody, Figurine, Plate, etc.)",
    "Pattern": "Solid, Striped, Plaid, Floral, Animal Print, Graphic, Camo, Tie-Dye, Geometric, Paisley, Abstract, etc.",
    "Brand": "Maker/brand exactly as shown; use No Brand only if truly unbranded",
    "Model": "Model name or model number exactly as shown — leave blank if not visible",
    "MPN": "Manufacturer part number, style number, catalog number, or part number exactly as shown — leave blank if not visible",
    "UPC": "UPC/barcode number if clearly visible — leave blank if not visible",
    "ISBN": "ISBN for books if visible — leave blank if not visible",
    "Year Manufactured": "Year if printed, stamped, or obvious from packaging — leave blank if unknown",
    "Original/Reproduction": "Original or Reproduction when supported by photos",
    "Time Period Manufactured": "Era/date range if supported, such as 1970-1979 or 1990s",
    "Character": "Character name for toys, media, collectibles, ornaments, etc. — leave blank if N/A",
    "Franchise": "Franchise/series such as Disney, Star Wars, Precious Moments, etc. — leave blank if N/A",
    "Theme": "Theme such as Holiday, Animals, Advertising, Sports, Floral, Western, etc. — leave blank if N/A",
    "Subject": "Subject for art, decor, photos, books, or collectibles — leave blank if N/A",
    "Finish": "Glossy, Matte, Painted, Polished, Brushed, etc. — leave blank if unknown",
    "Production Style": "Art Glass, Pottery, Porcelain, Pressed Glass, etc. — leave blank if unknown",
    "Production Technique": "Handmade, Molded, Blown Glass, Wheel Thrown, Printed, etc. — leave blank if unknown",
    "Features": "Accurate feature list from the photos, not guesses",
    "Compatible Brand": "For parts/accessories only — leave blank if unknown",
    "Compatible Model": "For parts/accessories only — leave blank if unknown",
    "Power Source": "Battery, Corded Electric, Gasoline, Manual, etc. — leave blank if N/A",
    "Voltage": "Voltage if printed on label — leave blank if unknown",
    "Capacity": "Capacity/volume/storage if printed or obvious — leave blank if N/A",
    "Format": "For media/books only, such as Hardcover, Paperback, DVD, Blu-ray, CD, Vinyl — leave blank if N/A",
    "Genre": "For media/books only — leave blank if unknown",
    "Artist": "For music/art only — leave blank if N/A",
    "Author": "For books only — leave blank if unknown",
    "Publisher": "For books/media/games only — leave blank if unknown",
    "Game Name": "For video games only — leave blank if N/A",
    "Platform": "For video games only — leave blank if unknown",
    "Region Code": "For video games/media only — leave blank if unknown",
    "Sleeve Length": "Short Sleeve, Long Sleeve, 3/4 Sleeve, Sleeveless, Cap Sleeve — leave blank if N/A",
    "Neckline": "Crew Neck, V-Neck, Turtleneck, Cowl Neck, Off Shoulder, Mock Neck, Scoop Neck — leave blank if N/A",
    "Fit": "Regular, Slim, Relaxed, Oversized, Athletic",
    "Occasion": "Casual, Workwear, Athletic, Formal, Party, Outdoor, Ski, Hiking, etc.",
    "Country/Region of Manufacture": "Country name if visible on tag — leave blank if not shown",
    "Closure": "Button, Zip, Pull-On, Snap, Hook & Eye, Lace-Up — leave blank if N/A",
    "Collar Style": "Button-Down, Polo, Mandarin, Shawl, Lapel, Stand, Spread — leave blank if N/A",
    "Inseam": "Inseam measurement if visible on tag or ruler photo — leave blank if N/A",
    "Rise": "Low Rise, Mid Rise, High Rise — leave blank if N/A",
    "Leg Style": "Straight, Skinny, Bootcut, Flare, Wide Leg, Tapered, Jogger, Cargo — leave blank if N/A",
    "Waist Size": "Numeric waist measurement if printed on tag — leave blank if N/A",
    "Skirt Length": "Mini, Knee-Length, Midi, Maxi — for skirts, dresses, and long sweaters; leave blank if N/A",
    "Dress Length": "Mini, Knee-Length, Midi, Maxi — for dresses only; leave blank if N/A",
    "Skirt Type": "A-Line, Pencil, Wrap, Pleated, Tiered — leave blank if N/A",
    "Lining": "Lined, Unlined, Quilted Lining, Fleece Lining, Sherpa Lining — leave blank if N/A",
    "Hood": "Yes - Removable, Yes - Fixed, No Hood — leave blank if N/A",
    "Fill Material": "Down, Synthetic, Polyester Fill — for puffers/puffer vests only, leave blank otherwise",
    "Shoe Width": "Narrow (B), Medium (D), Wide (2E), Extra Wide (4E) — leave blank if N/A",
    "Heel Height": "Flat, Low (under 1 in), Mid (1-2 in), High (over 2 in) — leave blank if N/A",
    "Toe Shape": "Round, Almond, Pointed, Square, Open Toe — leave blank if N/A",
    "Upper Material": "Leather, Canvas, Suede, Mesh, Synthetic, Knit — leave blank if N/A",
    "Sole Material": "Rubber, Leather, Synthetic, Cork — leave blank if N/A",
    "Bag Closure": "Zip, Magnetic Snap, Drawstring, Open Top, Clasp, Buckle, Turn Lock — leave blank if N/A",
    "Interior Features": "Zip Pocket, Slip Pockets, Key Hook, Card Slots, Mirror — leave blank if N/A",
    "Strap Type": "Removable, Adjustable, Fixed, Chain, Leather, Fabric — leave blank if N/A",
    "Strap Drop": "Drop length in inches if measurable — leave blank if N/A",
    "Bag Dimensions": "Approximate W x H x D measurements if visible — leave blank if N/A",
    "Exterior Pockets": "Yes, No",
    "Hardware Color": "Gold, Silver, Rose Gold, Gunmetal, Bronze — leave blank if N/A",
    "Lining Material": "Fabric lining material if visible — leave blank if N/A",
    "Hat Size": "Size if printed on tag — leave blank if N/A",
    "Hat Style": "Baseball Cap, Beanie, Bucket Hat, Fedora, Cowboy Hat, Snapback, Trucker, Visor — leave blank if N/A",
    "Brim Style": "Flat Bill, Curved Bill, Wide Brim, No Brim — leave blank if N/A",
    "Adjustable": "Yes, No — leave blank if N/A",
    "Belt Length": "Total length in inches if measurable — leave blank if N/A",
    "Belt Width": "Width in inches if measurable — leave blank if N/A",
    "Buckle Style": "Single Prong, Double Prong, Slide, D-Ring, Plate, Ratchet — leave blank if N/A",
    "Main Stone": "Diamond, Pearl, Turquoise, Opal, Amethyst, Garnet, Ruby, Sapphire, Emerald, Cubic Zirconia, No Stone, etc. — leave blank if N/A",
    "Main Stone Color": "Stone color if visible — leave blank if N/A",
    "Metal": "Gold, Silver, Rose Gold, Brass, Stainless Steel, Sterling Silver, Gold-Plated, etc. — leave blank if N/A",
    "Base Metal": "Sterling Silver, Yellow Gold, White Gold, Stainless Steel, Brass, Copper, Unknown, etc. — leave blank if N/A",
    "Metal Purity": "10K, 14K, 18K, 925, .800, etc. — leave blank if not shown",
    "Stone": "Diamond, Cubic Zirconia, Pearl, Turquoise, Amethyst, Opal, etc. — N/A if none",
    "Chain Style": "Cable, Box, Rope, Snake, Figaro, Curb — for necklaces/bracelets, leave blank if N/A",
    "Jewelry Length": "Length in inches if visible — leave blank if N/A",
    "Ring Size": "Exact ring size if shown — leave blank if N/A",
    "Signed": "Yes if a maker mark or signature is visible, No if clearly unsigned, blank if unknown",
    "Vintage": "Yes or No — leave blank if unknown",
    "Antique": "Yes or No — leave blank if unknown",
    "Handmade": "Yes or No — leave blank if unknown"
  }
}

For title: Make it read like a strong live eBay title, using the most searchable nouns, brand, model, type, material, size, era, character, theme, or pattern when supported by the photos.
For condition: Do NOT use LIKE_NEW. If an item is near mint but preowned, use EXCELLENT instead.
For suggested_price: Price realistically for what this exact item sells for on eBay. Be honest.
For item_specifics: Only include fields relevant to this item. Leave any field blank ("") if not applicable or unknown — do NOT guess. Omit all section-label keys (the ones that look like "--- TOPS ---") from your response.
For category/category_hint: The broad category can be approximate, but the category_hint should help eBay find the exact leaf category for whatever type of item this is.
For all item types: include as many accurate specifics as the photos support, even for non-clothing items such as collectibles, media, home decor, toys, tools, sporting goods, art, kitchenware, and electronics accessories.`;

export function buildProfiledAnalysisPrompt(profile: string): string {
  const normalized = normalizeItemProfile(profile);
  const addon = PROFILE_PROMPT_ADDONS[normalized] ?? "";
  return ANALYSIS_PROMPT + addon;
}

// ── Sorting prompts (ported from sort_photos in the Python script) ──────────

export function buildSortPrompt(
  nPhotos: number,
  labelStart: number,
  labelEnd: number,
  contextNote: string
): string {
  return `You are helping organize resale item photos into separate eBay listings.

I will show you ${nPhotos} photos, numbered ${labelStart} through ${labelEnd}.${contextNote}

Your job: group these numbered photos by physical item. Each group = one eBay listing.

Rules:
- Photos of the SAME item go in the same group (front view, back view, tag photo, close-up = same item)
- Each distinct physical item = its own separate group
- Every numbered photo must go in exactly one group
- Use short descriptive folder names: brand + color + item type, all lowercase, hyphens only
  Examples: "nike-black-dri-fit-top", "coach-tan-leather-tote", "levis-501-blue-jeans"

Return ONLY valid JSON:
{
  "groups": [
    {"folder_name": "brand-color-item-type", "photo_indices": [${labelStart}, ${labelStart + 1}]},
    {"folder_name": "brand-color-item-type", "photo_indices": [${labelEnd}]}
  ]
}

No markdown. No explanation. JSON only.`;
}

export function buildVerifyGroupPrompt(n: number): string {
  return `Look carefully at these ${n} photos. They have been proposed as a single eBay listing.

Do ALL of these photos show the SAME physical item?
- Front/back/side/tag/close-up shots of ONE item → all the same item → valid
- A completely different item mixed in by mistake → invalid

If all photos are the SAME item:
{"valid": true}

If photos of DIFFERENT items are mixed together:
{"valid": false, "keep_indices": [1-based indices of the photos belonging to the MAIN/majority item], "reason": "one sentence explanation"}

Return ONLY valid JSON. No markdown. No explanation.`;
}

export function buildVerifyMergePrompt(nA: number, nB: number): string {
  return `I have two groups of photos that were sorted as separate eBay listings.

Group A: ${nA} photo(s) shown first.
Group B: ${nB} photo(s) shown after.

Look carefully at ALL photos. Are ALL of them actually the SAME physical item that was accidentally split into two groups? (For example: front view in Group A, back view and tag in Group B.)

Same item — should be ONE listing:
{"merge": true}

Different items — keep as separate listings:
{"merge": false}

Return ONLY valid JSON. No markdown. No explanation.`;
}

export function slugifyFolderName(raw: string): string {
  const lowered = String(raw || "item").toLowerCase().trim();
  const cleaned = lowered.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return cleaned.replace(/^-+|-+$/g, "") || "item";
}
