/**
 * Generates the deterministic, non-sensitive binary fixtures required by the
 * physical iPhone acceptance matrix (5 KiB - 1 MiB) and writes a manifest of
 * their exact sizes and SHA-256 digests.
 *
 * Bytes come from a seeded xorshift32 PRNG so every regeneration is identical
 * and no personal data is ever placed in the transfer path.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIB = 1024;
const SIZES = [
  ['5KiB', 5 * KIB],
  ['25KiB', 25 * KIB],
  ['100KiB', 100 * KIB],
  ['500KiB', 500 * KIB],
  ['1MiB', 1024 * KIB],
];

// Representative extensions the product is expected to carry. The protocol is
// binary-safe, so every fixture holds the same class of pseudo-random bytes and
// only the extension differs.
const EXTENSIONS = ['bin', 'txt', 'pdf', 'xlsx', 'docx', 'zip', 'log'];

function seededBytes(length, seed) {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function main() {
  const outputDir = path.resolve(__dirname, '..', '..', '.local-run', 'acceptance-fixtures');
  fs.mkdirSync(outputDir, { recursive: true });

  const manifest = [];

  SIZES.forEach(([label, size], index) => {
    const bytes = seededBytes(size, 0x44455152 + index * 0x01000193);
    const name = `deqr-fixture-${label}.bin`;
    fs.writeFileSync(path.join(outputDir, name), bytes);
    manifest.push({ file: name, label, bytes: size, sha256: sha256(bytes) });
  });

  // One fixed-size fixture per representative extension for binary-safety checks.
  EXTENSIONS.forEach((extension, index) => {
    const size = 25 * KIB;
    const bytes = seededBytes(size, 0x5145524d + index * 0x01000193);
    const name = `deqr-fixture-ext-25KiB.${extension}`;
    fs.writeFileSync(path.join(outputDir, name), bytes);
    manifest.push({ file: name, label: `25KiB.${extension}`, bytes: size, sha256: sha256(bytes) });
  });

  const manifestPath = path.join(outputDir, 'MANIFEST.txt');
  const lines = manifest.map((e) => `${e.file}\t${e.bytes}\t${e.sha256}`);
  fs.writeFileSync(manifestPath, `file\tbytes\tsha256\n${lines.join('\n')}\n`);

  console.log(`FIXTURE_DIR ${outputDir}`);
  for (const entry of manifest) {
    console.log(`${entry.file.padEnd(34)} ${String(entry.bytes).padStart(8)}  ${entry.sha256}`);
  }
  console.log(`MANIFEST ${manifestPath}`);
}

main();
