// Tier effects: one WebGL2 canvas behind the main column, always on for the selected tier.
//
// Three states, eased into each other (critically damped, so nothing snaps):
//   flare    when the tier changes (and on first load): the tier's ignition, the peak
//   idle     after the flare: an almost-still ambient animation, drawn at a low frame rate
//   active   while a turn streams: a little above idle, well below the flare
//
// Intensity climbs with the tier (spark subtlest, nova strongest). Each tier has its own look:
//   spark     electric: tiny sparks fizzle in and out at random spots just outside the edge,
//             drift a little and crackle; on switch a scatter of them with short arcs jumping
//             between neighbours
//   ember     small craquelure: a sparse network of hairline cracks creeps along and a
//             little way out from the edge, meandering, branching and stopping at random,
//             white-hot only at the growing tips, then a faint glow that lives in the
//             cracks; while active, slow heat pulses wander along it
//   solstice  sunset: on switch the sun's glare appears on the top edge, flames and dusk
//             clouds rise and run out sideways under slowly turning rays, then it settles to
//             a low, faint flame with sparse cinders drifting up; all of it stays inside the
//             composer's width
//   nova      plasma: a charge (the edge heats to white-hot, motes gather), then an eruption
//             from the whole composer: core flash, lopsided torn shock fronts with filaments,
//             debris with physics, plasma smoke, then a supernova remnant of drifting gas
//             that fades over ~10 s; idle is a calm shimmering plasma rim
//
// Organic by construction: every envelope is a smooth attack into a two-rate decay (no
// kinks at the peak), timings vary per flare, idle brightness wanders on slow noise, and
// layers within a flare fade at different rates.
//
// Cheap: DPR capped at 1.5, the shader runs only in a band around the composer (plus a strip
// under the header and, during nova's eruption and remnant, the blast's box), every band fades out
// before its edge, idle draws at 20 fps, background windows at 30 fps (idle stops after a few
// seconds unfocused), nothing runs while the tab is hidden. pointer-events: none. Under
// prefers-reduced-motion, or without WebGL2, nothing runs and effects.css draws a static tier
// tint instead.
//
// The fallbacks (Claude Code, Codex) have an effect too: ember's style (a layer's `tier`) drawn
// in their own colour ramp (its `id`, a palette slot of its own), so a selected fallback looks
// as selected as a tier without a style of its own.
import { useEffect, useRef } from "react";
import { useTheme } from "../../theme/theme";
import type { FallbackCli } from "../../../shared/fallback-api";
import type { TierId } from "../../theme/tiers";
import { useReducedMotion, type FxState } from "./useFx";

export function FlameFx({ fx }: { fx: FxState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const theme = useTheme();
  const reduced = useReducedMotion();
  const id: FxId | null = fx.tier?.id ?? fx.fallback ?? null;

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    if (reduced) {
      host.dataset.fx = "static";
      return () => void delete host.dataset.fx;
    }
    const e = createEngine(canvas, host);
    if (!e) {
      host.dataset.fx = "static";
      return () => void delete host.dataset.fx;
    }
    host.dataset.fx = "gl";
    engine.current = e;
    return () => {
      e.destroy();
      engine.current = null;
      delete host.dataset.fx;
    };
  }, [reduced]);

  useEffect(() => {
    void theme;
    engine.current?.setPalette();
  }, [theme]);

  useEffect(() => {
    engine.current?.set(id, fx.streaming, fx.flareKey);
  }, [id, fx.streaming, fx.flareKey, reduced]);

  return <canvas ref={ref} className="flame-fx" aria-hidden />;
}

// ---------------------------------------------------------------------------------------

type Engine = NonNullable<ReturnType<typeof createEngine>>;

const TIER_INDEX: Record<TierId, number> = { spark: 0, ember: 1, solstice: 2, nova: 3 };
const TIER_IDS: TierId[] = ["spark", "ember", "solstice", "nova"];
/** Point palette slot for nova's off-palette debris (violet / cyan). */
const OFF = 4;

/** What an effect is for: a tier, or a fallback. */
type FxId = TierId | FallbackCli;
const FALLBACK_IDS: FallbackCli[] = ["claude", "codex"];
/** Which style draws it: a tier's own; a fallback's, ember's (hairline cracks, in its colour). */
const STYLE: Record<FxId, TierId> = {
  spark: "spark",
  ember: "ember",
  solstice: "solstice",
  nova: "nova",
  claude: "ember",
  codex: "ember",
};
/** Its colour ramp's palette slot: the tiers', OFF, then the fallbacks'. */
const PAL: Record<FxId, number> = { ...TIER_INDEX, claude: 5, codex: 6 };

/**
 * Flare envelope per tier, in seconds: an optional charge (`pre`) before the peak, a smooth
 * attack (`rise`), then a two-rate decay (fast `k1` for share `m`, slow `k2` for the rest),
 * gone by `len`. Each flare stretches all of it by a random 0.88..1.14.
 */
const FLARE: Record<
  TierId,
  { pre: number; rise: number; k1: number; k2: number; m: number; len: number }
> = {
  spark: { pre: 0, rise: 0.45, k1: 2.0, k2: 0.8, m: 0.6, len: 3.0 },
  ember: { pre: 0, rise: 0.7, k1: 1.3, k2: 0.55, m: 0.55, len: 4.2 },
  solstice: { pre: 0, rise: 0.9, k1: 0.8, k2: 0.38, m: 0.5, len: 6.5 },
  nova: { pre: 1.35, rise: 0.1, k1: 1.5, k2: 0.42, m: 0.6, len: 6.5 },
};

const QUAD_VS = `#version 300 es
in vec2 aPos;           // CSS px, y down
uniform vec2 uRes;      // canvas size, CSS px
out vec2 vPos;
void main() {
  vPos = aPos;
  vec2 clip = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FX_FS = `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 outColor;
uniform float uTime;    // per-layer phase: runs slow when idle, faster when active
uniform float uClock;   // wall clock, s
uniform float uFT;      // flare time, s (scaled per flare); < 0 during nova's charge
uniform float uFl;      // flare envelope 0..1
uniform float uPre;     // nova charge 0..1
uniform float uAct;     // active 0..1 (eased)
uniform float uFade;    // layer opacity (cross-fade when the tier changes)
uniform float uBreath;  // slow idle wander, ~0.6..1.15
uniform float uSeed;    // per-flare random, 0..100
uniform float uAlphaK, uGain, uHaze, uRadius, uTopY;
uniform vec2 uRes;
uniform int uMode;      // 0 = composer band, 1 = header filament, 2 = nova eruption
uniform int uTier;      // 0 spark, 1 ember, 2 solstice, 3 nova
uniform vec4 uRect;     // composer x, y, w, h (CSS px)
uniform vec4 uBand;     // the quad being drawn, x0 y0 x1 y1: everything fades out before it
uniform vec3 uC0, uC1, uC2, uC3, uOff1, uOff2, uDusk;
uniform vec4 uSparks[8]; // spark: x, y, brightness, size

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v / 0.875;
}
// Ridged multifractal: thin bright filaments where the noise crosses 0.5 (gas, smoke).
float ridged(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(noise(p) * 2.0 - 1.0);
    v += a * n * n; p = m * p; a *= 0.5;
  }
  return v / 0.9375;
}
vec2 hash2(vec2 p) {
  return vec2(hash(p), hash(p + 17.31));
}
// Distance (in cell units) to the nearest Voronoi edge, irregular cells (IQ's two-pass
// method). id = a random 0..1 per cell; eid = a random 0..1 per edge (the same from both
// sides), so single edges can be dropped to break the network into meandering paths.
float vorEdge(vec2 x, out float id, out float eid) {
  vec2 n = floor(x), f = fract(x);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + 0.1 + 0.8 * hash2(n + g) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  id = hash(n + mg + 3.7);
  md = 8.0;
  vec2 eg = mg;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 r = g + 0.1 + 0.8 * hash2(n + g) - f;
      vec2 e = r - mr;
      if (dot(e, e) > 1e-5) {
        float de = dot(0.5 * (mr + r), normalize(e));
        if (de < md) { md = de; eg = g; }
      }
    }
  eid = hash(2.0 * n + mg + eg + 11.3);
  return md;
}
// Thermal colour for nova's heat-up: dull orange -> yellow -> white-hot.
vec3 blackbody(float T) {
  vec3 c = mix(vec3(0.9, 0.22, 0.04), vec3(1.0, 0.55, 0.12), smoothstep(0.0, 0.35, T));
  c = mix(c, vec3(1.0, 0.86, 0.42), smoothstep(0.3, 0.65, T));
  return mix(c, vec3(1.0, 0.98, 0.94), smoothstep(0.62, 0.95, T));
}
float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Smooth ramp-in over a, then exp decay at rate k with no kink at the peak.
float sp(float x) { return x > 4.0 ? x : log(1.0 + exp(4.0 * x)) * 0.25; }
float pulse(float t, float a, float k) {
  if (t <= 0.0) return 0.0;
  return smoothstep(0.0, a, t) * exp(-k * sp(t - a));
}
float bandWin(vec2 p) {
  float m = 16.0;
  return smoothstep(uBand.x, uBand.x + m, p.x) * smoothstep(uBand.z, uBand.z - m, p.x)
       * smoothstep(uBand.y, uBand.y + m, p.y) * smoothstep(uBand.w, uBand.w - m, p.y);
}
// heat 0..1 -> premultiplied colour: transparent -> deep -> tier -> hot -> core
vec4 ramp(float h) {
  h = clamp(h, 0.0, 1.0);
  vec3 c = mix(uC0, uC1, smoothstep(0.1, 0.4, h));
  c = mix(c, uC2, smoothstep(0.4, 0.68, h));
  c = mix(c, uC3, smoothstep(0.7, 0.98, h));
  float a = smoothstep(0.0, 0.32, h) * (0.55 + 0.45 * h);
  return vec4(c * a, a);
}

// Fire off the composer's top edge (solstice and nova). H0 = tongue height in px.
float flames(vec2 pos, float d, float up, float H0, float nova, float fl, float t, float ft,
             inout float add) {
  float topBand = smoothstep(uRect.y + uRadius + 2.0, uRect.y + 1.0, pos.y);
  vec2 q = pos / vec2(34.0, 52.0) + uSeed * 0.07;
  q.y += t * (1.2 + 0.5 * nova);
  vec2 w = vec2(fbm(q + vec2(0.0, t * 0.15)), fbm(q + vec2(5.2, 1.3 - t * 0.1)));
  float n = fbm(q * vec2(1.5, 0.75) + 1.8 * w);
  float along = clamp((pos.x - uRect.x) / uRect.z, 0.0, 1.0);
  float shape = smoothstep(0.0, 0.16, along) * smoothstep(1.0, 0.84, along);
  float tall = pow(fbm(vec2(pos.x / 70.0 + uSeed, t * 0.22)), 2.0) * 2.4;
  float H = H0 * (0.25 + tall) * shape;
  float f = max(up, 0.0) / max(H, 1.0);
  float flame = smoothstep(0.95, 0.05, f + (n - 0.5) * 1.7);
  flame *= smoothstep(-1.0, 1.0, up) * topBand * smoothstep(0.0, 0.08, shape);
  float tip = clamp(f, 0.0, 1.0);
  // Internal structure: hot filaments stream up inside each tongue, so it is never a flat
  // fill; the core runs hotter than the tongue's edge (limb darkening of a volume).
  float strands = ridged(vec2(pos.x / 11.0 + w.x * 2.5, pos.y / 30.0 + t * (1.6 + 0.6 * nova)));
  float core = smoothstep(0.15, 0.6, flame);
  float heat = flame * mix(0.5, 0.16, tip) * (0.7 + 0.5 * strands);
  heat += core * smoothstep(0.5, 0.8, n) * smoothstep(0.45, 0.0, tip) * 0.4;
  heat += core * pow(strands, 3.0) * smoothstep(0.7, 0.1, tip) * 0.22;
  // Back layer: larger, slower, taller and dimmer tongues behind the front ones (parallax),
  // so the fire reads as a volume rather than one sheet.
  vec2 qb = pos / vec2(60.0, 84.0) + uSeed * 0.05 + 7.3;
  qb.y += t * (0.6 + 0.25 * nova);
  float nb = fbm3(qb + 1.3 * vec2(fbm3(qb * 0.7 + vec2(0.0, t * 0.08)), 0.0));
  float Hb = H0 * (0.55 + tall * 1.25) * shape * 1.45;
  float fb = max(up, 0.0) / max(Hb, 1.0);
  float back = smoothstep(0.95, 0.12, fb + (nb - 0.5) * 1.5) * smoothstep(-1.0, 1.0, up)
             * topBand * smoothstep(0.0, 0.08, shape);
  heat = max(heat, back * mix(0.3, 0.1, clamp(fb, 0.0, 1.0)));
  // A living rim on the top border: mostly dim, with bright travelling knots.
  float rimN = fbm(pos / 20.0 + vec2(t * 1.2, -t * 0.4));
  float rim = exp(-abs(d - 0.3) / 0.7) * (0.18 + 0.75 * smoothstep(0.45, 0.8, rimN)) * topBand * shape;
  heat = max(heat, rim * 0.85);
  float glowUp = exp(-max(up, 0.0) / (12.0 + 8.0 * nova)) * smoothstep(-1.0, 2.0, up)
               * smoothstep(48.0, 10.0, up) * topBand * shape;
  heat += glowUp * (0.12 + 0.08 * nova) * (0.75 + 0.35 * noise(vec2(t * 0.6, uSeed))) * uHaze
        * min(1.0, H0 / 14.0);
  // Heat haze: faint wisps off the tongues (dark theme only).
  float wisp = fbm(q * vec2(0.9, 0.5) + 2.4 * w - vec2(0.0, t * 0.2));
  heat += smoothstep(0.55, 0.85, wisp) * smoothstep(4.0, 22.0, up) * exp(-up / 34.0) * shape
        * 0.12 * uHaze * min(1.0, H0 / 20.0);
  // Flare: a sheet of flame leaps off the edge and falls back, unevenly along it.
  float sheetH = 14.0 + 46.0 * smoothstep(0.0, 1.2, ft);
  float uneven = smoothstep(0.2, 0.8, noise(vec2(pos.x / 90.0 + uSeed, ft * 0.4)));
  float sheet = exp(-max(up, 0.0) / sheetH) * smoothstep(-1.0, 1.0, up) * topBand * shape
              * smoothstep(0.25, 0.75, n) * fl * (0.4 + 0.6 * uneven);
  heat += sheet * (0.3 + 0.4 * nova);
  add += rim * fl * (0.3 + 0.6 * nova);
  return heat;
}

void main() {
  float t = uTime, ft = uFT, fl = uFl, act = uAct;
  float heat = 0.0;
  float add = 0.0;          // extra additive light (flash, ring, spark cores)
  vec3 tint = vec3(0.0);    // direct premultiplied colour (off-palette bits), dark theme
  float tintA = 0.0;
  float win = bandWin(vPos);
  if (win <= 0.0) { outColor = vec4(0.0); return; }

  vec2 c = uRect.xy + uRect.zw * 0.5;
  float d = sdRound(vPos - c, uRect.zw * 0.5, uRadius);    // > 0 outside the composer

  if (uMode == 2) {
    // NOVA ERUPTION, out of the whole composer. Every front is the composer's SDF pushed
    // through a turbulent warp, with its own speed per direction (so it is lopsided and
    // never a clean outline), broken into torn arcs of uneven thickness, trailing radial
    // filaments; behind it a supernova remnant: wispy multicoloured gas that drifts out
    // slowly and fades.
    if (d < -1.5) { outColor = vec4(0.0); return; }
    vec2 inner = clamp(vPos, uRect.xy + uRadius, uRect.xy + uRect.zw - uRadius);
    vec2 nrm = normalize(vPos - inner + 0.001);
    // A coordinate that varies all round the box (along the edges and round the corners).
    vec2 around = inner / 120.0 + nrm * 1.3 + uSeed;
    float R1 = 6.0 + 600.0 * (1.0 - exp(-ft * 1.7));
    // Turbulent warp of the plane, growing as the blast expands.
    vec2 wq = vPos / 85.0 + uSeed * 1.3;
    vec2 warp = (vec2(fbm3(wq + vec2(0.0, ft * 0.35)), fbm3(wq + vec2(5.2, 1.3 - ft * 0.3))) - 0.5);
    vec2 wp = vPos + warp * (18.0 + R1 * 0.22)
            + (vec2(noise(vPos / 17.0 + uSeed), noise(vPos / 17.0 - uSeed)) - 0.5) * (2.0 + R1 * 0.05);
    float ddw = max(sdRound(wp - c, uRect.zw * 0.5, uRadius), 0.0);
    float dd = max(d, 0.0);
    // Lopsided: speed per direction from noise, plus one random strong side per flare.
    vec2 bias = vec2(cos(uSeed * 2.1), sin(uSeed * 2.1));
    float spd = (0.6 + 0.75 * fbm3(around * 0.9)) * (1.0 + 0.3 * dot(nrm, bias));
    float edgeN = fbm3(around * 2.6 + vec2(ft * 1.1, 0.0));
    // Shockwave 1: thin, fast, white with chromatic fringes (red outside, blue inside),
    // torn into arcs; its width changes along the front.
    float f1 = R1 * spd;
    float w1 = (1.0 + R1 * 0.012) * (0.45 + 1.4 * fbm3(around * 3.3 + 9.0));
    float gap1 = smoothstep(0.38, 0.66, fbm(around * 3.4 + vec2(ddw / 140.0, ft * 0.6)));
    float L1 = smoothstep(0.0, 0.06, ft) * exp(-ft * 1.5) * gap1;
    float x1 = ddw - f1;
    float cs = 1.2 + R1 * 0.006;
    vec3 shock = vec3(exp(-abs(x1 - cs) / w1), exp(-abs(x1) / w1), exp(-abs(x1 + cs) / w1)) * L1;
    // Shockwave 2: slower, thicker, in the tier colour; a second, offset speed field so the
    // two fronts cross and separate unevenly.
    float R2 = 3.0 + 380.0 * (1.0 - exp(-ft * 1.2));
    float spd2 = (0.55 + 0.85 * fbm3(around * 1.4 + 31.0)) * (1.0 + 0.25 * dot(nrm, bias));
    float f2 = R2 * spd2;
    float w2 = (4.0 + R2 * 0.05) * (0.4 + 1.3 * fbm3(around * 2.2 + 17.0));
    float L2 = pulse(ft, 0.2, 1.1);
    float tear = smoothstep(0.28, 0.72, fbm(around * 2.4 + vec2(ddw / 70.0, ft * 0.7)));
    float ring2 = exp(-abs(ddw - f2) / w2) * L2 * (0.15 + 0.85 * tear);
    float wake2 = smoothstep(f2, f2 * 0.25, ddw) * exp(-ddw / (f2 * 0.6 + 8.0)) * L2 * 0.2;
    // Radial filaments: streaks trailing behind the front, combed outward by the blast.
    float along = dot(inner - c, vec2(1.0, 0.0)) + dot(inner - c, vec2(0.0, 1.0)) * 1.7
                + (nrm.x - nrm.y) * 40.0;
    float fil = ridged(vec2(along / 9.0 + warp.x * 6.0, ddw / 55.0 - ft * 0.9 + uSeed));
    float filZone = smoothstep(f2 * 0.2, f2 * 0.85, ddw) * smoothstep(f2 * 1.12, f2 * 0.9, ddw);
    float filaments = pow(fil, 4.0) * filZone * L2 * (0.4 + 0.6 * tear);
    // Core flash off the rim, and a faint bloom that fades across the column.
    float F = pulse(ft, 0.05, 4.8);
    float flash = exp(-dd / (8.0 + 90.0 * ft)) * F * (0.7 + 0.3 * edgeN);
    float bloom = exp(-dd / 360.0) * F * smoothstep(f1 * 1.15 + 70.0, f1 * 0.5, ddw);
    // Plasma smoke: advected outward from the rim, cooling pink -> violet -> cyan -> gone.
    float smL = pulse(ft - 0.06, 0.55, 0.62);
    vec2 sq = wp / 52.0 - nrm * ft * 0.85 + uSeed;
    float s1 = fbm(sq + vec2(0.0, ft * 0.18));
    float s2 = fbm3(sq * 1.9 - vec2(ft * 0.25, 0.0) + 3.7);
    float reach = (24.0 + 230.0 * (1.0 - exp(-ft * 1.05))) * spd2;
    float smoke = smoothstep(0.5, 0.92, s1 * 0.7 + s2 * 0.42) * exp(-ddw / reach)
                * smoothstep(reach * 1.5, reach * 0.4, ddw) * smoothstep(0.0, 8.0, dd) * smL;
    float hue = clamp(ft * 0.55 + (s2 - 0.5) * 0.8 + dd / 400.0, 0.0, 1.0);
    vec3 pc = mix(uC1, uOff1, smoothstep(0.05, 0.5, hue));
    pc = mix(pc, uOff2, smoothstep(0.55, 1.0, hue) * 0.45);
    // Remnant nebula: two layers of gas at different scales drifting at different speeds
    // (parallax), red-pink filaments (ridged) over violet / teal diffuse clouds, in a
    // broken shell where the blast went; it lingers and fades over ~10 s.
    float remL = smoothstep(0.5, 2.2, ft) * exp(-max(ft - 2.2, 0.0) * 0.42) * smoothstep(11.0, 8.0, ft) * 0.6;
    float neb = 0.0, nebF = 0.0;
    vec3 nebC = vec3(0.0);
    if (remL > 0.003) {
      float Rr = min((60.0 + 200.0 * (1.0 - exp(-ft * 0.5))) * spd2, 300.0);
      vec2 drift = nrm * ft * 3.0;
      vec2 np = wp - drift;
      float far = fbm(np / 120.0 + uSeed + vec2(ft * 0.012, 0.0));          // slow, big
      float nearN = fbm3(np / 46.0 - uSeed + vec2(0.0, ft * 0.03));          // faster, finer
      float rf = ridged((np - drift * 1.5) / 38.0 + vec2(uSeed * 0.7, ft * 0.02) + nearN * 0.9);
      float shell = smoothstep(10.0, 60.0, ddw) * smoothstep(Rr * 1.15, Rr * 0.35, ddw)
                  * (0.35 + 0.65 * smoothstep(0.3, 0.7, fbm3(around * 1.7 + 50.0)));
      float diffuse = smoothstep(0.5, 0.95, far * 0.65 + nearN * 0.5) * shell;
      nebF = pow(rf, 4.0) * smoothstep(0.35, 0.7, far + nearN * 0.3) * shell;
      neb = (diffuse * 0.5 + nebF) * remL;
      float hueN = smoothstep(0.35, 0.75, nearN + (far - 0.5) * 0.6);
      vec3 gas = mix(uOff1, uOff2, hueN);                    // violet <-> teal
      vec3 hot = mix(uC1, uC2, smoothstep(0.5, 0.95, rf));  // pink filaments, hot cores
      float clump = smoothstep(0.6, 0.85, far);                // brighter knots of gas
      nebC = (gas * diffuse * (0.6 + 0.8 * clump) + hot * nebF * 1.1) * remL;
    }
    float topBias = mix(0.75, 1.0, smoothstep(uRect.y + uRect.w, uRect.y - 40.0, vPos.y));
    heat = (ring2 * 0.38 + wake2 + flash * 0.7 + smoke * 0.18 * (1.0 - hue) + shock.g * 0.4
          + filaments * 0.3 + nebF * remL * 0.16) * topBias;
    vec3 white = mix(uC3, vec3(1.0), 0.5);
    vec3 shockC = mix(vec3(shock.g), shock, 0.55);    // fringes, not a rainbow
    tint = (shockC * white * 0.8 + uC2 * ring2 * 0.2 + pc * smoke * 0.3 + uC2 * filaments * 0.18
          + mix(uC2, uOff1, 0.4) * bloom * 0.07 + uC3 * flash * 0.5 + nebC * 0.7) * topBias;
    tintA = (shock.g * 0.4 + smoke * 0.2 + flash * 0.3 + neb * 0.25) * topBias;
  } else if (uMode == 1) {
    // Plasma filament under the header (solstice, nova): one hairline with a shimmer and
    // drifting highlights; on a flare it lights from the centre outwards.
    float nova = float(uTier == 3);
    float lvl = uTier == 3 ? max(act * 0.85, fl) : max(act * 0.55, fl * 0.75);
    float y = vPos.y - uTopY;
    float x = vPos.x / uRes.x;
    float ends = smoothstep(0.0, 0.25, x) * smoothstep(1.0, 0.75, x);
    // Solstice keeps to the composer's width here too.
    if (uTier == 2)
      ends = smoothstep(uRect.x, uRect.x + uRect.z * 0.3, vPos.x)
           * smoothstep(uRect.x + uRect.z, uRect.x + uRect.z * 0.7, vPos.x);
    float shimmer = 0.75 + 0.25 * fbm3(vec2(vPos.x / 140.0 - t * 0.4, t * 0.3));
    float hi = smoothstep(0.55, 0.85, fbm3(vec2(vPos.x / 220.0 - t * (0.12 + 0.06 * nova), uSeed)));
    float line = exp(-abs(y) / 0.6) * (0.28 * shimmer + 0.65 * hi);
    float glow = exp(-max(y, 0.0) / (6.0 + 4.0 * nova)) * smoothstep(-1.5, 0.5, y)
               * smoothstep(26.0, 4.0, y) * 0.22 * hi;
    float cx = c.x / uRes.x;
    float front = 1.0 - exp(-max(ft, 0.0) * 2.2);
    float ign = pulse(ft, 0.1, 1.6);
    float lit = mix(1.0, smoothstep(front + 0.05, front - 0.05, abs(x - cx)), ign);
    float spark = ign * exp(-abs(abs(x - cx) - front) * 50.0) * exp(-abs(y) / 2.0);
    heat = (line + glow) * lit * ends * lvl;
    add = spark * (0.4 + 0.6 * nova) * fl;
  } else {
    if (d < -1.5) { outColor = vec4(0.0); return; }        // under the opaque composer
    float dd = max(d, 0.0);
    float up = uRect.y - vPos.y;                             // px above the top edge
    float along = clamp((vPos.x - uRect.x) / uRect.z, 0.0, 1.0);
    float topW = smoothstep(uRect.y + uRect.w * 0.9, uRect.y, vPos.y);
    float outside = smoothstep(-1.0, 0.5, d);
    float rimLine = exp(-abs(d - 0.3) / 0.65) * outside;
    vec2 ap = abs(vPos - c) - uRect.zw * 0.5;
    float u = ap.x > ap.y ? vPos.y : vPos.x;                 // coordinate along the edge

    if (uTier == 0) {
      // SPARK: almost nothing on the rim; each live spark (CPU) lights a little of the edge
      // round it with a flickering blue-white glow.
      float crawl = smoothstep(0.6, 0.9, noise(vec2(u / 26.0 + uSeed, uClock * 0.7)));
      heat = rimLine * mix(0.35, 1.0, topW) * (0.015 + 0.08 * act * crawl + 0.5 * fl * crawl);
      heat += exp(-dd / 10.0) * outside * fl * 0.12
            * smoothstep(0.35, 0.85, noise(vPos / 22.0 + vec2(uClock * 0.5, uSeed)));
      float flick = noise(vec2((vPos.x + vPos.y) / 6.0, uClock * 24.0));
      for (int i = 0; i < 8; i++) {
        vec4 s = uSparks[i];
        if (s.z <= 0.0) continue;
        float r = length(vPos - s.xy);
        heat += s.z * (exp(-r / (5.0 + 3.0 * s.w)) * 0.55
                     + rimLine * exp(-r / 26.0) * (0.3 + 0.7 * flick) * 0.8);
        add += s.z * exp(-r / 3.0) * 0.2;
      }
    } else if (uTier == 1) {
      // EMBER: a small, sparse craquelure hugging the edge. One Voronoi network (cells
      // stretched along the edge so cracks run sideways as much as outward), with single
      // edges dropped at random so it reads as meandering cracks that branch and stop, not
      // a grid of cells. It grows from a few seed points on the edge, faster along the edge
      // than away from it, white-hot only at the growing tips, and cools to a faint glow
      // that stays in the cracks. While active, slow heat pulses wander along the network.
      vec2 lp = vPos - uRect.xy;                     // ride with the composer
      // Craggy edges: jitter the domain at two small scales so every crack zigzags.
      vec2 jp = lp + (vec2(noise(lp / 3.5 + uSeed), noise(lp / 3.5 + uSeed + 9.1)) - 0.5) * 2.4
              + (vec2(noise(lp / 14.0 + 3.0), noise(lp / 14.0 + 7.0)) - 0.5) * 7.0;
      float cid, eid;
      float e = vorEdge(jp / vec2(19.0, 12.0) + uSeed, cid, eid) * 12.0;  // ~px to a crack
      // Short reach: a few px at the sides and bottom, a little more on top, ragged.
      float reach = mix(8.0, 24.0, topW)
                  * (0.45 + 1.0 * smoothstep(0.25, 0.75, fbm3(vec2(vPos.x / 80.0 + uSeed, 3.0))));
      float rel = dd / max(reach, 1.0);
      // Growth distance: from the nearest seed point along the edge (one per ~150 px, placed
      // at random), stretched so the network creeps along the edge before it creeps out.
      float sx = vPos.x / 150.0 + uSeed * 0.37;
      float k0 = floor(sx), sAlong = 9.0, kSeed = k0;
      for (int i = -1; i <= 1; i++) {
        float kk = k0 + float(i);
        float a = abs(sx - kk - 0.15 - 0.7 * hash(vec2(kk, uSeed)));
        if (a < sAlong) { sAlong = a; kSeed = kk; }
      }
      sAlong *= 150.0;
      float g = length(vec2(sAlong, dd * 2.6)) * (0.8 + 0.45 * noise(lp / 24.0 + uSeed)) + 10.0 * cid;
      float F = 150.0 * (1.0 - exp(-max(ft, 0.0) * 0.8));
      float opened = smoothstep(F + 1.0, F - 2.0, g);
      float tOpen = -log(max(1.0 - g / 150.0, 0.02)) / 0.8;  // when the growth got here
      float age = max(ft - tOpen, 0.0);
      // Sparse: edges drop out more often further from the composer (cracks end at random),
      // and whole stretches of the edge stay quiet.
      float keep = step(0.12 + 0.6 * clamp(rel, 0.0, 1.0), eid);
      float live = smoothstep(0.27, 0.5, fbm3(vec2(vPos.x / 110.0 + uSeed * 1.3, 7.0)));
      float within = smoothstep(1.0, 0.55, rel) * keep * live * outside;
      // Hairline: a little wider at the edge, thinning out.
      float w = mix(1.15, 0.5, clamp(rel, 0.0, 1.0)) * (0.7 + 0.6 * noise(jp / 21.0));
      float crack = (1.0 - smoothstep(w * 0.5, w * 0.5 + 0.6, e)) * opened * within;
      float bleed = exp(-e / 1.6) * opened * within;
      // Heat: a hot tip where the crack is growing, cooling behind it; a faint residual
      // glow that lives in the network; active pulses that wander along it.
      float tip = exp(-max(F - g, 0.0) / 5.0) * exp(-max(ft, 0.0) * 0.45) * 0.62;
      float cool = exp(-age * 1.1) * 0.26 + exp(-age * 0.22) * 0.07;
      float resid = (0.14 * uBreath + 0.1 * act) * (1.0 - 0.5 * clamp(rel, 0.0, 1.0));
      float P = fract(uClock * 0.2 + hash(vec2(kSeed, 4.0))) * 130.0 - 10.0;
      float pulseA = act * exp(-abs(g - P) / 7.0) * 0.3;
      float hc = resid + cool + tip + pulseA;
      heat = crack * hc + bleed * hc * 0.12;
      // The edge itself warms faintly only where a crack leaves it.
      heat += rimLine * mix(0.3, 1.0, topW) * (0.015 * uBreath + 0.03 * act + 0.07 * fl)
            * smoothstep(2.5, 0.5, e) * live;
      add += crack * tip * 0.12;
    } else if (uTier == 2) {
      // SOLSTICE: a low faint flame off the top edge; on switch a sunset on the edge.
      // Every solstice layer fades out inside the composer's own width: nothing runs past
      // its ends.
      float xt = smoothstep(uRect.x + 2.0, uRect.x + uRect.z * 0.16, vPos.x)
               * smoothstep(uRect.x + uRect.z - 2.0, uRect.x + uRect.z * 0.84, vPos.x);
      float H0 = 22.0 * (0.8 + 0.4 * act + 1.1 * fl);
      heat = flames(vPos, d, up, H0, 0.0, fl, t, ft, add) * (0.25 * uBreath + 0.32 * act + 0.42 * fl);
      heat += rimLine * mix(0.15, 1.0, topW) * (0.035 + 0.06 * act)
            * smoothstep(uRect.x - 2.0, uRect.x + uRect.z * 0.08, vPos.x)
            * smoothstep(uRect.x + uRect.z + 2.0, uRect.x + uRect.z * 0.92, vPos.x);
      if (ft > 0.0 && ft < 8.0) {
        float sx = c.x + (hash(vec2(uSeed, 1.7)) - 0.5) * uRect.z * 0.3;
        vec2 v = vPos - vec2(sx, uRect.y + 3.0);
        float upS = -v.y;
        float gl = pulse(ft, 0.85, 0.75);        // the sun's glare comes first
        float ry = pulse(ft - 0.3, 1.2, 0.42);   // rays, slowly turning
        float cl = pulse(ft - 0.55, 1.1, 0.5);   // flames and clouds rise and run out
        vec2 e = vec2(v.x / (50.0 + 110.0 * gl), v.y / (18.0 + 22.0 * gl));
        float glare = exp(-dot(e, e) * 1.3) * gl * smoothstep(-8.0, 3.0, upS);
        float streak = exp(-abs(v.y + 0.5) / (2.0 + 2.5 * gl)) * exp(-abs(v.x) / (60.0 + 120.0 * gl))
                     * smoothstep(-2.0, 1.0, upS) * gl;
        float ang = atan(v.x, max(upS, 0.0) + 22.0);
        float spin = ft * 0.07;
        float rays = pow(noise(vec2((ang + spin) * 7.0, uSeed * 3.0)), 2.5) * 0.65
                   + pow(noise(vec2((ang - spin * 0.6) * 15.0, uSeed * 5.0 + 4.0)), 3.0) * 0.35;
        float rlen = 50.0 + 170.0 * smoothstep(0.0, 1.8, ft);
        rays *= exp(-length(v) / rlen) * smoothstep(2.0, 18.0, upS) * smoothstep(1.4, 0.8, abs(ang)) * ry;
        float run = 1.0 + 1.6 * smoothstep(0.0, 4.0, ft - 0.4);
        // Clouds run out sideways from the sun: a smooth odd function of x (sign() here
        // tore the noise apart into a vertical seam above the sun).
        float side = v.x / (abs(v.x) + 70.0);
        vec2 cq = vec2(v.x / (run * 95.0) - side * ft * 0.05, upS / 20.0 - ft * 0.04);
        float cn = fbm(cq * vec2(1.0, 1.4) + vec2(uSeed, 0.0));
        float lift = smoothstep(3.0, 20.0, upS) * exp(-upS / (60.0 + 40.0 * cl));
        float spread = exp(-pow(abs(v.x) / (170.0 * run), 2.0));
        float clouds = smoothstep(0.38, 0.78, cn) * lift * spread * cl;
        // Clouds: lit gold low and near the sun, dusky violet-red higher and further out.
        float dusk = smoothstep(8.0, 80.0, upS + abs(v.x) * 0.15);
        heat += (glare * 0.8 + streak * 0.45 + rays * 0.32 + clouds * 0.3) * xt;
        add += (glare * 0.32 + streak * 0.12) * xt;
        tint += mix(uC2 * 0.8, uDusk, dusk) * clouds * 0.6 * xt;
        tintA += clouds * 0.2 * xt;
      }
    } else {
      // NOVA: a shimmering plasma rim all round, plasma wisps drifting along it; the charge
      // tightens it, the eruption leaves a lingering afterglow; flames while active.
      float pre = uPre;
      float after = pulse(ft, 0.08, 0.55);
      float rimN = fbm3(vPos / 15.0 + vec2(t * 0.8, -t * 0.5) + uSeed);
      float lvl = 0.5 * uBreath + 0.25 * act + 0.5 * pre + 0.8 * fl + 0.35 * after;
      heat = rimLine * (0.3 + 0.7 * smoothstep(0.4, 0.8, rimN)) * lvl;
      float cw = (8.0 + 7.0 * act + 16.0 * fl + 14.0 * after) * (1.0 - 0.2 * pre);
      float corona = exp(-dd / cw) * outside;
      float swell = 0.8 + 0.4 * noise(vec2(t * 0.35, uSeed));
      heat += corona * mix(0.5, 1.0, topW)
            * (0.12 * uBreath + 0.08 * act * swell + 0.28 * fl + 0.22 * after + 0.12 * pre);
      float wn = fbm3(vec2(u / 34.0 - t * 0.18 + uSeed, dd / 9.0 - t * 0.25));
      heat += smoothstep(0.58, 0.88, wn) * exp(-dd / 13.0) * smoothstep(0.0, 3.0, dd)
            * (0.17 * uBreath + 0.1 * act) * outside;
      tint += mix(uOff1, uOff2, smoothstep(0.3, 0.8, wn)) * corona * after * 0.08;
      if (pre > 0.01) {
        // Gathering: faint streaks fall in towards the rim, faster as the charge builds.
        float g = smoothstep(0.62, 0.92, noise(vec2(u / 7.0 + uSeed, dd / 10.0 + uClock * (3.0 + 5.0 * pre))));
        heat += g * pre * 0.3 * exp(-dd / 26.0) * smoothstep(70.0, 0.0, dd) * outside;
        // Heat-up: the edge heats like metal, unevenly (hot spots spread along it) through
        // dull orange, yellow, to white-hot; it swells into a bloom and the air above it
        // shimmers.
        float T = clamp(pre * 1.3 - 0.3 * noise(vec2(u / 55.0 + uSeed, uClock * 0.6)), 0.0, 1.0);
        float shim = (noise(vec2(u / 4.0, uClock * 11.0)) - 0.5) * 1.6 * T;
        float rimH = exp(-abs(d - 0.4 - shim) / (0.6 + 1.4 * T)) * smoothstep(-1.5, 0.0, d);
        float halo = exp(-dd / (3.0 + 20.0 * T * T)) * outside;
        float hazeN = smoothstep(0.6, 0.9, fbm3(vec2(vPos.x / 6.0 + sin(up / 9.0 + uClock * 5.0) * 0.6, up / 22.0 + uClock * 2.4) + uSeed));
        float haze = hazeN * smoothstep(0.0, 6.0, up) * exp(-up / 18.0) * topW * T * T;
        vec3 bb = blackbody(T);
        tint += bb * (rimH * (0.2 + 1.5 * T) + halo * (0.12 + 0.4 * T * T) + haze * 0.12);
        tintA += (rimH * 0.5 + halo * 0.2) * T;
        heat += rimH * 0.25 * T;
      }
      float fire = act * 0.8 + fl;
      if (fire > 0.02)
        heat += flames(vPos, d, up, 28.0 * (0.35 + 0.65 * act + 1.1 * fl), 1.0, fl, t, ft, add) * min(fire, 1.0);
    }
  }

  vec4 col = ramp(heat) * uGain * uFade;
  // Paint on paper (light theme): let the shapes thin out instead of a solid silhouette.
  float light = step(0.5, uAlphaK);
  col *= mix(1.0, 0.15 + 0.85 * clamp(heat * 1.4, 0.0, 1.0), light);
  col.rgb += (uC3 * 0.6 + uC2 * 0.4) * add * uFade * uGain;
  col.rgb += tint * uFade * uGain * (1.0 - light);
  // uAlphaK: 0 = additive light (dark theme), 1 = normal paint (light theme).
  // tint is light (dark theme only); on paper its alpha would only paint grey.
  float a = clamp(col.a * uAlphaK + (add * 0.5 + tintA * (1.0 - light)) * uAlphaK * uFade, 0.0, 1.0);
  outColor = vec4(col.rgb, a) * win;
}`;

const POINT_VS = `#version 300 es
in vec4 aP;            // x, y, size, temperature (0..1)
in vec3 aQ;            // alpha, palette slot, sharpness (0 soft glow .. 1 hard spark)
uniform vec2 uRes;
uniform float uDpr;
uniform vec3 uPal[28]; // 7 slots x deep, mid, hot, core
out vec3 vC;
out float vA;
out float vS;
void main() {
  vec2 clip = aP.xy / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = aP.z * uDpr;
  int k = int(aQ.y + 0.5) * 4;
  float T = aP.w;
  vec3 c = mix(uPal[k], uPal[k + 1], smoothstep(0.0, 0.35, T));
  c = mix(c, uPal[k + 2], smoothstep(0.3, 0.7, T));
  vC = mix(c, uPal[k + 3], smoothstep(0.75, 1.0, T));
  vA = aQ.x;
  vS = aQ.z;
}`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec3 vC;
in float vA;
in float vS;
out vec4 outColor;
uniform float uAlphaK;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float soft = smoothstep(1.0, 0.0, r);
  soft = soft * soft * (0.6 + 0.4 * smoothstep(0.5, 0.0, r));
  float halo = smoothstep(1.0, 0.0, r);
  float sharp = smoothstep(0.62, 0.15, r) + 0.3 * halo * halo;
  float a = mix(soft, sharp, vS) * vA;
  outColor = vec4(vC * a * 1.6, a * uAlphaK);
}`;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  topY: number;
  radius: number;
}

/**
 * kind 0: rising ember / cinder (buoyant)    kind 1: falling spark (gravity, streak)
 * kind 2: spark-tier sparklet (fizzles, drifts) kind 3: nova charge mote (falls in)
 * kind 4: nova debris (fast, light gravity, streak)
 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  temp: number; // 1 hot -> 0 cold
  cool: number; // per second
  size: number;
  seed: number;
  pal: number;
  kind: 0 | 1 | 2 | 3 | 4;
  age: number;
  ttl: number;
  amp: number;
  /** sparklet: current brightness, written by the step for arcs / the shader */
  b: number;
}

/** A short electric arc between two live sparklets. */
interface Arc {
  a: Particle;
  b: Particle;
  age: number;
  ttl: number;
  seed: number;
}

interface Layer {
  /** What it is for (its colours). */
  id: FxId;
  /** Which style draws it (STYLE[id]). */
  tier: TierId;
  seed: number;
  fade: number;
  fading: boolean;
  flareAt: number; // wall clock s
  ts: number; // this flare's time stretch
  act: number;
  actV: number;
  time: number;
  fl: number;
  pre: number;
  ft: number;
  blasted: boolean;
  trickle: number;
  nextSpawn: number;
}

const MAX_PARTICLES = 420;
/** Seconds after nova's eruption that the remnant nebula lasts. */
const REMNANT = 11;
const MAX_POINTS = 4200;
const FLOATS = 7;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const hash1 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
/** Smooth 1-D value noise, 0..1. */
const noise1 = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
};
const softplus = (x: number) => (x > 4 ? x : Math.log(1 + Math.exp(4 * x)) / 4);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function createEngine(canvas: HTMLCanvasElement, host: HTMLElement) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "");
    return s;
  };
  const program = (vs: string, fs: string) => {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "");
    return p;
  };
  let fxProg: WebGLProgram;
  let ptProg: WebGLProgram;
  try {
    fxProg = program(QUAD_VS, FX_FS);
    ptProg = program(POINT_VS, POINT_FS);
  } catch (err) {
    console.warn("[fx] shader setup failed, using the static tint", err);
    return null;
  }
  const U = (p: WebGLProgram, names: string[]) =>
    Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
  const fu = U(fxProg, [
    "uRes",
    "uTime",
    "uClock",
    "uFT",
    "uFl",
    "uPre",
    "uAct",
    "uFade",
    "uBreath",
    "uSeed",
    "uAlphaK",
    "uGain",
    "uHaze",
    "uRadius",
    "uTopY",
    "uMode",
    "uTier",
    "uRect",
    "uBand",
    "uC0",
    "uC1",
    "uC2",
    "uC3",
    "uOff1",
    "uOff2",
    "uDusk",
    "uSparks",
  ]);
  const pu = U(ptProg, ["uRes", "uDpr", "uAlphaK", "uPal"]);

  const quadBuf = gl.createBuffer()!;
  const quadVao = gl.createVertexArray()!;
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aPos = gl.getAttribLocation(fxProg, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const ptData = new Float32Array(MAX_POINTS * FLOATS);
  const ptBuf = gl.createBuffer()!;
  const ptVao = gl.createVertexArray()!;
  gl.bindVertexArray(ptVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
  gl.bufferData(gl.ARRAY_BUFFER, ptData.byteLength, gl.DYNAMIC_DRAW);
  const aP = gl.getAttribLocation(ptProg, "aP");
  const aQ = gl.getAttribLocation(ptProg, "aQ");
  gl.enableVertexAttribArray(aP);
  gl.vertexAttribPointer(aP, 4, gl.FLOAT, false, FLOATS * 4, 0);
  gl.enableVertexAttribArray(aQ);
  gl.vertexAttribPointer(aQ, 3, gl.FLOAT, false, FLOATS * 4, 16);
  gl.bindVertexArray(null);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // ---- state ----
  const start = performance.now();
  const clock = () => (performance.now() - start) / 1000;
  let layers: Layer[] = [];
  let active = false;
  let flareKey = 0;
  let particles: Particle[] = [];
  let arcs: Arc[] = [];
  let raf = 0;
  let timer = 0;
  let last = 0;
  let blurredAt = document.hasFocus() ? -1 : clock();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let pal = new Float32Array(84);
  let off = { a: [0.5, 0.3, 1], b: [0.2, 0.8, 1], dusk: [0.5, 0.15, 0.4] };
  let alphaK = 0;
  let gain = 1;

  const readColor = (name: string, probe: CanvasRenderingContext2D) => {
    probe.fillStyle = "#000";
    probe.fillStyle =
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ff7a3d";
    // Browsers normalise opaque colours to "#rrggbb".
    const hex = /^#([0-9a-f]{6})$/i.exec(String(probe.fillStyle))?.[1] ?? "ff7a3d";
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const setPalette = () => {
    const probe = document.createElement("canvas").getContext("2d")!;
    off = {
      a: readColor("--fx-nova-off1", probe),
      b: readColor("--fx-nova-off2", probe),
      dusk: readColor("--fx-solstice-dusk", probe),
    };
    const novaCore = readColor("--fx-nova-core", probe);
    pal = new Float32Array([
      ...TIER_IDS.flatMap((t) =>
        ["deep", "mid", "hot", "core"].flatMap((k) => readColor(`--fx-${t}-${k}`, probe)),
      ),
      // OFF slot: nova debris cooling through cyan and violet.
      ...readColor("--fx-nova-deep", probe),
      ...off.a,
      ...off.b,
      ...novaCore,
      ...FALLBACK_IDS.flatMap((t) =>
        ["deep", "mid", "hot", "core"].flatMap((k) => readColor(`--fx-${t}-${k}`, probe)),
      ),
    ]);
    const light = document.documentElement.dataset.theme === "light";
    alphaK = light ? 1 : 0.12;
    gain = light ? 1 : 0.9;
  };
  setPalette();
  const color = (id: FxId, k: number) =>
    pal.subarray(PAL[id] * 12 + k * 3, PAL[id] * 12 + k * 3 + 3);

  const resize = () => {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    w = host.clientWidth;
    h = host.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (!raf && !timer) draw(0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const composerRect = (): Rect | null => {
    const el = host.querySelector<HTMLElement>(".composer");
    const header = host.querySelector<HTMLElement>(".thread-header");
    const hr = host.getBoundingClientRect();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left - hr.left,
      y: r.top - hr.top,
      w: r.width,
      h: r.height,
      topY: header ? header.getBoundingClientRect().bottom - hr.top : 0,
      radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12,
    };
  };

  // Rounded-rect perimeter, clockwise from the top edge's left end. Returns a point on the
  // border and the outward normal.
  const perimLength = (r: Rect) =>
    2 * (r.w - 2 * r.radius) + 2 * (r.h - 2 * r.radius) + 2 * Math.PI * r.radius;
  const perim = (r: Rect, s: number) => {
    const R = r.radius;
    const a = r.w - 2 * R;
    const b = r.h - 2 * R;
    const q = (Math.PI / 2) * R;
    const L = perimLength(r);
    s = ((s % L) + L) % L;
    const arc = (cx: number, cy: number, from: number, u: number) => {
      const ang = from + (u / q) * (Math.PI / 2);
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      return { x: cx + nx * R, y: cy + ny * R, nx, ny };
    };
    if (s < a) return { x: r.x + R + s, y: r.y, nx: 0, ny: -1 };
    s -= a;
    if (s < q) return arc(r.x + r.w - R, r.y + R, -Math.PI / 2, s);
    s -= q;
    if (s < b) return { x: r.x + r.w, y: r.y + R + s, nx: 1, ny: 0 };
    s -= b;
    if (s < q) return arc(r.x + r.w - R, r.y + r.h - R, 0, s);
    s -= q;
    if (s < a) return { x: r.x + r.w - R - s, y: r.y + r.h, nx: 0, ny: 1 };
    s -= a;
    if (s < q) return arc(r.x + R, r.y + r.h - R, Math.PI / 2, s);
    s -= q;
    if (s < b) return { x: r.x, y: r.y + r.h - R - s, nx: -1, ny: 0 };
    s -= b;
    return arc(r.x + R, r.y + R, Math.PI, s);
  };
  /** A random point on the edge, kept off the bottom (sparks there would hit the window). */
  const edgePoint = (r: Rect, maxY = 0.6) => {
    const L = perimLength(r);
    for (let i = 0; i < 12; i++) {
      const p = perim(r, Math.random() * L);
      if (p.y <= r.y + r.h * maxY) return p;
    }
    return perim(r, Math.random() * (r.w - 2 * r.radius));
  };

  // Nova's heat-up also warms the composer's own border and inner edge (a CSS variable on
  // the element, only while it is heating; effects.css draws it).
  let heatShown = 0;
  const setHeat = (v: number) => {
    const el = host.querySelector<HTMLElement>(".composer");
    if (!el) return;
    v = v < 0.01 ? 0 : Math.round(v * 50) / 50;
    if (v === heatShown) return;
    heatShown = v;
    if (!v) {
      el.classList.remove("fx-heating");
      el.style.removeProperty("--fx-heat");
      el.style.removeProperty("--fx-heat-color");
      return;
    }
    el.classList.add("fx-heating");
    el.style.setProperty("--fx-heat", String(v));
    // Same thermal ramp as the shader: dull orange -> yellow -> white (dark theme); on paper
    // a deepening orange-red.
    const T = clamp(v * 1.15, 0, 1);
    const light = alphaK >= 1;
    const rgb = light
      ? [234 - 60 * T, 88 - 40 * T, 12]
      : T < 0.5
        ? [235 + 20 * (T / 0.5), 70 + 120 * (T / 0.5), 20 + 40 * (T / 0.5)]
        : [255, 190 + 60 * ((T - 0.5) / 0.5), 60 + 180 * ((T - 0.5) / 0.5)];
    el.style.setProperty("--fx-heat-color", `rgb(${rgb.map(Math.round).join(" ")})`);
  };

  // ---- envelopes ----
  const stepFlare = (l: Layer, now: number) => {
    const f = FLARE[l.tier];
    const tt = (now - l.flareAt) / l.ts;
    l.ft = tt - f.pre;
    if (tt < 0 || tt > f.pre + f.len) {
      l.fl = 0;
      l.pre = 0;
      return;
    }
    // Charge: a slow gather that tips over into the peak, then lets go quickly.
    l.pre = f.pre > 0 ? (tt < f.pre ? Math.pow(tt / f.pre, 1.6) : Math.exp(-(tt - f.pre) * 7)) : 0;
    const t = l.ft;
    if (t <= 0) {
      l.fl = 0;
      return;
    }
    const x = clamp(t / f.rise, 0, 1);
    const attack = x * x * x * (x * (x * 6 - 15) + 10);
    const k = softplus(t - f.rise);
    const decay = f.m * Math.exp(-f.k1 * k) + (1 - f.m) * Math.exp(-f.k2 * k);
    const tail = smooth(f.len, f.len * 0.55, t);
    // A little unevenness so no two flares fall off the same way.
    const wobble = 1 + 0.12 * (noise1(t * 2.3 + l.seed) - 0.5) * smooth(0, 0.6, t);
    l.fl = attack * decay * tail * wobble;
  };

  // ---- particles ----
  const pushParticle = (p: Partial<Particle> & { x: number; y: number }) => {
    if (particles.length >= MAX_PARTICLES) return null;
    const e: Particle = {
      vx: 0,
      vy: 0,
      temp: 1,
      cool: 1,
      size: 2,
      seed: Math.random() * 100,
      pal: 0,
      kind: 0,
      age: 0,
      ttl: 99,
      amp: 1,
      b: 0,
      ...p,
    };
    particles.push(e);
    return e;
  };

  /** Rising embers off the top edge; `burst` throws them higher and wider. */
  const spawnEmbers = (l: Layer, r: Rect, n: number, burst: boolean, small = false) => {
    const nova = l.tier === "nova";
    for (let i = 0; i < n; i++) {
      const spread = burst ? 1 : 0.35;
      pushParticle({
        x: r.x + r.radius + Math.random() * (r.w - r.radius * 2),
        y: r.y - 2 - Math.random() * (small ? 4 : 10),
        vx: (Math.random() - 0.5) * 70 * spread,
        vy: small
          ? -rand(12, 34)
          : -(30 + Math.random() * (burst ? 190 : 70)) * (nova ? 0.85 : 0.7),
        temp: small ? rand(0.7, 0.95) : rand(0.75, 1),
        cool: small ? rand(0.16, 0.3) : rand(0.32, 0.77),
        size: small ? rand(2.4, 3.6) : (burst ? 3.4 : 3) + Math.random() * (nova ? 4.5 : 3.5),
        pal: PAL[l.id],
        kind: 0,
      });
    }
  };

  /** A spark fizzling in just outside the edge. `k` 0..1 = how strong. */
  const spawnSparklet = (r: Rect, k: number) => {
    const p = edgePoint(r, 0.55);
    const out = rand(2, 10) + 6 * k * Math.random();
    const e = pushParticle({
      x: clamp(p.x + p.nx * out + rand(-3, 3), 10, w - 10),
      y: clamp(p.y + p.ny * out + rand(-2, 2), 10, h - 10),
      vx: p.nx * rand(3, 14) + rand(-7, 7),
      vy: p.ny * rand(3, 14) - rand(2, 9),
      temp: 1,
      cool: 0,
      size: rand(3, 4.4) * (0.85 + 0.35 * k),
      pal: TIER_INDEX.spark,
      kind: 2,
      ttl: rand(0.22, 0.85) * (0.75 + 0.5 * k),
      amp: rand(0.55, 1) * (0.45 + 0.55 * k),
    });
    if (!e) return;
    // Now and then an arc jumps to a neighbour that is still alive.
    if (Math.random() < 0.15 + 0.4 * k) {
      const near = particles.find(
        (o) =>
          o !== e &&
          o.kind === 2 &&
          o.age < o.ttl * 0.7 &&
          Math.hypot(o.x - e.x, o.y - e.y) > 14 &&
          Math.hypot(o.x - e.x, o.y - e.y) < 30 + 60 * k,
      );
      if (near && arcs.length < 6)
        arcs.push({
          a: e,
          b: near,
          age: -rand(0.02, 0.1),
          ttl: rand(0.05, 0.14),
          seed: Math.random() * 100,
        });
    }
  };

  /** Nova's charge: motes a little way out fall in towards the rim. */
  const spawnMote = (r: Rect) => {
    const p = edgePoint(r, 0.7);
    const dist = rand(30, 85);
    pushParticle({
      x: p.x + p.nx * dist + rand(-10, 10),
      y: p.y + p.ny * dist + rand(-6, 6),
      vx: -p.nx * rand(30, 60),
      vy: -p.ny * rand(30, 60),
      temp: rand(0.55, 0.8),
      cool: 0,
      size: rand(1.8, 3),
      pal: TIER_INDEX.nova,
      kind: 3,
      ttl: rand(0.45, 0.7),
      amp: rand(0.5, 0.9),
      seed: dist,
    });
  };

  /** Nova's eruption debris, thrown out along the whole edge. */
  const spawnDebris = (r: Rect) => {
    const L = perimLength(r);
    for (let i = 0; i < 110; i++) {
      const p = perim(r, Math.random() * L);
      const bottom = p.ny > 0.5;
      if (bottom && Math.random() < 0.75) continue;
      const sp = rand(90, 520) * (Math.random() < 0.25 ? 0.4 : 1);
      const tx = -p.ny;
      const ty = p.nx;
      const tang = rand(-90, 90);
      const offPal = Math.random() < 0.16;
      pushParticle({
        x: p.x + p.nx * 2,
        y: p.y + p.ny * 2,
        vx: p.nx * sp + tx * tang,
        vy: p.ny * sp + ty * tang - rand(0, 60),
        temp: rand(0.85, 1),
        cool: rand(0.5, 1.3),
        size: rand(1.6, 3.2),
        pal: offPal ? OFF : TIER_INDEX.nova,
        kind: 4,
      });
    }
  };

  // ---- step ----
  const stepLayer = (l: Layer, dt: number, now: number, r: Rect) => {
    stepFlare(l, now);
    // Critically damped spring towards the target: eases in and out, never snaps.
    const target = !l.fading && active ? 1 : 0;
    const om = target > l.act ? 2.6 : 1.6;
    l.actV += (om * om * (target - l.act) - 2 * om * l.actV) * dt;
    l.act = clamp(l.act + l.actV * dt, 0, 1);
    if (l.act < 0.0005 && target === 0) {
      l.act = 0;
      l.actV = 0;
    }
    l.time += dt * (0.3 + 0.7 * l.act + 0.6 * l.fl);
    if (l.fading) l.fade = Math.max(0, l.fade - dt / 0.6);
    if (l.fading) return;

    if (l.tier === "nova" && !l.blasted && l.ft >= 0 && l.ft < 1) {
      l.blasted = true;
      spawnDebris(r);
      spawnEmbers(l, r, 34, true);
    }

    // Steady sources for the live layer: rate per second, Poisson-ish.
    let rate = 0;
    if (l.tier === "solstice") rate = 0.8 + 2.0 * l.act + 4 * l.fl;
    if (l.tier === "nova") rate = 0.45 + 4.0 * l.act;
    if (rate) {
      l.trickle += rate * dt * (0.6 + 0.8 * noise1(now * 0.7 + l.seed));
      while (l.trickle >= 1) {
        // Idle cinders are small and slow; active ones are proper embers.
        spawnEmbers(l, r, 1, false, Math.random() > l.act * 0.8);
        l.trickle -= 1;
      }
    }
    if (l.tier === "nova" && l.pre > 0.02 && l.ft < 0) {
      l.trickle += 40 * l.pre * dt;
      while (l.trickle >= 1) {
        spawnMote(r);
        l.trickle -= 1;
      }
    }
    if (l.tier === "spark") {
      // Idle: a lone spark every few seconds. Active: a few a second. Flare: a scatter.
      const k = Math.max(l.fl, 0.35 + 0.35 * l.act);
      const sparkRate = 0.4 + 4.2 * l.act + 36 * l.fl;
      l.nextSpawn -= dt * sparkRate;
      while (l.nextSpawn <= 0) {
        spawnSparklet(r, k);
        l.nextSpawn += -Math.log(1 - Math.random() * 0.98);
      }
    }
  };

  const stepParticles = (dt: number, t: number, r: Rect) => {
    const next: Particle[] = [];
    for (const e of particles) {
      e.age += dt;
      e.temp -= e.cool * dt;
      if (e.temp <= 0 || e.age >= e.ttl) continue;
      if (e.y > h + 10 || e.y < -10 || e.x < -10 || e.x > w + 10) continue;
      if (e.kind === 0) {
        if (r.y - e.y > 220) continue;
        // Buoyancy fades as the ember cools; drag; a swirling turbulence field.
        const buoy = 95 * e.temp * e.temp;
        const tx =
          Math.sin(e.y * 0.021 + t * 1.7 + e.seed) +
          0.6 * Math.sin(e.x * 0.013 - t * 1.1 + e.seed * 0.5);
        const ty = Math.cos(e.x * 0.017 + t * 1.3 + e.seed) * 0.5;
        e.vx += tx * 55 * dt;
        e.vy += (-buoy + ty * 30) * dt;
        const drag = 1 - 1.1 * dt;
        e.vx *= drag;
        e.vy *= drag;
      } else if (e.kind === 1) {
        e.vy += 520 * dt;
        const drag = 1 - 1.6 * dt;
        e.vx *= drag;
        e.vy *= drag;
      } else if (e.kind === 2) {
        // Brownian drift, gently damped; it fizzles: on/off flicker under an envelope.
        e.vx += rand(-1, 1) * 70 * dt;
        e.vy += (rand(-1, 1) * 70 - 6) * dt;
        const drag = 1 - 2.2 * dt;
        e.vx *= drag;
        e.vy *= drag;
        const u = e.age / e.ttl;
        const env = smooth(0, 0.18, u) * (1 - smooth(0.5, 1, u));
        const fizz = noise1(e.age * 34 + e.seed * 13);
        e.b = e.amp * env * (0.3 + 0.7 * smooth(0.3, 0.65, fizz));
        // A crackle now and then throws a tiny falling bit.
        if (Math.random() < dt * 2.5 * e.amp && particles.length < MAX_PARTICLES - 4)
          next.push({
            ...e,
            kind: 1,
            vx: rand(-40, 40),
            vy: rand(-50, 10),
            temp: rand(0.7, 1),
            cool: rand(3, 5),
            size: 1.4,
            ttl: 99,
            age: 0,
            amp: e.amp * 0.6,
          });
      } else if (e.kind === 3) {
        // Mote: accelerates in, brightening, gone as it reaches the rim.
        e.vx *= 1 + 2.2 * dt;
        e.vy *= 1 + 2.2 * dt;
        e.temp = Math.min(1, e.temp + dt * 0.6);
      } else {
        // Debris: light gravity, air drag; a little buoyancy once it slows (hot plasma).
        e.vy += (160 - 90 * e.temp) * dt;
        const drag = 1 - 1.5 * dt;
        e.vx *= drag;
        e.vy *= drag;
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      next.push(e);
    }
    particles = next;
    arcs = arcs.filter((a) => {
      a.age += dt;
      return a.age < a.ttl && a.a.age < a.a.ttl && a.b.age < a.b.ttl;
    });
  };

  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w, x1);
    y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return;
    gl.uniform4f(fu.uBand, x0, y0, x1, y1);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]),
      gl.STREAM_DRAW,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const sparkUniform = new Float32Array(32);
  const breathOf = (l: Layer, now: number) =>
    0.62 + 0.4 * noise1(now * 0.13 + l.seed) + 0.14 * noise1(now * 0.41 + l.seed * 3);

  const drawLayer = (l: Layer, now: number, r: Rect) => {
    const c = (k: number) => color(l.id, k);
    gl.uniform1f(fu.uTime, l.time);
    gl.uniform1f(fu.uFT, l.ft);
    gl.uniform1f(fu.uFl, l.fl);
    gl.uniform1f(fu.uPre, l.pre);
    gl.uniform1f(fu.uAct, l.act);
    gl.uniform1f(fu.uFade, l.fade);
    gl.uniform1f(fu.uBreath, breathOf(l, now));
    gl.uniform1f(fu.uSeed, l.seed);
    gl.uniform1i(fu.uTier, TIER_INDEX[l.tier]);
    gl.uniform3fv(fu.uC0, c(0));
    gl.uniform3fv(fu.uC1, c(1));
    gl.uniform3fv(fu.uC2, c(2));
    gl.uniform3fv(fu.uC3, c(3));
    sparkUniform.fill(0);
    if (l.tier === "spark") {
      particles
        .filter((p) => p.kind === 2 && p.b > 0.02)
        .sort((a, b) => b.b - a.b)
        .slice(0, 8)
        .forEach((p, i) => sparkUniform.set([p.x, p.y, p.b, p.size / 3], i * 4));
    }
    gl.uniform4fv(fu.uSparks, sparkUniform);

    // Composer band: how far above / around the box this tier reaches right now. The shader
    // fades everything out before the band's edge, so these only need to be generous.
    let top = 60;
    let side = 50;
    let below = 34;
    if (l.tier === "ember") {
      top = 56;
      side = 34;
    }
    if (l.tier === "solstice") {
      // Everything solstice draws tapers off inside the composer's own width.
      top = l.ft > 0 && l.ft < 8 ? 270 : 70 + 50 * l.act;
      side = 12;
    }
    if (l.tier === "nova") {
      top = 72 + 90 * l.act + 150 * l.fl + 60 * l.pre;
      side = 56 + 40 * l.fl + 70 * l.pre;
    }
    gl.uniform1i(fu.uMode, 0);
    quad(r.x - side, r.y - top, r.x + r.w + side, r.y + r.h + below);

    const filament =
      l.tier === "nova"
        ? Math.max(l.act, l.fl)
        : l.tier === "solstice"
          ? Math.max(l.act * 0.6, l.fl)
          : 0;
    if (filament > 0.01) {
      gl.uniform1i(fu.uMode, 1);
      quad(0, r.topY - 18, w, r.topY + 44);
    }
    if (l.tier === "nova" && l.ft > 0 && l.ft < REMNANT) {
      // The shock fronts while they last (lopsided, so up to ~1.6x R), then the remnant.
      const R = 6 + 600 * (1 - Math.exp(-l.ft * 1.7));
      const m = l.ft < 4.2 ? Math.max(R * 1.6 + 60, 440) : 440;
      gl.uniform1i(fu.uMode, 2);
      quad(r.x - m, r.y - m, r.x + r.w + m, r.y + r.h + m);
    }
  };

  const draw = (dt: number) => {
    const now = clock();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const r = composerRect();
    if (!r) return;
    for (const l of layers) stepLayer(l, dt, now, r);
    layers = layers.filter((l) => l.fade > 0);
    setHeat(layers.find((l) => l.tier === "nova" && !l.fading)?.pre ?? 0);
    stepParticles(dt, now, r);

    gl.useProgram(fxProg);
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.uniform2f(fu.uRes, w, h);
    gl.uniform1f(fu.uClock, now);
    gl.uniform1f(fu.uAlphaK, alphaK);
    gl.uniform1f(fu.uGain, gain);
    gl.uniform1f(fu.uHaze, alphaK < 1 ? 1 : 0);
    gl.uniform1f(fu.uRadius, r.radius);
    gl.uniform1f(fu.uTopY, r.topY);
    gl.uniform4f(fu.uRect, r.x, r.y, r.w, r.h);
    gl.uniform3fv(fu.uOff1, off.a);
    gl.uniform3fv(fu.uOff2, off.b);
    gl.uniform3fv(fu.uDusk, off.dusk);
    for (const l of layers) drawLayer(l, now, r);

    // ---- points ----
    let i = 0;
    let n = 0;
    const put = (
      x: number,
      y: number,
      size: number,
      temp: number,
      a: number,
      p: number,
      s: number,
    ) => {
      if (n >= MAX_POINTS) return;
      // Fade out near the canvas edges rather than get cut off by them.
      a *= clamp(Math.min(x, w - x, y, h - y) / 14, 0, 1);
      if (a <= 0.003) return;
      ptData[i++] = x;
      ptData[i++] = y;
      ptData[i++] = size;
      ptData[i++] = temp;
      ptData[i++] = a;
      ptData[i++] = p;
      ptData[i++] = s;
      n++;
    };
    const fadeOf = (p: number) =>
      layers.find((l) => PAL[l.id] === (p === OFF ? PAL.nova : p))?.fade ?? 1;

    for (const e of particles) {
      const fade = fadeOf(e.pal);
      if (e.kind === 0) {
        const flicker = 0.75 + 0.25 * noise1(now * 9 + e.seed * 7);
        const keep = Math.min(1, Math.max(0, (200 - (r.y - e.y)) / 70));
        put(
          e.x,
          e.y,
          e.size * (0.6 + 0.4 * e.temp),
          e.temp,
          Math.min(1, e.temp * 2.2) * flicker * keep * fade,
          e.pal,
          0,
        );
      } else if (e.kind === 1 || e.kind === 4) {
        const a = Math.min(1, e.temp * 1.6) * fade * (e.kind === 1 ? e.amp : 1);
        put(e.x, e.y, e.size, e.temp, a, e.pal, 1);
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 60) {
          put(
            e.x - e.vx * 0.01,
            e.y - e.vy * 0.01,
            e.size * 0.85,
            e.temp * 0.85,
            a * 0.6,
            e.pal,
            1,
          );
          put(e.x - e.vx * 0.02, e.y - e.vy * 0.02, e.size * 0.7, e.temp * 0.7, a * 0.35, e.pal, 1);
        }
        if (e.kind === 4) put(e.x, e.y, e.size * 4, e.temp * 0.6, a * 0.14, e.pal, 0);
      } else if (e.kind === 2) {
        if (e.b <= 0.01) continue;
        const b = e.b * fade;
        // Most glow ice-blue; about a third burn white-gold.
        const gold = e.seed % 3 < 1;
        put(e.x, e.y, e.size, 0.85 + 0.15 * b, Math.min(1, b * 2), e.pal, 1);
        put(e.x, e.y, e.size * 4.5, gold ? 0.9 : 0.55, b * (gold ? 0.3 : 0.4), e.pal, 0);
        // Crackle: two or three tiny jagged filaments, re-rolled ~25 times a second.
        if (b > 0.25) {
          const roll = Math.floor(now * 25) + e.seed * 31;
          const m = 2 + Math.floor(hash1(roll) * 2);
          for (let j = 0; j < m; j++) {
            const ang = hash1(roll + j * 7.1) * Math.PI * 2;
            const len = 4 + hash1(roll + j * 3.3) * 9 * e.amp;
            for (let s = 1; s <= 5; s++) {
              const jit = (hash1(roll + j * 11 + s) - 0.5) * 2;
              const dx = (Math.cos(ang) * (len * s)) / 5 - Math.sin(ang) * jit;
              const dy = (Math.sin(ang) * (len * s)) / 5 + Math.cos(ang) * jit;
              put(e.x + dx, e.y + dy, 1.8, 0.9, b * (1 - s * 0.16), e.pal, 1);
            }
          }
        }
      } else {
        const a = smooth(0, 0.25, e.age) * e.amp * fade;
        put(e.x, e.y, e.size, e.temp, a, e.pal, 0.6);
      }
    }
    // Arcs: a jagged chain between two sparks, re-struck every frame or two.
    for (const a of arcs) {
      if (a.age < 0) continue;
      const env = Math.sin(Math.PI * clamp(a.age / a.ttl, 0, 1));
      const dx = a.b.x - a.a.x;
      const dy = a.b.y - a.a.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const roll = Math.floor(clock() * 40) + a.seed;
      const N = Math.ceil(len / 1.6);
      for (let k = 0; k <= N; k++) {
        const u = k / N;
        const j =
          (Math.sin(u * 9 + roll) * 0.6 + (hash1(roll + k * 0.37) - 0.5) * 0.8) *
          len *
          0.09 *
          Math.sin(Math.PI * u);
        put(
          a.a.x + dx * u + nx * j,
          a.a.y + dy * u + ny * j,
          1.7,
          0.95,
          env * 0.85 * fadeOf(TIER_INDEX.spark),
          TIER_INDEX.spark,
          1,
        );
      }
    }
    if (n) {
      gl.useProgram(ptProg);
      gl.bindVertexArray(ptVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptData, 0, i);
      gl.uniform2f(pu.uRes, w, h);
      gl.uniform1f(pu.uDpr, dpr);
      gl.uniform1f(pu.uAlphaK, alphaK);
      gl.uniform3fv(pu.uPal, pal);
      gl.drawArrays(gl.POINTS, 0, n);
    }
    gl.bindVertexArray(null);
  };

  /** Something is moving fast enough to need full frame rate. */
  const busy = () =>
    arcs.length > 0 ||
    particles.some((p) => p.kind !== 0 || Math.abs(p.vy) > 45) ||
    layers.some(
      (l) =>
        l.fading ||
        l.fl > 0.002 ||
        l.pre > 0.002 ||
        l.act > 0.002 ||
        active ||
        (l.tier === "nova" && l.ft > 0 && l.ft < REMNANT),
    );

  const frame = (now: number) => {
    raf = 0;
    timer = 0;
    const dt = Math.min(0.06, last ? (now - last) / 1000 : 0.016);
    last = now;
    draw(dt);
    schedule();
  };

  const schedule = () => {
    if (raf || timer || document.hidden) return;
    if (!layers.length && !particles.length) {
      last = 0;
      draw(0); // clear
      return;
    }
    const focused = document.hasFocus();
    if (busy()) {
      // Full rate while the window has focus, ~30 fps behind other windows.
      if (focused) raf = requestAnimationFrame(frame);
      else timer = window.setTimeout(() => frame(performance.now()), 33);
      return;
    }
    // Idle: 20 fps; behind other windows 10 fps, and stop after a few seconds (the last
    // frame stays on screen; focus brings it back).
    if (!focused && blurredAt >= 0 && clock() - blurredAt > 8) {
      last = 0;
      return;
    }
    timer = window.setTimeout(() => frame(performance.now()), focused ? 50 : 100);
  };

  const stop = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    last = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : schedule());
  const onFocus = () => {
    blurredAt = -1;
    schedule();
  };
  const onBlur = () => {
    blurredAt = clock();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  resize();

  const flare = (l: Layer) => {
    l.flareAt = clock();
    l.ts = rand(0.88, 1.14);
    l.seed = Math.random() * 100;
    l.blasted = false;
    const r = composerRect();
    if (!r) return;
    if (l.tier === "solstice") spawnEmbers(l, r, 10, true);
    if (l.tier === "spark") l.nextSpawn = 0.2;
  };

  return {
    set(id: FxId | null, isActive: boolean, key: number) {
      active = isActive;
      const cur = layers.find((l) => !l.fading);
      if (cur?.id !== id) {
        if (cur) cur.fading = true;
        if (id) {
          const l: Layer = {
            id,
            tier: STYLE[id],
            seed: Math.random() * 100,
            fade: 1,
            fading: false,
            flareAt: 0,
            ts: 1,
            act: 0,
            actV: 0,
            time: Math.random() * 50,
            fl: 0,
            pre: 0,
            ft: 99,
            blasted: false,
            trickle: 0,
            nextSpawn: 1,
          };
          layers.push(l);
          flare(l);
        }
      } else if (cur && key !== flareKey) {
        flare(cur);
      }
      flareKey = key;
      // Restart the loop at full rate for the change.
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      schedule();
    },
    setPalette() {
      setPalette();
      schedule();
    },
    destroy() {
      stop();
      setHeat(0);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    },
  };
}
