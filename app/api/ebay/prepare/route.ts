import { categoryMatches, expectedDepartment } from "@/lib/category-selection";
import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import {
  parseListing,
  imagesSchema,
  validationMessage,
} from "@/lib/validation";
import {
  categoryAspects,
  suggestLeafCategories,
  acceptedConditionIds,
} from "@/lib/ebay/taxonomy";
import {
  buildAspects,
  reconcileAspects,
  CONDITION_ID_ENUM,
} from "@/lib/ebay/publish";
import { enforceCardinality, sanitizeNumericAspects } from "@/lib/ebay/aspects";
import { fillRecommendedAspects } from "@/lib/ebay/aspectFill";
import { validateAspects } from "@/lib/ebay/draft";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { signReview } from "@/lib/review";
import { withDeadline } from "@/lib/network";
import { collectUsage, currentUsage } from "@/lib/ai-usage";
export const maxDuration = 180;
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return (
    await collectUsage(() =>
      withDeadline(150_000, async () => {
        try {
          const body = await req.json();
          const listing = parseListing(body.listing);
          const images =
            body.enrich === true ? imagesSchema.parse(body.images) : [];
          const suggestions = listing.category_id
            ? []
            : await suggestLeafCategories(
                `${expectedDepartment(listing)} ${listing.category_hint || ""} ${listing.title}`,
                10,
              );
          const compatible = suggestions.filter((c) =>
            categoryMatches(c, listing),
          );
          const id = listing.category_id || compatible[0]?.id;
          if (!id)
            throw new Error(
              "Could not resolve a category matching this department. Review the department/category and enter the correct leaf category ID.",
            );
          const token = await accessTokenFromCookie(
            req.cookies.get(EBAY_COOKIE)?.value,
          );
          const [meta, ids] = await Promise.all([
            categoryAspects(id),
            acceptedConditionIds(id, token ?? undefined),
          ]);
          if (!meta.length || !ids.size)
            throw new Error(
              "Category specifics or conditions could not be loaded. Connect eBay and retry.",
            );
          const departmentMeta = meta.find((a) => a.name === "Department");
          const expected = expectedDepartment(listing);
          if (
            expected &&
            departmentMeta?.mode === "SELECTION_ONLY" &&
            !departmentMeta.values.includes(expected)
          )
            throw new Error(
              `This category does not accept Department ${expected}. Choose the correct category.`,
            );
          const aspects = buildAspects(listing, listing.category || "");
          reconcileAspects(aspects, meta, listing, listing.category || "");
          if (body.enrich === true)
            await fillRecommendedAspects(
              listing,
              aspects,
              meta,
              "draft",
              images,
            );
          enforceCardinality(aspects, meta);
          sanitizeNumericAspects(aspects, meta);
          const conditions = [...ids]
            .filter((id) => CONDITION_ID_ENUM[id])
            .map((id) => ({
              value: CONDITION_ID_ENUM[id],
              label: `${CONDITION_ID_ENUM[id].replace(/_/g, " ")} (${id})`,
            }));
          if (ids.has(2990) || ids.has(3010)) {
            const c = conditions.find(
              (c) => c.value === CONDITION_ID_ENUM[3000],
            );
            if (c) c.label = "Pre-owned Good (3000)";
          }
          listing.category_id = id;
          listing.item_specifics = Object.fromEntries(
            Object.entries(aspects).map(([k, v]) => [k, v.join(" | ")]),
          );
          // Cosmetic AI grades cannot establish the seller's sale condition.
          if (!conditions.some((c) => c.value === listing.ebay_condition))
            listing.ebay_condition = "";
          const expiresAt = Date.now() + 23 * 3600_000;
          return NextResponse.json({
            ok: true,
            listing,
            preparation: {
              categoryId: id,
              categoryName:
                suggestions.find((c) => c.id === id)?.path || `Category ${id}`,
              suggestions: compatible,
              aspects: meta,
              conditions,
              expiresAt,
              signature: signReview(id, expiresAt),
              issues: validateAspects(aspects, meta),
            },
            usage: currentUsage(),
          });
        } catch (e) {
          return NextResponse.json(
            { ok: false, error: validationMessage(e), usage: currentUsage() },
            { status: 422 },
          );
        }
      }),
    )
  ).result;
}
