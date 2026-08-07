const fs = require('fs');
const path = require('path');
const asar = require('asar');

async function verify() {
  try {
    const asarPath = path.join(__dirname, '../../release/win-unpacked/resources/app.asar');
    if (!fs.existsSync(asarPath)) {
      throw new Error(`ASAR not found at ${asarPath}`);
    }

    const files = asar.listPackage(asarPath);
    
    const requiredFiles = [
      'dist/main/index.js',
      'dist/preload/index.js',
      'dist/renderer/index.html'
    ];

    for (const f of requiredFiles) {
      if (!files.includes(f)) {
        throw new Error(`Required file ${f} not found in ASAR`);
      }
    }

    const htmlContent = asar.extractFile(asarPath, 'dist/renderer/index.html').toString('utf8');
    
    // Check asset paths are relative
    if (htmlContent.includes('="/assets/')) {
      throw new Error('index.html contains absolute /assets/ paths instead of relative ./assets/');
    }

    if (!htmlContent.includes('id="root"')) {
      throw new Error('index.html does not contain root div');
    }

    // Check main entry in package.json
    const packageJsonStr = asar.extractFile(asarPath, 'package.json').toString('utf8');
    const pkg = JSON.parse(packageJsonStr);
    if (pkg.main !== 'dist/main/index.js') {
      throw new Error(`Invalid package.json main entry: ${pkg.main}`);
    }

    console.log('PASS: Packaged renderer verification');
    process.exit(0);
  } catch (err) {
    console.error('FAIL: Packaged renderer verification', err);
    process.exit(1);
  }
}

verify();
