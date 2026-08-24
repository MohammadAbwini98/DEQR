# PHASE 13 — Physical iOS Transfer & Throughput Remediation

**Date**: 2026-08-24
**Verdict**: **NOT ACCEPTED — PHYSICAL IOS TRANSFER GATE PENDING.**
The structural defects are fixed and demonstrated. No physical device was
available, so no physical gate has been executed and none may be inferred.

Companion documents:
[IOS-PHYSICAL-TRANSFER-ROOT-CAUSE.md](./IOS-PHYSICAL-TRANSFER-ROOT-CAUSE.md) ·
[IOS-TRANSFER-TELEMETRY.md](./IOS-TRANSFER-TELEMETRY.md) ·
[IOS-TRANSFER-PHYSICAL-MATRIX.md](./IOS-TRANSFER-PHYSICAL-MATRIX.md)

---

## 1. Confirmed root causes

Four, established from the shipping code and each demonstrated by a test that
fails on the previous code. Full detail in the root-cause document.

| # | Cause |
|---|---|
| **C1** | **The sender stopped permanently.** `take()` returned `null` once the budgeted repair was spent and never resumed. A receiver short by one symbol had no possible source for it. |
| **C2** | **The receiver had no state for that.** `RECEIVING` could only be left by completion, failure, backgrounding or cancel. The sole stall detector watched the *video element*, which was healthy throughout. |
| **C3** | **Repair-only recovery is impossible.** The decoder holds at most `k` pending equations and then rejects everything; a segment with no source symbols can never be rebuilt from repair. Measured at 1.5×, 2.5× and 4× overhead. This invalidated the first version of the fix for C1. |
| **C4** | **A failed export wedged the receiver.** `EXPORTING` did not accept the event its own failure path dispatched, so the retry was silently dropped and the only exit discarded the verified file. |

**Contributing:** the optical symbol was clipped by the desktop window (fixed
separately as `65ced2b`, recorded as contributing and *not* as the root cause);
and the action dock let content show through it.

C1 and C2 together are sufficient to produce the exact reported symptom.

---

## 2. Files changed

18 files, +2,143 / −32, all uncommitted as one Phase 13 set.

**Behaviour**

| File | Change |
|---|---|
| `mobile-web/src/receiver-state.ts` | `INCOMPLETE` + `RECOVERING` states, `STALLED` event, transitions, camera/session/cancel derivations; `EXPORTING` accepts `VERIFIED` |
| `mobile-web/src/receive-pipeline.ts` | unique-frame stamp, injectable clock, refusal tally, systematic/repair split, targeted resume minting |
| `mobile-web/src/worker-protocol.ts` | protocol 5 → 6: `lastUniqueFrameAtMs`, `framesSystematic`, `framesRepair`, `rejectionsByReason` |
| `mobile-web/src/receiver-view-model.ts` | `transferHasStalled`, `usefulThroughput`, `mayOfferResume` widened |
| `mobile-web/src/App.tsx` | stall watcher, finer unique-frame dispatch, status copy and panels for the new states |
| `mobile-web/src/styles.css` | opaque action dock, `scroll-padding-bottom`, redundant override removed |
| `src/main/streaming-sender.ts` | `beginRecovery`, systematic-first batched recovery tail, recovery counters, resume targets |
| `src/core/resume-token.ts` | v2 targeted token, run-length gaps, `resumeTokenTargets` |
| `src/core/receiver-policy.ts` | `stallAfterSilentMs` |

**Tests** — 9 files: state machine, view model, pipeline, resume, camera
backpressure, accessibility contract, UX contract, resume token, FEC end-to-end.

---

## 3. Architecture and state-machine changes

```
RECEIVING ──STALLED──▶ INCOMPLETE ──FRAME_ACCEPTED──▶ RECOVERING
     │                      │                              │
     └──────SESSION_COMPLETE┴──────────────────────────────┘
                            ▼
                        VERIFYING ──VERIFIED──▶ COMPLETE ⇄ EXPORTING
```

- `INCOMPLETE` and `RECOVERING` are **absent from `SESSION_CLEARING_STATES`** and
  do not bump the epoch. That absence *is* the "preserve partial state"
  mechanism — membership would discard segments already on disk.
- The camera stays on in both, deliberately: the act that ends a stall happens on
  the *sending* device and there is no back channel to announce it.
- **Only `VERIFIED` can reach `COMPLETE`**, asserted across every state and
  transition. That is what structurally prevents a sender running out of frames
  from ever meaning "the file arrived".
- The sender gained a `pass` / `recovery` phase distinction. "Stream complete /
  Every frame has been displayed" is unchanged, as instructed — it was already
  correct.

---

## 4. Tests and results

| Suite | Before Phase 13 | After |
|---|---|---|
| Desktop | 862 / 51 files | **885 / 52 files** |
| PWA | 385 / 28 files | **415 / 28 files** |

**+53 tests.** Typechecks, both production builds, doctor and drift all pass.

Tests that fail on the pre-Phase-13 code:

- a stalled transfer leaves `RECEIVING` and reaches `INCOMPLETE`
- partial state and epoch survive a stall; backgrounding still clears
- recovery resumes on a single unique frame and completes hash-identically
- **"completes a transfer the initial pass could not, and the bytes match"**
- a segment whose every source symbol was lost — recovered only by the tail
- a 400-frame burst
- acquisition on a later manifest, having missed the start
- the final frame never arriving
- targeted resume: `[...touched]` is exactly the missing segments
- a failed export returns to `COMPLETE` and the retry starts again

---

## 5. Throughput

**No before/after throughput number is reported, and none may be.** The
programme's rule is that a performance claim requires measurement, and every
measurement available here is modelled rather than optical. Phase 11's modelled
figures (Balanced 4,631 verified B/s) are unchanged by this phase — nothing in
the wire format, the FEC or the QR profiles was altered.

What changed is the *ability* to measure: `usefulThroughput()` reports verified
original bytes per second from bytes actually committed to storage, which is the
unit §5 of the physical matrix ranks profiles by.

One structural cost is worth stating plainly. **The recovery tail replays a full
segment per targeted segment.** Without a back channel the sender cannot know
*which symbols* are missing, only which segments — which is precisely why the
targeted resume token matters: it reduces the set of segments, and on a large
file that is the difference between minutes and hours.

---

## 6. Physical gates

**All PENDING. None executed. No PASS inferred from any automated result.**

| Tier | 1 MiB | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1 GiB |
|---|---|---|---|---|---|---|---|---|---|
| Status | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |

Twelve provoked behaviours (P1–P12) are also PENDING. Procedure, fixtures,
measurement table and failure-capture steps are in the physical matrix.

**The certified maximum transfer size remains 0 bytes.**

---

## 7. Remaining risks

1. **Nothing here has met a camera.** Four causes were found by reading code and
   proven against harnesses. A harness cannot reproduce focus, glare, rolling
   shutter or a hand moving.
2. **H1 — guide/ROI disagreement on a landscape stream** (~64.5% vs 86% of the
   shorter video edge). Safe in direction, costs pixels per module. Not changed
   blind; the telemetry measures it.
3. **The default profile is still uncertified**, unchanged from Phase 11.
4. **The 12 s stall threshold is a judgement, not a measurement.** Too short
   reports a stall on a transfer about to recover; too long reproduces the
   defect. Confirm against a real camera's reacquisition time.
5. **Worker protocol 5 → 6.** A device with a cached older shell will mismatch.
   §0 of the matrix makes checking it the first step.
6. **Recovery cost scales with segment size**, per §5.

---

## 8. May Phase 11 and Phase 12 be rerun?

**Phase 11 — yes, and it should be.** Nothing in the wire format, FEC or
profiles changed, so its modelled ladder stands. Its *physical* matrix was never
executed and is now superseded in practice by this phase's, which tests the
recovery paths Phase 11 had no way to exercise.

**Phase 12 — not yet.** Rerunning its release gates is only meaningful against a
build whose physical gate has been executed at least once. The right order is:

1. Commit Phase 13 and build a recorded artifact (`npm run release`).
2. Run the physical matrix from tier A upward on that artifact.
3. Only then re-run Phase 12's gates, with real rows behind them.

Phase 12's prior verdict is superseded and stays superseded. **DEQR is NOT
ACCEPTED**, and the blocking reason is unchanged in kind but now much better
understood: the product has never completed a transfer to a physical iPhone, and
until this phase it structurally could not have recovered if it nearly did.
