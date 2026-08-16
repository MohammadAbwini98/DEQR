# branding/

Source of truth for the DEQR visual identity.

```
branding/
├── DEQR-BRAND-GUIDE.md          colour, construction, clear space, asset mapping
├── deqr-logo-preview.html       brand sheet — generated, gitignored, not in a fresh clone
├── source/                      vector masters (the only hand-owned artwork)
├── concepts/                    the four directions explored before selection
├── iterations/                  refinement studies, in order
└── export/desktop/              icon.ico + icon.png consumed by electron-builder
```

## Rules

- **`source/*.svg` is generated too.** It is written by
  `scripts/brand/build-masters.mjs`, which holds the spiral geometry. Editing a
  master by hand works until the next `npm run brand:masters` overwrites it —
  change the geometry there instead.
- **Everything under `mobile-web/public/icons/`, `mobile-web/public/favicon.ico`
  and `branding/export/` is generated.** Never hand-edit them; run
  `npm run brand:generate`. Those *are* tracked, because the build consumes
  them and a fresh clone has to package without running the generator.
- **`deqr-logo-preview.html` is gitignored.** It embeds every raster as base64,
  so it is ~1.3 MB and changes in full whenever the geometry does. Run
  `npm run brand:generate` to produce it.
- `concepts/` and `iterations/` are a record, not inputs. Nothing builds from them.

## How the direction was reached

1. **Four concepts** were built and scored against a weighted matrix — optical
   vortex, data aperture, portal tunnel, and reconstruction. `concepts/preview.html`
   shows them, including at 16–64 px.
2. The **data aperture** read as an eye at every size and the **portal tunnel**
   collapsed into moiré below 32 px. **Reconstruction** scattered into noise.
   The optical vortex won on distinctiveness and small-size legibility.
3. It was refined as a **square pinwheel aperture** —
   `iterations/01-square-aperture-studies.html`. Five structural variants were
   compared; the taper read as a rendering error and three geometric languages
   competed for attention.
4. A **reference image was then supplied** showing a spiral vortex converging on a
   luminous core. The geometry was rebuilt around that structure:
   `iterations/02-vortex-arm-studies.html` compares arm count, sweep, taper and
   focus treatment.
5. The **focal emblem** was added last, in two study rounds. The first found that
   enlarging the emblem by pushing the arms outward destroys the vortex — the mark
   becomes a bullseye. The emblem was sized to the throat instead.

## On the reference

The supplied reference is a *Naruto* Kamui/Mangekyō Sharingan wallpaper. What was
taken from it is structural: rotational convergence, long spiral arms sweeping into
a focus, dark ground against a luminous centre, and a layered core emblem — a
bright circular field carrying a darker shape inside it.

What was deliberately not taken: the three-comma tomoe pattern, the red-on-black
palette, the eye/iris outline, and any recognisable *Naruto* form. The DEQR emblem
uses five spiral blades rather than three hooked commas, resolves to a square
module rather than a round pupil, and sits in the product's own blue. Three arms
was excluded from the arm-count study for exactly this reason — at that count the
sweep reads as the reference's own emblem.
