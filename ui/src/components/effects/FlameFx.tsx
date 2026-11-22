// Tier effects: one WebGL2 canvas behind the main column, always on for the selected tier.
//
// Three states, eased into each other:
//   flare    when the tier changes (and on first load): a short ignition in the tier's style
//   idle     after the flare: an almost-still ambient animation, drawn at a low frame rate
//   active   while a turn streams: livelier than idle, well below the flare's peak
//
// Each tier has its own look (fragment shader branch + its own particles):
//   ember     a warm glow breathing round the composer; on switch (and now and then while
//             active) hairline heat cracks spread out from its edge and cool
//   spark     electric crackle: bright heads skip along the composer's edge trailing a
//             jagged arc and shedding falling sparks; idle is a rare tiny flick
//   solstice  warm flame licking off the top edge; on switch a sunrise (a golden bloom and
//             rays rising from the edge); idle is a low, slow corona lick
//   nova      a shimmering plasma rim all round; on switch a stellar ignition (flash,
//             shockwave ring, ember burst, the header filament lighting outward); while
//             active a breathing plasma corona with flames and embers
//
// Cheap by construction: DPR capped at 1.5, the shader runs only in a band around the
// composer (plus a strip under the header and, for nova's ignition, the shockwave's box),
// idle draws at 20 fps, background windows at 30 fps (idle stops after a few seconds
// unfocused), nothing runs while the tab is hidden. pointer-events: none. Under
// prefers-reduced-motion, or without WebGL2, nothing runs and effects.css draws a static
// tier tint instead.
import { useEffect, useRef } from "react";
import { useTheme } from "../../theme/theme";
import type { TierId } from "../../theme/tiers";
import { useReducedMotion, type FxState } from "./useFx";

export function FlameFx({ fx }: { fx: FxState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const theme = useTheme();
  const reduced = useReducedMotion();
  const tier = fx.tier?.id ?? null;

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
    engine.current?.set(tier, fx.streaming, fx.flareKey);
  }, [tier, fx.streaming, fx.flareKey, reduced]);

  return <canvas ref={ref} className="flame-fx" aria-hidden />;
}

// ---------------------------------------------------------------------------------------

type Engine = NonNullable<ReturnType<typeof createEngine>>;

const TIER_INDEX: Record<TierId, number> = { ember: 0, spark: 1, solstice: 2, nova: 3 };
const TIER_IDS: TierId[] = ["ember", "spark", "solstice", "nova"];

/** Flare envelope per tier: rise time (s), decay rate (1/s), total length (s). */
const FLARE: Record<TierId, { rise: number; decay: number; len: number }> = {
  ember: { rise: 0.3, decay: 1.9, len: 2.6 },
  spark: { rise: 0.05, decay: 2.2, len: 2.0 },
  solstice: { rise: 0.6, decay: 1.25, len: 3.8 },
  nova: { rise: 0.05, decay: 1.15, len: 4.0 },
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
uniform float uFT;      // seconds since the flare started
uniform float uFl;      // flare envelope 0..1
uniform float uAct;     // active 0..1 (eased)
uniform float uFade;    // layer opacity (cross-fade when the tier changes)
uniform float uAlphaK, uGain, uHaze, uRadius, uTopY;
uniform vec2 uRes;
uniform int uMode;      // 0 = composer band, 1 = header filament, 2 = nova shockwave
uniform int uTier;      // 0 ember, 1 spark, 2 solstice, 3 nova
uniform vec4 uRect;     // composer x, y, w, h (CSS px)
uniform vec3 uC0, uC1, uC2, uC3;
uniform vec4 uHeads[4]; // spark heads: x, y, brightness, -

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
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
// Voronoi border distance (F2 - F1): ~0 on the cell borders -> a network of cracks.
float cracks(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 r = g + hash2(i + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return sqrt(d2) - sqrt(d1);
}
float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
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
float flames(vec2 pos, float d, float up, float H0, float nova, float fl, float t,
             inout float add) {
  float topBand = smoothstep(uRect.y + uRadius + 2.0, uRect.y + 1.0, pos.y);
  vec2 q = pos / vec2(34.0, 52.0);
  q.y += t * (1.2 + 0.5 * nova);
  vec2 w = vec2(fbm(q + vec2(0.0, t * 0.15)), fbm(q + vec2(5.2, 1.3 - t * 0.1)));
  float n = fbm(q * vec2(1.5, 0.75) + 1.8 * w);
  float along = clamp((pos.x - uRect.x) / uRect.z, 0.0, 1.0);
  float shape = smoothstep(0.0, 0.14, along) * smoothstep(1.0, 0.86, along);
  float tall = pow(fbm(vec2(pos.x / 70.0, t * 0.22)), 2.0) * 2.4;
  float H = H0 * (0.25 + tall) * shape;
  float f = max(up, 0.0) / max(H, 1.0);
  float flame = smoothstep(0.95, 0.05, f + (n - 0.5) * 1.7);
  flame *= smoothstep(-1.0, 1.0, up) * topBand * smoothstep(0.0, 0.08, shape);
  float tip = clamp(f, 0.0, 1.0);
  float heat = flame * mix(0.62, 0.2, tip);
  heat += flame * smoothstep(0.5, 0.8, n) * smoothstep(0.45, 0.0, tip) * 0.42;
  // A living rim on the top border: mostly dim, with bright travelling knots.
  float rimN = fbm(pos / 20.0 + vec2(t * 1.2, -t * 0.4));
  float rim = exp(-abs(d - 0.3) / 0.7) * (0.18 + 0.75 * smoothstep(0.45, 0.8, rimN)) * topBand * shape;
  heat = max(heat, rim * 0.85);
  float glowUp = exp(-max(up, 0.0) / (12.0 + 8.0 * nova)) * smoothstep(-1.0, 2.0, up)
               * smoothstep(48.0, 10.0, up) * topBand * shape;
  heat += glowUp * (0.12 + 0.08 * nova) * (0.8 + 0.2 * sin(t * (1.3 + 0.7 * nova))) * uHaze
        * min(1.0, H0 / 14.0);
  // Heat haze: faint wisps off the tongues (dark theme only).
  float wisp = fbm(q * vec2(0.9, 0.5) + 2.4 * w - vec2(0.0, t * 0.2));
  heat += smoothstep(0.55, 0.85, wisp) * smoothstep(4.0, 22.0, up) * exp(-up / 34.0) * shape
        * 0.12 * uHaze * min(1.0, H0 / 20.0);
  // Flare: a sheet of flame leaps off the whole edge and falls back.
  float sheetH = 14.0 + 46.0 * (1.0 - exp(-uFT * 7.0));
  float sheet = exp(-max(up, 0.0) / sheetH) * smoothstep(-1.0, 1.0, up) * topBand * shape
              * smoothstep(0.25, 0.75, n) * fl;
  heat += sheet * (0.3 + 0.4 * nova);
  add += rim * fl * (0.3 + 0.6 * nova);
  return heat;
}

void main() {
  float t = uTime, ft = uFT, fl = uFl, act = uAct;
  float heat = 0.0;
  float add = 0.0;   // extra additive light (flash, ring, spark cores)

  if (uMode == 2) {
    // Nova ignition: a flash at the composer's top centre and a shockwave ring.
    vec2 v = vPos - vec2(uRect.x + uRect.z * 0.5, uRect.y);
    float r = length(v);
    float R = 24.0 + 720.0 * (1.0 - exp(-ft * 1.8));
    float wob = (noise(normalize(v + 0.001) * 3.0 + vec2(ft * 3.0, 0.0)) - 0.5) * (4.0 + R * 0.03);
    float width = 1.5 + R * 0.018;
    float life = exp(-ft * 2.1);
    float ring = exp(-abs(r - R + wob) / width) * life;
    float wake = exp(-abs(r - R * 0.86) / (width * 3.0)) * life * 0.25;
    float flash = exp(-r / (18.0 + 160.0 * ft)) * exp(-ft * 4.5);
    heat = ring * 0.5 + wake * 0.4 + flash * 0.8;
    add = ring * 0.35 + flash * 0.7;
  } else if (uMode == 1) {
    // Plasma filament under the header (solstice, nova): one hairline with a shimmer and
    // travelling highlights; on a flare it lights from the centre outwards.
    float nova = float(uTier == 3);
    float lvl = uTier == 3 ? max(act * 0.85, fl) : max(act * 0.55, fl * 0.75);
    float y = vPos.y - uTopY;
    float x = vPos.x / uRes.x;
    float ends = smoothstep(0.0, 0.25, x) * smoothstep(1.0, 0.75, x);
    float shimmer = 0.75 + 0.25 * fbm3(vec2(vPos.x / 140.0 - t * 0.4, t * 0.3));
    float speed = 0.07 + 0.05 * nova;
    float h1 = exp(-pow((fract(x - t * speed) - 0.5) * 7.0, 2.0));
    float h2 = exp(-pow((fract(x * 0.8 + t * speed * 0.6 + 0.37) - 0.5) * 9.0, 2.0)) * 0.6;
    float hi = max(h1, h2);
    float line = exp(-abs(y) / 0.6) * (0.28 * shimmer + 0.65 * hi);
    float glow = exp(-max(y, 0.0) / (6.0 + 4.0 * nova)) * smoothstep(-1.5, 0.5, y)
               * smoothstep(26.0, 4.0, y) * 0.22 * hi;
    float cx = (uRect.x + uRect.z * 0.5) / uRes.x;
    float front = 1.0 - exp(-ft * 2.6);
    float ign = exp(-ft * 2.4) * step(0.01, fl);
    float lit = mix(1.0, smoothstep(front + 0.03, front - 0.03, abs(x - cx)), ign);
    float spark = ign * exp(-abs(abs(x - cx) - front) * 60.0) * exp(-abs(y) / 2.0);
    heat = (line + glow) * lit * ends * lvl;
    add = spark * (0.4 + 0.6 * nova) * fl;
  } else {
    vec2 c = uRect.xy + uRect.zw * 0.5;
    float d = sdRound(vPos - c, uRect.zw * 0.5, uRadius);   // > 0 outside the composer
    if (d < -1.5) { outColor = vec4(0.0); return; }        // under the opaque composer
    float dd = max(d, 0.0);
    float up = uRect.y - vPos.y;                             // px above the top edge
    float along = clamp((vPos.x - uRect.x) / uRect.z, 0.0, 1.0);
    float topW = smoothstep(uRect.y + uRect.w * 0.9, uRect.y, vPos.y);
    float outside = smoothstep(-1.0, 0.5, d);
    float rimLine = exp(-abs(d - 0.3) / 0.65) * outside;

    if (uTier == 0) {
      // EMBER: a soft warm glow that breathes; heat cracks spread from the edge on a flare
      // and flicker up here and there while active.
      float breathe = 0.5 + 0.5 * sin(uClock * 0.8);
      float side = mix(0.35, 1.0, topW);
      float patchN = noise(vec2(vPos.x / 70.0 - t * 0.35, vPos.y / 50.0 + t * 0.1));
      float glow = exp(-dd / (6.0 + 5.0 * act + 10.0 * fl)) * outside;
      heat = glow * side * (0.15 + 0.08 * breathe + 0.2 * act * (0.5 + patchN) + 0.42 * fl);
      heat += rimLine * side * (0.16 + 0.1 * breathe + 0.28 * act * patchN + 0.5 * fl);
      float reach = 2.0 + 24.0 * fl * (1.0 - exp(-ft * 5.0)) + 10.0 * act;
      float flick = smoothstep(0.6, 0.8, noise(vec2(along * 9.0 + vPos.y * 0.03, t * 0.7)));
      float amount = fl + act * flick;
      if (amount > 0.01 && dd < reach + 2.0) {
        // Cells are laid out along the nearest edge and stretched away from it, so the
        // cracks run outwards from the border; a slow mask keeps them sparse.
        vec2 ap = abs(vPos - c) - uRect.zw * 0.5;
        float u = ap.x > ap.y ? vPos.y : vPos.x;
        float cr = cracks(vec2(u / 15.0, dd / 20.0 + 0.37));
        float sparse = smoothstep(0.3, 0.6, noise(vec2(u / 45.0, 3.1 + uFT * 0.3)));
        float line = smoothstep(0.075, 0.0, cr) * (0.25 + 0.75 * sparse);
        float fall = exp(-dd / max(reach * 0.45, 1.0)) * smoothstep(reach, reach * 0.4, dd);
        heat += line * fall * amount * outside * mix(0.5, 1.0, topW) * 0.75;
      }
    } else if (uTier == 1) {
      // SPARK: a barely-there rim; the bright heads (CPU particles) light the edge around
      // them with a flickering electric glow.
      heat = rimLine * (0.035 + 0.12 * act) * mix(0.4, 1.0, topW);
      float flick = noise(vec2((vPos.x + vPos.y) / 7.0, uClock * 26.0));
      for (int i = 0; i < 4; i++) {
        vec4 hd = uHeads[i];
        if (hd.z <= 0.0) continue;
        float r = length(vPos - hd.xy);
        heat += hd.z * outside * (exp(-r / 20.0) * exp(-dd / 6.0) * 0.28
                                + rimLine * exp(-r / 36.0) * (0.35 + 0.65 * flick) * 0.75);
        float jag = (noise(vec2((vPos.x + vPos.y) / 4.0, floor(uClock * 30.0) * 1.7)) - 0.5) * 5.0;
        heat += hd.z * outside * exp(-abs(d - 1.5 - jag) / 0.45) * exp(-r / 26.0) * 0.9;
        add += hd.z * exp(-r / 5.0) * 0.45;
      }
      heat += exp(-dd / 12.0) * outside * fl * exp(-ft * 3.5) * 0.4;
    } else if (uTier == 2) {
      // SOLSTICE: warm flame off the top edge, a sunrise on switch, a low lick when idle.
      float H0 = 22.0 * (0.3 + 0.6 * act + 1.2 * fl);
      heat = flames(vPos, d, up, H0, 0.0, fl, t, add) * (0.5 + 0.35 * act + 0.4 * fl);
      heat += rimLine * mix(0.15, 1.0, topW) * (0.05 + 0.08 * act);
      // Sunrise: a golden bloom rising off the edge, with rays fanning up from below it.
      float rise = 1.0 - exp(-ft * 2.0);
      vec2 sv = vec2((vPos.x - c.x) / (70.0 + 300.0 * rise), max(up, 0.0) / (16.0 + 70.0 * rise));
      float bloom = exp(-dot(sv, sv) * 1.6) * smoothstep(-2.0, 3.0, up) * fl;
      float ang = atan(vPos.x - c.x, max(up, 0.0) + 60.0);
      float rays = pow(noise(vec2(ang * 10.0, ft * 0.5)), 3.0)
                 * exp(-max(up, 0.0) / (50.0 + 90.0 * rise)) * smoothstep(0.0, 10.0, up) * fl;
      // Keep the sunrise inside the band it is drawn in (no hard quad edges).
      float bound = smoothstep(200.0, 120.0, up) * smoothstep(320.0, 200.0, abs(vPos.x - c.x));
      rays *= bound * smoothstep(1.25, 0.75, abs(ang));
      bloom *= bound;
      heat += bloom * 0.5 + rays * 0.4;
      add += bloom * 0.2;
    } else {
      // NOVA: a shimmering plasma rim all round; a breathing corona and flames while
      // active; everything white-hot for a moment on ignition.
      float rimN = fbm3(vPos / 15.0 + vec2(t * 0.8, -t * 0.5));
      float shimmer = 0.5 + 0.5 * sin(uClock * 2.2 + vPos.x * 0.025 - vPos.y * 0.02);
      heat = rimLine * (0.25 + 0.75 * smoothstep(0.45, 0.8, rimN))
           * (0.22 + 0.1 * shimmer + 0.35 * act + 0.7 * fl);
      float corona = exp(-dd / (7.0 + 9.0 * act + 16.0 * fl)) * outside;
      heat += corona * mix(0.45, 1.0, topW)
            * (0.045 + 0.1 * act * (0.8 + 0.2 * sin(uClock * 2.0)) + 0.32 * fl);
      float fire = act * 0.8 + fl;
      if (fire > 0.02)
        heat += flames(vPos, d, up, 28.0 * (0.35 + 0.65 * act + 1.1 * fl), 1.0, fl, t, add) * min(fire, 1.0);
    }
  }

  vec4 col = ramp(heat) * uGain * uFade;
  // Paint on paper (light theme): let the shapes thin out instead of a solid silhouette.
  col *= mix(1.0, 0.15 + 0.85 * clamp(heat * 1.4, 0.0, 1.0), step(0.5, uAlphaK));
  col.rgb += (uC3 * 0.6 + uC2 * 0.4) * add * uFade * uGain;
  // uAlphaK: 0 = additive light (dark theme), 1 = normal paint (light theme).
  float a = clamp(col.a * uAlphaK + add * uAlphaK * 0.5 * uFade, 0.0, 1.0);
  outColor = vec4(col.rgb, a);
}`;

const POINT_VS = `#version 300 es
in vec4 aP;            // x, y, size, temperature (0..1)
in vec3 aQ;            // alpha, palette (tier index), sharpness (0 soft ember .. 1 spark)
uniform vec2 uRes;
uniform float uDpr;
uniform vec3 uPal[16]; // 4 tiers x deep, mid, hot, core
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
  float sharp = smoothstep(0.5, 0.1, r) + 0.3 * halo * halo;
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

/** A rising ember (kind 0) or a falling spark (kind 1). */
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
  kind: 0 | 1;
}

/** A spark head skipping along the composer's edge (perimeter coordinate s, px). */
interface Head {
  s: number;
  v: number; // px/s, signed
  age: number;
  ttl: number;
  amp: number;
  shed: number; // falling sparks per second
  debt: number;
}

interface Layer {
  tier: TierId;
  fade: number;
  fading: boolean;
  flareAt: number; // wall clock s
  act: number;
  time: number;
  fl: number;
  // particles bookkeeping
  trickle: number;
  nextSpark: number;
}

const MAX_POINTS = 320;
const FLOATS = 7;

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
    "uAct",
    "uFade",
    "uAlphaK",
    "uGain",
    "uHaze",
    "uRadius",
    "uTopY",
    "uMode",
    "uTier",
    "uRect",
    "uC0",
    "uC1",
    "uC2",
    "uC3",
    "uHeads",
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
  let heads: Head[] = [];
  let raf = 0;
  let timer = 0;
  let last = 0;
  let blurredAt = document.hasFocus() ? -1 : clock();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let pal = new Float32Array(48);
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
    pal = new Float32Array(
      TIER_IDS.flatMap((t) =>
        ["deep", "mid", "hot", "core"].flatMap((k) => readColor(`--fx-${t}-${k}`, probe)),
      ),
    );
    const light = document.documentElement.dataset.theme === "light";
    alphaK = light ? 1 : 0.12;
    gain = light ? 1 : 0.9;
  };
  setPalette();
  const color = (tier: TierId, k: number) =>
    pal.subarray(TIER_INDEX[tier] * 12 + k * 3, TIER_INDEX[tier] * 12 + k * 3 + 3);

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

  // Rounded-rect perimeter, clockwise from the top edge's left end. Returns a point just
  // outside the border and the outward normal.
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

  const flareEnv = (l: Layer, now: number) => {
    const f = FLARE[l.tier];
    const ft = now - l.flareAt;
    if (ft < 0 || ft > f.len) return 0;
    const e = ft < f.rise ? 1 - Math.pow(1 - ft / f.rise, 3) : Math.exp(-(ft - f.rise) * f.decay);
    const tail = Math.min(1, (f.len - ft) / (f.len * 0.3));
    return e * tail;
  };

  // ---- particles ----
  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  const spawnEmbers = (l: Layer, r: Rect, n: number, burst: boolean) => {
    const nova = l.tier === "nova";
    const small = l.tier === "ember";
    for (let i = 0; i < n && particles.length < 200; i++) {
      const spread = burst ? 1 : 0.35;
      particles.push({
        x: r.x + r.radius + Math.random() * (r.w - r.radius * 2),
        y: r.y - 2 - Math.random() * 10,
        vx: (Math.random() - 0.5) * 70 * spread,
        vy: -(30 + Math.random() * (burst ? 190 : 70)) * (nova ? 0.85 : small ? 0.35 : 0.7),
        temp: 0.75 + Math.random() * 0.25,
        cool: small ? rand(0.5, 0.8) : rand(0.32, 0.77),
        size: small ? rand(2, 3.2) : (burst ? 3.4 : 3) + Math.random() * (nova ? 4.5 : 3.5),
        seed: Math.random() * 100,
        pal: TIER_INDEX[l.tier],
        kind: 0,
      });
    }
  };

  const spawnHead = (opts: Partial<Head> & { s: number }) => {
    if (heads.length >= 6) return;
    heads.push({ v: 600, age: 0, ttl: 0.3, amp: 1, shed: 20, debt: 0, ...opts });
  };

  const shedSpark = (r: Rect, hd: Head) => {
    if (particles.length >= 200) return;
    const p = perim(r, hd.s);
    const dir = Math.sign(hd.v);
    const tx = -p.ny * dir;
    const ty = p.nx * dir;
    const out = rand(40, 170);
    particles.push({
      x: p.x + p.nx * 1.5,
      y: p.y + p.ny * 1.5,
      vx: p.nx * out + tx * Math.abs(hd.v) * rand(0.05, 0.25) + rand(-30, 30),
      vy: p.ny * out + ty * Math.abs(hd.v) * rand(0.05, 0.25) + rand(-60, 10),
      temp: rand(0.85, 1),
      cool: rand(1.8, 3.6),
      size: rand(1.6, 2.6) * Math.min(1.2, hd.amp + 0.3),
      seed: Math.random() * 100,
      pal: TIER_INDEX.spark,
      kind: 1,
    });
  };

  const stepLayer = (l: Layer, dt: number, now: number, r: Rect) => {
    l.fl = flareEnv(l, now);
    const target = !l.fading && active ? 1 : 0;
    const k = target > l.act ? 2.4 : 1.1;
    l.act += (target - l.act) * (1 - Math.exp(-k * dt));
    if (l.act < 0.001) l.act = 0;
    l.time += dt * (0.3 + 0.7 * l.act + 0.6 * l.fl);
    if (l.fading) l.fade = Math.max(0, l.fade - dt / 0.4);
    if (l.fading) return;
    // Steady particle sources for the live layer.
    if (l.tier === "solstice" || l.tier === "nova") {
      const rate = (l.tier === "nova" ? 4.5 : 2.2) * l.act;
      l.trickle += rate * dt;
      const n = Math.floor(l.trickle);
      if (n) {
        spawnEmbers(l, r, n, false);
        l.trickle -= n;
      }
    }
    if (l.tier === "spark") {
      l.nextSpark -= dt;
      const ft = now - l.flareAt;
      if (ft < 0.9 && l.fl > 0.05) {
        // The flare keeps throwing extra crackle while the two racers go round.
        if (l.nextSpark > 0.12) l.nextSpark = rand(0.04, 0.12);
      }
      if (l.nextSpark <= 0) {
        const L = perimLength(r);
        const hot = l.fl > 0.05 ? 1 : l.act;
        spawnHead({
          s: Math.random() * L,
          v: (Math.random() < 0.5 ? -1 : 1) * rand(260 + 400 * hot, 420 + 600 * hot),
          ttl: rand(0.12 + 0.08 * hot, 0.2 + 0.2 * hot),
          amp: 0.45 + 0.5 * hot,
          shed: 4 + 22 * hot,
        });
        // Idle: a tiny flick every few seconds. Active: a few per second.
        l.nextSpark =
          l.act > 0.05 || l.fl > 0.05 ? rand(0.12, 0.45) / Math.max(0.35, l.act) : rand(2.2, 5);
      }
    }
  };

  const stepParticles = (dt: number, t: number, r: Rect) => {
    const L = perimLength(r);
    const nextHeads: Head[] = [];
    for (const hd of heads) {
      hd.age += dt;
      if (hd.age >= hd.ttl) continue;
      hd.s += hd.v * dt;
      // Skip: now and then the head jumps ahead a little, like an arc re-striking.
      if (Math.random() < dt * 9) hd.s += Math.sign(hd.v) * rand(6, 22);
      hd.s = ((hd.s % L) + L) % L;
      hd.debt += hd.shed * dt;
      while (hd.debt >= 1) {
        shedSpark(r, hd);
        hd.debt -= 1;
      }
      nextHeads.push(hd);
    }
    heads = nextHeads;

    const next: Particle[] = [];
    for (const e of particles) {
      e.temp -= e.cool * dt;
      if (e.temp <= 0 || r.y - e.y > 160 || e.y > h + 10) continue;
      if (e.kind === 0) {
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
      } else {
        // Falling spark: gravity and a little drag.
        e.vy += 520 * dt;
        const drag = 1 - 1.6 * dt;
        e.vx *= drag;
        e.vy *= drag;
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      next.push(e);
    }
    particles = next;
  };

  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w, x1);
    y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return;
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]),
      gl.STREAM_DRAW,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const headUniform = new Float32Array(16);

  const drawLayer = (l: Layer, now: number, r: Rect) => {
    const ft = now - l.flareAt;
    const c = (k: number) => color(l.tier, k);
    gl.uniform1f(fu.uTime, l.time);
    gl.uniform1f(fu.uFT, ft);
    gl.uniform1f(fu.uFl, l.fl);
    gl.uniform1f(fu.uAct, l.act);
    gl.uniform1f(fu.uFade, l.fade);
    gl.uniform1i(fu.uTier, TIER_INDEX[l.tier]);
    gl.uniform3fv(fu.uC0, c(0));
    gl.uniform3fv(fu.uC1, c(1));
    gl.uniform3fv(fu.uC2, c(2));
    gl.uniform3fv(fu.uC3, c(3));
    headUniform.fill(0);
    if (l.tier === "spark") {
      heads.slice(0, 4).forEach((hd, i) => {
        const p = perim(r, hd.s);
        const env = Math.sin(Math.PI * Math.min(1, hd.age / hd.ttl)) ** 0.6;
        headUniform.set([p.x, p.y, hd.amp * env, 0], i * 4);
      });
    }
    gl.uniform4fv(fu.uHeads, headUniform);

    // Composer band: how far above / around the box this tier can reach right now.
    let top = 24;
    let side = 22;
    if (l.tier === "ember") top = 26 + 30 * l.fl;
    if (l.tier === "spark") top = side = 40;
    if (l.tier === "solstice") {
      const sunrise = l.fl > 0.002;
      top = sunrise ? 210 : 30 + 60 * l.act;
      side = sunrise ? 330 : 10;
    }
    if (l.tier === "nova") top = 34 + 80 * l.act + 130 * l.fl;
    gl.uniform1i(fu.uMode, 0);
    quad(r.x - side, r.y - top, r.x + r.w + side, r.y + r.h + 24);

    const filament =
      l.tier === "nova"
        ? Math.max(l.act, l.fl)
        : l.tier === "solstice"
          ? Math.max(l.act * 0.6, l.fl)
          : 0;
    if (filament > 0.01) {
      gl.uniform1i(fu.uMode, 1);
      quad(0, r.topY - 6, w, r.topY + 34);
    }
    if (l.tier === "nova" && ft >= 0 && ft < 2.4) {
      const R = 24 + 720 * (1 - Math.exp(-ft * 1.8));
      const m = R + 40 + R * 0.08;
      gl.uniform1i(fu.uMode, 2);
      quad(r.x + r.w / 2 - m, r.y - m, r.x + r.w / 2 + m, r.y + m);
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
    for (const l of layers) drawLayer(l, now, r);

    // Points: embers, falling sparks (with a short streak) and spark-head trails.
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
      if (n >= MAX_POINTS || a <= 0.003) return;
      ptData[i++] = x;
      ptData[i++] = y;
      ptData[i++] = size;
      ptData[i++] = temp;
      ptData[i++] = a;
      ptData[i++] = p;
      ptData[i++] = s;
      n++;
    };
    const fadeOf = (p: number) => layers.find((l) => TIER_INDEX[l.tier] === p)?.fade ?? 1;
    for (const e of particles) {
      const fade = fadeOf(e.pal);
      if (e.kind === 0) {
        const flicker = 0.75 + 0.25 * Math.sin(now * 23 + e.seed * 7);
        const keep = Math.min(1, Math.max(0, (140 - (r.y - e.y)) / 60));
        put(
          e.x,
          e.y,
          e.size * (0.6 + 0.4 * e.temp),
          e.temp,
          Math.min(1, e.temp * 2.2) * flicker * keep * fade,
          e.pal,
          0,
        );
      } else {
        const a = Math.min(1, e.temp * 1.6) * fade;
        put(e.x, e.y, e.size, e.temp, a, e.pal, 1);
        put(e.x - e.vx * 0.012, e.y - e.vy * 0.012, e.size * 0.8, e.temp * 0.8, a * 0.55, e.pal, 1);
      }
    }
    const crackle = Math.floor(now * 30); // jitter re-rolls ~30 times a second
    for (const hd of heads) {
      const env = Math.sin(Math.PI * Math.min(1, hd.age / hd.ttl)) ** 0.6;
      const dir = Math.sign(hd.v);
      const N = 14;
      for (let k = 0; k < N; k++) {
        const p = perim(r, hd.s - dir * k * 4);
        const jr = Math.sin((crackle + k * 7.13 + hd.s) * 12.9898) * 43758.5453;
        const j = (jr - Math.floor(jr) - 0.5) * (1.2 + k * 0.8);
        const fall = 1 - k / N;
        put(
          p.x + p.nx * (1.2 + j),
          p.y + p.ny * (1.2 + j),
          (k === 0 ? 5 : 3 * fall + 1) * Math.min(1.2, hd.amp + 0.3),
          1 - k * 0.06,
          hd.amp * env * fall * fadeOf(TIER_INDEX.spark),
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
    particles.length > 0 ||
    heads.length > 0 ||
    layers.some((l) => l.fading || l.fl > 0.002 || l.act > 0.002 || active);

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
    if (!layers.length && !particles.length && !heads.length) {
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
    const r = composerRect();
    if (!r) return;
    if (l.tier === "nova") spawnEmbers(l, r, 50, true);
    if (l.tier === "solstice") spawnEmbers(l, r, 12, true);
    if (l.tier === "ember") spawnEmbers(l, r, 7, true);
    if (l.tier === "spark") {
      // Two racers leave the top centre in opposite directions and meet at the bottom.
      const L = perimLength(r);
      const s = (r.w - 2 * r.radius) / 2;
      for (const dir of [-1, 1])
        spawnHead({ s, v: (dir * L) / 2 / 0.75, ttl: 0.8, amp: 1.25, shed: 70 });
      l.nextSpark = 0.05;
    }
  };

  return {
    set(tier: TierId | null, isActive: boolean, key: number) {
      active = isActive;
      const cur = layers.find((l) => !l.fading);
      if (cur?.tier !== tier) {
        if (cur) cur.fading = true;
        if (tier) {
          const l: Layer = {
            tier,
            fade: 1,
            fading: false,
            flareAt: 0,
            act: 0,
            time: Math.random() * 50,
            fl: 0,
            trickle: 0,
            nextSpark: rand(1, 3),
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
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    },
  };
}
