// Tier identity: ember < spark < solstice < nova. Colors are CSS variables in
// tokens.css (--tier-<id>, --tier-<id>-grad); this file only holds names, order,
// blurbs and how loud the streaming effect is for each tier.

export type TierId = "ember" | "spark" | "solstice" | "nova";

/** none = plain UI; warm = solstice pulse; plasma = nova ring + rising sparks. */
export type TierEffect = "none" | "warm" | "plasma";

export interface TierInfo {
  id: TierId;
  rank: number;
  blurb: string;
  effect: TierEffect;
}

export const TIERS: Record<TierId, TierInfo> = {
  ember: { id: "ember", rank: 1, blurb: "Fast and small", effect: "none" },
  spark: { id: "spark", rank: 2, blurb: "Strong mid-tier", effect: "none" },
  solstice: { id: "solstice", rank: 3, blurb: "Frontier · default", effect: "warm" },
  nova: { id: "nova", rank: 4, blurb: "Hyperfrontier", effect: "plasma" },
};

/** Known tier for a model id (tolerates prefixes like "tierlm/nova"), else null. */
export function tierOf(model: string | null | undefined): TierInfo | null {
  if (!model) return null;
  const key = model.toLowerCase().split("/").pop() as TierId;
  return TIERS[key] ?? null;
}

/** Highest tier first, unknown models last in their original order. */
export function sortTiers(models: string[]): string[] {
  return models
    .map((m, i) => ({ m, i, r: tierOf(m)?.rank ?? 0 }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.m);
}
