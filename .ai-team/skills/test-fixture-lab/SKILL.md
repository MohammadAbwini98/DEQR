---
name: test-fixture-lab
description: Generate deterministic test vector binary files, corrupted frame streams, and optical transfer fixtures.
roles:
  - quality-assurance-engineer
access: workspace-write
tools:
  - file-read
  - file-create
---

# Skill: Test Fixture Lab

## When to Use
Use when creating test data files (PDF, TXT, XLSX, ZIP, EXE) or golden protocol test vectors for optical transfer verification.

## When NOT to Use
Do not use to generate production file payloads.

## Required Reading
- `init.md` (Decimen test vector specs)
- `.ai-team/engineering/TESTING.md`

## Preconditions
Test scenario requirements defined.

## Procedure
1. Create deterministic binary test files with known SHA-256 hashes across target extensions (TXT, PDF, DOCX, XLSX, ZIP, RAR, MSG, SQL, LOG, EXE).
2. Generate synthetic Luby transform fountain block streams with dropped, out-of-order, or blurred frames.
3. Store fixtures in `tests/fixtures/`.
4. Validate fixture file integrity using SHA-256 calculators.

## Evidence Requirements
Fixture manifest and SHA-256 checksum list.

## Safety Constraints
Do not place malware or real sensitive user files in test fixtures. Use synthetic test patterns.

## Project-Memory Updates
Log fixtures in `tests/fixtures/README.md`.

## Definition of Done
Test fixtures generated, checksums verified, saved to `tests/fixtures/`.

## Fallback Behavior
Create synthetic text-based test files using standard file creation tools.
