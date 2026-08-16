/**
 * Constructs the DEQR vortex geometry and writes the vector masters.
 *
 * The arms are logarithmic spirals: the radius decays geometrically as the
 * angle advances, which is the curve a real vortex traces and the reason the
 * mark reads as rotating without drawing a single arrow. Each arm is the band
 * between that spiral offset inward and outward by a width that tapers along
 * the sweep, so the arm thins as it is drawn toward the focus.
 *
 * Hand-authoring those paths is not practical, so this script computes them
 * once and emits `branding/source/*.svg`. Those SVGs are the committed vector
 * masters and the only input to `generate-brand-assets.mjs`; this file records
 * how they were derived and lets the construction be re-tuned.
 *
 *   node scripts/brand/build-masters.mjs [--variants <file.html>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(ROOT, 'branding', 'source');

const rad = (deg) => (deg * Math.PI) / 180;
const round = (n) => Math.round(n * 10) / 10;

/**
 * Catmull-Rom through the sampled points, converted to cubic Beziers. Sampling
 * a spiral and joining with straight lines would flat-spot the curve at icon
 * sizes where the arm is only a few pixels wide.
 */
function curveThrough(points) {
  let d = '';
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

/**
 * One arm, as a closed path. `phase` rotates the arm into its place in the
 * ring; every other parameter is shared, so the arms are identical and the
 * symmetry is exact.
 */
/**
 * Width along the sweep. With `wLead` the arm also tapers at its outer tip, so
 * it enters the frame as a fine edge and thickens as it turns inward instead of
 * starting on a blunt radial cut.
 */
function widthAt(t, { wOuter, wInner, wLead, lead = 0.2 }) {
  if (wLead === undefined || t >= lead) {
    const u = wLead === undefined ? t : (t - lead) / (1 - lead);
    return wOuter + (wInner - wOuter) * u;
  }
  return wLead + (wOuter - wLead) * (t / lead);
}

function arm({ rOuter, rInner, sweep, phase, samples = 16, ...width }) {
  const outer = [];
  const inner = [];
  const decay = rInner / rOuter;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const theta = rad(phase + sweep * t);
    const r = rOuter * decay ** t;
    const w = widthAt(t, width);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    outer.push([(r + w / 2) * cos, (r + w / 2) * sin]);
    inner.push([(r - w / 2) * cos, (r - w / 2) * sin]);
  }
  inner.reverse();
  return `M ${round(outer[0][0])} ${round(outer[0][1])}${curveThrough(outer)}`
    + ` L ${round(inner[0][0])} ${round(inner[0][1])}${curveThrough(inner)} Z`;
}

/** Rounded diamond, half-diagonal `d`, corner radius `r`. */
function diamond(d, r) {
  const k = round(r / Math.SQRT2);
  const a = round(d - r / Math.SQRT2);
  return `M ${-k} ${-a} A ${r} ${r} 0 0 1 ${k} ${-a} L ${a} ${-k} A ${r} ${r} 0 0 1 ${a} ${k}`
    + ` L ${k} ${a} A ${r} ${r} 0 0 1 ${-k} ${a} L ${-a} ${k} A ${r} ${r} 0 0 1 ${-a} ${-k} Z`;
}

function arms(count, options) {
  return Array.from({ length: count }, (_, i) =>
    arm({ ...options, phase: (options.phase ?? 0) + (360 / count) * i }));
}

/**
 * A short segment of the same spiral, used for the detached modules that lead
 * into an arm. `from`/`to` are positions along the arm's own sweep.
 */
function armSegment({ rOuter, rInner, sweep, phase, from, to, samples = 8, ...width }) {
  const outer = [];
  const inner = [];
  const decay = rInner / rOuter;
  for (let i = 0; i <= samples; i += 1) {
    const t = from + ((to - from) * i) / samples;
    const theta = rad(phase + sweep * t);
    const r = rOuter * decay ** t;
    const w = widthAt(Math.min(t, 1), width);
    outer.push([(r + w / 2) * Math.cos(theta), (r + w / 2) * Math.sin(theta)]);
    inner.push([(r - w / 2) * Math.cos(theta), (r - w / 2) * Math.sin(theta)]);
  }
  inner.reverse();
  return `M ${round(outer[0][0])} ${round(outer[0][1])}${curveThrough(outer)}`
    + ` L ${round(inner[0][0])} ${round(inner[0][1])}${curveThrough(inner)} Z`;
}

// ---------------------------------------------------------------------------
// Variants explored before the geometry was locked. Kept so the choice of arm
// count and taper can be re-examined rather than taken on trust.
// ---------------------------------------------------------------------------

// Three arms is deliberately absent: at that count the sweep reads as the
// three-comma emblem the reference is built from, which is the one thing this
// mark must not reproduce.
const VARIANTS = {
  r1: { count: 5, rOuter: 158, rInner: 44, sweep: 200, wOuter: 50, wInner: 18, core: 34, coreShape: 'diamond' },
  r2: { count: 5, rOuter: 158, rInner: 44, sweep: 200, wOuter: 50, wInner: 18, core: 32, coreShape: 'disc' },
  r3: { count: 4, rOuter: 158, rInner: 44, sweep: 215, wOuter: 56, wInner: 20, core: 36, coreShape: 'diamond' },
  r4: { count: 6, rOuter: 158, rInner: 42, sweep: 205, wOuter: 42, wInner: 16, core: 32, coreShape: 'diamond' },
  r5: { count: 5, rOuter: 158, rInner: 44, sweep: 200, wOuter: 50, wInner: 18, wLead: 16, core: 34, coreShape: 'diamond' },
  r6: { count: 5, rOuter: 158, rInner: 44, sweep: 200, wOuter: 50, wInner: 18, core: 34, coreShape: 'diamond', modules: true },
};

/**
 * The arm ramp is radial, not vertical: the arms brighten as they approach the
 * focus, so the colour itself carries the convergence rather than a light
 * source that has nothing to do with the subject.
 */
const RAMPS = `
    <linearGradient id="§-ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#131C29"/><stop offset="1" stop-color="#080D14"/>
    </linearGradient>
    <radialGradient id="§-arm" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.12" stop-color="#8FCDFF"/>
      <stop offset="0.46" stop-color="#3D93F5"/>
      <stop offset="1" stop-color="#0A50BE"/>
    </radialGradient>
    <radialGradient id="§-focus" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#BFE6FF" stop-opacity="0.50"/>
      <stop offset="0.42" stop-color="#5AB2FF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#5AB2FF" stop-opacity="0"/>
    </radialGradient>`;

function markBody(spec, id) {
  const { count, core, coreShape, modules } = spec;
  const armPaths = modules
    ? arms(count, { ...spec, sweep: spec.sweep * 0.74 }).map((d, i) => {
      // Two detached blocks lead each arm in: discrete data entering the
      // channel, becoming continuous once it is inside.
      const phase = (360 / count) * i;
      return d + armSegment({ ...spec, phase, from: 0.80, to: 0.90 })
        + armSegment({ ...spec, phase, from: 0.96, to: 1.04 });
    })
    : arms(count, spec);

  const focus = coreShape === 'disc'
    ? `<circle r="${core}" fill="#F4FBFF"/>`
    : `<path d="${diamond(core, 9)}" fill="#F4FBFF"/>`;

  return `
    <circle r="${Math.round(spec.rOuter * 0.92)}" fill="url(#${id}-focus)"/>
    <g fill="url(#${id}-arm)">
${armPaths.map((d) => `      <path d="${d}"/>`).join('\n')}
    </g>
    ${focus}`;
}

function variantSvg(key) {
  const spec = VARIANTS[key];
  return `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>${RAMPS.replaceAll('§', key)}
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#${key}-ground)"/>
  <g transform="translate(256 256)">${markBody(spec, key)}
  </g>
</svg>`;
}

// ---------------------------------------------------------------------------

function writeVariantSheet(target) {
  // Each variant's geometry is emitted once as a <symbol>; every rendering is
  // a <use>. Repeating the paths per size would make the sheet unopenable.
  const defs = Object.keys(VARIANTS).map((key) => `
  <symbol id="${key}" viewBox="0 0 512 512">${RAMPS.replaceAll('§', key)}
    <rect width="512" height="512" rx="112" fill="url(#${key}-ground)"/>
    <g transform="translate(256 256)">${markBody(VARIANTS[key], key)}
    </g>
  </symbol>`).join('');

  const at = (key, size) => `<svg viewBox="0 0 512 512" style="width:${size}px;height:${size}px"><use href="#${key}"/></svg>`;

  const cards = Object.keys(VARIANTS).map((key) => {
    const spec = VARIANTS[key];
    return `<div class="card"><div class="art">${at(key, 150)}</div>
      <div class="label">${key} · ${spec.count} arms · sweep ${spec.sweep}° · w ${spec.wOuter}→${spec.wInner}${spec.modules ? ' · modules' : ''}</div></div>`;
  }).join('\n');

  const strips = Object.keys(VARIANTS).map((key) => `
    <div class="strip"><span class="n">${key}</span>
      ${[64, 48, 32, 24, 16].map((s) => `<figure>${at(key, s)}<figcaption>${s}</figcaption></figure>`).join('')}
    </div>`).join('');

  fs.writeFileSync(target, `<!DOCTYPE html><meta charset="utf-8"><title>DEQR vortex variants</title><style>
body{margin:0;padding:16px;background:#f5f5f7;font:13px -apple-system,"Segoe UI",sans-serif;color:#1d1d1f}
h1{font-size:1rem;margin:0 0 12px}
h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;margin:16px 0 7px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;overflow:hidden}
.art{display:flex;justify-content:center;padding:12px}
svg.big{width:150px;height:150px;display:block}
.label{padding:6px 9px;font-size:.64rem;font-weight:600;border-top:1px solid rgba(0,0,0,.1)}
.strip{display:flex;gap:13px;align-items:flex-end;background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:10px;padding:8px 12px;margin-bottom:6px}
.n{font-size:.66rem;font-weight:700;width:26px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:3px}
figcaption{font-size:.55rem;opacity:.5}
svg{display:block}
</style>
<svg width="0" height="0" style="position:absolute"><defs>${defs}</defs></svg>
<h1>DEQR — vortex arm studies</h1>
<div class="grid">${cards}</div>
<h2>Small-size behaviour</h2>${strips}`);
}

/** Rasterises every variant onto one image, at real pixel sizes. */
async function writeVariantImage(target) {
  const { createCanvas, loadImage } = (await import('canvas')).default ?? await import('canvas');
  const keys = Object.keys(VARIANTS);
  const draw = async (key, size) => {
    const svg = variantSvg(key).replace('<svg ', `<svg width="${size}" height="${size}" `);
    return loadImage(Buffer.from(svg, 'utf8'));
  };

  const W = 1180;
  const H = 200 + keys.length * 150;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f5f7';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d1d1f';
  ctx.font = 'bold 18px "Segoe UI"';
  ctx.fillText('DEQR — vortex arm studies', 22, 30);

  let y = 52;
  for (const key of keys) {
    const spec = VARIANTS[key];
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(22, y, W - 44, 138);
    ctx.drawImage(await draw(key, 256), 34, y + 5, 128, 128);
    let x = 190;
    for (const size of [96, 64, 48, 32, 24, 16]) {
      ctx.drawImage(await draw(key, size), x, y + 5 + (96 - size) / 2, size, size);
      ctx.fillStyle = '#9a9aa0'; ctx.font = '11px "Segoe UI"'; ctx.textAlign = 'center';
      ctx.fillText(String(size), x + size / 2, y + 118);
      ctx.textAlign = 'left';
      x += size + 34;
    }
    // the same variant on the shell's dark strip
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(x + 8, y + 12, 250, 82);
    let dx = x + 26;
    for (const size of [48, 32, 24, 16]) {
      ctx.drawImage(await draw(key, size), dx, y + 24 + (48 - size) / 2, size, size);
      dx += size + 22;
    }
    ctx.fillStyle = '#1d1d1f'; ctx.font = 'bold 13px "Segoe UI"';
    ctx.fillText(`${key}`, 34, y + 133 + 0);
    ctx.fillStyle = '#6e6e73'; ctx.font = '12px "Segoe UI"';
    ctx.fillText(`${spec.count} arms · sweep ${spec.sweep}° · width ${spec.wOuter}→${spec.wInner}${spec.modules ? ' · leading modules' : ''}`, 62, y + 133);
    y += 150;
  }
  fs.writeFileSync(target, canvas.toBuffer('image/png'));
}

// ---------------------------------------------------------------------------
// The locked geometry
// ---------------------------------------------------------------------------

/**
 * Five arms rather than four: four settles into a static cross under the eye,
 * and three would read as the reference's three-comma emblem. The sweep is
 * long enough that each arm turns visibly through the frame, and the leading
 * taper lets it enter as a fine edge instead of a blunt radial cut.
 */
const PRIMARY = {
  count: 5, rOuter: 158, rInner: 70, sweep: 215, wLead: 16, wOuter: 50, wInner: 20,
  /**
   * The focus is an emblem, not a dot: a hairline ring, a luminous field, and a
   * second set of spiral blades running inside it in shadow. It is the same
   * vortex again an order of magnitude down and inverted — the channel seen
   * from inside — with the DEQR module resolved at the very centre.
   *
   * Five blades, spiral bands, and an angular centre. Three hooked commas
   * around a round pupil is the reference's own emblem and is not ours to use.
   */
  emblem: {
    ring: 50,
    field: 42,
    blades: { count: 5, rOuter: 30, rInner: 9, sweep: 180, wLead: 4, wOuter: 13, wInner: 5 },
    centre: 11,
  },
};

/**
 * Around 32 px the primary arms fall under two pixels and the focal light
 * blooms over them. Same five-arm construction, heavier and with a shorter
 * sweep so the gaps survive.
 */
const SMALL = {
  count: 5, rOuter: 158, rInner: 62, sweep: 190, wLead: 26, wOuter: 58, wInner: 26,
  // The emblem loses its blades here — at 32 px they are a third of a pixel and
  // only muddy the field. Ring and centre survive, so the focus still reads as
  // the same object rather than a different mark.
  emblem: { field: 40, centre: 17 },
};

/**
 * At 24 px and below there is simply not enough room for five arms and the
 * gaps between them: everything merges into one blue mass. Dropping to four
 * much heavier blades over a short sweep keeps real negative space between
 * them, which is what makes the mark still read as turning. Verified by
 * magnifying the actual 16 px raster, not by scaling the vector down.
 */
const MICRO = {
  count: 4, rOuter: 150, rInner: 60, sweep: 110, wLead: 56, wOuter: 80, wInner: 48,
  emblem: { field: 44 },
};

const INK = '#0B1119';

function ramps(id, { arm: armRamp, focus, ground = true, field }) {
  return `${ground ? `
    <linearGradient id="${id}-ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#131C29"/><stop offset="1" stop-color="#080D14"/>
    </linearGradient>` : ''}
    <radialGradient id="${id}-arm" cx="0.5" cy="0.5" r="0.5">
${armRamp.map(([offset, color]) => `      <stop offset="${offset}" stop-color="${color}"/>`).join('\n')}
    </radialGradient>${field ? `
    <radialGradient id="${id}-field" cx="0.42" cy="0.36" r="0.75">
      <stop offset="0" stop-color="${field[0]}"/><stop offset="1" stop-color="${field[1]}"/>
    </radialGradient>
    <linearGradient id="${id}-ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#C6EAFF"/><stop offset="1" stop-color="#3D93F5"/>
    </linearGradient>` : ''}${focus ? `
    <radialGradient id="${id}-focus" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#BFE6FF" stop-opacity="${focus}"/>
      <stop offset="0.42" stop-color="#5AB2FF" stop-opacity="${round(focus * 0.32)}"/>
      <stop offset="1" stop-color="#5AB2FF" stop-opacity="0"/>
    </radialGradient>` : ''}`;
}

const DARK_ARM = [[0.12, '#8FCDFF'], [0.46, '#3D93F5'], [1, '#0A50BE']];
const LIGHT_ARM = [[0.12, '#4FA3F0'], [0.46, '#1A6FD8'], [1, '#083E9C']];
const FIELD = ['#FFFFFF', '#9BD5FF'];

/**
 * The focal emblem. `shadow` is the colour its blades and negative space are
 * cut in — the ground on a tile, the ink on a transparent mark — so the emblem
 * keeps its layering wherever it is placed.
 */
function emblemBody({ ring, field, blades, centre }, id, shadow, flat) {
  // A one-colour stencil cannot hold the emblem's layering: blades cut in a
  // second colour would vanish, and knocking them out would open holes onto
  // whatever the mark is placed on. It keeps the field disc and drops the rest.
  if (flat) return `      <circle r="${field}" fill="${flat}"/>`;
  return [
    ring ? `      <circle r="${ring}" fill="none" stroke="url(#${id}-ring)" stroke-width="3"/>` : '',
    `      <circle r="${field}" fill="url(#${id}-field)"/>`,
    ...(blades ? arms(blades.count, blades).map((d) => `      <path d="${d}" fill="${shadow}"/>`) : []),
    centre ? `      <path d="${diamond(centre, 3)}" fill="#FFFFFF"/>` : '',
  ].filter(Boolean).join('\n');
}

function vortex(spec, id, { focus = 0.5, shadow = '#080D14', flat } = {}) {
  const armPaths = arms(spec.count, spec);
  return `${focus ? `
      <circle r="${Math.round(spec.rOuter * 0.92)}" fill="url(#${id}-focus)"/>` : ''}
      <g fill="${flat ?? `url(#${id}-arm)`}">
${armPaths.map((d) => `        <path d="${d}"/>`).join('\n')}
      </g>
${emblemBody(spec.emblem, id, shadow, flat)}`;
}

const DOC = (title, desc) => `  <title>${title}</title>
  <desc>${desc}</desc>`;

function master({ id, title, desc, spec = PRIMARY, viewBox = '0 0 512 512', radius, scale = 1, ground = true, armRamp = DARK_ARM, focus = 0.5, shadow = '#080D14' }) {
  const groundShape = ground
    ? `\n  <rect width="512" height="512"${radius ? ` rx="${radius}"` : ''} fill="url(#${id}-ground)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="DEQR">
${DOC(title, desc)}
  <defs>${ramps(id, { arm: armRamp, focus, ground, field: FIELD })}
  </defs>${groundShape}
  <g transform="translate(256 256)${scale === 1 ? '' : ` scale(${scale})`}">${vortex(spec, id, { focus, shadow })}
  </g>
</svg>
`;
}

const CONSTRUCTION = 'Five logarithmic-spiral arms converge on a focal module. Radius decays geometrically as the sweep advances, so the mark turns without an arrow; the arms brighten inward, so the colour carries the convergence; the focus is a square module turned on its diagonal, which resolves the optical channel into discrete verified data.';

function writeMasters() {
  fs.mkdirSync(SOURCE, { recursive: true });
  const files = {
    'deqr-tile.svg': master({
      id: 'deqr-tile', radius: 112,
      title: 'DEQR',
      desc: `Primary application tile. ${CONSTRUCTION}`,
    }),
    'deqr-tile-small.svg': master({
      id: 'deqr-small', radius: 104, spec: SMALL, scale: 1.03, focus: 0.26,
      title: 'DEQR — small-size treatment',
      desc: 'The primary construction with heavier arms, a shorter sweep and a dimmed focus. Used for exports from 25 to 47 pixels, where the primary arms fall below two pixels wide.',
    }),
    'deqr-tile-micro.svg': master({
      id: 'deqr-micro', radius: 96, spec: MICRO, focus: 0,
      title: 'DEQR — micro-size treatment',
      desc: 'Four heavy blades over a short sweep, with the focal light removed. Used for exports at 24 pixels and below, where five arms and the gaps between them cannot both survive and the mark collapses into one blue mass.',
    }),
    'deqr-ios.svg': master({
      id: 'deqr-ios', scale: 0.94, focus: 0.56,
      title: 'DEQR — iOS Home Screen treatment',
      desc: 'Opaque, square-cornered artwork for apple-touch-icon. iOS applies its own squircle mask, so no corner radius is baked in.',
    }),
    'deqr-maskable.svg': master({
      id: 'deqr-maskable', scale: 0.9, focus: 0.56,
      title: 'DEQR — maskable',
      desc: 'Full-bleed artwork for the PWA maskable purpose. At this scale the arms reach radius 149, well inside the 205 that every platform mask preserves.',
    }),
    'deqr-mark.svg': master({
      id: 'deqr-mark', viewBox: '80 80 352 352', ground: false, focus: 0,
      title: 'DEQR mark',
      desc: `The mark without a container, for dark surfaces. The viewBox carries clear space around the arms; keep at least that much when placing it. ${CONSTRUCTION}`,
    }),
    'deqr-mark-light.svg': master({
      id: 'deqr-light', viewBox: '80 80 352 352', ground: false, focus: 0,
      armRamp: LIGHT_ARM, shadow: INK,
      title: 'DEQR mark — light surfaces',
      desc: 'Geometry identical to the primary mark, with the blue ramp darkened and the focus inked so both hold contrast against white and near-white backgrounds.',
    }),
  };

  // Monochrome is written by hand rather than through `master`: it is a single
  // fill with no ramps, and it must inherit colour when inlined.
  files['deqr-mark-mono.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="80 80 352 352" role="img" aria-label="DEQR" color="${INK}">
${DOC('DEQR mark — monochrome', 'Single-colour stencil. Inline this file and it inherits the surrounding text colour; used as an image it falls back to the ink colour set on the root element.')}
  <g transform="translate(256 256)" fill="currentColor">
${arms(PRIMARY.count, PRIMARY).map((d) => `    <path d="${d}"/>`).join('\n')}
${emblemBody(PRIMARY.emblem, 'mono', INK, 'currentColor')}
  </g>
</svg>
`;

  const markRadius = Math.round(PRIMARY.rOuter + PRIMARY.wLead / 2);
  files['deqr-lockup.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 320" role="img" aria-label="DEQR — Optical Transfer" color="${INK}">
${DOC('DEQR — Optical Transfer', "Horizontal lockup: mark, wordmark, descriptor. The wordmark is set in the application's own display stack rather than a separate brand face, so documentation and interface stay typographically identical. Inline this file and the type inherits the surrounding colour.")}
  <defs>${ramps('deqr-lockup', { arm: LIGHT_ARM, focus: 0, ground: false, field: FIELD })}
  </defs>
  <g id="mark" transform="translate(160 160) scale(${round(140 / markRadius)})">
    <g fill="url(#deqr-lockup-arm)">
${arms(PRIMARY.count, PRIMARY).map((d) => `      <path d="${d}"/>`).join('\n')}
    </g>
${emblemBody(PRIMARY.emblem, 'deqr-lockup', INK)}
  </g>
  <g id="wordmark" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Helvetica, Arial, sans-serif" fill="currentColor">
    <!-- Large type takes negative tracking; the small descriptor takes positive. -->
    <text x="356" y="186" font-size="150" font-weight="700" letter-spacing="-3">DEQR</text>
    <text x="360" y="250" font-size="44" font-weight="600" letter-spacing="8" opacity="0.62">OPTICAL TRANSFER</text>
  </g>
</svg>
`;

  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(SOURCE, name), contents, 'utf8');
    console.log(`  branding/source/${name.padEnd(24)} ${String(Buffer.byteLength(contents)).padStart(6)} B`);
  }
}

const sheetFlag = process.argv.indexOf('--sheet');
const flag = process.argv.indexOf('--variants');
if (sheetFlag !== -1) {
  await writeVariantImage(process.argv[sheetFlag + 1]);
  console.log('variant image written');
} else if (flag !== -1) {
  writeVariantSheet(process.argv[flag + 1]);
  console.log('variant sheet written');
} else {
  console.log('DEQR vector masters\n');
  writeMasters();
  console.log('\nNow run: node scripts/brand/generate-brand-assets.mjs');
}

export { arm, arms, armSegment, curveThrough, diamond, PRIMARY, SMALL, MICRO, VARIANTS };
