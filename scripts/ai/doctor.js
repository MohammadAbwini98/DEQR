/**
 * DEQR AI Architecture Doctor & System Validator
 * Verifies system file completeness, role contracts, skill libraries,
 * vendor adapters, path safety, and zero secret leaks.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '../..');
let errors = 0;
let warnings = 0;

function logInfo(msg) {
  console.log(`[INFO] ${msg}`);
}

function logError(msg) {
  console.error(`[ERROR] ${msg}`);
  errors++;
}

function logWarning(msg) {
  console.warn(`[WARN] ${msg}`);
  warnings++;
}

function assertFileExists(relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    logError(`Missing required canonical file: ${relativePath}`);
    return false;
  }
  const stat = fs.statSync(fullPath);
  if (stat.size === 0) {
    logError(`File is empty: ${relativePath}`);
    return false;
  }
  return true;
}

console.log('====================================================');
console.log('   DEQR AI Multi-Agent Architecture Doctor       ');
console.log('====================================================');

// 1. Verify Core Canonical Files
const canonicalFiles = [
  '.ai-team/README.md',
  '.ai-team/TEAM-CHARTER.md',
  '.ai-team/ORCHESTRATION.md',
  '.ai-team/CAPABILITY-MATRIX.md',
  '.ai-team/project-control/PROJECT-BRIEF.md',
  '.ai-team/project-control/CURRENT-STATE.md',
  '.ai-team/project-control/BACKLOG.md',
  '.ai-team/project-control/HANDOFF.md',
  '.ai-team/project-control/TASK-LOG.md',
  '.ai-team/project-control/DECISIONS.md',
  '.ai-team/project-control/RISKS.md',
  '.ai-team/project-control/KNOWN-ISSUES.md',
  '.ai-team/project-control/RELEASE-STATUS.md',
  '.ai-team/project-control/ASSIGNMENTS.json',
  '.ai-team/engineering/ARCHITECTURE.md',
  '.ai-team/engineering/FEATURES.md',
  '.ai-team/engineering/RULES.md',
  '.ai-team/engineering/COMMANDS.md',
  '.ai-team/engineering/TESTING.md',
  '.ai-team/engineering/SECURITY.md',
  '.ai-team/engineering/DATABASE.md',
  '.ai-team/engineering/UI-UX.md',
  '.ai-team/engineering/BRANDING.md',
  '.ai-team/engineering/DEVELOPMENT-WORKFLOW.md',
  '.ai-team/tools/TOOL-REGISTRY.yaml',
  '.ai-team/tools/TOOL-POLICY.md',
  '.ai-team/tools/FALLBACKS.md',
  '.ai-team/mcp/MCP-REGISTRY.yaml',
  '.ai-team/mcp/MCP-POLICY.md',
  '.ai-team/mcp/mcp.example.json',
  '.ai-team/mcp/INSTALLATION.md',
  '.ai-team/permissions/ROLE-CAPABILITIES.yaml',
  '.ai-team/permissions/FILE-OWNERSHIP.md',
  '.ai-team/permissions/APPROVAL-GATES.md',
  'AGENTS.md'
];

logInfo('Verifying canonical baseline files...');
canonicalFiles.forEach(f => assertFileExists(f));

// 2. Verify 9 Specialist Roles
const roles = [
  'project-manager.md',
  'system-architect.md',
  'cybersecurity-engineer.md',
  'quality-assurance-engineer.md',
  'frontend-engineer.md',
  'backend-engineer.md',
  'database-administrator.md',
  'ui-ux-designer.md',
  'branding-designer.md'
];

logInfo('Verifying 9 role contracts...');
roles.forEach(roleFile => {
  assertFileExists(`.ai-team/roles/${roleFile}`);
});

// 3. Verify 22 Skills
const skills = [
  'project-intake',
  'project-planning',
  'multi-agent-orchestration',
  'agent-handoff',
  'agent-takeoff',
  'ai-memory-maintainer',
  'codebase-review',
  'architecture-review',
  'threat-model',
  'security-review',
  'feature-implementation',
  'bug-fix',
  'refactor-safe',
  'frontend-ui-ux',
  'branding-system',
  'database-change',
  'test-and-verify',
  'pr-review',
  'docs-sync',
  'git-full-cycle',
  'release-gate',
  'test-fixture-lab'
];

logInfo('Verifying 22 skill libraries...');
skills.forEach(skillDir => {
  assertFileExists(`.ai-team/skills/${skillDir}/SKILL.md`);
});

// 4. Verify 8 Workflows
const workflows = [
  'PROJECT-CYCLE.md',
  'FEATURE.md',
  'BUG-FIX.md',
  'SECURITY-REVIEW.md',
  'ARCHITECTURE-REVIEW.md',
  'RELEASE-GATE.md',
  'HANDOFF.md',
  'TAKEOFF.md'
];

logInfo('Verifying 8 operational lifecycle workflows...');
workflows.forEach(wf => {
  assertFileExists(`.ai-team/workflows/${wf}`);
});

// 5. Verify Vendor Adapters
logInfo('Verifying vendor adapters...');
assertFileExists('CLAUDE.md');
assertFileExists('.claude/settings.example.json');
assertFileExists('.codex/config.example.toml');
assertFileExists('GEMINI.md');
assertFileExists('.agents/agents.md');
assertFileExists('.cursor/rules/01-shared-project-rules.mdc');

// 6. Inspect root AGENTS.md Pointers
logInfo('Checking authority pointers in AGENTS.md...');
const agentsContent = fs.readFileSync(path.join(rootDir, 'AGENTS.md'), 'utf8');
if (!agentsContent.includes('.ai-team/')) {
  logError('AGENTS.md does not reference canonical authority .ai-team/');
}

// 7. Check for Machine-Specific Absolute Paths or Secrets
logInfo('Scanning for machine-specific paths or hardcoded secrets...');
function scanFileForBadPatterns(relPath) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  if (content.match(/C:\\Users\\[a-zA-Z0-9_\-]+\\(?!AppData)/i)) {
    logWarning(`Possible absolute user path found in ${relPath}`);
  }
  if (content.match(/([a-zA-Z0-9_-]*key[a-zA-Z0-9_-]*\s*=\s*['"][a-zA-Z0-9_\-=]{16,}['"])/i)) {
    logError(`Possible secret pattern detected in ${relPath}`);
  }
}

canonicalFiles.forEach(scanFileForBadPatterns);

console.log('----------------------------------------------------');
if (errors === 0) {
  console.log(`DOCTOR RESULT: PASSED (${warnings} warnings)`);
  process.exit(0);
} else {
  console.log(`DOCTOR RESULT: FAILED (${errors} errors, ${warnings} warnings)`);
  process.exit(1);
}
