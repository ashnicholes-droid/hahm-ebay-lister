// Which listings aren't working, and what to do about them.
//
// The seller view already fetches everything needed to answer this — age,
// impressions, views, watchers, quantity sold — and then showed it as four
// numbers per row and left the seller to scan two hundred of them. This turns
// the same data into a judgement.
//
// Every rule here is deliberately conservative. A listing wrongly called dead
// gets its price cut for no reason, which costs real money, so the thresholds
// favour saying nothing over saying something weak — and each verdict carries
// the evidence that produced it rather than a score the seller has to trust.

export interface TriageInput {
  startTime: string;
  impressions: number | null;
  views: number | null;
  watchCount: number | null;
  quantitySold: number | null;
}

export type TriageVerdict =
  /** Selling, or too new to judge. Nothing to do. */
  | "fine"
  /** Getting seen but not clicked — the photo, title or price is the problem. */
  | "poor-clickthrough"
  /** Being clicked but not bought, and people are watching. Price or offer. */
  | "watched-not-bought"
  /** Barely being shown at all — a search problem, not a price problem. */
  | "invisible"
  /** Old, seen, and nothing to show for it. */
  | "stale";

export interface Triage {
  verdict: TriageVerdict;
  /** Ordering weight; higher is more worth acting on. 0 for "fine". */
  priority: number;
  /** One sentence naming what's wrong. */
  headline: string;
  /** The numbers behind the verdict, so it can be checked rather than believed. */
  evidence: string;
  /** What to actually do, in the seller's terms. */
  suggestion: string;
}

/** Below this a listing hasn't had a fair run and is never judged. */
export const MIN_AGE_DAYS = 14;
/** Below this there isn't enough traffic to conclude anything. */
export const MIN_IMPRESSIONS = 150;
/** Impressions-to-views under this means the search result isn't tempting. */
export const WEAK_CTR = 0.01;
/** Old enough that "give it time" has stopped being advice. */
export const STALE_DAYS = 45;

export function ageInDays(startTime: string, now = Date.now()): number | null {
  const t = Date.parse(startTime);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400_000));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Judge one listing.
 *
 * Returns "fine" whenever there isn't enough evidence to say otherwise. That is
 * the important default: an unhelpful nudge on a listing that's simply young
 * trains the seller to ignore the whole column.
 */
export function triageListing(input: TriageInput, now = Date.now()): Triage {
  const fine = (headline: string, evidence = ""): Triage => ({
    verdict: "fine",
    priority: 0,
    headline,
    evidence,
    suggestion: "",
  });

  const age = ageInDays(input.startTime, now);
  const sold = input.quantitySold ?? 0;
  if (sold > 0) return fine("Selling", `${plural(sold, "sale")} so far.`);
  if (age === null) return fine("");
  if (age < MIN_AGE_DAYS) {
    return fine("Still new", `Listed ${plural(age, "day")} ago — give it time.`);
  }

  const impressions = input.impressions;
  const views = input.views;
  const watchers = input.watchCount ?? 0;

  // Without traffic figures the only honest signals left are age and watchers.
  if (impressions === null || views === null) {
    if (watchers > 0 && age >= STALE_DAYS) {
      return {
        verdict: "watched-not-bought",
        priority: 60,
        headline: `${plural(watchers, "watcher")}, no sale`,
        evidence: `Listed ${plural(age, "day")} ago.`,
        suggestion: "Send those watchers an offer, or cut the price.",
      };
    }
    if (age >= STALE_DAYS) {
      return {
        verdict: "stale",
        priority: 40,
        headline: `${plural(age, "day")} old, no sale`,
        evidence: "No traffic figures — connect eBay's analytics permission for more.",
        suggestion: "Worth a price cut, a better title, or ending it.",
      };
    }
    return fine("");
  }

  if (impressions < MIN_IMPRESSIONS) {
    return {
      verdict: "invisible",
      priority: 80,
      headline: "Barely showing in search",
      evidence: `Only ${impressions} impressions in ${plural(age, "day")}.`,
      suggestion:
        "This is a findability problem, not a price one — fix the title keywords and fill in missing item specifics.",
    };
  }

  const ctr = views / impressions;
  if (ctr < WEAK_CTR) {
    return {
      verdict: "poor-clickthrough",
      priority: 70,
      headline: "Seen but not clicked",
      evidence: `${impressions} impressions, ${views} views (${(ctr * 100).toFixed(1)}%).`,
      suggestion:
        "People see it in search and scroll past — usually the main photo or the price shown in results.",
    };
  }

  if (watchers > 0) {
    return {
      verdict: "watched-not-bought",
      priority: 90,
      headline: `${plural(watchers, "watcher")}, no sale`,
      evidence: `${views} views in ${plural(age, "day")}.`,
      suggestion: "The strongest case for an offer — these people already want it.",
    };
  }

  if (age >= STALE_DAYS) {
    return {
      verdict: "stale",
      priority: 50,
      headline: `${plural(age, "day")} old, no sale`,
      evidence: `${views} views, no watchers.`,
      suggestion: "Interest without commitment. Try a lower price, or end it and reinvest.",
    };
  }

  return fine("Getting traffic", `${views} views, ${plural(age, "day")} old.`);
}

/** Summary line for the top of the list. */
export function triageSummary(triages: Triage[]): string {
  const needing = triages.filter((t) => t.priority > 0);
  if (triages.length === 0) return "";
  if (needing.length === 0) {
    return "Nothing looks stuck — every listing is either selling or still new enough to leave alone.";
  }
  const watched = needing.filter((t) => t.verdict === "watched-not-bought").length;
  const parts = [`${plural(needing.length, "listing")} worth a look`];
  if (watched > 0) parts.push(`${watched} with watchers who haven't bought`);
  return `${parts.join(", ")}.`;
}
