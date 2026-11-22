// Renders the icon PNGs, the macOS .icns and the web icons from the SVGs gen.py writes.
//   cd ui/design/icon && python3 gen.py && node render.mjs
// Uses the Playwright Chromium from ui/node_modules (headless), and macOS iconutil.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../node_modules/playwright/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "../../public");

let executablePath;
if (!existsSync(chromium.executablePath())) {
  const cache = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  for (const d of readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse()) {
    const bin = `${cache}/${d}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    if (existsSync(bin)) {
      executablePath = bin;
      break;
    }
  }
}

const browser = await chromium.launch({ executablePath });
/** Rasterise an SVG at its target size (not downscaled from 1024, so small sizes stay crisp). */
async function render(svg, size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const src = "data:image/svg+xml;base64," + readFileSync(path.join(here, svg)).toString("base64");
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.waitForFunction(() => document.querySelector("img")?.complete);
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
}

// 16 and 32 px come from the small master (bigger sun, heavier glyph); the rest from the full one.
const master = (size) => (size <= 32 ? "provenance-icon-small.svg" : "provenance-icon.svg");
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  await render(master(size), size, path.join(here, `icon-${size}.png`));
}

const iconset = path.join(here, "Provenance.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  await render(master(size), size, path.join(iconset, `icon_${size}x${size}.png`));
  await render(master(size * 2), size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(here, "Provenance.icns")]);
rmSync(iconset, { recursive: true });

mkdirSync(pub, { recursive: true });
await render("provenance-icon-touch.svg", 180, path.join(pub, "apple-touch-icon.png"));
await render("provenance-icon.svg", 192, path.join(pub, "icon-192.png"));
await render("provenance-icon.svg", 512, path.join(pub, "icon-512.png"));
await browser.close();
