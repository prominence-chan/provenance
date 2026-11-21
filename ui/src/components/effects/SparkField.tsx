// Rising plasma sparks above the composer (nova only). A burst when a turn starts,
// then a light trickle while it streams. One small canvas, pre-rendered glow sprites,
// requestAnimationFrame only while particles are alive, paused while the tab is hidden,
// and skipped entirely under prefers-reduced-motion. pointer-events: none, so it never
// gets in the way of typing or scrolling.
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./useFx";

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  sprite: number;
  wobble: number;
}

const BURST = 64;
const TRICKLE_PER_SEC = 7;
const MAX_SPARKS = 160;

export function SparkField({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ReturnType<typeof createEngine> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || prefersReducedMotion()) return;
    const e = createEngine(canvas);
    engine.current = e;
    return () => {
      e.destroy();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (active) e.burst(BURST);
    e.setTrickle(active);
  }, [active]);

  return <canvas ref={canvasRef} className="spark-field" aria-hidden />;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Soft round glow with a hot core, drawn once per color. */
function makeSprite(color: string, core: string): HTMLCanvasElement {
  const s = 32;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, core);
  grad.addColorStop(0.18, color);
  grad.addColorStop(0.45, color + "55");
  grad.addColorStop(1, color + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return c;
}

function createEngine(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const core = cssVar("--fx-nova-core", "#ffe7f3");
  const sprites = [
    cssVar("--fx-nova-a", "#ff4fa3"),
    cssVar("--fx-nova-b", "#ff7a3d"),
    cssVar("--corona", "#ffc061"),
    cssVar("--fx-nova-c", "#b44dff"),
  ].map((c) => makeSprite(toHex(c), core));
  // Weighted toward magenta/ember; violet is rare.
  const pick = () => {
    const r = Math.random();
    return r < 0.42 ? 0 : r < 0.78 ? 1 : r < 0.93 ? 2 : 3;
  };

  let sparks: Spark[] = [];
  let raf = 0;
  let last = 0;
  let trickle = false;
  let trickleDebt = 0;
  let pendingBurst = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const spawn = (n: number) => {
    // Inset a bit so sparks rise from the composer's top edge, not the canvas margin.
    const margin = 28;
    for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
      sparks.push({
        x: margin + Math.random() * Math.max(1, w - margin * 2),
        y: h - 2 - Math.random() * 6,
        vx: (Math.random() - 0.5) * 18,
        vy: -(38 + Math.random() * 80),
        age: 0,
        life: 1.1 + Math.random() * 1.5,
        size: 5 + Math.random() * 9,
        sprite: pick(),
        wobble: Math.random() * Math.PI * 2,
      });
    }
  };

  const frame = (t: number) => {
    raf = 0;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;

    if (pendingBurst > 0) {
      // Spread the burst over a few frames so it swells instead of popping.
      const n = Math.min(pendingBurst, 10);
      spawn(n);
      pendingBurst -= n;
    }
    if (trickle) {
      trickleDebt += TRICKLE_PER_SEC * dt;
      const n = Math.floor(trickleDebt);
      if (n) {
        spawn(n);
        trickleDebt -= n;
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const next: Spark[] = [];
    for (const s of sparks) {
      s.age += dt;
      if (s.age >= s.life) continue;
      s.wobble += dt * 3;
      s.vx += Math.sin(s.wobble) * 6 * dt;
      s.vy *= 1 - 0.35 * dt; // drag: sparks slow and fade as they rise
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const k = s.age / s.life;
      const alpha = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
      const size = s.size * (1 - k * 0.55);
      ctx.globalAlpha = Math.max(0, alpha) * 0.9;
      ctx.drawImage(sprites[s.sprite], s.x - size / 2, s.y - size / 2, size, size);
      next.push(s);
    }
    ctx.globalAlpha = 1;
    sparks = next;
    schedule();
  };

  const schedule = () => {
    if (raf || document.hidden) return;
    if (!sparks.length && !trickle && pendingBurst <= 0) {
      last = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    } else {
      schedule();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    burst(n: number) {
      pendingBurst += n;
      schedule();
    },
    setTrickle(on: boolean) {
      trickle = on;
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/** Sprites append alpha hex digits, so normalize `#abc` / `rgb()` to `#rrggbb`. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = color;
  const v = c.fillStyle; // browsers normalize to #rrggbb for opaque colors
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#ff4fa3";
}
