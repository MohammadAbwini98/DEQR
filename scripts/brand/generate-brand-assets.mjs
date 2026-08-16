/**
 * DEQR brand asset generator.
 *
 * The vector masters in `branding/source/` are the only source of truth. Every
 * raster the applications ship is produced here, so an icon can never drift
 * from the artwork it claims to come from: re-run the script and the exports
 * are rebuilt byte-for-byte from the SVG.
 *
 *   branding/source/*.svg
 *        -> PNG (node-canvas / librsvg)
 *        -> ICO (multi-resolution, DIB up to 128 and PNG at 256)
 *        -> branding/deqr-logo-preview.html (self-contained, offline)
 *
 * Usage:  npm run brand:generate
 *
 * `canvas` is already a devDependency of this repository (the QR fidelity
 * tests use it), so nothing new is installed to resize an icon.
 */
import { createCanvas, loadImage } from 'canvas';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(ROOT, 'branding', 'source');

/**
 * One mark, three size treatments. The arms of the primary fall below two
 * pixels around 32 px and below any usable width by 24, so the small exports
 * come from masters built for them rather than from a naive downscale. Which
 * master a size uses is decided here and nowhere else, so the preview sheet
 * shows the same artwork the applications ship.
 */
const tileFor = (size) => {
  if (size <= 24) return 'deqr-tile-micro.svg';
  if (size < 48) return 'deqr-tile-small.svg';
  return 'deqr-tile.svg';
};

/** PNGs the applications actually load. */
const PNG_TARGETS = [
  { src: tileFor(16), out: 'mobile-web/public/icons/deqr-16.png', size: 16 },
  { src: tileFor(32), out: 'mobile-web/public/icons/deqr-32.png', size: 32 },
  { src: tileFor(64), out: 'mobile-web/public/icons/deqr-64.png', size: 64 },
  { src: 'deqr-tile.svg', out: 'mobile-web/public/icons/deqr-192.png', size: 192 },
  { src: 'deqr-tile.svg', out: 'mobile-web/public/icons/deqr-512.png', size: 512 },
  { src: 'deqr-ios.svg', out: 'mobile-web/public/icons/apple-touch-icon-180.png', size: 180 },
  { src: 'deqr-maskable.svg', out: 'mobile-web/public/icons/deqr-maskable-512.png', size: 512 },
  { src: 'deqr-tile.svg', out: 'branding/export/desktop/icon.png', size: 512 },
];

/**
 * Vector masters copied verbatim to where an application references them.
 *
 * Two are needed because an `<img>` cannot switch artwork by rendered size the
 * way the PNG exports do. `deqr.svg` is the full mark, for the manifest's
 * vector entry. `deqr-chip.svg` is the micro treatment, for every place a
 * single SVG is drawn between 23 and 47 px — both application headers, the
 * receiver's home mark, and the SVG favicon. The full mark speckles at those
 * sizes; the arms and the emblem's blades are under two pixels.
 */
const SVG_COPIES = [
  { src: 'deqr-tile.svg', out: 'mobile-web/public/icons/deqr.svg' },
  { src: 'deqr-tile-micro.svg', out: 'mobile-web/public/icons/deqr-chip.svg' },
];

/**
 * Windows wants several resolutions in one file. electron-builder requires a
 * 256 entry; the smaller ones are what the taskbar and Alt+Tab actually draw,
 * and leaving them out makes Windows downscale 256 badly.
 */
const ICO_TARGETS = [
  { out: 'branding/export/desktop/icon.ico', sizes: [16, 24, 32, 48, 64, 128, 256] },
  { out: 'mobile-web/public/favicon.ico', sizes: [16, 32, 48] },
];

/** Rasters the preview sheet embeds. Never loaded by the applications. */
const PREVIEW_SIZES = [16, 20, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024];

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

const svgCache = new Map();

function readMaster(name) {
  if (!svgCache.has(name)) svgCache.set(name, fs.readFileSync(path.join(SOURCE, name), 'utf8'));
  return svgCache.get(name);
}

/**
 * librsvg refuses an `<svg>` element that carries only a viewBox, and it scales
 * from the intrinsic size when one is present. Injecting the target size is
 * therefore both required and the mechanism that makes the export resolution
 * independent.
 */
async function rasterize(name, size) {
  const svg = readMaster(name).replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  const image = await loadImage(Buffer.from(svg, 'utf8'));
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);
  return { png: canvas.toBuffer('image/png'), rgba: ctx.getImageData(0, 0, size, size).data };
}

// ---------------------------------------------------------------------------
// ICO assembly
// ---------------------------------------------------------------------------

/**
 * A 32-bit bottom-up DIB plus the 1bpp AND mask, which is the shape every
 * Windows shell icon has had since NT. The alpha channel drives compositing on
 * Vista and later, but the mask still has to describe the transparent corners
 * or older paths draw them opaque.
 */
function encodeDib(size, rgba) {
  const HEADER = 40;
  const xorStride = size * 4;
  const xorSize = xorStride * size;
  const andStride = Math.ceil(size / 32) * 4;
  const andSize = andStride * size;
  const buffer = Buffer.alloc(HEADER + xorSize + andSize);

  buffer.writeUInt32LE(HEADER, 0);
  buffer.writeInt32LE(size, 4);
  buffer.writeInt32LE(size * 2, 8); // colour rows followed by mask rows
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt16LE(32, 14);
  buffer.writeUInt32LE(0, 16); // BI_RGB
  buffer.writeUInt32LE(xorSize + andSize, 20);

  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * xorStride;
    let target = HEADER + y * xorStride;
    let maskByte = HEADER + xorSize + y * andStride;
    for (let x = 0; x < size; x += 1) {
      const i = sourceRow + x * 4;
      buffer[target] = rgba[i + 2];
      buffer[target + 1] = rgba[i + 1];
      buffer[target + 2] = rgba[i];
      buffer[target + 3] = rgba[i + 3];
      target += 4;
      if (rgba[i + 3] < 128) buffer[maskByte + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return buffer;
}

function buildIco(images) {
  const DIRECTORY_ENTRY = 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon, not cursor
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(DIRECTORY_ENTRY * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * DIRECTORY_ENTRY;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.payload.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.payload.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.payload)]);
}

// ---------------------------------------------------------------------------
// Preview sheet
// ---------------------------------------------------------------------------

function inlineSvg(absolutePath) {
  return fs.readFileSync(absolutePath, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '').trim();
}

function dataUri(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function sizeStrip(uris, sizes, label) {
  const cells = sizes.map((size) => `
        <figure><img src="${uris[size]}" width="${size}" height="${size}" alt="DEQR at ${size} pixels"><figcaption>${size}</figcaption></figure>`).join('');
  return `
      <div class="strip"><span class="strip-name">${label}</span>${cells}
      </div>`;
}

function buildPreview({ tile, ios, maskable, concepts }) {
  const conceptCards = concepts.map(({ id, title, svg }) => `
        <figure class="concept"><div class="concept-art">${svg}</div><figcaption><b>${id}</b> ${title}</figcaption></figure>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DEQR — Brand Sheet</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 28px clamp(16px, 4vw, 48px) 72px; background: #f5f5f7; color: #1d1d1f;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
  h1 { font-size: 1.55rem; letter-spacing: -0.02em; margin: 0 0 4px; }
  .lede { color: #6e6e73; margin: 0 0 28px; max-width: 62ch; }
  h2 { font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; color: #6e6e73;
       margin: 34px 0 12px; padding-bottom: 6px; border-bottom: 1px solid rgba(29,29,31,.13); }
  p.note { color: #6e6e73; font-size: .85rem; margin: -4px 0 12px; max-width: 74ch; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .panel { background: #fff; border: 1px solid rgba(29,29,31,.13); border-radius: 16px; padding: 18px; }
  .panel.dark { background: #101114; border-color: rgba(255,255,255,.14); color: #f5f5f7; }
  .panel.grey { background: #d7d9de; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 7px; }
  figcaption { font-size: .68rem; color: #6e6e73; }
  .panel.dark figcaption { color: #a7a7ad; }
  .strip { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;
           background: #fff; border: 1px solid rgba(29,29,31,.13); border-radius: 14px; padding: 12px 16px; margin-bottom: 10px; }
  .strip-name { font-size: .72rem; font-weight: 600; width: 118px; flex: none; }
  .strip.dark { background: #101114; border-color: rgba(255,255,255,.14); color: #f5f5f7; }
  .strip.dark figcaption { color: #a7a7ad; }
  img { display: block; image-rendering: auto; }
  .concepts { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 14px; }
  .concept { background: #fff; border: 1px solid rgba(29,29,31,.13); border-radius: 14px; padding: 14px; gap: 10px; }
  .concept-art svg { width: 128px; height: 128px; display: block; }
  .concept figcaption { text-align: center; }
  .selected { outline: 2px solid #0071e3; outline-offset: 3px; }
  .taskbar { display: flex; align-items: center; gap: 20px; background: #1f1f1f; border-radius: 10px;
             padding: 8px 18px; height: 48px; }
  .taskbar .slot { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 6px; }
  .taskbar .slot.active { background: rgba(255,255,255,.10); }
  .homescreen { display: flex; gap: 26px; background: linear-gradient(160deg, #2a3550, #101726 62%, #05070c);
                border-radius: 22px; padding: 24px 28px; }
  .homescreen figure { gap: 8px; }
  .homescreen figcaption { color: rgba(255,255,255,.72); font-size: .66rem; }
  .ios-icon { border-radius: 22.37%; display: block; }
  .app-label { color: #fff; font-size: .62rem; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
  .crop-circle { clip-path: circle(50% at 50% 50%); }
  .crop-squircle { border-radius: 24%; }
  .crop-rounded { border-radius: 12%; }
  .safe { position: relative; }
  .safe::after { content: ""; position: absolute; inset: 10%; border: 1px dashed rgba(255,90,90,.85); border-radius: 50%; }
  table { border-collapse: collapse; font-size: .82rem; background: #fff; border-radius: 12px; overflow: hidden;
          border: 1px solid rgba(29,29,31,.13); }
  th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid rgba(29,29,31,.09); }
  th { background: #fafafa; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #6e6e73; }
  tr:last-child td { border-bottom: 0; }
  code { font: .82em ui-monospace, "Cascadia Code", Consolas, monospace; background: rgba(29,29,31,.06); padding: 1px 5px; border-radius: 4px; }
  .swatch { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .chip { width: 92px; height: 56px; border-radius: 10px; border: 1px solid rgba(29,29,31,.13); }
  .swatch small { font: .68rem ui-monospace, Consolas, monospace; color: #6e6e73; }
  .lockup { max-width: 460px; width: 100%; height: auto; }
</style>
</head>
<body>
  <h1>DEQR — Brand Sheet</h1>
  <p class="lede">Generated by <code>npm run brand:generate</code> from the vector masters in <code>branding/source/</code>.
     Every image below is embedded in this file, so it renders with no network and no external assets.</p>

  <h2>Concept exploration</h2>
  <p class="note">Four directions were built and scored before one was refined. Concept 1 is the selected direction.</p>
  <div class="concepts">${conceptCards}</div>

  <h2>Master mark</h2>
  <div class="row">
    <div class="panel"><figure><img src="${tile[512]}" width="200" height="200" alt="DEQR tile on light"><figcaption>Primary tile — light surface</figcaption></figure></div>
    <div class="panel dark"><figure><img src="${tile[512]}" width="200" height="200" alt="DEQR tile on dark"><figcaption>Primary tile — dark surface</figcaption></figure></div>
    <div class="panel grey"><figure><img src="${tile[512]}" width="200" height="200" alt="DEQR tile on grey"><figcaption>Primary tile — light grey</figcaption></figure></div>
    <div class="panel"><figure><div style="width:200px">${inlineSvg(path.join(SOURCE, 'deqr-mark-mono.svg'))}</div><figcaption>Monochrome stencil</figcaption></figure></div>
  </div>

  <h2>Mark without container</h2>
  <div class="row">
    <div class="panel"><figure><div style="width:180px">${inlineSvg(path.join(SOURCE, 'deqr-mark-light.svg'))}</div><figcaption>Light-surface ramp</figcaption></figure></div>
    <div class="panel dark"><figure><div style="width:180px">${inlineSvg(path.join(SOURCE, 'deqr-mark.svg'))}</div><figcaption>Dark-surface ramp</figcaption></figure></div>
    <div class="panel" style="flex:1 1 360px"><figure style="align-items:flex-start;width:100%">
      <div class="lockup">${inlineSvg(path.join(SOURCE, 'deqr-lockup.svg'))}</div><figcaption>Horizontal lockup</figcaption></figure></div>
  </div>

  <h2>Palette</h2>
  <div class="row">
    <div class="swatch"><div class="chip" style="background:#0B1119"></div><small>#0B1119 ink</small></div>
    <div class="swatch"><div class="chip" style="background:linear-gradient(#131C29,#080D14)"></div><small>ground</small></div>
    <div class="swatch"><div class="chip" style="background:linear-gradient(#5AB2FF,#0A63DC)"></div><small>ring</small></div>
    <div class="swatch"><div class="chip" style="background:linear-gradient(#A6E1FF,#3D93F5)"></div><small>stage</small></div>
    <div class="swatch"><div class="chip" style="background:#F4FBFF"></div><small>#F4FBFF focus</small></div>
    <div class="swatch"><div class="chip" style="background:#0071E3"></div><small>#0071E3 product accent</small></div>
  </div>

  <h2>Size ladder — 16 to 1024</h2>
  <p class="note">Real rasters at their real pixel dimensions, not a scaled vector. Below 32&nbsp;px the stage and focus merge
     into one bright centre; that is the intended degradation, and the ring silhouette still carries the mark.</p>
${sizeStrip(tile, [16, 20, 24, 32, 48, 64], 'small · light')}
${sizeStrip(tile, [16, 20, 24, 32, 48, 64], 'small · dark').replace('class="strip"', 'class="strip dark"')}
${sizeStrip(tile, [128, 180, 192, 256], 'large')}
  <div class="strip"><span class="strip-name">512 / 1024</span>
    <figure><img src="${tile[512]}" width="256" height="256" alt="512 shown at 256"><figcaption>512 (shown 256)</figcaption></figure>
    <figure><img src="${tile[1024]}" width="256" height="256" alt="1024 shown at 256"><figcaption>1024 (shown 256)</figcaption></figure>
  </div>

  <h2>Windows taskbar and Alt+Tab</h2>
  <div class="row">
    <div class="panel dark">
      <div class="taskbar">
        <span class="slot active"><img src="${tile[24]}" width="24" height="24" alt="taskbar 24"></span>
        <span class="slot"><img src="${tile[32]}" width="32" height="32" alt="taskbar 32"></span>
        <span class="slot"><img src="${tile[48]}" width="40" height="40" alt="taskbar 48 scaled"></span>
      </div>
      <figcaption style="margin-top:10px">24 px · 32 px · 48 px on the shell's own dark strip</figcaption>
    </div>
    <div class="panel"><figure><img src="${tile[256]}" width="96" height="96" alt="Alt+Tab"><figcaption>Alt+Tab / large tile</figcaption></figure></div>
  </div>

  <h2>iOS Home Screen</h2>
  <p class="note">Drawn from <code>deqr-ios.svg</code>: opaque, square-cornered artwork with the mask applied by the platform,
     not baked into the file. Home Screen icons render near 60&nbsp;pt and 76&nbsp;pt.</p>
  <div class="homescreen">
    <figure><img class="ios-icon" src="${ios[180]}" width="60" height="60" alt="iOS 60pt"><span class="app-label">DEQR Receive</span><figcaption>60 pt</figcaption></figure>
    <figure><img class="ios-icon" src="${ios[180]}" width="76" height="76" alt="iOS 76pt"><span class="app-label">DEQR Receive</span><figcaption>76 pt</figcaption></figure>
    <figure><img class="ios-icon" src="${ios[180]}" width="120" height="120" alt="iOS large"><span class="app-label">DEQR Receive</span><figcaption>120 px</figcaption></figure>
    <figure><img src="${ios[180]}" width="120" height="120" alt="iOS unmasked"><figcaption>unmasked source</figcaption></figure>
  </div>

  <h2>PWA maskable safe zone</h2>
  <p class="note">The dashed circle is the 80% safe area every platform mask preserves. The mark is inset to 268 units
     across, so its corners sit at radius 189 against the 205 the circle allows.</p>
  <div class="row">
    <div class="panel"><figure><div class="safe"><img src="${maskable[512]}" width="150" height="150" alt="maskable with safe zone"></div><figcaption>safe zone</figcaption></figure></div>
    <div class="panel"><figure><img class="crop-circle" src="${maskable[512]}" width="150" height="150" alt="circle crop"><figcaption>circle mask</figcaption></figure></div>
    <div class="panel"><figure><img class="crop-squircle" src="${maskable[512]}" width="150" height="150" alt="squircle crop"><figcaption>squircle mask</figcaption></figure></div>
    <div class="panel"><figure><img class="crop-rounded" src="${maskable[512]}" width="150" height="150" alt="rounded square crop"><figcaption>rounded square</figcaption></figure></div>
    <div class="panel"><figure><img class="crop-circle" src="${tile[512]}" width="150" height="150" alt="any icon under a circle crop"><figcaption style="color:#b3261e">"any" icon circle-cropped — why it is not maskable</figcaption></figure></div>
  </div>

  <h2>Where each file goes</h2>
  <table>
    <tr><th>Master</th><th>Export</th><th>Consumer</th></tr>
    <tr><td><code>deqr-tile.svg</code></td><td><code>branding/export/desktop/icon.ico</code></td><td>electron-builder <code>win.icon</code> — exe, installer, portable, shortcuts</td></tr>
    <tr><td><code>deqr-tile.svg</code></td><td><code>branding/export/desktop/icon.png</code></td><td>BrowserWindow icon while unpackaged</td></tr>
    <tr><td><code>deqr-tile.svg</code></td><td><code>mobile-web/public/icons/deqr.svg</code></td><td>manifest vector entry</td></tr>
    <tr><td><code>deqr-tile-micro.svg</code></td><td><code>mobile-web/public/icons/deqr-chip.svg</code></td><td>SVG favicon, both application headers, receiver home mark</td></tr>
    <tr><td><code>deqr-tile.svg</code></td><td><code>mobile-web/public/icons/deqr-{64,192,512}.png</code></td><td>manifest <code>purpose: any</code></td></tr>
    <tr><td><code>deqr-tile-small.svg</code></td><td><code>mobile-web/public/icons/deqr-32.png</code>, the 32 ICO frame</td><td>favicon, taskbar at 100% DPI</td></tr>
    <tr><td><code>deqr-tile-micro.svg</code></td><td><code>mobile-web/public/icons/deqr-16.png</code>, the 16/24 ICO frames</td><td>tab favicon, Explorer small icons</td></tr>
    <tr><td>all three tiles</td><td><code>mobile-web/public/favicon.ico</code></td><td>browsers without SVG favicon support</td></tr>
    <tr><td><code>deqr-ios.svg</code></td><td><code>mobile-web/public/icons/apple-touch-icon-180.png</code></td><td>iPhone Home Screen</td></tr>
    <tr><td><code>deqr-maskable.svg</code></td><td><code>mobile-web/public/icons/deqr-maskable-512.png</code></td><td>manifest <code>purpose: maskable</code></td></tr>
  </table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

function write(relative, buffer) {
  const target = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`  ${relative.padEnd(52)} ${String(buffer.length).padStart(8)} B  (${kb} kB)`);
}

async function main() {
  console.log('DEQR brand assets — masters: branding/source/\n');

  console.log('PNG');
  for (const target of PNG_TARGETS) {
    const { png } = await rasterize(target.src, target.size);
    write(target.out, png);
  }

  console.log('\nSVG');
  for (const copy of SVG_COPIES) {
    write(copy.out, fs.readFileSync(path.join(SOURCE, copy.src)));
  }

  console.log('\nICO');
  for (const target of ICO_TARGETS) {
    const images = [];
    for (const size of target.sizes) {
      const { png, rgba } = await rasterize(tileFor(size), size);
      // 256 stays PNG-compressed: that is what Windows itself ships, and a raw
      // 256 DIB would add a quarter of a megabyte to every build.
      images.push({ size, payload: size >= 256 ? png : encodeDib(size, rgba) });
    }
    write(target.out, buildIco(images));
  }

  console.log('\nPreview');
  const collect = async (master, sizes) => {
    const uris = {};
    // `null` means "whichever master that size actually ships from", so the
    // sheet shows the real artifact rather than an idealised render.
    for (const size of sizes) uris[size] = dataUri((await rasterize(master ?? tileFor(size), size)).png);
    return uris;
  };
  const conceptDir = path.join(ROOT, 'branding', 'concepts');
  const concepts = fs.readdirSync(conceptDir)
    .filter((name) => name.endsWith('.svg'))
    .sort()
    .map((name) => {
      const svg = inlineSvg(path.join(conceptDir, name));
      const title = (svg.match(/<title>([^<]*)<\/title>/) ?? [, name])[1].replace(/^Concept \d+ — /, '');
      return { id: name.replace(/^concept-(\d+).*$/, '$1'), title, svg };
    });

  const preview = buildPreview({
    tile: await collect(null, PREVIEW_SIZES),
    ios: await collect('deqr-ios.svg', [180]),
    maskable: await collect('deqr-maskable.svg', [512]),
    concepts,
  });
  write('branding/deqr-logo-preview.html', Buffer.from(preview, 'utf8'));

  console.log('\nDone.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
