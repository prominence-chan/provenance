// The new-thread hero: a live sun with prominences and flares, one small WebGL2 canvas.
//
// The disc is a turning sphere (spherical mapping, so features foreshorten at the limb), with
// limb darkening, granulation at three scales and speeds, faculae and a dark filament; a
// corona with two streamer layers turning at different rates and a soft bloom; a red
// chromosphere with two layers of spicules; and a few prominence loops (braided threads in a
// soft sheath, lit from below, plasma draining down the legs) that each live their own cycle
// (rise, hang, drift, sometimes erupt and fade) at random spots round the limb, so the picture
// never repeats. Now and then a flare jet bursts off the limb and falls back.
//
// Cheap: ~200 CSS px square, DPR capped at 2, 30 fps, paused when the tab is hidden or the
// window is unfocused for a few seconds. Under prefers-reduced-motion it draws one still
// frame; without WebGL2 it falls back to the static SolarMark.
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../theme/theme";
import { SolarMark } from "../SolarMark";
import { GLSL_HASH } from "./glsl";
import { devUptime, useReducedMotion } from "./useFx";

/** Seconds a surface layer lives (see surface() in the shader): long enough to read as one
 * slowly turning surface, short enough that its shear stays at the first minute's. */
const LAYER_LIFE = 100;
const TAU = Math.PI * 2;
const hash1 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const wrap = (x: number, m: number) => x - m * Math.floor(x / m);

/**
 * The shader's time inputs at t seconds (any t: days of uptime included), each small:
 * two surface layers half a life apart, cross-faded so each is born and dies unseen; the
 * streamers' turn as an angle; each prominence's and the flare's place in its cycle.
 */
function timeInputs(t: number) {
  const age = [0, 1].map((j) => wrap(t + (j * LAYER_LIFE) / 2, LAYER_LIFE));
  const life = [0, 1].map((j) => Math.floor((t + (j * LAYER_LIFE) / 2) / LAYER_LIFE));
  const off = life.flatMap((c, j) => [
    hash1(c * 1.37 + j * 0.31) * 40,
    hash1(c * 2.71 + j * 0.53) * 40,
  ]);
  const prom = [0, 1, 2, 3].flatMap((i) => {
    const T = 9 + 5 * hash1(i * 3.1); // life length, s
    const cyc = t / T + hash1(i * 7.7);
    const k = Math.floor(cyc);
    // The life number only seeds the loop's place, size and fate: wrapped, it stays exact.
    return [cyc - k, wrap(k, 997) * 13 + i * 5.3, 0.05 * Math.sin(wrap(t * 0.13, TAU) + i), T];
  });
  const fk = Math.floor(t / 6.5);
  const flare = [t / 6.5 - fk, hash1(fk * 3.7 + 1) > 0.45 ? 1 : 0, hash1(fk * 5.1) * TAU];
  const w = age.map((a) => Math.abs(Math.sin((Math.PI * a) / LAYER_LIFE)));
  return { age, w, off, spin: [wrap(t * 0.005, TAU), wrap(-t * 0.004, TAU)], prom, flare };
}

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
// Every time value here stays small, whatever the uptime: the CPU works them out from its
// own clock (double precision) and sends them wrapped (see draw() below).
uniform vec2 uAge;       // the two surface layers' ages, 0..LAYER_LIFE s
uniform vec2 uW;         // their weights: sin and |cos| of the same angle, so w1^2 + w2^2 = 1
uniform vec4 uOff;       // each layer's random offset (xy: layer 1, zw: layer 2)
uniform vec2 uSpin;      // the two streamer layers' turn, radians, wrapped
uniform vec4 uProm[4];   // per prominence: how far through this life (0..1), seed, drift, life (s)
uniform vec3 uFlare;     // how far through this flare cycle (0..1), on, angle
uniform float uLight;
uniform vec3 uGlint, uCorona, uEmber, uCrimson, uMagenta;
${GLSL_HASH}
float h1(float n) { return hash(vec2(n, 311.7)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
float wrapA(float a) { return mod(a + 3.14159265, 6.2831853) - 3.14159265; }
// Noise round the limb with no seam where atan wraps (at -x): just above -pi the value is
// blended into the one from just below +pi.
float seamW(float a) { return 1.0 - smoothstep(-3.14159265, -2.3, a); }
float noiseA(float a, float k, float y) {
  float v = noise(vec2(a * k, y)), w = seamW(a);
  return w > 0.0 ? mix(v, noise(vec2((a + 6.2831853) * k, y)), w) : v;
}
float fbmA(float a, float k, float y) {
  float v = fbm(vec2(a * k, y)), w = seamW(a);
  return w > 0.0 ? mix(v, fbm(vec2((a + 6.2831853) * k, y)), w) : v;
}
// Two independent layers blended by uW keep one layer's contrast (w1^2 + w2^2 = 1): each
// layer is born and dies while its weight is 0, so nothing jumps. m = the field's mean.
float blend2(float a, float b, float m) { return m + uW.x * (a - m) + uW.y * (b - m); }
const float FBM_MEAN = 0.484;
// One layer of the turning surface, age seconds old. The equator turns a little faster than
// the poles, so the surface shears as it turns; a layer lives only LAYER_LIFE seconds, so the
// shear never builds past what the first minute shows (left running for hours, one surface
// sheared into chevrons and then stripes).
void surface(vec2 ll, float qy, float age, vec2 off, out float sg, out float gran, out float act,
             out float fil, out float filOn) {
  float rot = age * 0.03 * (1.0 - 0.3 * qy * qy);
  vec2 s = vec2(ll.x + rot, ll.y) + off;
  // Three scales at three speeds: supergranulation (big, slow), granulation (fine,
  // boiling), and active regions with faculae that show up bright near the limb.
  sg = fbm(s * 2.4 + vec2(0.0, age * 0.003) + 3.0);
  vec2 g = s * 17.0;
  float gw = fbm(g * 0.45 + vec2(age * 0.07, -age * 0.05));
  gran = noise(g + gw * 1.8) * 0.6 + noise(g * 2.2 - gw * 1.3 + age * 0.09) * 0.4;
  act = fbm(s * 1.5 + 11.0);
  fil = fbm(s * vec2(2.4, 5.0) + 21.0);
  filOn = fbm(s * 1.1 + 5.0);
}

// heat 0..1 -> colour: crimson -> ember -> corona -> glint
vec3 ramp(float h) {
  vec3 c = mix(uCrimson, uEmber, smoothstep(0.05, 0.4, h));
  c = mix(c, uCorona, smoothstep(0.4, 0.75, h));
  return mix(c, uGlint, smoothstep(0.75, 1.0, h));
}

void main() {
  vec2 p = vUv;
  float R = 0.36;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // ---- disc: a turning sphere ----
  if (r < R) {
    vec2 q = p / R;
    float mu = sqrt(max(1.0 - dot(q, q), 0.0));      // cos of the view angle
    // Spherical coordinates, so features foreshorten towards the limb and drift faster at
    // the centre than at the edge as the sun turns (the main depth cue); the equator turns
    // a little faster than the poles.
    float lat = asin(clamp(q.y, -1.0, 1.0));
    float lon = asin(clamp(q.x / max(cos(lat), 1e-3), -1.0, 1.0));
    float sg1, gr1, ac1, fi1, fo1, sg2, gr2, ac2, fi2, fo2;
    surface(vec2(lon, lat), q.y, uAge.x, uOff.xy, sg1, gr1, ac1, fi1, fo1);
    surface(vec2(lon, lat), q.y, uAge.y, uOff.zw, sg2, gr2, ac2, fi2, fo2);
    float sg = blend2(sg1, sg2, FBM_MEAN);
    float gran = smoothstep(0.2, 0.85, blend2(gr1, gr2, 0.5));
    float act = smoothstep(0.6, 0.78, blend2(ac1, ac2, FBM_MEAN));
    // Limb darkening (Eddington-ish) and a redder, cooler limb.
    float limb = 0.2 + 0.8 * pow(mu, 0.85);
    float heat = limb * (0.74 + (sg - 0.5) * 0.24 + (gran - 0.5) * 0.3 * (0.35 + 0.65 * mu))
               + act * pow(1.0 - mu, 1.5) * 0.3;
    // A dark filament: a prominence seen from above, lying on the disc and turning with it.
    float fl = abs(blend2(fi1, fi2, FBM_MEAN) - 0.5);
    heat -= smoothstep(0.035, 0.0, fl) * smoothstep(0.55, 0.68, blend2(fo1, fo2, FBM_MEAN)) * 0.16 * mu;
    col = ramp(clamp(heat, 0.0, 1.0));
    col *= 0.42 + 0.66 * pow(mu, 0.45);
    col += uGlint * pow(mu, 8.0) * 0.08;               // a soft hot core
    alpha = smoothstep(R, R - 0.004, r);
  }

  float h = r - R;          // height above the limb
  if (h > -0.01) {
    float hh = max(h, 0.0);
    // ---- corona: two streamer layers turning at different rates (parallax) ----
    float st1 = 0.55 + 0.9 * pow(noiseA(wrapA(a + uSpin.x), 2.6, 1.0), 2.0);
    float st2 = pow(noiseA(wrapA(a + uSpin.y), 8.0, 4.0 + hh * 3.0), 3.0);
    float corona = exp(-hh / 0.032) * 0.5 + exp(-hh / (0.11 * st1)) * 0.3 + exp(-hh / 0.07) * st2 * 0.35;
    float bloom = exp(-hh / 0.2) * 0.14;
    // ---- chromosphere: a thin red rim with two layers of spicules licking off it ----
    // They flow outwards on the two surface layers' clocks, blended the same way. Beyond
    // 0.06 above the limb no spicule reaches (hh / fringeH alone is past 1.74 there).
    float spic = 0.0;
    if (hh < 0.06) {
      float fringeH = 0.012 + 0.022 * blend2(fbmA(a, 4.0, uAge.x * 0.1 + uOff.x),
                                             fbmA(a, 4.0, uAge.y * 0.1 + uOff.z), FBM_MEAN);
      float sp = blend2(fbmA(a, 40.0, hh * 34.0 - uAge.x * 0.8 + uOff.y),
                        fbmA(a, 40.0, hh * 34.0 - uAge.y * 0.8 + uOff.w), FBM_MEAN);
      float sp2 = blend2(noiseA(a, 95.0, hh * 70.0 - uAge.x * 1.5 + uOff.x),
                         noiseA(a, 95.0, hh * 70.0 - uAge.y * 1.5 + uOff.z), 0.5);
      spic = smoothstep(1.0, 0.15, hh / fringeH + (0.5 - sp) * 1.1 + (0.5 - sp2) * 0.45)
           * smoothstep(-0.01, 0.0015, h);
    }
    float chrom = exp(-abs(h - 0.002) / 0.004);
    float heat = corona * 0.4 + spic * 0.42 + chrom * 0.25;
    float glow = corona * 0.7 + spic * 0.55 + chrom * 0.4 + bloom;

    // ---- prominences: a few loops, each on its own life cycle ----
    // Each loop's cycle (which life it is on, how far through) comes from the CPU; its
    // motion runs on tl, the seconds since this life began, so it stays small.
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec4 pr = uProm[i];
      float u = pr.x;                                 // 0..1 through this loop's life
      float seed = pr.y;
      float tl = u * pr.w;
      float a0 = h1(seed) * 6.2831853;
      float span = 0.28 + 0.36 * h1(seed + 1.0);
      float erupt = step(0.62, h1(seed + 2.0));       // some cycles end in an eruption
      // smooth life: slow rise, long hang, slow fade (or a lift-off if erupting)
      float life = smoothstep(0.0, 0.3, u) * (1.0 - smoothstep(0.7, 1.0, u));
      float rise = smoothstep(0.0, 0.45, u);
      float lift = erupt * smoothstep(0.55, 1.0, u);
      float H = (0.09 + 0.12 * h1(seed + 3.0)) * (0.5 + 0.5 * rise) + lift * 0.25;
      float da = wrapA(a - a0 - pr.z);
      float x = da / (span * 0.5);
      if (abs(x) < 1.15) {
        float yc = H * sqrt(max(1.0 - x * x, 0.0)) + lift * 0.04;
        float wob = (fbm(vec2(x * 3.0 + seed, tl * 0.25)) - 0.5) * 0.03;
        float sd = hh - yc - wob;                    // signed: < 0 under the arch
        float w = 0.012 + 0.009 * (1.0 - abs(x)) + lift * 0.012;
        // A rope of braided threads inside a soft sheath, not one flat stroke: three
        // strands wander across the rope's width at their own rates.
        float threads = 0.0;
        for (int j = 0; j < 3; j++) {
          float fj = float(j);
          float off = (fj - 1.0) * w * 0.6
                    + (noise(vec2(x * 4.0 + fj * 7.3 + seed, tl * (0.25 + 0.1 * fj))) - 0.5) * w * 1.1;
          threads += exp(-abs(sd - off) / (w * 0.22)) * (0.7 + 0.3 * fj / 2.0);
        }
        float sheath = exp(-sd * sd / (w * w * 2.4));
        // Lit from the disc: the underside of the rope is brighter (rim light), the top cooler.
        float lit = 0.75 + 0.45 * smoothstep(w, -w, sd);
        // a faint curtain of plasma hanging under the arch, in fine vertical threads
        float curtain = smoothstep(yc + 0.01, 0.0, hh) * smoothstep(1.0, 0.55, abs(x))
                      * fbm(vec2(x * 9.0 + seed, hh * 30.0 - tl * 0.35)) * 0.3;
        // plasma drains down both legs: knots travel from the top to the feet
        float knots = 0.55 + 0.6 * smoothstep(0.35, 0.85, noise(vec2(abs(x) * 6.0 - tl * 0.5, seed)));
        float feet = smoothstep(1.15, 0.85, abs(x));
        float pv = ((threads * 0.4 + sheath * 0.85) * knots * lit * 1.2 + curtain) * feet * life
                 * (1.0 - lift * 0.6);
        heat += pv * 0.75;
        glow += pv;
      }
    }

    // ---- flare: now and then a jet bursts off the limb and falls back ----
    {
      float u = uFlare.x;
      float on = uFlare.y;
      float af = uFlare.z;
      float da = wrapA(a - af);
      float burst = smoothstep(0.0, 0.12, u) * exp(-max(u - 0.12, 0.0) * 5.0);
      float reach = 0.05 + 0.2 * smoothstep(0.0, 0.35, u);
      float jet = exp(-pow(da / (0.05 + hh * 0.5), 2.0)) * smoothstep(reach, 0.0, hh)
                * (0.6 + 0.4 * fbm(vec2(da * 30.0, hh * 25.0 - u * 6.0)));
      float flash = exp(-pow(da / 0.12, 2.0)) * exp(-hh / 0.02) * burst;
      float f = (jet * 0.9 + flash) * burst * on;
      heat += f * 0.9;
      glow += f;
    }

    vec3 c = ramp(clamp(heat, 0.0, 1.0)) * glow;
    // a touch of magenta in the outer corona and the cooler prominence plasma
    c = mix(c, uMagenta * glow, smoothstep(0.02, 0.2, hh) * 0.35);
    c = mix(c, uCrimson * glow, chrom * smoothstep(0.003, 0.0, hh) * 0.4);
    float ga = clamp(glow, 0.0, 1.0);
    col = col * alpha + c * (1.0 - alpha);
    alpha = max(alpha, ga * mix(0.75, 1.0, uLight));
  }
  // fade out well before the canvas edge
  float edge = smoothstep(1.0, 0.82, r);
  outColor = vec4(col * edge, alpha * edge);
}`;

export function HeroSun({ size = 200 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const theme = useTheme();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
    if (!gl) {
      setFailed(true);
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? "");
      return s;
    };
    const prog = gl.createProgram()!;
    try {
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog) ?? "");
    } catch (err) {
      console.warn("[hero sun] shader setup failed", err);
      setFailed(true);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uni = Object.fromEntries(
      ["uAge", "uW", "uOff", "uSpin", "uProm", "uFlare"].map((n) => [n, u(n)]),
    );

    const probe = document.createElement("canvas").getContext("2d")!;
    const rgb = (name: string) => {
      probe.fillStyle = "#000";
      probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const n = parseInt(String(probe.fillStyle).slice(1), 16) || 0;
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const;
    };
    for (const [uni, v] of [
      ["uGlint", "--glint"],
      ["uCorona", "--corona"],
      ["uEmber", "--ember"],
      ["uCrimson", "--crimson"],
      ["uMagenta", "--magenta"],
    ] as const)
      gl.uniform3fv(u(uni), rgb(v));
    gl.uniform1f(u("uLight"), document.documentElement.dataset.theme === "light" ? 1 : 0);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Start at a random moment so every visit shows a different sky.
    const t0 = performance.now() - Math.random() * 60_000 - devUptime * 1000;
    const draw = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const ti = timeInputs((performance.now() - t0) / 1000);
      gl.uniform2fv(uni.uAge, ti.age);
      gl.uniform2fv(uni.uW, ti.w);
      gl.uniform4fv(uni.uOff, ti.off);
      gl.uniform2fv(uni.uSpin, ti.spin);
      gl.uniform4fv(uni.uProm, ti.prom);
      gl.uniform3fv(uni.uFlare, ti.flare);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    if (reduced) {
      draw();
      return;
    }
    let timer = 0;
    let stopped = false;
    let blurredAt = document.hasFocus() ? -1 : performance.now();
    const loop = () => {
      timer = 0;
      if (stopped || document.hidden) return;
      if (blurredAt >= 0 && performance.now() - blurredAt > 8000) return;
      draw();
      timer = window.setTimeout(() => requestAnimationFrame(loop), 1000 / 30 - 4);
    };
    const resume = () => {
      if (!timer) loop();
    };
    const onFocus = () => {
      blurredAt = -1;
      resume();
    };
    const onBlur = () => {
      blurredAt = performance.now();
    };
    const onVis = () => !document.hidden && resume();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };
  }, [reduced, theme, size]);

  if (failed) return <SolarMark size={Math.round(size * 0.4)} />;
  return (
    <canvas ref={ref} className="hero-sun" style={{ width: size, height: size }} aria-hidden />
  );
}
