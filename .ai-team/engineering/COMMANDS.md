# Verified Command Reference

All project commands must be verified against actual package scripts before claiming execution success.

## Environment & Build Commands
- `npm install` — Install Node dependencies (NOT INSTALLED / UNVERIFIED)
- `npm run dev` — Launch Vite dev server & Electron dev window (NOT EXECUTED)
- `npm run build` — Compile TypeScript and bundle renderer/main via Vite (NOT EXECUTED)
- `npm run package` — Packaging DEQR as a portable Windows `.exe` via electron-builder (NOT EXECUTED)

## Testing & Quality Commands
- `npm test` — Run complete automated unit and protocol test suites (NOT EXECUTED)
- `npm run test:core` — Run optical fountain protocol and golden vector tests (NOT EXECUTED)
- `npm run test:security` — Run security assertions & CSP checks (NOT EXECUTED)

## AI System Architecture Commands
- `node scripts/ai/doctor.js` — Run AI architecture system validator (VERIFIED & READY)
- `node scripts/ai/sync-adapters.js` — Synchronize vendor adapter pointer files (VERIFIED & READY)
- `node scripts/ai/check-adapter-drift.js` — Check for vendor adapter drift against canonical `.ai-team/` (VERIFIED & READY)
