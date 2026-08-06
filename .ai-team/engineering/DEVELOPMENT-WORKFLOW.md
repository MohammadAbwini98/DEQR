# DEQR Development Workflow & Version Control Policy

## Git Strategy
- **Default Branch**: `main`
- **Feature Branches**: `feat/<short-description>` or `fix/<short-description>` created when working on bounded assignments.
- **Commit Message Standard**: Conventional Commits (`feat: add AES encryption option`, `fix: handle frame sequence overflow`).

## Quality Gates for Integration
1. Feature branch passes local `npm run build`.
2. Unit and protocol test suites pass 100%.
3. Security review confirms no secret leaks or sandbox regressions.
4. AI Doctor validator (`node scripts/ai/doctor.js`) passes cleanly.
5. Project Manager reconciles specialist deliverables and merges commit.
