"""Provenance icon sources, generated from one set of numbers.

    python3 gen.py            # writes the SVGs next to this file
    node render.mjs           # renders the PNGs, the .icns and the web icons

Geometry is taken from icon-reference.jpg (the sun disc and the ">_" glyph, their sizes
and positions relative to each other), cleaned up: the sun centred on Apple's Big Sur grid
(1024 canvas, 824 continuous-corner tile at 100), the chevron made symmetric, one stroke
width with round caps and joins, the underscore on the chevron's lower end.
"""

import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.dirname(os.path.dirname(HERE))

# Sun gradient sampled from the reference, top to bottom of the disc: yellow, orange, a
# deep red and a near-black lower limb (the sun setting into the tile).
SUN_STOPS = [(0.0, "#fff236"), (0.08, "#fde10c"), (0.22, "#feba02"), (0.34, "#fe9202"),
             (0.46, "#fd7602"), (0.54, "#f56103"), (0.62, "#d74703"), (0.70, "#a52e03"),
             (0.78, "#661a04"), (0.86, "#2c0b05"), (0.93, "#0d0304"), (1.0, "#030102")]

# The glyph relative to the sun's centre, for a sun of radius R (reference: r 386 px on a
# 1254 px tile; chevron arms 0.66 run per rise; stroke 68 px).
R = 254.0
CHEV = [(-138.5, -86.0), (-83.5, -3.0), (-138.5, 80.0)]
BAR = [(10.5, 80.0), (138.5, 80.0)]
STROKE = 45.0
INK = "#0a0709"


def squircle(x0, y0, s, r):
    """Apple's continuous-corner rounded rect (the macOS / iOS icon tile) as cubics."""
    X0, Y0, X1, Y1 = x0, y0, x0 + s, y0 + s
    a, b, c, d, e, f, g = (1.52866483, 1.08849296, 0.86840694, 0.66993427, 0.06549600,
                           0.37282383, 0.16276366)

    def P(x, y):
        return f"{x:.2f} {y:.2f}"

    return " ".join([
        f"M{P(X0 + a * r, Y0)}", f"L{P(X1 - a * r, Y0)}",
        f"C{P(X1 - b * r, Y0)} {P(X1 - c * r, Y0)} {P(X1 - d * r, Y0 + e * r)}",
        f"C{P(X1 - f * r, Y0 + g * r)} {P(X1 - g * r, Y0 + f * r)} {P(X1 - e * r, Y0 + d * r)}",
        f"C{P(X1, Y0 + c * r)} {P(X1, Y0 + b * r)} {P(X1, Y0 + a * r)}",
        f"L{P(X1, Y1 - a * r)}",
        f"C{P(X1, Y1 - b * r)} {P(X1, Y1 - c * r)} {P(X1 - e * r, Y1 - d * r)}",
        f"C{P(X1 - g * r, Y1 - f * r)} {P(X1 - f * r, Y1 - g * r)} {P(X1 - d * r, Y1 - e * r)}",
        f"C{P(X1 - c * r, Y1)} {P(X1 - b * r, Y1)} {P(X1 - a * r, Y1)}",
        f"L{P(X0 + a * r, Y1)}",
        f"C{P(X0 + b * r, Y1)} {P(X0 + c * r, Y1)} {P(X0 + d * r, Y1 - e * r)}",
        f"C{P(X0 + f * r, Y1 - g * r)} {P(X0 + g * r, Y1 - f * r)} {P(X0 + e * r, Y1 - d * r)}",
        f"C{P(X0, Y1 - c * r)} {P(X0, Y1 - b * r)} {P(X0, Y1 - a * r)}",
        f"L{P(X0, Y0 + a * r)}",
        f"C{P(X0, Y0 + b * r)} {P(X0, Y0 + c * r)} {P(X0 + e * r, Y0 + d * r)}",
        f"C{P(X0 + g * r, Y0 + f * r)} {P(X0 + f * r, Y0 + g * r)} {P(X0 + d * r, Y0 + e * r)}",
        f"C{P(X0 + c * r, Y0)} {P(X0 + b * r, Y0)} {P(X0 + a * r, Y0)}Z",
    ])


def glyph(cx, cy, k, stroke, color=INK):
    (ax, ay), (bx, by), (qx, qy) = [(cx + x * k, cy + y * k) for x, y in CHEV]
    (ux, uy), (vx, _) = [(cx + x * k, cy + y * k) for x, y in BAR]
    return (f'<g fill="none" stroke="{color}" stroke-width="{stroke:.2f}" '
            f'stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="M{ax:.2f} {ay:.2f} L{bx:.2f} {by:.2f} L{qx:.2f} {qy:.2f}"/>'
            f'<path d="M{ux:.2f} {uy:.2f} H{vx:.2f}"/></g>')


def app_icon(small=False, touch=False):
    """The macOS app icon. small: the 16/32 px master (bigger sun, heavier glyph, no
    shadow). touch: full-bleed square for apple-touch-icon / PWA (iOS masks it itself)."""
    tile = squircle(100, 100, 824, 185.4)
    cx = cy = 512
    r = 290.0 if small else R
    k = r / R
    stroke = (62.0 if small else STROKE * k)
    glow_sd = 20 if small else 34
    view = "100 100 824 824" if touch else "0 0 1024 1024"
    sun_stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in SUN_STOPS)
    shadow = "" if (small or touch) else (
        f'\n  <path d="{tile}" fill="#000" opacity="0.5" filter="url(#shadow)"/>')
    rim = "" if touch else (
        f'\n    <path d="{tile}" fill="none" stroke="url(#rim)" stroke-width="{6 if small else 4}"/>')
    body = "M100 100 H924 V924 H100 Z" if touch else tile
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">
  <defs>
    <linearGradient id="sun" x1="0" y1="{cy - r}" x2="0" y2="{cy + r}" gradientUnits="userSpaceOnUse">{sun_stops}</linearGradient>
    <linearGradient id="glowc" x1="0" y1="{cy - r}" x2="0" y2="{cy + r}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff5a00" stop-opacity="0.75"/><stop offset="0.5" stop-color="#ff5000" stop-opacity="0.8"/>
      <stop offset="0.8" stop-color="#b02400" stop-opacity="0.35"/><stop offset="1" stop-color="#400800" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#141015"/><stop offset="0.5" stop-color="#0c0a0e"/><stop offset="1" stop-color="#08070a"/>
    </linearGradient>
    <radialGradient id="lift" cx="512" cy="250" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.12" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.04"/><stop offset="0.9" stop-color="#fff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.12"/>
    </linearGradient>
    <clipPath id="tile"><path d="{body}"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/><feOffset dy="12"/></filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{glow_sd}"/></filter>
    <filter id="glow2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{glow_sd * 0.3:.1f}"/></filter>
  </defs>{shadow}
  <path d="{body}" fill="url(#bg)"/>
  <g clip-path="url(#tile)">
    <rect x="100" y="100" width="824" height="824" fill="url(#lift)"/>
    <circle cx="{cx}" cy="{cy}" r="{r + 6:.1f}" fill="url(#glowc)" filter="url(#glow)"/>
    <circle cx="{cx}" cy="{cy}" r="{r + 2:.1f}" fill="url(#glowc)" filter="url(#glow2)"/>
    <circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="url(#sun)"/>
    {glyph(cx, cy, k, stroke)}
    <rect x="100" y="100" width="824" height="824" fill="url(#shade)"/>{rim}
  </g>
</svg>
'''


# The in-app mark (SolarMark, favicon): the sun and the glyph only, no tile, on a 32 grid
# (disc r 15). Its gradient stops at a deep red instead of near-black so the disc keeps its
# silhouette on a dark sidebar; the glyph thickens at tiny sizes.
MARK_K = 15 / R
MARK_STOPS = [(0, "#ffe94a"), (0.3, "#ffb000"), (0.55, "#ff7a0a"), (0.8, "#e2440e"), (1, "#a8261a")]


def mark(stroke):
    st = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in MARK_STOPS)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            f'<defs><linearGradient id="d" x1="0" y1="1" x2="0" y2="31" gradientUnits="userSpaceOnUse">{st}'
            f'</linearGradient></defs><circle cx="16" cy="16" r="15" fill="url(#d)"/>'
            f'{glyph(16, 16, MARK_K, stroke, "#140b08")}</svg>\n')


if __name__ == "__main__":
    def write(path, text):
        with open(path, "w") as fh:
            fh.write(text)

    write(f"{HERE}/provenance-icon.svg", app_icon())
    write(f"{HERE}/provenance-icon-small.svg", app_icon(small=True))
    write(f"{HERE}/provenance-icon-touch.svg", app_icon(touch=True))
    write(f"{HERE}/provenance-mark.svg", mark(2.8))
    os.makedirs(f"{UI}/public", exist_ok=True)
    write(f"{UI}/public/favicon.svg", mark(3.6))  # tab-sized: the heavy glyph
    # Glyph coordinates for SolarMark.tsx (kept in sync by hand; printed for reference).
    print("mark glyph:", glyph(16, 16, MARK_K, 2.8))
