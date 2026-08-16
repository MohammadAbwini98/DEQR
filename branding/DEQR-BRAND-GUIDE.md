# DEQR Brand Guide

The DEQR identity is one mark applied across two applications: the Windows Electron
sender and the iPhone Safari Web App receiver. There is no second logo — the sender
and the receiver carry the same symbol.

## The mark

**DEQR Vortex.** Five logarithmic-spiral arms turn inward onto a focal emblem.

| Element | What it carries |
| --- | --- |
| Spiral arms | The optical channel. Radius decays geometrically as the sweep advances, so the mark turns without drawing an arrow. |
| Inward brightening | Convergence. The arm ramp is radial, not vertical: colour gets brighter toward the focus, so light reads as arriving rather than falling from above. |
| Leading taper | Entry. Each arm enters as a fine edge and thickens as it turns, instead of starting on a blunt radial cut. |
| Focal emblem | The receiving aperture — the same vortex an order of magnitude down and inverted, seen from inside. |
| Centre module | The reconstructed, verified file. A square on its diagonal: the one angular element in a curved mark. |

Read as a whole: **information drawn through a controlled optical channel and
resolved at the far end.** That is DEQR's actual job — a file becomes fountain-coded
blocks, becomes an animated QR stream, crosses open air to a camera, and is
reconstructed and hash-verified.

### Construction

Geometry is generated, not drawn by hand, from `scripts/brand/build-masters.mjs`.
Each arm is the band between a logarithmic spiral offset inward and outward by a
width that tapers along the sweep:

```
θ(t) = phase + sweep·t
r(t) = rOuter · (rInner/rOuter)^t
w(t) = tapered: wLead → wOuter at t=0.2 → wInner at t=1
```

sampled and joined as Catmull-Rom cubic Béziers. The arms are exact rotations of one
another, so rotational symmetry is exact rather than approximately eyeballed.

| Parameter | Primary | Small | Micro |
| --- | --- | --- | --- |
| arms | 5 | 5 | 4 |
| sweep | 215° | 190° | 110° |
| rOuter → rInner | 158 → 70 | 158 → 62 | 150 → 60 |
| width lead → outer → inner | 16 → 50 → 20 | 26 → 58 → 26 | 56 → 80 → 48 |
| emblem | ring + field + blades + centre | field + centre | field |

All figures are in the 512-unit master grid.

## Size treatments

One mark, three treatments. Which master a size uses is decided in exactly one
place — `tileFor()` in `scripts/brand/generate-brand-assets.mjs` — so the preview
sheet always shows what the applications actually ship.

| Size | Master | Why |
| --- | --- | --- |
| ≥ 48 px | `deqr-tile.svg` | Full detail, including the emblem's blades. |
| 25–47 px | `deqr-tile-small.svg` | Primary arms fall under two pixels; the emblem's blades turn to mud. Heavier arms, emblem reduced to field and centre. |
| ≤ 24 px | `deqr-tile-micro.svg` | Five arms and the gaps between them cannot both survive. Four heavy blades keep real negative space, which is what still reads as rotation. |

This is a deliberate per-size artwork system, not a fallback. It was settled by
magnifying the real 16 px raster, not by scaling the vector down and guessing.

## Colour

| Role | Value | Notes |
| --- | --- | --- |
| Ground (top → bottom) | `#131C29` → `#080D14` | Icon tile only. |
| Arm ramp (centre → rim) | `#8FCDFF` → `#3D93F5` → `#0A50BE` | Radial. Structural, not decorative. |
| Arm ramp, light surfaces | `#4FA3F0` → `#1A6FD8` → `#083E9C` | Holds contrast against white. |
| Emblem field | `#FFFFFF` → `#9BD5FF` | Radial, offset up-left. |
| Emblem ring | `#C6EAFF` → `#3D93F5` | 3-unit hairline. |
| Emblem shadow | `#080D14` | Blades, and the ink cut on light surfaces. |
| Ink | `#0B1119` | Monochrome default, lockup type. |

The blue is the product's own accent family (`--accent-primary` `#0071e3` light /
`#2997ff` dark), not a new brand colour. The previous icon's `#00f2fe` cyan was
dropped: it belonged to no part of the application's palette.

Two hues only — a blue family plus near-white on near-black. No third hue, no
decorative gradient.

## Clear space and minimum size

- **Clear space:** at least 32 units on the 512 grid — one eighth of the mark's
  width — on every side. `deqr-mark.svg` carries exactly that in its viewBox.
- **Minimum size:** 16 px for the tile, using the micro treatment. Below that,
  use the wordmark alone.
- **Do not** place the mark on a busy photograph without the tile container.

## Variants

| File | Use |
| --- | --- |
| `source/deqr-tile.svg` | Primary. Rounded container, dark ground. ≥ 48 px exports and the manifest's vector entry. |
| `source/deqr-tile-small.svg` | 25–47 px exports. |
| `source/deqr-tile-micro.svg` | ≤ 24 px exports, and `deqr-chip.svg` — the one SVG that application `<img>` tags draw between 23 and 47 px. |
| `source/deqr-ios.svg` | apple-touch-icon source. Opaque, square-cornered. |
| `source/deqr-maskable.svg` | PWA `purpose: maskable`. Inset to the safe circle. |
| `source/deqr-mark.svg` | Mark alone, dark surfaces, no container. |
| `source/deqr-mark-light.svg` | Mark alone, white and near-white surfaces. |
| `source/deqr-mark-mono.svg` | One-colour stencil. Inherits `currentColor` when inlined. |
| `source/deqr-lockup.svg` | Mark + `DEQR` + `OPTICAL TRANSFER`. |

The monochrome stencil keeps the arms and the emblem's field disc and drops the
blades. A one-colour mark cannot hold the emblem's layering, and knocking the
blades out would open holes onto whatever it is placed over.

## Typography

The wordmark is set in the application's own display stack —
`-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", …`, matching
`--font-display` in `src/renderer/styles/theme.css`. No separate brand face was
introduced.

Tracking is size-specific: `DEQR` at 150 units takes `-3` (negative, because
letters read too far apart as they grow); `OPTICAL TRANSFER` at 44 units takes
`+8`. A single letter-spacing value would be wrong at one of the two.

**Caveat:** `deqr-lockup.svg` references system fonts by name, so it renders with
a substitute face on a machine without them. It is a documentation and layout
asset. Anything that must be pixel-identical everywhere should use the mark plus
live text in the application's own CSS.

## Inappropriate uses

Do not: recolour the arms outside the blue family; add a glow, bevel, or drop
shadow; rotate the mark (the sweep direction is meaningful); stretch it
non-uniformly; place the transparent mark on a mid-tone that collides with the
arm ramp; use the `any` icon where a `maskable` one is required; or reintroduce a
literal QR grid.

## Asset mapping

### Electron / Windows

| Config | Value |
| --- | --- |
| `build.win.icon` | `branding/export/desktop/icon.ico` |
| `build.directories.buildResources` | `branding/export/desktop` |
| `BrowserWindow({ icon })` | `branding/export/desktop/icon.ico`, **unpackaged only** |

`icon.ico` carries 16, 24, 32, 48, 64, 128 as 32-bit DIBs and 256 as an embedded
PNG — the layout Windows itself ships. electron-builder embeds it in the
executable, so a packaged window, the taskbar, Alt+Tab, the NSIS installer, the
portable executable, and shortcuts all take their icon from that one file. A
packaged build therefore must *not* set `BrowserWindow.icon`; unpackaged there is
no executable resource to read, which is the only reason the option is set at all.

### PWA / iOS

| File | Referenced by |
| --- | --- |
| `icons/deqr.svg` | manifest vector entry (`sizes: any`) |
| `icons/deqr-chip.svg` | `<link rel="icon">`, both application headers, receiver home mark |
| `icons/deqr-{16,32,64,192,512}.png` | manifest `purpose: any` |
| `icons/deqr-maskable-512.png` | manifest `purpose: maskable` |
| `icons/apple-touch-icon-180.png` | `<link rel="apple-touch-icon">` |
| `favicon.ico` | `<link rel="alternate icon">` |

The 192 and 512 icons declare `purpose: "any"` alone. They previously declared
`"any maskable"`, which is the common mistake: a platform mask crops that artwork
to a circle, and anything drawn to fill the square loses its edges. The maskable
entry is its own inset artwork.

`apple-touch-icon-180.png` is opaque and square-cornered. iOS applies its own
squircle; a radius baked into the file would be masked a second time.

## Regenerating

```bash
npm run brand:masters
```

Rebuilds `branding/source/*.svg` from the geometry in
`scripts/brand/build-masters.mjs`. Run this after changing arm count, sweep,
taper, or the emblem.

```bash
npm run brand:generate
```

Rasterises the masters into every shipped PNG and ICO, and rebuilds
`branding/deqr-logo-preview.html`. Run this after either the masters or the
export targets change.

Rasterisation uses `canvas`, already a devDependency of this repository — no new
dependency was added to resize an icon. The masters are the only input; nothing
downstream is hand-edited.

To explore the geometry without touching the masters:

```bash
node scripts/brand/build-masters.mjs --variants branding/iterations/next-study.html
```
