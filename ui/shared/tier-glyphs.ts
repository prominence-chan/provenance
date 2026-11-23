// The four tiers' glyphs (spark < ember < solstice < nova), drawn once here for the page
// (src/components/TierBadge.tsx) and the Discord presence images (design/presence/render.ts).
//
// One family on a 24-unit grid, centred, solid: each tier throws off more points than the one
// below and reaches further out, so the four read as a climb even without their colours.
//   spark     a four-point spark                       4 points, 16 units across
//   ember     a glowing coal, seven soft lobes          7 lobes, 16 units, the densest mass
//   solstice  the sun: a disc and eight rays            8 rays, 22 units
//   nova      a stellar burst, twelve sharp points      12 points, the full 24 units
// Drawn for 12 px on a 2x screen (1 unit = 1 device pixel): the sun's disc, its straight rays and
// the tips land on whole units, and nothing is thinner than 2 units. From DETAIL_FROM px up each
// glyph adds a white-hot core, a little larger as the tier rises.

export type TierGlyphId = "spark" | "ember" | "solstice" | "nova";

export interface TierGlyphShape {
  /** The filled silhouette. */
  body: string;
  /** Width of a round-joined outline in the body's paint that softens its corners (0: none). */
  soften: number;
  /** Round-capped 2-unit strokes in the body's paint (solstice's rays). */
  rays?: string;
  /** The white-hot core of the detailed drawing, and its softening outline. */
  core: string;
  coreSoften: number;
}

/** Size (px) from which the glyph draws its core. */
export const DETAIL_FROM = 32;

const disc = (r: number) => `M12 ${12 - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`;

export const TIER_GLYPHS: Record<TierGlyphId, TierGlyphShape> = {
  // Curved-sided four-point spark, tips at radius 8.
  spark: {
    body: "M12 4C12.96 8.32 15.68 11.04 20 12C15.68 12.96 12.96 15.68 12 20C11.04 15.68 8.32 12.96 4 12C8.32 11.04 11.04 8.32 12 4Z",
    soften: 0,
    core: "M12 9C12.36 10.62 13.38 11.64 15 12C13.38 12.36 12.36 13.38 12 15C11.64 13.38 10.62 12.36 9 12C10.62 11.64 11.64 10.62 12 9Z",
    coreSoften: 0,
  },
  // Seven-lobed coal (radii 7 / 5.6, optically centred), softened by a 2-unit round outline.
  ember: {
    body: "M12 5.35L14.43 7.3L17.47 7.98L17.46 11.1L18.82 13.9L16.38 15.84L15.04 18.65L12 17.95L8.96 18.65L7.62 15.84L5.18 13.9L6.54 11.1L6.53 7.98L9.57 7.3Z",
    soften: 2,
    core: "M12 9.45L13 10.27L14.27 10.54L14.24 11.83L14.83 12.99L13.8 13.78L13.26 14.96L12 14.65L10.74 14.96L10.2 13.78L9.17 12.99L9.76 11.83L9.73 10.54L11 10.27Z",
    coreSoften: 1,
  },
  // Disc of radius 5; eight rays from radius 8 to 10 (with their caps, 7 to 11).
  solstice: {
    body: disc(5),
    soften: 0,
    rays: "M12 4V2M12 20v2M4 12H2M20 12h2M17.66 6.34l1.41-1.41M6.34 17.66l-1.41 1.41M6.34 6.34L4.93 4.93M17.66 17.66l1.41 1.41",
    core: disc(3),
    coreSoften: 0,
  },
  // Twelve-point burst, radii 12 / 5.4.
  nova: {
    body: "M12 0L13.4 6.78L18 1.61L15.82 8.18L22.39 6L17.22 10.6L24 12L17.22 13.4L22.39 18L15.82 15.82L18 22.39L13.4 17.22L12 24L10.6 17.22L6 22.39L8.18 15.82L1.61 18L6.78 13.4L0 12L6.78 10.6L1.61 6L8.18 8.18L6 1.61L10.6 6.78Z",
    soften: 0,
    core: disc(3.6),
    coreSoften: 0,
  },
};
