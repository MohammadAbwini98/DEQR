/**
 * DEQR Adapter Drift Checker
 * Verifies that vendor adapters have not drifted from canonical .ai-team/ authority.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '../..');
let driftFound = false;

console.log('Checking vendor adapters for documentation drift...');

const requiredPointers = [
  { file: 'CLAUDE.md', expected: '.ai-team/' },
  { file: 'GEMINI.md', expected: '.ai-team/' },
  { file: '.agents/agents.md', expected: '.ai-team/' }
];

requiredPointers.forEach(item => {
  const filePath = path.join(rootDir, item.file);
  if (!fs.existsSync(filePath)) {
    console.error(`[DRIFT ERROR] Missing adapter file: ${item.file}`);
    driftFound = true;
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(item.expected)) {
    console.error(`[DRIFT ERROR] Adapter ${item.file} does not contain pointer to ${item.expected}`);
    driftFound = true;
  }
});

if (driftFound) {
  console.error('DRIFT CHECK FAILED: Vendor adapters are out of sync.');
  process.exit(1);
} else {
  console.log('DRIFT CHECK PASSED: Zero vendor adapter drift detected.');
  process.exit(0);
}
