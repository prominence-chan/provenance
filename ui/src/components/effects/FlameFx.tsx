// Fire for solstice / nova turns: one WebGL2 canvas behind the main column.
//
//   flames   domain-warped fbm noise licking up off the composer's top edge, with a
//            living rim along its border and a soft corona around it (fragment shader,
//            shaded only inside a band around the composer, never the whole canvas)
//   filament a thin plasma line under the header with a downward glow
//   embers   GL points with buoyancy that fades as they cool, drag and a curl-ish
//            turbulence field; colour follows temperature (white-gold -> tier -> deep red)
//   ignite   nova: a flash, a shockwave ring and an ember burst when a turn starts, which
//            settles into the steady corona. solstice kindles gently instead.
//
// Cheap by construction: DPR capped at 1.5, small shaded area, rAF only while visible
// and while there is something to draw (fades out, then the loop stops), 30 fps when the
// window is in the background. pointer-events: none. Under prefers-reduced-motion, or
// without WebGL2, nothing runs and effects.css draws a static glow instead.
import { useEffect, useRef } from "react";
import { useTheme } from "../../theme/theme";
import type { TierEffect } from "../../theme/tiers";
import { prefersReducedMotion, type FxState } from "./useFx";

export function FlameFx({ fx }: { fx: FxState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const theme = useTheme();
  const effect: TierEffect = fx.tier?.effect ?? "none";
  const on = fx.streaming && effect !== "none";

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    if (prefersReducedMotion()) {
      host.dataset.fx = "static";
      return;
    }
    const e = createEngine(canvas, host);
    if (!e) {
      host.dataset.fx = "static";
      return;
    }
    host.dataset.fx = "gl";
    engine.current = e;
    return () => {
      e.destroy();
      engine.current = null;
      delete host.dataset.fx;
    };
  }, []);

  useEffect(() => {
    void theme;
    engine.current?.setPalette();
  }, [theme]);

  useEffect(() => {
    engine.current?.set(on ? effect : "none");
  }, [on, effect]);

  return <canvas ref={ref} className="flame-fx" aria-hidden />;
}

// ---------------------------------------------------------------------------------------

type Engine = NonNullable<ReturnType<typeof createEngine>>;

const QUAD_VS = `#version 300 es
in vec2 aPos;           // CSS px, y down
uniform vec2 uRes;      // canvas size, CSS px
out vec2 vPos;
void main() {
  vPos = aPos;
  vec2 clip = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FLAME_FS = `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 outColor;
uniform float uTime, uLevel, uIgnite, uNova, uAlphaK, uGain, uHaze, uRadius, uHeight, uTopY;
uniform vec2 uRes;
uniform int uMode;      // 0 = composer flames, 1 = top filament
uniform vec4 uRect;     // composer x, y, w, h (CSS px)
uniform vec3 uC0, uC1, uC2, uC3;

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

void main() {
  float t = uTime;
  // Ignition envelope: 1 at the start of a turn, gone after ~1.5 s.
  float ign = exp(-uIgnite * 2.4);
  float heat = 0.0;
  float add = 0.0;   // extra additive light (shockwave, flash)

  if (uMode == 1) {
    // Plasma filament under the header: one continuous hairline, a slow shimmer along it
    // and a couple of travelling highlights. Fades out towards both ends.
    float y = vPos.y - uTopY;
    float x = vPos.x / uRes.x;
    float ends = smoothstep(0.0, 0.25, x) * smoothstep(1.0, 0.75, x);
    float shimmer = 0.75 + 0.25 * fbm(vec2(vPos.x / 140.0 - t * 0.4, t * 0.3));
    float speed = 0.07 + 0.05 * uNova;
    float h1 = exp(-pow((fract(x - t * speed) - 0.5) * 7.0, 2.0));
    float h2 = exp(-pow((fract(x * 0.8 + t * speed * 0.6 + 0.37) - 0.5) * 9.0, 2.0)) * 0.6;
    float hi = max(h1, h2);
    float line = exp(-abs(y) / 0.6) * (0.28 * shimmer + 0.65 * hi);
    float glow = exp(-max(y, 0.0) / (6.0 + 4.0 * uNova)) * smoothstep(-1.5, 0.5, y)
               * smoothstep(26.0, 4.0, y) * 0.22 * hi;
    // Ignition: the filament lights from the centre outwards with a travelling spark.
    float cx = (uRect.x + uRect.z * 0.5) / uRes.x;
    float front = 1.0 - exp(-uIgnite * 2.6);
    float lit = mix(1.0, smoothstep(front + 0.03, front - 0.03, abs(x - cx)), ign);
    float flash = uNova * ign * exp(-abs(abs(x - cx) - front) * 60.0) * exp(-abs(y) / 2.0);
    heat = (line + glow) * lit * ends;
    add = flash;
  } else {
    vec2 c = uRect.xy + uRect.zw * 0.5;
    vec2 p = vPos - c;
    float d = sdRound(p, uRect.zw * 0.5, uRadius);    // > 0 outside the composer
    float up = uRect.y - vPos.y;                        // px above the top edge
    // Only the top edge burns: fade everything out below the corners' start.
    float topBand = smoothstep(uRect.y + uRadius + 2.0, uRect.y + 1.0, vPos.y);
    // Flames rise: noise scrolls upward and is stretched vertically into tongues.
    vec2 q = vPos / vec2(34.0, 52.0);
    q.y += t * (1.2 + 0.5 * uNova);
    vec2 w = vec2(fbm(q + vec2(0.0, t * 0.15)), fbm(q + vec2(5.2, 1.3 - t * 0.1)));
    float n = fbm(q * vec2(1.5, 0.75) + 1.8 * w);
    // Tongue height: a slow wave of a few tall tongues over a lower bed, fading near the
    // corners; ignition makes them leap.
    float along = clamp((vPos.x - uRect.x) / uRect.z, 0.0, 1.0);
    float shape = smoothstep(0.0, 0.14, along) * smoothstep(1.0, 0.86, along);
    float tall = pow(fbm(vec2(vPos.x / 70.0, t * 0.22)), 2.0) * 2.4;
    float H = uHeight * (0.25 + tall) * shape;
    H *= 1.0 + 1.3 * ign * (0.4 + uNova);
    float reach = max(H, 1.0);
    float f = max(up, 0.0) / reach;                    // 0 at the edge, ~1 at the tip
    float flame = smoothstep(0.95, 0.05, f + (n - 0.5) * 1.7);
    flame *= smoothstep(-1.0, 1.0, up) * topBand * smoothstep(0.0, 0.08, shape);
    float tip = clamp(f, 0.0, 1.0);
    heat = flame * mix(0.62, 0.2, tip);
    // White-hot along the base, in knots.
    heat += flame * smoothstep(0.5, 0.8, n) * smoothstep(0.45, 0.0, tip) * 0.42;
    // A living rim on the top border: mostly dim, with bright travelling knots.
    float rimN = fbm(vPos / 20.0 + vec2(t * 1.2, -t * 0.4));
    float rim = exp(-abs(d - 0.3) / 0.7) * (0.18 + 0.75 * smoothstep(0.45, 0.8, rimN)) * topBand * shape;
    heat = max(heat, rim * 0.85);
    // A low glow above the edge; nova breathes.
    float breathe = 0.8 + 0.2 * sin(t * (1.3 + 0.7 * uNova));
    float glowUp = exp(-max(up, 0.0) / (12.0 + 8.0 * uNova)) * smoothstep(-1.0, 2.0, up)
                 * smoothstep(48.0, 10.0, up) * topBand * shape;
    heat += glowUp * (0.12 + 0.08 * uNova) * breathe * uHaze;
    // Heat haze: faint wisps off the tongues (dark theme only).
    float wisp = fbm(q * vec2(0.9, 0.5) + 2.4 * w - vec2(0.0, t * 0.2));
    float haze = smoothstep(0.55, 0.85, wisp) * smoothstep(4.0, 22.0, up) * exp(-up / 34.0) * shape;
    heat += haze * 0.12 * uHaze;
    // Ignition flare: the whole edge flashes white-hot and a sheet of flame leaps up,
    // then falls back into the steady fire within ~0.6 s.
    float flareH = 14.0 + 46.0 * (1.0 - exp(-uIgnite * 7.0));
    float flareN = smoothstep(0.25, 0.75, n);
    float flare = exp(-max(up, 0.0) / flareH) * smoothstep(-1.0, 1.0, up) * topBand * shape
                * exp(-uIgnite * 4.0) * flareN;
    heat += flare * (0.35 + 0.45 * uNova);
    add = rim * exp(-uIgnite * 5.0) * (0.4 + 0.8 * uNova);
  }

  vec4 col = ramp(heat * uLevel) * uGain;
  // Paint on paper (light theme): let the tongues thin out instead of a solid silhouette.
  col *= mix(1.0, 0.15 + 0.85 * clamp(heat * 1.4, 0.0, 1.0), step(0.5, uAlphaK));
  col.rgb += (uC3 * 0.6 + uC2 * 0.4) * add * uLevel * uGain;
  // uAlphaK: 0 = additive light (dark theme), 1 = normal paint (light theme).
  float a = clamp(col.a * uAlphaK + add * uAlphaK * 0.5, 0.0, 1.0);
  outColor = vec4(col.rgb, a);
}`;

const EMBER_VS = `#version 300 es
in vec4 aP;            // x, y, size, temperature (0..1)
in float aA;           // alpha
uniform vec2 uRes;
uniform float uDpr;
out float vT;
out float vA;
void main() {
  vec2 clip = aP.xy / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = aP.z * uDpr;
  vT = aP.w;
  vA = aA;
}`;

const EMBER_FS = `#version 300 es
precision mediump float;
in float vT;
in float vA;
out vec4 outColor;
uniform vec3 uC0, uC1, uC2, uC3;
uniform float uAlphaK;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  float spot = core * core * (0.6 + 0.4 * smoothstep(0.5, 0.0, r));
  vec3 c = mix(uC0, uC1, smoothstep(0.0, 0.35, vT));
  c = mix(c, uC2, smoothstep(0.3, 0.7, vT));
  c = mix(c, uC3, smoothstep(0.75, 1.0, vT));
  float a = spot * vA;
  outColor = vec4(c * a * 1.6, a * uAlphaK);
}`;

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  temp: number; // 1 hot -> 0 cold
  cool: number; // per second
  size: number;
  seed: number;
}

const MAX_EMBERS = 220;

const PALETTES = {
  warm: ["--fx-solstice-deep", "--fx-solstice-mid", "--fx-solstice-hot", "--fx-solstice-core"],
  plasma: ["--fx-nova-deep", "--fx-nova-mid", "--fx-nova-hot", "--fx-nova-core"],
} as const;

const TUNING = {
  warm: { height: 22, trickle: 2.5, burst: 14, nova: 0, rise: 0.7 },
  plasma: { height: 28, trickle: 5, burst: 50, nova: 1, rise: 0.85 },
} as const;

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
  let flameProg: WebGLProgram;
  let emberProg: WebGLProgram;
  try {
    flameProg = program(QUAD_VS, FLAME_FS);
    emberProg = program(EMBER_VS, EMBER_FS);
  } catch (err) {
    console.warn("[fx] shader setup failed, using the static glow", err);
    return null;
  }
  const U = (p: WebGLProgram, names: string[]) =>
    Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
  const fu = U(flameProg, [
    "uRes",
    "uTime",
    "uLevel",
    "uIgnite",
    "uNova",
    "uAlphaK",
    "uGain",
    "uHaze",
    "uRadius",
    "uHeight",
    "uTopY",
    "uMode",
    "uRect",
    "uC0",
    "uC1",
    "uC2",
    "uC3",
  ]);
  const eu = U(emberProg, ["uRes", "uDpr", "uAlphaK", "uC0", "uC1", "uC2", "uC3"]);

  const quadBuf = gl.createBuffer()!;
  const quadVao = gl.createVertexArray()!;
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aPos = gl.getAttribLocation(flameProg, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const emberData = new Float32Array(MAX_EMBERS * 5);
  const emberBuf = gl.createBuffer()!;
  const emberVao = gl.createVertexArray()!;
  gl.bindVertexArray(emberVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, emberBuf);
  gl.bufferData(gl.ARRAY_BUFFER, emberData.byteLength, gl.DYNAMIC_DRAW);
  const aP = gl.getAttribLocation(emberProg, "aP");
  const aA = gl.getAttribLocation(emberProg, "aA");
  gl.enableVertexAttribArray(aP);
  gl.vertexAttribPointer(aP, 4, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(aA);
  gl.vertexAttribPointer(aA, 1, gl.FLOAT, false, 20, 16);
  gl.bindVertexArray(null);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // ---- state ----
  let effect: Exclude<TierEffect, "none"> = "warm";
  let target = 0; // 1 while a turn streams
  let level = 0; // eased towards target
  let ignitedAt = -1e9;
  let embers: Ember[] = [];
  let trickleDebt = 0;
  let raf = 0;
  let timer = 0;
  let last = 0;
  const start = performance.now();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let colors: Record<"warm" | "plasma", number[][]> = { warm: [], plasma: [] };
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
    colors = {
      warm: PALETTES.warm.map((n) => readColor(n, probe)),
      plasma: PALETTES.plasma.map((n) => readColor(n, probe)),
    };
    const light = document.documentElement.dataset.theme === "light";
    alphaK = light ? 1 : 0.12;
    gain = light ? 1 : 0.9;
  };
  setPalette();

  const resize = () => {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    w = host.clientWidth;
    h = host.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (!raf && level > 0) draw(0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const composerRect = () => {
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

  const spawn = (n: number, rect: NonNullable<ReturnType<typeof composerRect>>, burst: boolean) => {
    const tune = TUNING[effect];
    for (let i = 0; i < n && embers.length < MAX_EMBERS; i++) {
      const x = rect.x + rect.radius + Math.random() * (rect.w - rect.radius * 2);
      const spread = burst ? 1 : 0.35;
      embers.push({
        x,
        y: rect.y - 2 - Math.random() * 10,
        vx: (Math.random() - 0.5) * 70 * spread,
        vy: -(30 + Math.random() * (burst ? 190 : 70)) * tune.rise,
        temp: 0.75 + Math.random() * 0.25,
        cool: 0.32 + Math.random() * 0.45,
        size: (burst ? 3.4 : 3) + Math.random() * (tune.nova ? 4.5 : 3.5),
        seed: Math.random() * 100,
      });
    }
  };

  const step = (dt: number, t: number, rect: NonNullable<ReturnType<typeof composerRect>>) => {
    const tune = TUNING[effect];
    if (target > 0) {
      trickleDebt += tune.trickle * dt;
      const n = Math.floor(trickleDebt);
      if (n) {
        spawn(n, rect, false);
        trickleDebt -= n;
      }
    }
    const next: Ember[] = [];
    for (const e of embers) {
      e.temp -= e.cool * dt;
      if (e.temp <= 0 || rect.y - e.y > 140) continue;
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
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      next.push(e);
    }
    embers = next;
  };

  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]),
      gl.STREAM_DRAW,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const draw = (dt: number) => {
    const t = (performance.now() - start) / 1000;
    const rect = composerRect();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!rect || level <= 0.001) return;
    const tune = TUNING[effect];
    const c = colors[effect];
    const since = t - ignitedAt;
    step(dt, t, rect);

    gl.useProgram(flameProg);
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.uniform2f(fu.uRes, w, h);
    gl.uniform1f(fu.uTime, t);
    gl.uniform1f(fu.uLevel, level);
    gl.uniform1f(fu.uIgnite, since);
    gl.uniform1f(fu.uNova, tune.nova);
    gl.uniform1f(fu.uAlphaK, alphaK);
    gl.uniform1f(fu.uGain, gain);
    gl.uniform1f(fu.uHaze, alphaK < 1 ? 1 : 0);
    gl.uniform1f(fu.uRadius, rect.radius);
    gl.uniform1f(fu.uHeight, tune.height);
    gl.uniform1f(fu.uTopY, rect.topY);
    gl.uniform4f(fu.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform3fv(fu.uC0, c[0]);
    gl.uniform3fv(fu.uC1, c[1]);
    gl.uniform3fv(fu.uC2, c[2]);
    gl.uniform3fv(fu.uC3, c[3]);
    // Composer band: only above the top edge (and the top corners).
    gl.uniform1i(fu.uMode, 0);
    quad(
      Math.max(0, rect.x - 4),
      Math.max(0, rect.y - tune.height * 3.2 - 40),
      Math.min(w, rect.x + rect.w + 4),
      rect.y + rect.radius + 2,
    );
    // Top filament.
    gl.uniform1i(fu.uMode, 1);
    quad(0, Math.max(0, rect.topY - 6), w, rect.topY + 34);

    if (embers.length) {
      let i = 0;
      for (const e of embers) {
        const flicker = 0.75 + 0.25 * Math.sin(t * 23 + e.seed * 7);
        emberData[i++] = e.x;
        emberData[i++] = e.y;
        emberData[i++] = e.size * (0.6 + 0.4 * e.temp);
        emberData[i++] = e.temp;
        // Fade out before they reach the transcript text.
        const height = rect.y - e.y;
        const keep = Math.min(1, Math.max(0, (130 - height) / 60));
        emberData[i++] = Math.min(1, e.temp * 2.2) * flicker * level * keep;
      }
      gl.useProgram(emberProg);
      gl.bindVertexArray(emberVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, emberBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, emberData, 0, i);
      gl.uniform2f(eu.uRes, w, h);
      gl.uniform1f(eu.uDpr, dpr);
      gl.uniform1f(eu.uAlphaK, alphaK);
      gl.uniform3fv(eu.uC0, c[0]);
      gl.uniform3fv(eu.uC1, c[1]);
      gl.uniform3fv(eu.uC2, c[2]);
      gl.uniform3fv(eu.uC3, c[3]);
      gl.drawArrays(gl.POINTS, 0, embers.length);
    }
    gl.bindVertexArray(null);
  };

  const frame = (now: number) => {
    raf = 0;
    timer = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    // Ease the overall level: quick to light, slower to die down.
    const rate = target > level ? 2.2 : 1.3;
    level += Math.sign(target - level) * Math.min(Math.abs(target - level), rate * dt);
    draw(dt);
    schedule();
  };

  const schedule = () => {
    if (raf || timer || document.hidden) return;
    if (target === 0 && level <= 0.001 && !embers.length) {
      last = 0;
      level = 0;
      draw(0); // clear
      return;
    }
    // Full rate while the window has focus, ~30 fps behind other windows.
    if (document.hasFocus()) raf = requestAnimationFrame(frame);
    else timer = window.setTimeout(() => frame(performance.now()), 33);
  };

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = 0;
      last = 0;
    } else schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    set(next: TierEffect) {
      if (next === "none") {
        target = 0;
      } else {
        const fresh = target === 0 || next !== effect;
        effect = next;
        target = 1;
        if (fresh) {
          ignitedAt = (performance.now() - start) / 1000;
          const rect = composerRect();
          if (rect) spawn(TUNING[effect].burst, rect, true);
        }
      }
      schedule();
    },
    setPalette() {
      setPalette();
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
