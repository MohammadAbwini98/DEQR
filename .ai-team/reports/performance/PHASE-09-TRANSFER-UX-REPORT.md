# PHASE-09 — Large-Transfer UX, State Flow, and Design Rules

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 09 (sender and receiver transfer UX; one authoritative state model; no protocol math changed)
**Date**: 2026-08-22
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Six deviations are stated in §9. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**The desktop sender was still driving DEQR v1.** Every part of the streaming architecture built in Phases 02 through 08 — segmented reads off disk, pulled frames, transport profiles, content-based compression, resume tokens — sat behind an IPC surface the renderer never called. The shipping send flow was a main-process `setInterval` pushing fountain frames for a container that had to fit under 32 MiB, and the screen said so.

That is the single largest change here. `src/renderer/App.tsx` now drives `streamTransfer`, and the ceiling message is gone because the ceiling is gone.

Three claims the two UIs could previously make, and can no longer:

| Old claim | Why it was wrong | What replaced it |
|---|---|---|
| "the serialized optical container must be below 32 MiB" | True of the v1 in-memory container; false since Phase 02 streams segments and Phase 06 writes them straight to device storage | A statement of what actually bounds a transfer — time, and room on the receiving device — with both figures shown for the real file |
| A sender success screen indistinguishable from a verified receive | The sender never sees the reconstructed file and cannot know whether it arrived | `STREAM_COMPLETE`, mapped to the `COMPLETED` phase, with `VERIFIED` structurally unreachable from the sender |
| "Reception was interrupted and the transfer was cleared" | Phase 07 made `INTERRUPTED` the one ending that *keeps* its bytes | A card naming what was kept, the resume code to continue from it, and a control to erase it |

And one fact that had nowhere to live: **the receiver computed a storage preflight, refused transfers with `INSUFFICIENT_STORAGE`, and threw the numbers away before any screen saw them.** A user could be told there was not enough room without being told how much room was wanted.

---

## 2. What was built

| Component | File | What it is |
|---|---|---|
| Shared phase vocabulary | `src/shared/transfer-ui-state.ts` | The one lifecycle both surfaces describe a transfer in, plus the predicate that decides who may claim integrity |
| Sender state machine | `src/renderer/sender-state.ts` | Ten states, transition table as data, every UI question derived rather than stored |
| Receiver phase mapping | `mobile-web/src/receiver-state.ts` | Phase 05's states, unchanged, mapped onto the shared vocabulary |
| Sender derivations | `src/renderer/sender-model.ts` | 64-bit byte formatting, measured rate, and a stability-gated ETA |
| Receiver derivations | `mobile-web/src/receiver-view-model.ts` | Transfer summary, storage summary, verification view, interruption summary, fault copy |
| Preflight card | `src/renderer/components/SenderPreflightCard.tsx` | File, both sizes, compression decision, profile selector |
| Streaming transfer view | `src/renderer/components/StreamTransferView.tsx` | Pulled frames, one dominant status, collapsible diagnostics |
| Resume code entry | `src/renderer/components/ResumeTokenEntry.tsx` | The desktop half Phase 07 left open |
| QR surface | `src/renderer/components/QRCanvas.tsx` | Reduced to the presentational canvas, so the "never animate the symbol" rules have one owner |
| Storage reporting | `mobile-web/src/receiver-storage.ts` | `estimateDeviceStorage`, `discardRetainedSessions` |
| Profile selection | `src/main/streaming-session-registry.ts`, `ipc-handlers.ts`, `preload/index.ts`, `shared/types.ts` | `select({ resumeToken, transportProfileId })`, resolved on the privileged side |

---

## 3. Acceptance gate

> Every transfer/error/resume/verification state is explicit and testable; no UI implies success before final integrity verification.

**Explicit and testable.** Both surfaces are transition tables written as data, over closed state sets, with every derived question — should the camera run, should frames be pulled, does cancel mean anything, is this terminal — computed from the state rather than kept beside it. `tests/renderer/sender-state.test.ts` and `mobile-web/tests/receiver-state-machine.test.ts` enumerate the tables; neither surface has a second state model any more (see §5).

**No UI implies success before verification.** This is enforced structurally rather than by review:

- `claimsIntegrityVerified(phase)` is true for exactly `VERIFIED` and `EXPORTING`.
- `SENDER_PHASES` does not contain either one. A sender state mapped to a phase it may not occupy fails `senderPhasesAreDeclared()`.
- The receiver's `COMPLETE` is the only state in either surface that maps to `VERIFIED`, and it is reached only from the worker's `verified` event — which the worker emits only after a SHA-256 comparison.
- `mayOfferExport(state)` gates the save control and is true for exactly `COMPLETE` and `EXPORTING`.
- The sender's completion screen is asserted not to use the word "verified", "saved", "success" or "received" in its eyebrow or heading, and asserted to carry the sentence that says the opposite.

Asserted in `tests/shared/transfer-ui-state.test.ts`, `tests/renderer/sender-state.test.ts`, `tests/renderer/desktop-transfer-ux-contract.test.ts` and `mobile-web/tests/large-transfer-ux-contract.test.ts`.

---

## 4. The ETA is withheld, and that is the feature

The plan asks for an ETA "only after enough stable samples, never immediately". That has to mean something testable or it means nothing, so `EtaEstimator` has four named refusals:

| Withheld | When | What a user sees |
|---|---|---|
| `TOO_FEW_SAMPLES` | Under 4 samples for a rate, under 10 for an ETA | "Measuring rate…" |
| `WINDOW_TOO_SHORT` | Window spans under 6 s | "Measuring rate…" |
| `RATE_UNSTABLE` | Recent half of the window differs from the whole by more than 35% | "Measuring rate…" |
| `NOT_MOVING` | No bytes covered across the window | "Waiting for frames" |

A **measured rate** appears before an ETA does, because a rate is an observation and an ETA is a prediction. The window is trimmed by time rather than by count, so a one-hour transfer estimates from its recent past instead of paying forever for a slow start. A hold resets the window, so a pause is never measured as slowness.

The tolerance is deliberately loose. Its job is not to detect small variation — an optical link jitters by construction — but to refuse an ETA while the rate is still an order of magnitude from where it will settle, which is exactly the first seconds of every transfer.

---

## 5. Two state models became one, on each side

The renderer held its transfer state in a bare `useState` over a fifteen-member `TransferState` union that mixed screens (`selecting-file`), phases (`streaming`) and outcomes (`completed`), assigned from inside seven async handlers. Beside it sat `src/renderer/state-machine.ts` — an `AppStateMachine` that **nothing ever rendered from**, that cast `'receive-camera'` through `any`, and that had a `'verified'` state the renderer never produced.

Both are gone. `TransferState` is retired with a pointer left in `src/shared/types.ts`; `state-machine.ts` and its test are deleted. Nothing was weakened: the five behaviours that test asserted are restated in `sender-state.test.ts` against the machine the renderer actually renders from, where they were previously claims about dead code. Two assertions from `app-model.test.ts` moved the same way — the size boundaries to `formatBytes`, the cancel-meaningfulness cases to `canCancel`/`cancelNeedsConfirmation` — and both migrations are named in the files they left.

---

## 6. Two defects found by running the app, not by testing it

Neither is reachable from a unit test, and both would have destroyed a transfer silently rather than failing it.

**The scheduler was rebuilt twice a second.** `StreamTransferView`'s frame-source effect listed `onFinished` and `onFailed` in its dependencies. The parent passes inline arrows, so their identity changes on every render — and the view re-renders off a 500 ms progress poll. The scheduler would have been stopped and reconstructed on every one of those renders, dropping its prefetch queue and resetting its cadence counters each time. The callbacks are now held by ref and the effect is keyed on the session and the profile only.

**React state was set once per painted frame.** The frame source also called `setProgress` with the progress that rides along on every `nextFrame` response. At Balanced that is twelve full re-renders per second of the transfer view, diagnostics grid included, on the same thread that encodes and paints the QR symbol — the precise thing the phase's own design rules forbid. The poll is now the only writer.

Both are pinned by assertions in `tests/renderer/desktop-transfer-ux-contract.test.ts`.

---

## 7. What the receiver can now say

| Screen | What it shows | Where the data was |
|---|---|---|
| Home | Device storage available, or nothing if the browser will not answer | `navigator.storage.estimate`, never read before |
| Scanning / Receiving | Filename, original size, transport size, compression share, segment `x of y` | `ReceiveProgress`, plumbed in Phase 08, drawn by nothing |
| Scanning / Receiving | Room needed vs. room reported, with the confidence stated | `StoragePreflight`, computed and **discarded** in `onProvisioned` |
| Receiving | "Resuming: N of M segments were already on this device" | `unitsAdopted`, Phase 07 |
| Receiving | Why a checkpoint was *not* adopted, in a sentence, never a code | `checkpointRejection`, Phase 07 |
| Verifying | Its own panel; two steps for a compressed transfer, one otherwise | `verify-progress`, Phase 08 — `onVerifyProgress` existed and had no subscriber |
| Interrupted | Segments and bytes kept, the resume code, and a control to erase them | `resumeToken`, Phase 07 |
| Failed (compression) | What to ask the *sending* device for | Nothing. There is no back channel; the sentence is the entire remedy |

The compression refusal is the one that could not be fixed any other way. A sender decides to compress from bytes it sampled and cannot learn that the receiving browser has no `DecompressionStream`. The optical link is one-way by construction, so no automatic path exists — the screen has to tell the user what to say to the desktop.

---

## 8. The worker protocol moved 4 → 5

`ReceiveProgress` gained `storageRequiredBytes`, `storageAvailableBytes` and `storageConfidence`. The confidence is a three-value enum rather than a boolean because `none` (no preflight yet), `reported` (the browser answered) and `unknown` (no estimate API) want three different sentences, and the third must never be rendered as reassurance.

All three are validated by `isReceiveWorkerEvent` on receipt, like every other field that reaches a screen. A service worker can serve a cached shell against a freshly fetched worker bundle; the version bump turns that into a clean handshake failure rather than a progress message read with three fields missing.

---

## 9. Stated deviations

1. **The transport profile selector applies to the next selection, not the current one.** A profile changes segmentation, which is fixed when the file is opened and hashed. Re-selecting mid-session would mean re-running preflight over the whole file. The card says which profile the session is actually running on, read back from the manifest.

2. **`Experimental` is not offered.** It is `productionSelectable: false`, needs a capture resolution above the 720-line baseline everything was measured against, and `resolveTransportProfile` falls back to Balanced rather than honouring a renderer that asks for it by number.

3. **The receiver's progress bars do not interpolate.** The desktop bar has a transform transition because it is fed by a 500 ms poll; the receiver's advances per accepted segment and already reads as continuous. A compositor animation on a page running jsQR is the decorative motion the design rules forbid.

4. **The desktop camera receiver and loopback still use v1.** Neither is a transfer: loopback is a self-test of the v1 container and needs the v1 decoder it exercises, and the desktop receiver is a development surface — the shipping receiver is the PWA. Both are reachable only from an idle sender and share no state with it.

5. **Original bytes covered is derived from the transport fraction under compression.** The sender knows how much of the *container* it has emitted, not which original byte that lands on, because window records are variable length. The two agree exactly when nothing is compressed, and the segment counter — exact in both modes — is what the screen leads with.

6. **No screenshot of the receiver's transfer screens.** The receiver mounts and renders correctly at 375×812 with no horizontal overflow (§10), but the metadata card, verify panel and resume card need a live camera and an active sender to reach. They are covered by the view-model and source-contract suites, not by a rendered image. Physical verification is Phase 11's.

Carried forward unchanged from Phase 08: no real OPFS implementation has been exercised, no iOS share-sheet size limit is claimed, and physical certification of any profile remains **PENDING**.

---

## 10. Verification

Every command below was executed and its output observed.

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run mobile-web:typecheck` | clean |
| `npx vitest run` | **789 passed / 48 files** (from 696 / 45) |
| `npm run mobile-web:test` | **347 passed / 27 files** (from 282 / 24) |
| `npm run build` | clean |
| `npm run mobile-web:build` | clean; receive worker chunk **215.96 kB** |
| `npm run test:packaged` | PASS |
| `npm run vectors:v2:generate` | 24 vectors written, `git diff --exit-code` clean |
| `npm run doctor` | PASSED (0 warnings) |
| `npm run drift-check` | PASSED |

**Runtime, desktop.** Electron launched against the dev server and reported `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available` — the rewired App mounts, the dashboard renders, and the preload bridge is reachable. This is what surfaced the two defects in §6.

**Runtime, receiver.** The PWA served at 375×812: mounts clean, `scrollWidth === clientWidth === 375` (no horizontal overflow), and the new storage line rendered a real measured value — "About 5.81 GiB is available on this device for transfers." Console shows only the pre-existing `frame-ancestors` meta-CSP warning (`WEB-IOS-SEC-003`, open) and 404s from the host-reachability probe, which has no endpoint on a bare dev server.

**Test accounting.** Phase 09 adds 98 desktop tests and 65 PWA tests. Seven pre-existing tests were removed or changed, and every one is accounted for:

| Changed | Why |
|---|---|
| `tests/renderer/state-machine.test.ts` — 5 tests, deleted | Its subject, `AppStateMachine`, was dead code no component imported. All five behaviours restated in `sender-state.test.ts` against the live machine |
| `tests/renderer/app-model.test.ts` — 2 tests, removed | `formatFileSize` and `isActiveTransferState` were deleted with the `TransferState` union. Both sets of assertions carried to `sender-model.test.ts` and `sender-state.test.ts` |
| `mobile-web/tests/accessibility-and-design-contract.test.ts` — 1 test, amended | The retry button's label became conditional; the assertion now pins the structure it always meant rather than the exact string |

**No prior assertion was weakened.** Every migration is named in the file it left.

New test files:

| File | Covers |
|---|---|
| `tests/shared/transfer-ui-state.test.ts` | The vocabulary, the phase ordering, and the rule that only a receiver may claim integrity |
| `tests/renderer/sender-state.test.ts` | The transition table, epoch fencing, fault routing, and the five behaviours inherited from the deleted machine |
| `tests/renderer/sender-model.test.ts` | 64-bit formatting past `MAX_SAFE_INTEGER`, every ETA refusal, compression copy for every policy reason, the two-size readout |
| `tests/renderer/desktop-transfer-ux-contract.test.ts` | Capacity messaging, the completion screen's claims, QR immutability, motion, announcements, hierarchy, profiles, resume, layout, focus, and the two §6 defects |
| `mobile-web/tests/receiver-view-model.test.ts` | Transfer, storage, verification, interruption and fault derivations |
| `mobile-web/tests/receiver-storage-reporting.test.ts` | Device estimate, discard, preflight figures behind a refusal, and the widened progress schema |
| `mobile-web/tests/large-transfer-ux-contract.test.ts` | Receiver phase conformance, export gating, motion, safe areas, contrast, and the compression refusal screen |

One of those tests found a real bug while being written: `discardRetainedSessions` was handing `sweepStaleSessions` the already-resolved sessions directory, which then looked for a second `deqr/sessions` inside it and deleted nothing. Fixed, and the test that caught it also pins that the discard cannot reach a directory this receiver did not create.

---

## 11. What Phase 10 inherits

- **A new privileged input.** `streamTransfer:select` now takes an object from the renderer carrying a resume token and a profile id. Both are bounded on the privileged side — the token by length before it reaches the codec, the profile by `resolveTransportProfile`, which falls back rather than failing. The threat model should confirm that a renderer cannot select an uncertified profile, and that the fallback is silent by design rather than by omission.
- **A new deletion path.** `discardRetainedSessions` removes origin-private directories on user action. It is the existing sweep with both bounds set to zero, so there is exactly one piece of code that removes a session directory, and it can only reach names matching the fixed-width hex form this receiver produces. That constraint is asserted; it is worth a threat model's attention because a discard is still a deletion driven from a screen.
- **A resume code that is now typed into a field.** Phase 07 minted it and Phase 09 accepts it. It carries a session id, a file id, a segmentation and a digest prefix, and the sender refuses it unless the selected file agrees. What Phase 10 should consider is what a *hostile* code entered by a user could cause — the refusal path is at selection time, and nothing is transmitted by entering one.
- **A storage summary derived from a browser-reported quota.** It is labelled as such on screen and never as free space, and the receiver's margin exists because the quota can shrink under pressure while a transfer runs.

For Phase 11: the physical matrix now has UI states to certify as well as decode rates — the resume round trip across two devices, the compression refusal on a browser without `DecompressionStream`, and whether the withheld-ETA thresholds in §4 are right against a real camera rather than against synthetic samples. `MIN_ETA_WINDOW_MS` and `ETA_STABILITY_TOLERANCE` are exported constants for exactly that reason.
