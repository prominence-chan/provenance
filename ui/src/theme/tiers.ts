// Tier identity: spark < ember < solstice < nova. Colors are CSS variables in
// tokens.css (--tier-<id>, --tier-<id>-grad, --fx-<id>-*); this file only holds names,
// order, blurbs and effort labels. Each tier has its own effect style, keyed by id in FlameFx.tsx.
//
// A model string is either a plain tier ("solstice": provenance-core picks the source) or
// "<source>/<tier>" ("luna/solstice": that source is pinned for the tier).

export type TierId = "spark" | "ember" | "solstice" | "nova";

export interface TierInfo {
  id: TierId;
  rank: number;
  blurb: string;
  /** How much the tier puts in, as a word (the picker shows it instead of rank bars). */
  effort: string;
}

export const TIERS: Record<TierId, TierInfo> = {
  spark: { id: "spark", rank: 1, blurb: "Fast · small", effort: "Low" },
  ember: { id: "ember", rank: 2, blurb: "Strong mid", effort: "Medium" },
  solstice: { id: "solstice", rank: 3, blurb: "Frontier · default", effort: "High" },
  nova: { id: "nova", rank: 4, blurb: "Hyperfrontier", effort: "Max" },
};

/** "luna/solstice" -> { tier: "solstice", source: "luna" }; "solstice" -> source null. */
export function splitModel(model: string): { tier: string; source: string | null } {
  const i = model.lastIndexOf("/");
  return i < 0
    ? { tier: model, source: null }
    : { tier: model.slice(i + 1), source: model.slice(0, i) || null };
}

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
