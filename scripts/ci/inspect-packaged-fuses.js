/**
 * Reads the Electron fuse wire directly out of a built executable.
 *
 * This deliberately inspects the artifact rather than package.json so the
 * recorded fuse states are independent evidence, not a restatement of the
 * electron-builder input configuration.
 */
const path = require('path');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const { FuseState } = require('@electron/fuses/dist/constants');

const REQUIRED = {
  RunAsNode: FuseState.DISABLE,
  EnableCookieEncryption: FuseState.ENABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
};

function stateName(value) {
  if (value === FuseState.ENABLE) return 'ENABLE';
  if (value === FuseState.DISABLE) return 'DISABLE';
  if (value === FuseState.INHERIT) return 'INHERIT';
  if (value === FuseState.REMOVED) return 'REMOVED';
  return `UNKNOWN(${String(value)})`;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/ci/inspect-packaged-fuses.js <path-to-electron-exe>');
    process.exit(2);
  }

  const resolved = path.resolve(target);
  const wire = await getCurrentFuseWire(resolved);

  console.log(`ARTIFACT ${resolved}`);
  console.log(`FUSE_WIRE_VERSION ${wire.version}`);

  const failures = [];
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index !== 'number') continue;
    const actual = wire[index];
    if (actual === undefined) continue;

    const expected = REQUIRED[name];
    const verdict =
      expected === undefined ? 'NOT_REQUIRED' : actual === expected ? 'PASS' : 'FAIL';
    if (verdict === 'FAIL') {
      failures.push(`${name}: expected ${stateName(expected)} got ${stateName(actual)}`);
    }
    console.log(`FUSE ${name} = ${stateName(actual)} [${verdict}]`);
  }

  if (failures.length > 0) {
    console.error(`FUSE_VERDICT FAIL (${failures.length})`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log('FUSE_VERDICT PASS');
}

main().catch((error) => {
  console.error('FUSE_INSPECTION_ERROR', error);
  process.exit(1);
});
