// The new-thread hero: a live sun with 3D loops and flares, one small WebGL2 canvas, and it
// reacts to the selected tier.
//
// The disc is a turning sphere (spherical mapping, so features foreshorten at the limb), with
// limb darkening, granulation at three scales and speeds, faculae and a dark filament; a
// corona with two streamer layers turning at different rates and a soft bloom; a red
// chromosphere with two layers of spicules.
//
// Loops and flares are 3D: each active region is a pair of footpoints (faint plage, no
// sunspots) on the turning sphere, carried by the same differential rotation as the
// surface, with a loop of plasma arching between them. The CPU builds each loop's curve in 3D
// and sends it projected (x, y, depth); the shader draws it as a tube, bright against the disc
// when it faces you, as a prominence when it stands off the limb, hidden where it passes
// behind. Each lives its own cycle (it emerges, the footpoints spread, it arcs, then fades or
// erupts: the top lifts off and the footpoints flare), and now and then a jet bursts out of a
// region and falls back.
//
// The tier (App passes the selected one; the welcome's intro shows the plain sun):
//   spark      a calmer sun: fewer active regions and jets, slightly smaller
//   ember      the sun (also the fallbacks, Claude Code and Codex)
//   solstice   an ageing sun, eased into over ~2.5 s: 18% larger, brighter, a deeper
//              orange-red and puffier, a redder glow, rougher convection and limb, more loops
//              and eruptions, a slow pulsation
//   nova       the star boils for a moment and collapses straight down to a white dwarf; its
//              tipping point lands on the composer's nova burst (FlameFx publishes when, see
//              fxSync.ts; ~1.2-1.6 s after the selection), so the flash and the composer's
//              eruption are one event. Then one soft flash, a shock front, and a nebula round
//              the dwarf that fills the hero (its own canvas behind the heading) and keeps
//              drifting on closed loops; each explosion draws one of six styles and six
//              palettes, and its proportions, from its seed. Leaving nova runs it back: the
//              nebula falls in (IMPLODE), the star re-ignites out of the dwarf (REIGNITE) and
//              settles to the new tier. Every stage is a function of two levels (collapse,
//              nebula), so a switch mid-way just turns them round from where they are.
//
// Days of uptime (see 12d215ff): the shader only sees small time values. The surface is two
// layers each living LAYER_LIFE s, cross-faded; everything else (loop lives, the streamers'
// turn, the pulsation, the nebula's drift) is worked out here in double precision and sent
// wrapped or as a phase. The nebula's idle motion is periodic by construction.
//
// Cheap: the sun's canvas ~200 CSS px square, DPR capped at 2, 30 fps; the nebula's canvas at
// NEB_RES device px per CSS px, drawn only while there is a nebula (15 fps once settled);
// paused when the hero is off screen, the
// tab is hidden or the window has been unfocused for a few seconds. Under
// prefers-reduced-motion (or data-fx="static" on the main column) there is no sequence: each
// tier's settled still, cross-faded over STILL_FADE when the tier changes. Without WebGL2: the
// static SolarMark, or a small remnant mark for nova.
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../theme/theme";
import type { TierId } from "../../theme/tiers";
import { SolarMark } from "../SolarMark";
import { novaBurst } from "./fxSync";
import { GLSL_HASH } from "./glsl";
import { devUptime, useReducedMotion } from "./useFx";

/** Seconds a surface layer lives (see surface() in the shader): long enough to read as one
 * slowly turning surface, short enough that its shear stays at the first minute's. */
const LAYER_LIFE = 100;
/** Nova's stages, in seconds: the collapse, the nebula's expansion after the blast, and on
 * the way back the nebula falling in and the star re-igniting. The collapse is normally timed
 * by the composer's nova flare instead (it lands on its burst, see fxSync.ts); BUILD is its
 * nominal charge, used when there is no composer flare to follow. */
const BUILD = 1.35;
const EXPAND = 6;
const IMPLODE = 1.8;
const REIGNITE = 1.7;
/** At most one flash per this many seconds, however fast nova is toggled. */
const FLASH_GAP = 6;
/** The flash's peak (0..1 of the shader's flash term; see the measurements in the commit). */
const FLASH_PEAK = 0.75;
/** Seconds from the tipping point to the flash's peak (the composer's is 0.05 s too). */
const FLASH_RISE = 0.05;
/** Reduced motion: the cross-fade between two tiers' stills. */
const STILL_FADE = 0.6;
/** A frame gap longer than this (paused, hidden) settles the sequence instead of playing it. */
const JUMP = 0.5;
/** How far into the collapse level the star starts shrinking (before it: it boils). */
const COLLAPSE_FROM = 0.25;
/** Solstice's extra radius. */
const SOLSTICE_GROWTH = 0.18;
/** The nebula's canvas resolution, device px per CSS px: soft gas, scaled up by the browser. */
const NEB_RES = 0.6;
/** Loops and jets: NL slots (the last one a jet), NP points per curve. */
const NL = 8;
const NP = 11;

const TAU = Math.PI * 2;
const hash1 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const wrap = (x: number, m: number) => x - m * Math.floor(x / m);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ss = (a: number, b: number, x: number) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};

// ---- what each tier shows ----------------------------------------------------------------

interface Target {
  /** -1 spark (calm) .. 0 the sun .. 1 solstice (ageing); null: as it is (nova goes straight
   * into the collapse, it doesn't age or swell first). */
  evo: number | null;
  nova: boolean;
}
function targetOf(tier: TierId | null | undefined): Target {
  if (tier === "spark") return { evo: -1, nova: false };
  if (tier === "solstice") return { evo: 1, nova: false };
  if (tier === "nova") return { evo: null, nova: true };
  return { evo: 0, nova: false };
}

/** The sequence's state. col and neb only move at fixed rates (see step()). */
interface Sim {
  evo: number;
  evoV: number;
  /** 0 the star .. 1 collapsed to the white dwarf. */
  col: number;
  /** 0 no nebula .. 1 the settled remnant (only above 0 while col is 1). */
  neb: number;
  /** Clock seconds of the last explosion (-1e9: none on screen). */
  blastAt: number;
  /** Whether that explosion flashed (FLASH_GAP). */
  flashed: boolean;
  lastFlash: number;
  /** Eases to 1 while nova is wanted, to 0 otherwise: the shock and flash fade if you leave. */
  fwd: number;
  seed: number;
}

// The last nebula's seed, kept across remounts of the hero so it shows the same remnant.
let lastSeed: number | null = null;
let devSeed = import.meta.env.DEV
  ? Number(new URLSearchParams(location.search).get("sunseed") ?? NaN)
  : NaN;
function newSeed(): number {
  if (import.meta.env.DEV && Number.isFinite(devSeed)) return devSeed++;
  return Math.floor(Math.random() * 10_000);
}

function settled(tg: Target): Sim {
  const nova = tg.nova;
  if (nova && lastSeed == null) lastSeed = newSeed();
  return {
    evo: tg.evo ?? 0,
    evoV: 0,
    col: nova ? 1 : 0,
    neb: nova ? 1 : 0,
    blastAt: -1e9,
    flashed: false,
    lastFlash: -1e9,
    fwd: nova ? 1 : 0,
    seed: lastSeed ?? 0,
  };
}

/**
 * Moves the sequence on by dt (clock t). tip: when the collapse should reach its tipping point
 * (the composer's burst less FLASH_RISE, on this clock), or null to take BUILD.
 */
function step(s: Sim, tg: Target, t: number, dt: number, tip: number | null = null): void {
  // evo: critically damped, so a change mid-way turns round without a kink (~2.5 s to settle)
  for (let left = dt; left > 0; left -= 1 / 60) {
    const h = Math.min(left, 1 / 60);
    const w = 2.6;
    if (tg.evo == null) s.evoV *= Math.exp(-h * 8);
    else s.evoV += (-2 * w * s.evoV - w * w * (s.evo - tg.evo)) * h;
    s.evo += s.evoV * h;
  }
  s.fwd += ((tg.nova ? 1 : 0) - s.fwd) * (1 - Math.exp(-dt / 0.25));
  if (tg.nova) {
    if (s.col < 1) {
      // Aimed at the composer's burst: the rest of the way in the time left, so it lands on it
      // from wherever it is (a re-selection mid-way included).
      // The blast is placed at the tip itself, not at the frame that reaches it, so a slow
      // frame rate doesn't move the flash off the composer's burst.
      const left = tip == null || tip - t > 4 ? null : tip - t;
      let at = t;
      if (left == null) s.col = Math.min(1, s.col + dt / BUILD);
      else if (left <= dt / 2) {
        s.col = 1;
        at = t + Math.max(left, 0);
      } else s.col = Math.min(0.999, s.col + ((1 - s.col) * dt) / left);
      if (s.col === 1 && s.neb === 0) {
        // the hypernova: a new remnant each time, at most one flash per FLASH_GAP
        s.blastAt = at;
        s.flashed = at - s.lastFlash > FLASH_GAP;
        if (s.flashed) s.lastFlash = at;
        s.seed = lastSeed = newSeed();
      }
    } else s.neb = Math.min(1, s.neb + dt / EXPAND);
  } else if (s.neb > 0) s.neb = Math.max(0, s.neb - dt / IMPLODE);
  else s.col = Math.max(0, s.col - dt / REIGNITE);
}

// ---- the nebula's look, from its seed ---------------------------------------------------------

/** Emission palettes, dark theme (linear-ish RGB): low ionisation (outer: Hα, [NII], [SII]),
 * high ionisation (inner: [OIII]), knots. */
const PALETTES: [number[], number[], number[]][] = [
  // natural colour: Hα red outside, [OIII] teal inside
  [
    [0.95, 0.2, 0.28],
    [0.2, 0.82, 0.8],
    [1.0, 0.6, 0.55],
  ],
  // the Hubble palette (SHO): [SII]/Hα gold, [OIII] blue
  [
    [1.0, 0.62, 0.2],
    [0.25, 0.5, 1.0],
    [1.0, 0.88, 0.6],
  ],
  // magenta and green (HOO with Hα pushed to magenta)
  [
    [0.9, 0.22, 0.7],
    [0.3, 0.9, 0.5],
    [1.0, 0.7, 0.9],
  ],
  // Crab-like: orange-red filaments, blue-white synchrotron glow
  [
    [1.0, 0.4, 0.16],
    [0.5, 0.66, 1.0],
    [1.0, 0.82, 0.45],
  ],
  // Helix-like natural colour: deep red rim, blue-white core, gold knots
  [
    [0.92, 0.18, 0.16],
    [0.45, 0.68, 1.0],
    [1.0, 0.75, 0.4],
  ],
  // amber and violet
  [
    [1.0, 0.55, 0.18],
    [0.62, 0.45, 1.0],
    [1.0, 0.85, 0.7],
  ],
];
/** ring (a thick shell, planetary nebula), shell (a thin torn supernova shell with knots),
 * bipolar (unequal lobes on a bent axis, a waist ring), crab (filaments over a synchrotron
 * glow), veil (broken arcs of an old shell, sweeping filaments), eye (nested offset shells). */
export const NEBULA_STYLES = ["ring", "shell", "bipolar", "crab", "veil", "eye"] as const;
export const NEBULA_PALETTES = [
  "natural",
  "narrowband",
  "magenta-green",
  "crab",
  "helix",
  "amber-violet",
] as const;

/** Everything about a remnant's look, from its seed: the same seed, the same nebula. */
export function nebulaOf(seed: number) {
  const h = (k: number) => hash1(seed * 0.618 + k * 7.31 + 0.5);
  const n = PALETTES.length;
  const style = Math.min(5, Math.floor(h(1) * 6));
  const pal = style === 3 && h(2) < 0.55 ? 3 : Math.min(n - 1, Math.floor(h(3) * n));
  return {
    style,
    pal,
    axis: h(4) * TAU,
    ell: 0.58 + 0.42 * h(5),
    thick: h(6),
    off: [h(7) * 40, h(8) * 40],
    // irregularity: lopsided towards an angle, a broken shell, streamers, an off-centre cavity,
    // unequal lobes, jets
    lopA: h(9) * TAU,
    lop: 0.1 + 0.32 * h(10),
    tear: style === 4 ? 0.85 + 0.15 * h(11) : 0.15 + 0.7 * h(11),
    streak: 0.2 + 0.8 * h(12),
    shift: [(h(13) - 0.5) * 0.3, (h(14) - 0.5) * 0.3],
    asym: 0.6 + 0.4 * h(15),
    jets: style !== 4 && h(16) > 0.6 ? 1 : 0,
  };
}

// ---- per-frame inputs ---------------------------------------------------------------------

interface Frame {
  age: number[];
  w: number[];
  off: number[];
  spin: number[];
  star: number[];
  loop: Float32Array;
  loopA: Float32Array;
  loopB: Float32Array;
  loopC: Float32Array;
  spot: Float32Array;
  nova: number[];
  neb: number[];
  nebP: number[];
  nebQ: number[];
  nebS: number[];
  nebPh: number[];
  nebPh2: number[];
  nebC: number[];
  flash: number;
}

const sph = (lat: number, lon: number) => [
  Math.cos(lat) * Math.sin(lon),
  Math.sin(lat),
  Math.cos(lat) * Math.cos(lon),
];
const norm = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** The surface's turn rate at a latitude, rad/s: the same as surface() in the shader. */
const omega = (lat: number) => 0.03 * (1 - 0.3 * Math.sin(lat) ** 2);

/**
 * The shader's inputs at t seconds (any t: days of uptime included) for a sequence state,
 * each small: two surface layers half a life apart; the streamers' turn as an angle; each
 * loop's curve, worked out here from how far it is through its life.
 */
function frameAt(t: number, s: Sim): Frame {
  const age = [0, 1].map((j) => wrap(t + (j * LAYER_LIFE) / 2, LAYER_LIFE));
  const life = [0, 1].map((j) => Math.floor((t + (j * LAYER_LIFE) / 2) / LAYER_LIFE));
  const off = life.flatMap((c, j) => [
    hash1(c * 1.37 + j * 0.31) * 40,
    hash1(c * 2.71 + j * 0.53) * 40,
  ]);
  const w = age.map((a) => Math.abs(Math.sin((Math.PI * a) / LAYER_LIFE)));
  const evoP = Math.max(s.evo, 0);
  const evoN = Math.max(-s.evo, 0);
  const crush = ss(COLLAPSE_FROM, 1, s.col);
  const unrest = ss(0, COLLAPSE_FROM, s.col) * (1 - crush);
  const sunOn = 1 - ss(0.15, 0.6, s.col); // the loops fade as the star collapses

  // The star's radius: older is larger and breathes slowly; the collapse crushes it straight
  // down to the dwarf's size, faster and faster (no swell first).
  const breath = Math.sin(wrap(t / 7.5, 1) * TAU);
  const R =
    0.36 *
    (1 + SOLSTICE_GROWTH * evoP - 0.03 * evoN) *
    (1 + 0.016 * evoP * breath) *
    (1 - 0.95 * Math.pow(crush, 1.8));

  // ---- loops: NL - 1 active regions and a jet ----
  const loop = new Float32Array(NL * NP * 4);
  const loopA = new Float32Array(NL * 4);
  const loopB = new Float32Array(NL * 4);
  const loopC = new Float32Array(NL * 4);
  const spot = new Float32Array(NL * 2 * 4);
  const count = 5 + 2 * s.evo; // active regions: 3 calm, 5 the sun, 7 ageing
  for (let i = 0; i < NL; i++) {
    const jet = i === NL - 1;
    const T = jet ? 7.5 : 16 + 9 * hash1(i * 3.1); // life length, s
    const cyc = t / T + hash1(i * 7.7);
    const k = Math.floor(cyc);
    const u = cyc - k;
    const tau = u * T; // seconds into this life: small
    // The life number only seeds the region's place, size and fate: wrapped, it stays exact.
    const seed = wrap(k, 997) * 13 + i * 5.3;
    const H = (n: number) => hash1(seed + n * 1.37);
    const lat = (H(1) < 0.5 ? -1 : 1) * (0.12 + 0.52 * H(2));
    const lon = (H(3) * 2 - 1) * Math.PI - omega(lat) * tau;
    const C = sph(lat, lon);
    const east = [Math.cos(lon), 0, -Math.sin(lon)];
    const north = [-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon)];
    let pts: number[][];
    let bright: number;
    let width: number;
    let flare: number;
    let erupt = 0;
    let spotR = 0;
    let F1 = C;
    let F2 = C;
    if (!jet) {
      const act = clamp01(count - i);
      const emerge = ss(0, 0.3, u);
      const lifeE = ss(0, 0.15, u) * (1 - ss(0.78, 1, u));
      const erupts = H(8) > 0.64 - 0.12 * evoP;
      erupt = erupts ? Math.pow(ss(0.55, 1, u), 2) : 0;
      const sep = (0.2 + 0.26 * H(4)) * (0.55 + 0.45 * emerge);
      // any orientation: at the limb some stand as arches, some edge-on as columns
      const tilt = H(5) * Math.PI;
      const tv = [0, 1, 2].map((c) => east[c] * Math.cos(tilt) + north[c] * Math.sin(tilt));
      F1 = norm(C.map((c, j) => c + (tv[j] * sep) / 2));
      F2 = norm(C.map((c, j) => c - (tv[j] * sep) / 2));
      const nrm = norm(cross(tv, C));
      const lean = (H(7) - 0.5) * 0.9;
      const height =
        (0.11 + 0.2 * H(6)) *
          (1 + 0.25 * evoP) *
          (0.35 + 0.65 * emerge) *
          (1 + 0.05 * Math.sin(tau * 0.8 + seed)) +
        erupt * 0.6;
      pts = [];
      for (let j = 0; j < NP; j++) {
        const f = j / (NP - 1);
        const base = norm([0, 1, 2].map((c) => F1[c] * (1 - f) + F2[c] * f));
        const arch = Math.sin(Math.PI * f);
        const hgt = height * Math.pow(arch, 0.85) * (1 + erupt * 0.5 * arch * arch);
        // erupting, the rope balloons sideways as it lifts (a bubble, not a stretched wire)
        const spread = erupt * 0.3 * Math.sin(2 * Math.PI * f);
        pts.push(
          [0, 1, 2].map(
            (c) =>
              base[c] * (1 + hgt * Math.cos(lean)) + nrm[c] * hgt * Math.sin(lean) + tv[c] * spread,
          ),
        );
      }
      bright = lifeE * (1 - 0.8 * erupt) * act * sunOn;
      width = (0.028 + 0.018 * H(9)) * (1 + erupt * 3.5);
      flare = erupts ? Math.exp(-(((u - 0.6) / 0.06) ** 2)) * act * sunOn : 0;
      // no sunspots: the footpoints are only faint plage
      spotR = (0.07 + 0.05 * H(10)) * ss(0, 0.25, u) * (1 - ss(0.85, 1, u)) * act * sunOn;
    } else {
      // A jet: a spray of plasma up out of a region, curving over as it falls back.
      const on = H(11) > 0.5 - 0.2 * s.evo ? 1 : 0;
      const burst = ss(0, 0.12, u) * Math.exp(-Math.max(u - 0.12, 0) * 5);
      const reach = 0.08 + 0.42 * ss(0, 0.35, u);
      const side = east.map((c, j) => c * Math.cos(H(12) * TAU) + north[j] * Math.sin(H(12) * TAU));
      pts = [];
      for (let j = 0; j < NP; j++) {
        const f = j / (NP - 1);
        const up = reach * f;
        pts.push([0, 1, 2].map((c) => C[c] * (1 + up) + side[c] * up * up * 0.9));
      }
      bright = burst * on * sunOn * 1.1;
      width = 0.045;
      flare = burst * on * sunOn;
    }
    // what's left of nova's build-up: the regions lose their shape and fade
    bright *= 1 - unrest * 0.5;
    let x0 = 9;
    let y0 = 9;
    let x1 = -9;
    let y1 = -9;
    pts.forEach((p, j) => {
      loop.set([p[0], p[1], p[2], 0], (i * NP + j) * 4);
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    });
    const m = width * 4 + 0.02;
    loopA.set([bright, width, erupt, tau], i * 4);
    loopB.set([x0 - m, y0 - m, x1 + m, y1 + m], i * 4);
    loopC.set([wrap(seed, 97), jet ? 1 : 0, flare, 0], i * 4);
    spot.set([...F1, spotR], i * 8);
    spot.set([...F2, spotR * 0.65], i * 8 + 4);
  }

  // ---- nova ----
  const bt = Math.min(t - s.blastAt, 60);
  const flash =
    s.flashed && bt >= 0
      ? FLASH_PEAK *
        ss(0, FLASH_RISE, bt) *
        Math.exp(-Math.max(bt - FLASH_RISE, 0) / 0.22) *
        (0.3 + 0.7 * s.fwd)
      : 0;
  // (layer 1 draws it, in units of the nebula's radius)
  const shockR = 1.3 * (1 - Math.exp(-bt / 0.75));
  const shock = bt >= 0 && bt < 6 ? ss(0, 0.06, bt) * Math.exp(-bt / 0.8) * s.fwd : 0;
  const E = s.neb > 0 ? 1 - Math.pow(1 - s.neb, 2.6) : 0;
  // the young remnant is hot (whiter); falling in, it heats up again
  const hot = Math.max(
    bt >= 0 ? Math.exp(-bt / 2.2) : 0,
    s.fwd < 0.5 && s.neb > 0 ? (1 - E) * 0.8 : 0,
  );
  const nb = nebulaOf(s.seed);
  const pal = PALETTES[nb.pal];
  // The settled remnant keeps moving, on closed loops: the gas folds round once a minute, the
  // filaments shimmer on a 23 s loop, it breathes over 40 s, the dwarf twinkles.
  const phase = wrap(t / 60, 1) * TAU;
  const phase2 = wrap(t / 23, 1) * TAU;
  const twinkle =
    0.8 + 0.12 * Math.sin(wrap(t / 0.9, 1) * TAU) + 0.08 * Math.sin(wrap(t / 0.37, 1) * TAU);
  return {
    age,
    w,
    off,
    spin: [wrap(t * 0.005, TAU), wrap(-t * 0.004, TAU)],
    star: [R, s.col, s.evo, 1],
    loop,
    loopA,
    loopB,
    loopC,
    spot,
    nova: [flash, shockR, shock, E],
    neb: [ss(0, 0.06, s.neb), hot, nb.style, nb.axis],
    nebP: [nb.ell, nb.thick, nb.off[0], nb.off[1]],
    nebQ: [nb.lopA, nb.lop, nb.tear, nb.streak],
    nebS: [nb.shift[0], nb.shift[1], nb.asym, nb.jets],
    nebPh: [Math.cos(phase), Math.sin(phase), 1 + 0.03 * Math.sin(wrap(t / 40, 1) * TAU), twinkle],
    nebPh2: [Math.cos(phase2), Math.sin(phase2), 0, 0],
    nebC: pal.flat(),
    flash,
  };
}

// ---- shaders ------------------------------------------------------------------------------

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Layer 0: the sun's canvas (the star, its loops, the dwarf, the flash). Layer 1: the
 * hero-sized canvas behind the heading (the nebula and the shock front). */
const fs = (layer: 0 | 1) => `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
#define LAYER ${layer}
#define NL ${NL}
#define NP ${NP}
// Every time value here stays small, whatever the uptime: the CPU works them out from its
// own clock (double precision) and sends them wrapped (see frameAt()).
uniform vec2 uAge;       // the two surface layers' ages, 0..LAYER_LIFE s
uniform vec2 uW;         // their weights: sin and |cos| of the same angle, so w1^2 + w2^2 = 1
uniform vec4 uOff;       // each layer's random offset (xy: layer 1, zw: layer 2)
uniform vec2 uSpin;      // the two streamer layers' turn, radians, wrapped
uniform vec4 uStar;      // radius (canvas units), collapse 0..1, evo -1..1, this draw's weight
uniform vec4 uLoop[NL * NP]; // each loop's curve, sphere units: x, y on screen, z towards you
uniform vec4 uLoopA[NL]; // brightness, tube width, eruption 0..1, seconds into its life
uniform vec4 uLoopB[NL]; // its screen box (x0, y0, x1, y1), sphere units
uniform vec4 uLoopC[NL]; // seed, jet (1) or loop (0), footpoint flare, -
uniform vec4 uSpot[NL * 2]; // footpoints: unit vector on the sphere, sunspot radius
uniform vec4 uNova;      // flash 0..1, shock radius, shock strength, nebula scale 0..1
uniform vec4 uNeb;       // nebula brightness, heat (young or falling in), style, axis angle
uniform vec4 uNebP;      // ellipticity, thickness, noise offset xy
uniform vec4 uNebQ;      // lopsided towards (angle), by how much, broken shell 0..1, streamers 0..1
uniform vec4 uNebS;      // cavity offset xy, second lobe's size, jets (1) or not
uniform vec4 uNebPh;     // drift phase (cos, sin; 60 s), breathing scale, the dwarf's twinkle
uniform vec4 uNebPh2;    // shimmer phase (cos, sin; 23 s)
uniform vec3 uNebC[3];   // palette: low ionisation (outer), high (inner), knots
// layer 1 only: where it sits, in the sun canvas's units (1 = half the sun canvas), y up
uniform vec4 uView;      // this canvas's half size (xy), the sun's centre from its centre (zw)
uniform vec4 uFade;      // the sun's centre to the hero's left, right, bottom and top edges
uniform vec4 uText;      // the heading's box round the sun's centre (x0, y0, x1, y1)
uniform float uNebR;     // the settled nebula's radius
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
// Gradient noise (-~0.7..0.7) for the nebula: sharper creases than value noise once ridged.
vec2 grad(vec2 i) {
  float h = hash(i);
  return vec2(h, fract(h * 251.0)) * 2.0 - 1.0;
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f), b = dot(grad(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad(i + vec2(0, 1)), f - vec2(0, 1)), d = dot(grad(i + vec2(1, 1)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float gfbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += a * gnoise(p); p = m * p; a *= 0.5; }
  return v;
}
// Ridged multifractal (Musgrave): thin bright creases, each octave weighted by the one
// before, so the fine filaments follow the big ones instead of speckling everywhere.
float ridged(vec2 p) {
  float v = 0.0, a = 0.55, w = 1.0;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(gnoise(p) * 1.7);
    n *= n * w;
    w = clamp(n * 1.6, 0.0, 1.0);
    v += n * a;
    p = m * p + 3.1;
    a *= 0.5;
  }
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
// sheared into chevrons and then stripes). The loops' footpoints turn at the same rate.
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

// The loops and jets, each a tube along its projected 3D curve. A stretch of curve behind
// the sphere is hidden where it crosses the disc and shows where it stands off the limb.
// face: light on the disc (from the parts in front of it); limb: light off the disc.
void loops(vec2 q, float inDisc, out float face, out float limb) {
  face = 0.0; limb = 0.0;
  for (int i = 0; i < NL; i++) {
    vec4 A = uLoopA[i];
    if (A.x < 0.004) continue;
    vec4 B = uLoopB[i];
    if (q.x < B.x || q.y < B.y || q.x > B.z || q.y > B.w) continue;
    vec4 C = uLoopC[i];
    float best = 1e3, bt = 0.0, bz = 0.0;
    for (int j = 0; j < NP - 1; j++) {
      vec3 s0 = uLoop[i * NP + j].xyz, s1 = uLoop[i * NP + j + 1].xyz;
      vec2 pa = q - s0.xy, ba = s1.xy - s0.xy;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
      float z = mix(s0.z, s1.z, h);
      float d = length(pa - ba * h) + inDisc * smoothstep(0.0, -0.05, z);
      if (d < best) { best = d; bt = (float(j) + h) / float(NP - 1); bz = z; }
    }
    float w = A.y;
    if (best > w * 5.0) continue;
    float seed = C.x, tl = A.w;
    // a rope of threads in a soft sheath; knots of plasma drain from the top down both legs
    float threads = 0.55 + 0.7 * noise(vec2(bt * 26.0 + seed, best / w * 1.4 + seed));
    float knots = 0.6 + 0.6 * smoothstep(0.35, 0.85, noise(vec2(abs(bt - 0.5) * 10.0 - tl * 0.5, seed)));
    float core = exp(-best * best / (w * w * 0.4));
    float sheath = exp(-best / (w * 1.3)) * 0.4;
    float e = (core * threads * knots + sheath) * A.x;
    // a jet is brightest at its base and thins out as it climbs
    e *= mix(1.0, pow(1.0 - bt, 0.7) * 1.5, C.y);
    // against the disc a loop's legs fade into its footpoints
    if (inDisc > 0.5 && bz > -0.02) face += e * mix(smoothstep(0.0, 0.2, bt) * smoothstep(1.0, 0.8, bt), 1.0, C.y);
    else limb += e;
  }
}

// Projected emission of a thick spherical shell between radii a < b, at projected radius rho:
// the path length through it, 1 at the inner edge (where the line of sight grazes the most
// gas). This is what makes a shell look like a ring with a darker middle.
// The outer edge is softened (the shell's density thins out rather than stopping).
float shell(float rho, float a, float b) {
  float o = sqrt(max(b * b - rho * rho, 0.0) + 0.006) - 0.0775;
  return (o - sqrt(max(a * a - rho * rho, 0.0))) / sqrt(b * b - a * a)
       * smoothstep(b * 1.12, b * 0.9, rho);
}

// The remnant: em = light (dark theme), dens = how much gas (the light theme's ink). p is in
// the sun canvas's units round the star.
void nebula(vec2 p, out vec3 em, out float dens) {
  em = vec3(0.0); dens = 0.0;
  float E = uNova.w;
  if (E < 0.003) return;
  float Rn = uNebR * E * uNebPh.z;
  // (it rocks a little about its axis, on the 60 s loop)
  float ax = uNeb.w + 0.035 * uNebPh.y;
  float ca = cos(ax), sa = sin(ax);
  vec2 np = mat2(ca, sa, -sa, ca) * p / Rn;
  np.y /= uNebP.x;
  if (dot(np, np) > 4.0) return;
  vec2 off = uNebP.zw;
  // Two closed loops of motion (uNebPh, uNebPh2 are phases), so it drifts and shimmers forever
  // without going anywhere: the whole gas folds slowly, the filaments a little faster.
  vec2 flow = uNebPh.xy * 0.3;
  vec2 shim = uNebPh2.xy * 0.22;
  // Domain warping (after Inigo Quilez): fbm displaces the plane, so the noise folds into
  // sheets and wisps rather than blobs.
  vec2 wq = np * 1.5 + off;
  vec2 wv = vec2(gfbm(wq + flow), gfbm(wq + vec2(5.2, 1.3) - flow.yx));
  vec2 wp = np + wv * 0.3;
  // Lopsided and off-centre: the gas got further one way, and the cavity sits off the star.
  vec2 cp = wp - uNebS.xy;
  float rr0 = length(cp);
  vec2 dir = cp / max(rr0, 1e-4);
  float lop = 1.0 + uNebQ.y * dot(dir, vec2(cos(uNebQ.x), sin(uNebQ.x)));
  float lump = gnoise(dir * 1.7 + off) * 0.24 + gnoise(dir * 4.3 + off + 2.0) * 0.08;
  float rr = rr0 / (lop * (1.0 + lump));       // in the outline's own units: 1 = the rim
  // the filament network: ridged noise on the warped plane, combed along the flow
  float fil = ridged(wp * 4.0 + off * 1.7 + wv * 1.6 + shim);
  // patchy density, and a shell broken open in places
  float clump = 0.45 + 1.1 * smoothstep(-0.3, 0.3, gnoise(np * 1.2 + off + 3.0 + shim * 0.5));
  // (angle-only terms fade out towards the middle, where every direction meets)
  float brk = mix(1.0, smoothstep(-0.15, 0.3, gnoise(dir * 2.3 + off + 11.0)), uNebQ.z * smoothstep(0.1, 0.55, rr0));
  float lo = 0.0, hi = 0.0, knot = 0.0, haze = 0.0;
  int style = int(uNeb.z + 0.5);
  if (style == 0) {
    // RING: a thick shell, red outside, the inner [OIII] zone filling the cavity in teal
    float ri = 0.5 + 0.14 * uNebP.y;
    lo = shell(rr, ri * 1.08, 0.86) * (0.3 + 1.1 * fil * fil) * brk;
    hi = shell(rr, ri * 0.7, 0.7) * (0.45 + 0.6 * (wv.x + 0.5)) * 0.7;
    knot = smoothstep(0.32, 0.55, gnoise(wp * 13.0 + off)) * shell(rr, ri, 0.82) * 0.7;
    // a faint outer halo of older, cooler gas
    lo += exp(-abs(rr - 0.86) / 0.14) * smoothstep(0.8, 0.92, rr) * (0.3 + fil) * 0.22;
  } else if (style == 1) {
    // SHELL: a thin, torn supernova shell; shocked ejecta knots inside it
    lo = shell(rr, 0.82, 0.92) * (0.2 + 1.8 * pow(fil, 5.0)) * brk;
    float fil2 = ridged(wp * 5.4 - off + wv * 2.0 - shim);
    hi = shell(rr, 0.66, 0.84) * pow(fil2, 6.0) * 1.4 * (0.4 + 0.6 * brk);
    knot = smoothstep(0.34, 0.5, gfbm(wp * 7.0 + off * 1.3)) * smoothstep(0.85, 0.5, rr) * 0.6;
    haze = smoothstep(0.92, 0.2, rr) * 0.06;
  } else if (style == 2) {
    // BIPOLAR: two unequal lobes on a bent axis, pinched at a waist ring round the star
    for (int s = 0; s < 2; s++) {
      float sx = s == 0 ? 1.0 : -1.0;
      float sz = s == 0 ? 1.0 : uNebS.z;
      vec2 c = vec2(sx * 0.46 * sz, sx * 0.14 * uNebQ.y);
      vec2 l = (wp - c) / (vec2(0.56, 0.42) * sz * (1.0 + 0.5 * lump));
      float rl = length(l);
      float open = 1.0 - 0.6 * smoothstep(0.6, 1.0, l.x * sx);   // the tips thin out
      lo += shell(rl, 0.76, 1.0) * open * (0.15 + 1.2 * fil * fil);
      hi += shell(rl * 1.12, 0.5, 1.0) * exp(-abs(wp.x) / 0.35) * 0.5;
    }
    float e = length((wp - uNebS.xy * 0.3) / vec2(0.1, 0.3));
    float waist = exp(-pow((e - 1.0) / 0.3, 2.0)) * brk;
    lo += waist * 0.7;
    knot = waist * smoothstep(0.0, 0.4, gnoise(wp * 16.0 + off)) * 1.2;
    haze = exp(-dot(wp, wp) / 0.04) * 0.35;
  } else if (style == 3) {
    // CRAB: an ellipsoid cage of filaments, streaming outward, over a blue synchrotron glow
    float rho = length(cp / vec2(0.95, 0.72)) / (lop * (1.0 + lump));
    float mask = smoothstep(1.0, 0.72, rho);
    float rad = ridged(dir * 5.0 + vec2(rho * 1.2, 0.0) + off * 0.7 + shim);  // radial streaks
    lo = mask * (0.75 * pow(fil, 2.2) + 0.4 * pow(rad, 3.0) * smoothstep(0.35, 0.8, rho))
       * (0.35 + 0.65 * smoothstep(0.15, 0.85, rho));
    hi = exp(-rho * rho / 0.3) * (0.5 + 0.5 * (wv.y + 0.5)) * 0.75 * mask;
    knot = lo * smoothstep(0.55, 0.9, fil) * 0.8;
  } else if (style == 4) {
    // VEIL: what is left of a big old shell, broken arcs and long sweeping filaments
    float sweep = pow(ridged(wp * 2.6 + off + wv * 2.4 + shim), 4.0);
    lo = shell(rr, 0.8, 0.95) * brk * (0.25 + 2.4 * sweep) + sweep * smoothstep(1.0, 0.5, rr) * 0.3;
    hi = shell(rr, 0.72, 0.9) * pow(fil, 5.0) * 1.2 * brk;
  } else {
    // EYE: nested shells, offset and tilted against each other, round a bright inner bubble
    float cb = cos(1.1 + uNebQ.x), sb = sin(1.1 + uNebQ.x);
    vec2 r2 = mat2(cb, sb, -sb, cb) * (wp + uNebS.xy * 0.6);
    float e1 = length(cp / vec2(0.62, 0.42)) / (1.0 + lump * 0.6);
    float e2 = length(r2 / vec2(0.5, 0.32));
    lo = shell(e1, 0.82, 1.0) * (0.3 + 1.0 * fil * fil) + shell(rr, 0.85, 1.0) * 0.35 * (0.3 + fil) * brk;
    hi = shell(e2, 0.7, 1.0) * 0.6 + exp(-dot(wp, wp) / 0.03) * 0.25;
    knot = shell(e2, 0.85, 1.0) * smoothstep(0.1, 0.5, gnoise(wp * 14.0 + off)) * 0.8;
  }
  // ragged outer filaments: sparse streaks running out past the rim, only along some
  // stretches of it (some seeds more than others)
  if (rr > 0.78 && uNebQ.w > 0.05) {
    float sector = smoothstep(0.05, 0.4, gnoise(dir * 1.3 + off + 21.0));
    float streak = pow(ridged(dir * 6.5 + vec2(rr * 1.4, 0.0) + off * 1.3 + shim), 5.0);
    lo += streak * sector * smoothstep(0.8, 0.97, rr) * exp(-max(rr - 0.97, 0.0) / 0.25) * uNebQ.w * 0.5;
  }
  // jets: knots out along the axis, either side (ansae)
  if (uNebS.w > 0.5) {
    for (int s = 0; s < 2; s++) {
      float sx = s == 0 ? 1.0 : -1.0;
      vec2 d = (wp - vec2(sx * 1.16, 0.05 * sx)) / vec2(0.2, 0.035);
      knot += exp(-dot(d, d)) * (0.35 + 0.5 * fil);
    }
  }
  lo *= clump;
  hi *= mix(1.0, clump, 0.5);
  // dark lanes of dust across the glow
  vec2 dq = np * 2.1 + off * 0.7 + 9.0 + flow * 0.5;
  float dust = smoothstep(0.08, 0.35, gnoise(dq) * 0.55 + gnoise(dq * 2.03 + 1.7) * 0.28);
  vec3 c0 = uNebC[0], c1 = uNebC[1], c2 = uNebC[2];
  em = c0 * lo * 0.9 + c1 * (hi + haze) * 0.85 + c2 * knot * 0.7;
  em *= 1.0 - 0.5 * dust;
  // young (and falling in): hotter, whiter, brighter
  float hot = uNeb.y;
  float L = dot(em, vec3(0.3, 0.5, 0.2));
  em = mix(em, vec3(0.82, 0.9, 1.0) * L * 1.8, hot * 0.75) * (1.0 + hot * 0.8);
  em *= smoothstep(1.5, 1.05, rr) * smoothstep(2.0, 1.6, length(np));
  em = (1.0 - exp(-em * 1.25)) * uNeb.x;
  dens = clamp(max(em.r, max(em.g, em.b)), 0.0, 1.0);
}

#if LAYER == 0
void main() {
  vec2 p = vUv;
  float r = length(p);
  float a = atan(p.y, p.x);
  float R0 = uStar.x;
  float colp = uStar.y;
  float evoP = max(uStar.z, 0.0), evoN = max(-uStar.z, 0.0);
  float crush = smoothstep(${COLLAPSE_FROM}, 1.0, colp);
  float unrest = smoothstep(0.0, ${COLLAPSE_FROM}, colp) * (1.0 - crush);
  float k = R0 / 0.36;                 // the star against the normal sun's size
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // The limb's shape: rougher when ageing, rougher still while it destabilises.
  float limbN = FBM_MEAN;
  if (abs(r - R0) < 0.09 * k + 0.01)
    limbN = blend2(fbmA(a, 4.0, uAge.x * 0.1 + uOff.x), fbmA(a, 4.0, uAge.y * 0.1 + uOff.z), FBM_MEAN);
  float R = R0 * (1.0 + (limbN - FBM_MEAN) * (0.075 * evoP + 0.14 * unrest));
  vec2 q = p / R;                      // sphere units
  float inDisc = step(r, R);
  float lpFace = 0.0, lpLimb = 0.0;
  if (crush < 0.95) loops(q, inDisc, lpFace, lpLimb);

  // ---- disc: a turning sphere ----
  if (r < R) {
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
    float act = smoothstep(0.6 - 0.05 * evoP, 0.78, blend2(ac1, ac2, FBM_MEAN));
    // Limb darkening (Eddington-ish) and a redder, cooler limb; an ageing star is puffier
    // (less darkening), its convection rougher.
    float limb = 0.2 + 0.8 * pow(mu, 0.85 - 0.35 * evoP);
    float gk = 0.3 * (1.0 + 0.7 * evoP - 0.2 * evoN);
    float heat = limb * (0.74 + (sg - 0.5) * (0.24 + 0.25 * evoP + 0.9 * unrest) + (gran - 0.5) * gk * (0.35 + 0.65 * mu))
               + act * pow(1.0 - mu, 1.5) * (0.3 + 0.15 * evoP);
    // A dark filament: a prominence seen from above, lying on the disc and turning with it.
    float fl = abs(blend2(fi1, fi2, FBM_MEAN) - 0.5);
    heat -= smoothstep(0.035, 0.0, fl) * smoothstep(0.55, 0.68, blend2(fo1, fo2, FBM_MEAN)) * 0.16 * mu;
    // Faint plage round the loops' footpoints (no sunspots), and a flare's bright kernels
    // when a loop erupts or a jet goes.
    vec3 P = vec3(q, mu);
    float plage = 0.0, fk = 0.0;
    for (int i = 0; i < NL * 2; i++) {
      vec4 s = uSpot[i];
      float d = length(P - s.xyz);
      float fl = uLoopC[i / 2].z;
      if (fl > 0.002) fk += fl * exp(-d / 0.05);
      if (s.w > 0.004) plage += smoothstep(s.w * 2.6, s.w * 0.4, d) * 0.5;
    }
    heat += min(plage, 1.0) * (0.03 + 0.1 * (1.0 - mu)) + fk * 0.5;
    // ageing: the heat runs lower (a deeper orange-red) though it shines more
    heat *= 1.0 - 0.1 * evoP;
    col = ramp(clamp(heat, 0.0, 1.0));
    col *= 0.42 + 0.66 * pow(mu, 0.45);
    col += uGlint * pow(mu, 8.0) * 0.08;               // a soft hot core
    // loops in front of the disc: bright arcs of hot plasma across the face
    col += mix(uCorona, uGlint, 0.6) * min(lpFace, 1.5) * (0.35 + 0.25 * mu);
    // ageing: brighter, deeper orange-red, swollen; calm: a touch paler
    col *= mix(vec3(1.0), vec3(1.34, 0.9, 0.6), evoP) * mix(vec3(1.0), vec3(1.0, 1.02, 1.05), evoN);
    // collapsing: it brightens and turns blue-white
    float lum = dot(col, vec3(0.3, 0.55, 0.15));
    // (on paper: a clear blue, since a white-hot star can't show against the page)
    vec3 blue = mix(vec3(0.62, 0.78, 1.0) * lum * 1.25, vec3(0.42, 0.58, 1.0) * (0.8 + 0.3 * lum), uLight);
    col = mix(col, blue, crush * 0.85) * (1.0 + 0.2 * crush);
    alpha = smoothstep(R, R - 0.004, r);
  }

  float h = (r - R) / k;      // height above the limb, in the normal sun's units
  float fade = 1.0 - 0.75 * crush;
  if (h > -0.01) {
    float hh = max(h, 0.0);
    // ---- corona: two streamer layers turning at different rates (parallax) ----
    float st1 = 0.55 + 0.9 * pow(noiseA(wrapA(a + uSpin.x), 2.6, 1.0), 2.0);
    float st2 = pow(noiseA(wrapA(a + uSpin.y), 8.0, 4.0 + hh * 3.0), 3.0);
    float corona = exp(-hh / 0.032) * 0.5 + exp(-hh / (0.11 * st1)) * 0.3 + exp(-hh / 0.07) * st2 * 0.35;
    corona *= (1.0 + 0.35 * evoP + 0.6 * unrest) * fade;
    float bloom = exp(-hh / 0.2) * 0.14 * (1.0 + 0.6 * evoP) * fade;
    // ---- chromosphere: a thin red rim with two layers of spicules licking off it ----
    // They flow outwards on the two surface layers' clocks, blended the same way. Beyond
    // 0.06 above the limb no spicule reaches (hh / fringeH alone is past 1.74 there).
    float spic = 0.0;
    if (hh < 0.06) {
      float fringeH = (0.012 + 0.022 * limbN) * (1.0 + 0.5 * evoP);
      float sp = blend2(fbmA(a, 40.0, hh * 34.0 - uAge.x * 0.8 + uOff.y),
                        fbmA(a, 40.0, hh * 34.0 - uAge.y * 0.8 + uOff.w), FBM_MEAN);
      float sp2 = blend2(noiseA(a, 95.0, hh * 70.0 - uAge.x * 1.5 + uOff.x),
                         noiseA(a, 95.0, hh * 70.0 - uAge.y * 1.5 + uOff.z), 0.5);
      spic = smoothstep(1.0, 0.15, hh / fringeH + (0.5 - sp) * 1.1 + (0.5 - sp2) * 0.45)
           * smoothstep(-0.01, 0.0015, h) * fade;
    }
    float chrom = exp(-abs(h - 0.002) / 0.004) * fade;
    // ---- prominences: the loops standing off the limb (and the parts of loops behind) ----
    float pv = lpLimb * (1.0 + 0.15 * evoP);
    float heat = corona * 0.4 + spic * 0.42 + chrom * 0.25 + pv * 0.55;
    float glow = corona * 0.7 + spic * 0.55 + chrom * 0.4 + bloom + pv;
    // the collapse: gas streams in, in radial threads
    if (colp > 0.02 && crush < 1.0) {
      vec2 dr = p / max(r, 1e-4);
      float strand = pow(1.0 - abs(gnoise(dr * 7.0 + 3.0) * 1.6), 6.0);
      float fall = noise(vec2(a * 3.0, r * 18.0 + colp * 14.0));
      float infall = strand * fall * exp(-hh / 0.12) * smoothstep(0.1, 0.6, colp) * (1.0 - smoothstep(0.85, 1.0, colp));
      heat += infall * 0.7;
      glow += infall * 0.6;
    }
    vec3 c = ramp(clamp(heat, 0.0, 1.0)) * glow;
    // a touch of magenta in the outer corona and the cooler prominence plasma
    c = mix(c, uMagenta * glow, smoothstep(0.02, 0.2, hh) * 0.35);
    c = mix(c, uCrimson * glow, chrom * smoothstep(0.003, 0.0, hh) * 0.4);
    c = mix(c, mix(uCrimson, uEmber, 0.5) * glow * 1.15, 0.3 * evoP);   // a redder glow round an old star
    c = mix(c, vec3(0.75, 0.88, 1.0) * glow * 1.2, crush * 0.8);
    float ga = clamp(glow, 0.0, 1.0);
    col = col * alpha + c * (1.0 - alpha);
    alpha = max(alpha, ga * mix(0.75, 1.0, uLight));
  }

  // ---- nova: the dwarf and the flash (the nebula and the shock are on layer 1) ----
  if (colp > 0.5) {
    // the white dwarf: a hard bright point in a small soft halo, twinkling a little
    float dw = smoothstep(0.85, 1.0, colp) * uNebPh.w;
    float core = exp(-r * r / 0.00012);
    float halo = exp(-r / 0.03) * 0.35 + exp(-r / 0.09) * 0.06;
    vec3 dc = mix(vec3(0.85, 0.93, 1.0), uGlint, 0.3);
    vec3 dwarf = dc * (core * 1.1 + halo) * dw;
    // on paper: a white point in a small blue halo (pigment), so it still reads as a star
    float hl = clamp(halo * 2.2, 0.0, 0.85) * (1.0 - core) * dw;
    vec3 dwarfL = vec3(1.0) * core * dw + vec3(0.25, 0.42, 0.85) * hl;
    float dwA = clamp((core + halo) * dw, 0.0, 1.0);
    col = mix(col + dwarf, col * (1.0 - max(core * dw, hl)) + dwarfL, uLight);
    alpha = max(alpha, mix(dwA, max(core * dw, hl), uLight));
  }
  // the flash: one soft-edged glow from the core, never the whole canvas
  if (uNova.x > 0.001) {
    float f = (exp(-r * r / 0.03) + exp(-r / 0.2) * 0.2) * uNova.x;
    col += mix(vec3(0.95, 0.97, 1.0), vec3(0.6, 0.7, 0.95), uLight) * f;
    alpha = max(alpha, clamp(f, 0.0, 1.0) * mix(0.6, 0.8, uLight));
  }
  // fade out well before the canvas edge
  float edge = smoothstep(1.0, 0.82, r);
  outColor = vec4(col * edge, alpha * edge) * uStar.w;
}
#else
void main() {
  vec2 p = vUv * uView.xy - uView.zw;  // the sun canvas's units round the star, y up
  float r = length(p);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (uStar.y > 0.5) {
    vec3 em; float dens;
    nebula(p, em, dens);
    // Dark theme: the gas is light, added to the page. Light theme: it is printed like a
    // plate in an atlas, pigment whose cover follows the gas's density (the cavity stays
    // paper), since glow can't show on a light page.
    vec3 pigment = em / max(max(em.r, max(em.g, em.b)), 1e-3) * 0.76;
    float cover = clamp(dens * 1.5, 0.0, 0.92);
    col += mix(em, pigment * cover, uLight);
    alpha = max(alpha, mix(dens * 0.55, cover, uLight));
    // the shock front: a thin, torn, lopsided ring racing out ahead of the gas
    if (uNova.z > 0.002) {
      vec2 dr = p / max(r, 1e-4);
      float rs = uNova.y * uNebR;
      float wob = 1.0 + 0.08 * gnoise(dr * 2.4 + uNebP.zw) + 0.04 * gnoise(dr * 7.0 + uNebP.zw);
      float d = r * wob - rs;
      float w = 0.012 + 0.04 * rs;
      float ring = exp(-d * d / (w * w)) * (0.45 + 0.75 * smoothstep(-0.3, 0.3, gnoise(dr * 5.0 + uNebP.zw + uNova.y * 3.0)));
      float wake = smoothstep(0.0, -0.05, d) * smoothstep(-rs, -rs * 0.3, d) * 0.15;
      float sk = (ring + wake) * uNova.z;
      col += mix(vec3(0.85, 0.92, 1.0), uNebC[1], smoothstep(0.1, 0.6, uNova.y)) * sk * 0.9;
      alpha = max(alpha, clamp(sk, 0.0, 1.0) * mix(0.5, 0.8, uLight));
    }
  }
  // Soft towards the hero's edges, never a hard clip; dimmed behind the heading, so it stays
  // legible on both themes.
  float fx = smoothstep(-uFade.x, -uFade.x * 0.55, p.x) * smoothstep(uFade.y, uFade.y * 0.55, p.x);
  float fy = smoothstep(-uFade.z, -uFade.z * 0.55, p.y) * smoothstep(uFade.w, uFade.w * 0.55, p.y);
  vec2 tc = (uText.xy + uText.zw) * 0.5, th = (uText.zw - uText.xy) * 0.5;
  vec2 tq = abs(p - tc) - th;
  float sd = length(max(tq, 0.0)) + min(max(tq.x, tq.y), 0.0);
  float dim = mix(0.3, 1.0, smoothstep(-0.05, 0.35, sd));
  outColor = vec4(col, alpha) * fx * fy * dim * uStar.w;
}
#endif`;

// Dev only (?sunstep): every hero sun on the page steps by __provenanceSunStep(seconds),
// which returns the tiered one's sequence state.
const steppers = new Map<(sec: number) => unknown, boolean>();
if (import.meta.env.DEV)
  (window as unknown as { __provenanceSunStep: (sec: number) => unknown }).__provenanceSunStep = (
    sec,
  ) => {
    let main: unknown = null;
    for (const [f, tiered] of steppers) {
      const st = f(sec);
      if (tiered || main == null) main = st;
    }
    return main;
  };

// ---- drawing ------------------------------------------------------------------------------

const UNIFORMS = [
  "uAge",
  "uW",
  "uOff",
  "uSpin",
  "uStar",
  "uLoop",
  "uLoopA",
  "uLoopB",
  "uLoopC",
  "uSpot",
  "uNova",
  "uNeb",
  "uNebP",
  "uNebQ",
  "uNebS",
  "uNebPh",
  "uNebPh2",
  "uNebC",
  "uView",
  "uFade",
  "uText",
  "uNebR",
] as const;

/** Where the nebula's canvas sits round the sun, in the sun canvas's units (see uView etc.). */
interface Layout {
  view: number[];
  fade: number[];
  text: number[];
  nebR: number;
}

/** One canvas and its program: the sun's (layer 0) or the nebula's (layer 1). */
function surface(canvas: HTMLCanvasElement, layer: 0 | 1) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "");
    return s;
  };
  const prog = gl.createProgram()!;
  try {
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs(layer)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) ?? "");
  } catch (err) {
    console.warn("[hero sun] shader setup failed", err);
    return null;
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
  const uni = Object.fromEntries(UNIFORMS.map((n) => [n, u(n)]));
  const probe = document.createElement("canvas").getContext("2d")!;
  const rgb = (name: string) => {
    probe.fillStyle = "#000";
    probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseInt(String(probe.fillStyle).slice(1), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const;
  };
  for (const [name, v] of [
    ["uGlint", "--glint"],
    ["uCorona", "--corona"],
    ["uEmber", "--ember"],
    ["uCrimson", "--crimson"],
    ["uMagenta", "--magenta"],
  ] as const)
    gl.uniform3fv(u(name), rgb(v));
  gl.uniform1f(u("uLight"), document.documentElement.dataset.theme === "light" ? 1 : 0);
  // Each draw's output is premultiplied and scaled by its weight, so two draws added up are a
  // cross-fade (the reduced-motion stills).
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  return {
    size(w: number, h: number) {
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(frames: [Frame, number][], lay?: Layout) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (lay) {
        gl.uniform4fv(uni.uView, lay.view);
        gl.uniform4fv(uni.uFade, lay.fade);
        gl.uniform4fv(uni.uText, lay.text);
        gl.uniform1f(uni.uNebR, lay.nebR);
      }
      for (const [f, weight] of frames) {
        gl.uniform2fv(uni.uAge, f.age);
        gl.uniform2fv(uni.uW, f.w);
        gl.uniform4fv(uni.uOff, f.off);
        gl.uniform2fv(uni.uSpin, f.spin);
        gl.uniform4fv(uni.uStar, [f.star[0], f.star[1], f.star[2], weight]);
        gl.uniform4fv(uni.uNova, f.nova);
        gl.uniform4fv(uni.uNeb, f.neb);
        gl.uniform4fv(uni.uNebP, f.nebP);
        gl.uniform4fv(uni.uNebQ, f.nebQ);
        gl.uniform4fv(uni.uNebS, f.nebS);
        gl.uniform4fv(uni.uNebPh, f.nebPh);
        gl.uniform4fv(uni.uNebPh2, f.nebPh2);
        gl.uniform3fv(uni.uNebC, f.nebC);
        if (layer === 0) {
          gl.uniform4fv(uni.uLoop, f.loop);
          gl.uniform4fv(uni.uLoopA, f.loopA);
          gl.uniform4fv(uni.uLoopB, f.loopB);
          gl.uniform4fv(uni.uLoopC, f.loopC);
          gl.uniform4fv(uni.uSpot, f.spot);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    },
    destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    },
  };
}

/** Whether a frame has anything for the nebula's canvas (the remnant or the shock front). */
const hasNebula = (f: Frame) => f.star[1] > 0.5 && (f.nova[3] > 0.003 || f.nova[2] > 0.002);

// ---- the component ----------------------------------------------------------------------

/** The welcome's intro passes no tier: the plain sun (and no nebula canvas). */
export function HeroSun({ size = 200, tier }: { size?: number; tier?: TierId | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nebRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const [staticFx, setStaticFx] = useState(false);
  const target = useRef(targetOf(tier));
  // the home page's sun (a tier or null) rather than the welcome's (undefined)
  const tiered = tier !== undefined;
  const sim = useRef<Sim | null>(null);
  const retarget = useRef<(() => void) | null>(null);
  /** performance.now() when nova was last selected (the composer's flare starts there too). */
  const novaSel = useRef(-Infinity);

  useEffect(() => {
    const next = targetOf(tier);
    if (next.nova && !target.current.nova) novaSel.current = performance.now();
    target.current = next;
    retarget.current?.();
  }, [tier]);

  // data-fx="static" on the main column (set by FlameFx): the effects are stills.
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-fx]") ?? ref.current?.closest("main");
    if (!host) return;
    const read = () => setStaticFx(host.dataset.fx === "static");
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { attributes: true, attributeFilter: ["data-fx"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const sun = surface(canvas, 0);
    if (!sun) {
      setFailed(true);
      return;
    }
    sun.size(
      size * Math.min(2, window.devicePixelRatio || 1),
      size * Math.min(2, window.devicePixelRatio || 1),
    );
    // The nebula's canvas fills the hero behind the heading, at NEB_RES (soft gas needs no
    // more), and only draws while there is a nebula or a shock.
    const nebCanvas = nebRef.current;
    const neb = nebCanvas ? surface(nebCanvas, 1) : null;
    const unit = size / 2; // CSS px per sun-canvas unit
    let lay: Layout = { view: [1, 1, 0, 0], fade: [9, 9, 9, 9], text: [0, 0, 0, 0], nebR: 1 };
    const measure = () => {
      if (!nebCanvas || !neb) return;
      const hr = nebCanvas.getBoundingClientRect();
      const sr = canvas.getBoundingClientRect();
      const tr = canvas.parentElement?.querySelector("h1")?.getBoundingClientRect();
      if (hr.width < 1 || hr.height < 1) return;
      neb.size(hr.width * NEB_RES, hr.height * NEB_RES);
      const sx = sr.left + sr.width / 2;
      const sy = sr.top + sr.height / 2;
      const fade = [sx - hr.left, hr.right - sx, hr.bottom - sy, sy - hr.top].map((d) => d / unit);
      lay = {
        view: [
          hr.width / 2 / unit,
          hr.height / 2 / unit,
          (sx - (hr.left + hr.width / 2)) / unit,
          -(sy - (hr.top + hr.height / 2)) / unit,
        ],
        fade,
        text: tr
          ? [
              (tr.left - sx) / unit,
              -(tr.bottom - sy) / unit,
              (tr.right - sx) / unit,
              -(tr.top - sy) / unit,
            ]
          : [0, 0, 0, 0],
        // most of the way to the nearest edge of the hero (it fades out softly there)
        nebR: Math.min(4.5, Math.max(1.1, 0.85 * Math.min(...fade))),
      };
    };
    measure();
    const ro = new ResizeObserver(() => {
      measure();
      drawNow();
    });
    if (nebCanvas) ro.observe(nebCanvas);
    ro.observe(canvas);

    const speed = import.meta.env.DEV
      ? Number(new URLSearchParams(location.search).get("fxspeed")) || 1
      : 1;
    // Dev only (?sunstep): the clock stands still and __provenanceSunStep(s) moves it, for
    // looking at the sequence frame by frame.
    const manual = import.meta.env.DEV && new URLSearchParams(location.search).has("sunstep");
    let manualT = 0;
    // Start at a random moment so every visit shows a different sky.
    const t0 = performance.now() - Math.random() * 60_000 - devUptime * 1000;
    const clock = () => (manual ? manualT + devUptime : ((performance.now() - t0) / 1000) * speed);

    const s = (sim.current ??= settled(target.current));
    const still = reduced || staticFx;
    let nebShown = false;
    let tick = 0;
    /** Draws both canvases; the nebula's only when it has something (or must be cleared). */
    const drawBoth = (frames: [Frame, number][], everyNeb = true) => {
      sun.draw(frames);
      if (!neb) return;
      const want = frames.some(([f]) => hasNebula(f));
      if (want ? everyNeb || !nebShown : nebShown) neb.draw(want ? frames : [], lay);
      nebShown = want;
    };
    let drawNow = () => {};
    const cleanups: (() => void)[] = [() => ro.disconnect()];

    if (still) {
      // One still per tier, at a fixed moment; a tier change cross-fades between them.
      const tStill = 30;
      Object.assign(s, settled(target.current));
      let shown = frameAt(tStill, s);
      let raf = 0;
      drawNow = () => drawBoth([[shown, 1]]);
      drawNow();
      retarget.current = () => {
        const next = frameAt(tStill, Object.assign(s, settled(target.current)));
        const from = shown;
        const start = performance.now();
        cancelAnimationFrame(raf);
        const fade = () => {
          const k = ss(0, 1, (performance.now() - start) / 1000 / STILL_FADE);
          drawBoth(
            k < 1
              ? [
                  [from, 1 - k],
                  [next, k],
                ]
              : [[next, 1]],
          );
          if (k < 1) raf = requestAnimationFrame(fade);
        };
        shown = next;
        fade();
      };
      cleanups.push(() => cancelAnimationFrame(raf));
    } else {
      let last = clock();
      let lastFlash = 0;
      let shownFrame: Frame | null = null;
      /** When the collapse should tip over, on this clock: the composer's burst (fxSync.ts) of
       * the selection now playing, less the flash's rise; null with no flare to follow. */
      const tipAt = (t: number) => {
        if (manual || novaBurst.selectedAt < novaSel.current - 300) return null;
        return t + ((novaBurst.burstAt - performance.now()) / 1000) * speed - FLASH_RISE;
      };
      const frame = () => {
        const t = clock();
        const dt = Math.max(0, t - last);
        last = t;
        const blast = s.blastAt;
        if (dt > JUMP) {
          // Away (paused, hidden) for a while: show where the sequence has got to by now.
          const keep = s.lastFlash;
          Object.assign(s, settled(target.current), {
            evo: target.current.evo ?? s.evo,
            lastFlash: keep,
          });
        } else step(s, target.current, t, dt, tipAt(t));
        if (import.meta.env.DEV && s.blastAt !== blast)
          (window as unknown as { __provenanceSunTip: number }).__provenanceSunTip =
            performance.now() + ((s.blastAt - t) / speed) * 1000;
        const f = frameAt(t, s);
        lastFlash = f.flash;
        shownFrame = f;
        // the settled remnant moves slowly: its canvas redraws at 15 fps
        const busy = s.neb < 1 || f.nova[2] > 0.002;
        drawBoth([[f, 1]], busy || manual || tick++ % 2 === 0);
      };
      drawNow = () => shownFrame && drawBoth([[shownFrame, 1]]);
      let timer = 0;
      let raf = 0;
      let stopped = false;
      let onScreen = true;
      let blurredAt = document.hasFocus() ? -1 : performance.now();
      const loop = () => {
        timer = 0;
        raf = 0;
        if (stopped || document.hidden || !onScreen) return;
        if (blurredAt >= 0 && performance.now() - blurredAt > 8000) return;
        frame();
        timer = window.setTimeout(() => (raf = requestAnimationFrame(loop)), 1000 / 30 - 4);
      };
      const resume = () => {
        if (!timer && !raf && !manual) loop();
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
      // Off screen (scrolled away, hidden by the short-window rule): nothing runs.
      const io = new IntersectionObserver((es) => {
        onScreen = es.some((e) => e.isIntersecting);
        if (onScreen) resume();
      });
      io.observe(canvas);
      retarget.current = resume;
      if (manual) {
        frame();
        const stepper = (sec: number) => {
          for (let left = sec; left > 1e-9; left -= 1 / 60) {
            manualT += Math.min(left, 1 / 60);
            const t = clock();
            step(s, target.current, t, t - last);
            last = t;
          }
          frame();
          const nb = nebulaOf(s.seed);
          return {
            ...s,
            flash: lastFlash,
            style: NEBULA_STYLES[nb.style],
            palette: NEBULA_PALETTES[nb.pal],
          };
        };
        steppers.set(stepper, tiered);
        cleanups.push(() => steppers.delete(stepper));
      } else loop();
      cleanups.push(() => {
        stopped = true;
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        io.disconnect();
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onVis);
      });
    }
    return () => {
      for (const c of cleanups) c();
      retarget.current = null;
      sun.destroy();
      neb?.destroy();
    };
  }, [reduced, staticFx, theme, size, tiered]);

  if (failed) return <StaticSun size={size} nova={targetOf(tier).nova} />;
  return (
    <>
      <canvas ref={ref} className="hero-sun" style={{ width: size, height: size }} aria-hidden />
      {tiered && <canvas ref={nebRef} className="hero-nebula" aria-hidden />}
    </>
  );
}

/** Without WebGL2: the mark for the sun, a small remnant for nova, cross-faded. */
function StaticSun({ size, nova }: { size: number; nova: boolean }) {
  const m = Math.round(size * 0.4);
  // the canvas's box, so the page doesn't move between the two
  const pad = (size - m) / 2;
  return (
    <span
      className="hero-sun hero-sun-static"
      style={{ width: m, height: m, marginTop: pad, marginBottom: pad - 18 }}
      aria-hidden
    >
      <span data-on={!nova || undefined}>
        <SolarMark size={m} />
      </span>
      <span data-on={nova || undefined}>
        <svg width={m} height={m} viewBox="0 0 32 32">
          <defs>
            <radialGradient id="hero-remnant">
              <stop offset="0.35" stopColor="#2fb7b0" stopOpacity="0.15" />
              <stop offset="0.62" stopColor="#2fb7b0" stopOpacity="0.55" />
              <stop offset="0.8" stopColor="#e23a52" stopOpacity="0.75" />
              <stop offset="1" stopColor="#e23a52" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="16" cy="16" rx="15" ry="12.5" fill="url(#hero-remnant)" />
          <circle cx="16" cy="16" r="1.4" fill="#eef4ff" />
        </svg>
      </span>
    </span>
  );
}
