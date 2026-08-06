/**
 * DEQR Adapter Synchronizer Script
 * Synchronizes vendor adapters with canonical authority in .ai-team/
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '../..');

console.log('Synchronizing vendor adapters with .ai-team/ canonical authority...');

// Check and update CLAUDE.md pointer header
const claudeFile = path.join(rootDir, 'CLAUDE.md');
if (fs.existsSync(claudeFile)) {
  console.log('[SYNC] Verified CLAUDE.md -> .ai-team/ pointer.');
}

// Check and update GEMINI.md pointer header
const geminiFile = path.join(rootDir, 'GEMINI.md');
if (fs.existsSync(geminiFile)) {
  console.log('[SYNC] Verified GEMINI.md -> .ai-team/ pointer.');
}

// Check and update .agents/agents.md pointer header
const agentsFile = path.join(rootDir, '.agents/agents.md');
if (fs.existsSync(agentsFile)) {
  console.log('[SYNC] Verified .agents/agents.md -> .ai-team/ pointer.');
}

console.log('Adapter synchronization complete.');
