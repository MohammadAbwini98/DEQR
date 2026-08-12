# First physical iPhone optical attempt — 2026-08-08

## Observed result

The supplied iPhone evidence shows the receiver camera active while aimed at the
desktop animated QR display. The receiver reported **166 / 166** unique blocks,
**0** duplicates, and **100%** progress, then rejected the reconstructed bytes:

```text
INVALID_METADATA: magic is not valid UTF-8
```

The desktop display visible in the same evidence reported 166 source blocks,
30 FPS, and 1,994 generated frames at approximately 66.1 seconds.

## Assessment

Physical camera operation, raw QR decoding, frame parsing, and full systematic
block collection were observed. End-to-end transfer acceptance did **not** pass:
container validation, SHA-256 verification, and saved-file byte comparison were
not reached.

## Root cause and correction

Source inspection found that `src/main/session-manager.ts` read a selected file
and supplied the raw bytes directly to `FountainEncoder`. The protocol requires
the fountain payload to be a complete DEQR v1 container beginning with `DEQR`.
The iPhone error is consistent with receiving ordinary file bytes where the
container parser expects metadata.

The active iOS worktree now serializes the container before session storage and
fountain encoding. `tests/main/session-manager.test.ts` deserializes the queued
payload and checks its filename, original size, source bytes, and SHA-256.

## Gate status

**FAIL / RETEST REQUIRED.** This evidence does not establish physical desktop to
iPhone interoperability. Re-run the same transfer using the corrected sender
from `D:\Projects\DEQR-ios2`, then verify completion, hash, and byte-for-byte
saved output.
