// GLSL shared by the effect shaders (HeroSun, FlameFx).

/**
 * hash(vec2) -> 0..1, from the float's bits (pcg2d), so it is as random a million units from
 * the origin as next to it. The usual fract(p * 456.21) kind runs out of float precision once
 * its input is in the thousands and turns into stripes and blocks.
 */
export const GLSL_HASH = `
float hash(vec2 p) {
  uvec2 v = floatBitsToUint(mix(p, vec2(0.0), equal(p, vec2(0.0)))); // -0 hashes as +0
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return float(v.x ^ v.y) * (1.0 / 4294967296.0);
}`;
