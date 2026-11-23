// Renders the Discord Rich Presence images (electron/discord-presence.ts) into this folder:
//   provenance.png       1024 x 1024, the app icon full-bleed (Discord rounds the corners itself)
//   tier-<id>.png        512 x 512, each tier's glyph (shared/tier-glyphs.ts, the detailed drawing
//                        with its core) in its colours (tokens.css)
//   fallback-<id>.png    512 x 512, the fallbacks' terminal glyph in their colours
// Discord crops the small image to a circle, so the glyphs sit on a dark disc.
//   cd ui && node design/presence/render.ts      (headless Chromium, scripts/chromium.ts)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { findChromium } from "../../scripts/chromium.ts";
import { TIER_GLYPHS, type TierGlyphId } from "../../shared/tier-glyphs.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// Dark-theme stops of --tier-<id>-grad / --fallback-<id>-grad (src/theme/tokens.css).
const GRADS: Record<string, string[]> = {
  "tier-spark": ["#fff3c4", "#9cc8ff", "#4b84ff"],
  "tier-ember": ["#f09a6c", "#c9663f", "#8f3b22"],
  "tier-solstice": ["#ffc061", "#ff6a3d", "#e23a52"],
  "tier-nova": ["#ffe3f1", "#ff4fa3", "#c2185b", "#7a1fa2"],
  "fallback-claude": ["#e9e0ff", "#b794ff", "#7d55f0"],
  "fallback-codex": ["#dcfff9", "#45d3c7", "#129488"],
};
const GLOW: Record<string, string> = {
  "tier-spark": "#9cc8ff",
  "tier-ember": "#c9663f",
  "tier-solstice": "#ff6a3d",
  "tier-nova": "#ff4fa3",
  "fallback-claude": "#b794ff",
  "fallback-codex": "#45d3c7",
};

// Each tier's core: the white-hot end of its effect ramp (--fx-<id>-core, dark theme).
const CORE: Record<TierGlyphId, string> = {
  spark: "#fff5d6",
  ember: "#ffd0a6",
  solstice: "#fff0c8",
  nova: "#f6f1ff",
};

// The tier glyphs (shared/tier-glyphs.ts, 24-unit box) in their detailed drawing, with the core,
// and icons.tsx's IconTerminal (24-unit box).
const G = "url(#g)";
function tierBody(id: TierGlyphId): string {
  const t = TIER_GLYPHS[id];
  const soft = (w: number, paint: string) =>
    w ? ` stroke="${paint}" stroke-width="${w}" stroke-linejoin="round"` : "";
  return (
    `<path d="${t.body}" fill="${G}"${soft(t.soften, G)}/>` +
    (t.rays
      ? `<path d="${t.rays}" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round"/>`
      : "") +
    `<path d="${t.core}" fill="${CORE[id]}"${soft(t.coreSoften, CORE[id])}/>`
  );
}
// fill: the share of the disc the glyph's box spans (the tier glyphs fill their box to its edge,
// and Discord shows this image at about 20-30 px, so they get more of it).
const GLYPHS: Record<string, { box: number; body: string; fill?: number }> = {
  "fallback-claude": {
    box: 24,
    body: `<path d="M4 17l6-6-6-6M12 19h8" fill="none" stroke="${G}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};
for (const id of Object.keys(TIER_GLYPHS) as TierGlyphId[])
  GLYPHS[`tier-${id}`] = { box: 24, body: tierBody(id), fill: 0.74 };
GLYPHS["fallback-codex"] = GLYPHS["fallback-claude"];

function smallSvg(key: string): string {
  const { box, body, fill = 0.66 } = GLYPHS[key];
  const stops = GRADS[key]
    .map((c, i, a) => `<stop offset="${i / (a.length - 1)}" stop-color="${c}"/>`)
    .join("");
  // Glyph box drawn at `fill` of the disc, centred.
  const size = 512 * fill;
  const k = size / box;
  const off = (512 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="256" cy="200" r="320" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c161d"/><stop offset="1" stop-color="#08070a"/>
    </radialGradient>
    <radialGradient id="glow" cx="256" cy="256" r="230" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${GLOW[key]}" stop-opacity="0.28"/><stop offset="1" stop-color="${GLOW[key]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="g" x1="0" y1="0" x2="${box}" y2="${box}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
  </defs>
  <circle cx="256" cy="256" r="256" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="230" fill="url(#glow)"/>
  <g transform="translate(${off} ${off}) scale(${k})">${body}</g>
</svg>`;
}

const browser = await chromium.launch({ executablePath: findChromium() });
async function render(svg: string, size: number, out: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.waitForFunction(() => document.querySelector("img")?.complete);
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
}

const touch = readFileSync(path.join(here, "../icon/provenance-icon-touch.svg"), "utf8");
await render(touch, 1024, path.join(here, "provenance.png"));
for (const key of Object.keys(GLYPHS))
  await render(smallSvg(key), 512, path.join(here, `${key}.png`));
await browser.close();
console.log(`wrote provenance.png and ${Object.keys(GLYPHS).length} small images to ${here}`);
