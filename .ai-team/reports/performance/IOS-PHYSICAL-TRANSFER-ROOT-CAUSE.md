# iOS Physical Transfer Failure — Root Cause

**Symptom reported.** The Electron sender displayed every scheduled QR frame and
reached its end-of-pass screen. The iOS receiver stayed in `Receiving transfer`
with the camera active. No file was delivered or exported.

**Method.** No physical device was available, so nothing here was reproduced on
a phone. Every confirmed cause below was established by reading the shipping
code and demonstrating the behaviour with a test that fails on the old code and
passes on the new. Everything that could not be established that way is listed
as a hypothesis with the measurement that would settle it.

---

## Confirmed causes

### C1 — The sender stopped permanently, by construction

`StreamingTransferSession.take()` returned `null` once the pass was finished,
and `done` was never cleared. When every segment's source symbols and its
budgeted repair had been emitted, the sender was finished for the life of the
session.

A receiver short by even one symbol therefore had **no possible source for it**.
The transfer was unrecoverable at the moment the pass ended, whatever the
receiver did next.

*Evidence:* `src/main/streaming-sender.ts` — `if (this.done) return null` with
`done` set in `advanceToPendingSymbol` and never reset.

### C2 — The receiver had no state meaning "the frames stopped"

`RECEIVING` was entered on the first accepted frame and could be left only by
`SESSION_COMPLETE`, `SESSION_FAILED`, `CAMERA_FAILED`, `WORKER_FATAL`,
`BACKGROUNDED`, `CANCELLED` or `RESET`. None of those describes a sender that
simply ran out.

So the receiver sat in `RECEIVING` with a live camera indefinitely. **A receiver
that cannot say "incomplete" can only say "receiving" forever.**

The only stall detection in the codebase watched the *video element*
(`camera.ts`), which during the failure was healthy — presenting frames at full
rate, pointed at a desktop that had stopped transmitting. Every component
reported itself working.

*Evidence:* `mobile-web/src/receiver-state.ts` transition table, before Phase 13.

### C3 — Repair-only recovery is impossible, so a naive fix would not have worked

Found while building the fix for C1, and it changed the design.

`SegmentDecoder` holds at most `maxPendingEquations = sourceSymbolCount` pending
equations. A repair symbol that cannot yet be reduced is stored; once `k` are
stored, every further one is rejected as saturated. With **no** source symbols
known, arriving repair symbols fill that budget with algebra that can never be
reduced, and the decoder then refuses everything after it.

Measured: a segment whose every source symbol was lost did not recover at 1.5×,
2.5× or 4× repair overhead — 512 repair symbols for a 128-symbol segment.

The first recovery tail emitted only repair symbols. It would have transmitted
indefinitely and completed nothing whenever a burst took a whole segment, which
is exactly what a hand moving in front of a camera produces. The shipped tail is
**systematic-first**: it replays the segment's source symbols before generating
fresh repair.

The bound itself is correct and stays — it is what makes the existing
*"saturates rather than grows under a flood"* hostile test pass. What was
missing was anyone having written down its consequence.

### C4 — A failed export wedged the receiver, with the retry unreachable

`EXPORTING` accepted only `EXPORT_SETTLED` and `RESET`. The screen's failure path
dispatches `VERIFIED` and tells the user *"the verified file remains available
until you reset"* — but that event was not in the table, so the machine silently
ignored it and stayed in `EXPORTING`, which offers neither cancel nor save. The
message was true and the state was stuck; the only way out was the reset that
discards the file the message had just promised.

Not a cause of the reported symptom, but a release-blocking defect on the same
path, found by walking the finalization sequence the plan asks to prove.

---

## Contributing causes

### B1 — The optical symbol was clipped by the desktop window

The transfer screen asked for a fixed 480 CSS px of QR regardless of window
size, and nothing in the layout bounded height. On a 1125×796 client area,
**132 px of the transfer view sat below the fold** with the symbol partly out of
view. A clipped QR does not decode at all: the missing modules are absent rather
than faint, and jsQR cannot locate the third finder pattern or the bottom quiet
zone.

Fixed before Phase 13 began, committed separately as `65ced2b`, and recorded
here as a **potential contributing cause, not the confirmed root cause.**

Two facts keep it from being the whole explanation: the phone reached
`RECEIVING`, which requires at least one *completed segment*, so the optical
link demonstrably worked for a while; and the window could be scrolled, so the
symbol may have been fully visible for part of the run.

### B2 — The action dock let content show through it

`rgba(244, 247, 251, .92)` with no `backdrop-filter` anywhere in the stylesheet.
Content scrolling beneath the sticky dock was visible through it at 8%. The
opaque rule existed only under `prefers-reduced-transparency`, which iOS Safari
does not implement, so on the target device it could never apply.

Cosmetic rather than causal, but it degrades exactly the screens a failing
transfer depends on — the ones showing a progress figure or a resume code.

---

## Hypotheses — not established, with the measurement that would settle each

### H1 — The decode ROI is larger than the visible guide on a landscape stream

`.camera-frame` is 3:4 with `object-fit: cover`. The guide is 86% of the
container **width**; the decoder crops 86% of the shorter **video** edge. On a
portrait stream these coincide. On a landscape stream (1280×720) the video's
shorter edge maps to the container *height*, so the guide covers roughly 64.5%
of what the decoder actually reads.

The direction is safe — the decoder sees more than the guide shows, so nothing
aimed inside the guide is missed — but it spreads the decode budget over a
larger region than the user is aiming into, costing pixels per module.

*Settled by:* comparing `pxPerModule` and `symbolSpanPx` from scan details
against the profile's requirement, on a real device, in both orientations.

### H2 — The default profile is wrong for this camera

Unchanged from Phase 11 and still open. Which profile should be the default
depends on camera pixels per module at a realistic scanning distance, which no
one has measured.

*Settled by:* the primary ladder at tier B across profiles, ranked by verified
original bytes per second.

### H3 — Frame loss was high enough that the pass could never have finished

If the link was losing more than roughly 20% of frames, Phase 11's cliff
equation `(1 + r)(1 − p) ≥ 1.05` says the budgeted repair could not close the
gap, and C1 then made the shortfall permanent. This is consistent with the
symptom but was never measured.

*Settled by:* the refusal-by-reason counters added in this phase, which
distinguish optical loss from protocol refusal, plus the systematic/repair
accepted ratio.

---

## Why the failure was invisible to the existing test suite

Worth stating, because the suite was large and passing throughout.

- **Loss was modelled as independent per-frame** — the average case. A burst
  takes a whole segment's symbols together, which is the case the coding cannot
  recover from.
- **Every end-to-end test ran one pass and asserted the outcome.** No test asked
  what happens *after* a pass that fell short, because nothing happened after it.
- **The receiver's hang had no observable symptom in a test**: the machine was in
  a legal state, the camera was healthy, and no error was raised. There was
  nothing to assert against except the passage of time.

The three tests added for these cases fail on the pre-Phase-13 code.
