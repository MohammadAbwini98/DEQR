# PHASE 12 — Packaging, Regression Gates, Documentation, Release

**Date**: 2026-08-23
**Scope**: final integration, migration, regression validation, documentation, and
the release verdict for the Large-File / Maximum-Speed program.
**Verdict**: **CONDITIONALLY ACCEPTED for internal distribution — NOT ACCEPTED for release.**
Reasons in §9.

---

## 1. What this phase was for, and what it refused to do

Phase 12 integrates Phases 00–11 into something shippable without regressing
offline behaviour, security, lifecycle or existing features. It does **not**
extend the architecture: the two large improvements Phase 11 identified — the
unconditional repair budget (worth 1.78×) and a loss indicator on the receiver —
are protocol and UX changes and are recorded, not built.

It also inherits one hard constraint from Phase 11 and honours it throughout:
**no maximum-size or maximum-speed claim may ship.**

Phase 00–11 evidence was verified as present and left unmodified. In particular
`PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` still has every row PENDING, and
nothing in this phase wrote a result into it.

---

## 2. The defect this phase found

**WEB-IOS-SHELL-018 — a service-worker upgrade left the offline shell
incomplete.** Found by running the built PWA in a real browser and driving an
actual release-to-release upgrade, not by any test.

### What happened

Installed receiver on the previous release, host serves a new build:

```text
navigation        -> served by the OLD worker (network-first, returns new HTML)
document assets   -> fetched, cached by the OLD worker, into the OLD cache
new worker        -> installs, skipWaiting, activate DELETES every older cache
                     ... taking this build's assets with it
controllerchange  -> the new worker claims the page
```

`main.tsx` posted its precache list exactly once, right after
`navigator.serviceWorker.ready`, to `registration.active` — which at that moment
is the **outgoing** worker. The list therefore landed in the cache that was about
to be deleted. Measured, immediately after an upgrade:

```json
"deqr-mobile-shell-v3": ["/", "/boot.js", "/icons/deqr.svg",
                         "/index.html", "/manifest.webmanifest"]
"needed":               ["/assets/index-D84XoIAp.js", "/assets/index-CrC5arbT.css", ...]
```

Five CORE entries; neither of the two files the document actually names. Compare
a **clean first install**, which cached all eleven.

### Why it matters

The cached `index.html` names an `/assets/index-HASH.js` that is in no cache at
all. `cacheFirst` finds no match, goes to the network, gets nothing offline, and
returns `Response.error()` — which fires `error` on the script element, so
`boot.js` purges and reloads once, still finds no network, and shows its
diagnostic. **This is the permanent-white-page failure of WEB-IOS-SHELL-017
reproduced by an ordinary update**, and it would have reached a phone on the
first release after that fix.

A second, quieter half: the receive-worker chunk is constructed from JavaScript
and appears in no `<script>` or `<link>`, so it was never in the precache list at
all. It only ever entered the cache because a live session happened to fetch it
while the host was reachable. An offline receiver that cannot start its decoder
is not an offline receiver.

### The fix

- `mobile-web/src/main.tsx` — post the list again on `controllerchange` (the
  point at which the new worker owns the cache the document will be served from)
  and again on `load`; address `navigator.serviceWorker.controller` rather than
  `registration.active`; and assemble the list from the union of the document's
  **declared** graph (`<script>`, `<link>`) and its **observed** one
  (`performance.getEntriesByType('resource')`), which is what names the worker
  chunk.
- `mobile-web/public/sw.js` — cache bumped to `deqr-mobile-shell-v4`, because
  what the cache must *contain* changed and a device must not go on reusing one
  written under the old rules. The precache filter also now excludes the health
  probe explicitly: the observed-request list includes it, `fetch` deliberately
  never touches it, and a `put` would have reintroduced remembered reachability
  by the back door.

### Verified after the fix, in the same real browser

Device installed on the previous release, then upgraded:

```json
"keys": ["deqr-mobile-shell-v4"],
"deqr-mobile-shell-v4": ["/", "/assets/index-BAgx3QX9.js", "/assets/index-CrC5arbT.css",
  "/assets/receive-worker-BxSdhboO.js", "/boot.js", "/favicon.ico",
  "/icons/apple-touch-icon-180.png", "/icons/deqr-chip.svg", "/icons/deqr.svg",
  "/index.html", "/manifest.webmanifest"],
"missingFromCache": []
```

Old cache gone, worker chunk present, nothing the document names absent. With the
host then **stopped**, every one of those paths still answered `200` from cache
with a full-length body.

---

## 3. Exact changed files

### Fix and regression coverage

| File | Change |
|---|---|
| `mobile-web/src/main.tsx` | precache on `controllerchange` and `load`, to the controller, from declared + observed graph |
| `mobile-web/public/sw.js` | cache `v3` → `v4`; `isCacheable` excludes the health probe from `PRECACHE_URLS` |
| `mobile-web/tests/service-worker-strategy.test.ts` | cache name derived from source; `cache.keys()` in the fake; new `upgrade migration` block (5 cases) |
| `mobile-web/tests/pwa-assets.test.ts` | new case locking the `controllerchange` / controller / observed-graph / `load` contract |
| `mobile-web/tests/receiver-resume.test.ts` | new case: a checkpoint from an unknown schema is refused **and its data cleared**, both directions |
| `mobile-web/src/receive-pipeline.ts` | module comment corrected — it still claimed the desktop UI had not moved to v2, which stopped being true at Phase 09 |

### Documentation

| File | Change |
|---|---|
| `.ai-team/engineering/ARCHITECTURE.md` | **rewritten.** Was a Milestone-1 proposal describing v1 only, with a source tree that does not exist. Now describes what ships, and names what was proposed and never built |
| `.ai-team/engineering/PROTOCOL-V2.md` | status header corrected; §10 rewritten (v2 is the shipping format; v1 retirement considered and refused); §12 open items reconciled against Phases 02–11 |
| `.ai-team/engineering/SECURITY.md` | new §6.4, the application shell as a versioned supply chain |
| `.ai-team/engineering/TROUBLESHOOTING.md` | **new.** Symptom-first, both surfaces, with the diagnostics table |
| `mobile-web/ARCHITECTURE.md` | new section on the shell cache and what an upgrade does to it; corrected the stale "no real OPFS implementation has been exercised" boundary |
| `RELEASE-NOTES.md` | **new.** Carries the release claim, measured performance, known limitations, upgrade/migration and rollback |
| `.claude/launch.json` | added `pwa-prod` (`vite preview` over `dist/pwa`, port 5313) — the only way to exercise the service worker, which registers in production builds only |

Plus this report and the project-control updates.

---

## 4. Validation commands and results

All run on 2026-08-23 against the Phase 12 tree.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run mobile-web:typecheck` | **PASS** |
| `npm test` | **PASS** — 51 files, 842 tests |
| `npm run mobile-web:test` | **PASS** — 28 files, **385** tests (378 before; +7 from this phase) |
| `npm run build` | **PASS** |
| `npm run mobile-web:build` | **PASS** |
| `npm run doctor` | **PASS** — 0 warnings |
| `npm run drift-check` | **PASS** — zero adapter drift |
| `git diff --check` | **clean** |
| `npm run typecheck:phase11` | not re-run; Phase 11 owns it and this phase changed nothing under `scripts/bench/` |

---

## 5. Runtime gates — Electron

| Gate | Result |
|---|---|
| Dev launch | **PASS** — `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available` |
| Preload availability | **PASS** — reported by the marker above, which is emitted only after the bridge is present |
| IPC registration | **PASS** — 19 channels; the `handleTrusted` list in `src/main/ipc-handlers.ts` and the preload's exposed list are **identical**, compared name by name |
| Close / shutdown | **PASS** — graceful `WM_CLOSE`, process exited, **exit code 0**, and **no output whatsoever after the readiness marker** |
| Historical post-close exception | **DOES NOT RETURN** — see above |
| No remote runtime resources | **PASS with one stated caveat** — the only absolute URLs in either bundle are `https://react.dev/errors/…` inside React's minified error *formatter* and a `feross.org` license comment in `ieee754`. Neither is fetched, and packaged CSP is `connect-src 'none'` |
| Custom window controls | **NOT EXECUTED** — needs a click on a native window; see §7 |
| Start / cancel / complete lifecycle | **NOT EXECUTED** — same reason |
| Packaged launch, CSP, fuses, ASAR | see §8 |

---

## 6. Runtime gates — PWA

Driven against the production build served by `vite preview` (port 5313), in
Chromium. The service worker registers in production builds only, so a dev server
cannot exercise any of this.

| Gate | Result |
|---|---|
| Clean first load | **PASS** — `BOOT_HTML → BOOT_JS_LOADED → BOOT_REACT_MOUNT → BOOT_SW_CHECK`, mount at 254 ms |
| Service worker registration | **PASS** — activated, controlling, 11-entry cache |
| Service-worker / cache upgrade path | **PASS** — device installed on the historical **v2** worker (restored from `f232464`), upgraded through **v3** to **v4**; each activation removed the previous cache |
| Stale-cache blank page | **PASS, after the fix in §2** — every asset the document names is present in the live cache |
| Offline asset service | **PASS** — with the host stopped, the document and all seven referenced assets returned `200` from cache with full-length bodies |
| Offline top-level *navigation* | **NOT EXECUTED** — see §7 |
| Camera permission / recovery | **PASS as far as a browser without a camera can go** — the failure surface renders with "Try camera again" and "Return to home" |
| No horizontal overflow at 390×844 | **PASS** — home and camera-recovery screens; `scrollWidth === clientWidth === 390`, zero out-of-bounds elements |
| Health probe never cached | **PASS** — absent from the cache after an upgrade that included it in the observed-request list |
| Home-Screen standalone | **NOT EXECUTED** — needs a device |

### Real-OPFS re-certification

The Phase 11 browser harness (`scripts/bench/browser/`, port 5312) was re-run
against the Phase 12 tree — the shipping `ReceivePipeline` and `ReceiverStorage`
in a worker, writing through Chromium's own OPFS. **10 checks passed, 0 failed:**

- storage support: `opfs=true syncAccess=true`, quota 6,287 MiB
- `sha256-stream` agrees with `crypto.subtle` over 3,145,745 bytes
- transfers at **1 / 16 / 64 MiB**, all hash-verified, receiver held at **1.34 MiB**
  regardless of size; OPFS write 27.6–29.0 MiB/s
- export handoff at each size: the `File` opens from OPFS and its digest matches
- **interrupt and resume across two pipelines on real OPFS** — 3 of 6 segments
  adopted, `resumedFlag=true`, digest matches
- session retention policy holds: 4 sessions retained, nothing swept that policy
  said to keep

This is the storage-layer half of "resume after app restart" and "OPFS session
cleanup". The other half — WebKit — is untested and untestable here.

---

## 7. Gates that could not be executed, and why

Stated rather than quietly omitted.

| Gate | Why not |
|---|---|
| Custom window controls; start/cancel/complete/close **with a live transfer** | Requires clicking a native Electron window. No automation path from this session; the launch-and-close cycle was executed and passed |
| Offline top-level navigation | Stopping the preview server makes Chromium fail the navigation with a connection-refused error page **ahead of** the service worker, so the worker never sees it. The cache-fallback path was proven instead, by `fetch` with the host down. A phone's "offline" is a missing route, not a refused port, and that case remains a device gate |
| Every physical iPhone gate | No device. Unchanged from Phase 11 |
| iOS Safari OPFS, share-sheet export limit | Chromium's OPFS agreeing with the spec says nothing about WebKit |

---

## 8. Packaged artifact

See §11 for the artifact produced by this phase. Before it, the recorded artifact
was built from `3358ac0` and **predates the entire program** — every Phase 00–11
source file was uncommitted until this phase. `npm run release:verify` confirmed
the old hashes still matched their manifest and warned that HEAD had moved past
them; `npm run test:packaged` passed, but against that same pre-program archive
and so proved nothing about this code.

---

## 9. Verdict

### NOT ACCEPTED for release

Two independent reasons, either sufficient:

1. **The certified maximum transfer size is 0 bytes.** No size has been certified
   on a physical device. `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` has seven
   named gates and every row is PENDING, including the packaged-Electron gate
   (G7), WebKit's OPFS (G1) and the share-sheet export limit (G2).
2. **The default transport profile is not certified.** Which profile should be
   the default depends on camera pixels per QR module at a realistic distance,
   which no one has measured on a phone.

The phase plan is explicit and is being followed: *do not mark ACCEPTED while
required physical iPhone or packaged-runtime gates are still unexecuted.*

### CONDITIONALLY ACCEPTED for internal distribution

Everything that does not require a phone passes, and the artifact is now, for the
first time, traceable to a commit containing the architecture it implements. It
is fit for the physical certification runs — which is precisely what it is needed
for.

**One thing must happen before any phone test is believed**: confirm the device
picked up the rebuilt shell. If a stale shell persists, every result below it is
meaningless, because a stale shell silently reproduces the original symptom.

---

## 10. Known limitations carried forward

- 43% of a clean Balanced link carries repair symbols nobody needed; removing the
  waste is worth **1.78×** and needs a protocol change (Phase 11 §12 F1).
- Loss fails as a cliff: `(1 + r)(1 − p) ≥ 1.05`. Above `p = 0.40` at Balanced no
  number of passes ever completes a transfer. The receiver knows its own reject
  rate and still does not tell the user which side of 0.20 they are on (F2).
- Real OPFS is ~100× slower than Node `fs`, so every storage rate in the Phase
  06–08 reports is an upper bound rather than a device number. It changes no
  design decision: one write per segment covers 298 optical seconds.
- Payload encryption is reserved in the format and not implemented.
- `frame-ancestors` is ignored when CSP is delivered by `<meta>`. The packaged
  desktop host sends a real response header; any other deployment of the PWA must
  send one too (`WEB-IOS-SEC-003`).
- The v1 `transfer:*` IPC channels remain registered and unreachable from any UI.
  Removing them is a deliberate change with an installed-base cost, considered in
  §10 of `PROTOCOL-V2.md` and refused for this release.

---

## 11. Rollback and migration notes

- **Artifacts** are recorded with SHA-256 and their source commit.
  `npm run release:verify` re-checks the files against the manifest and warns
  when HEAD has moved; `npm run release:list` shows what was built when. Roll back
  by reinstalling an earlier recorded artifact.
- **Never use `npm run package` to build a release.** It passes `--dir`, refreshes
  only `release/win-unpacked/`, and leaves the portable `.exe` at whatever it
  already was — which is how a stale portable shipped twice, once still carrying
  a crash that had already been fixed.
- **Receiver shell.** `activate` deletes every `deqr-mobile-` cache that is not
  the current one, older *or* newer, so a host rollback is as safe as an upgrade;
  the document is fetched network-first, so an installed phone follows whatever
  the host serves. An upgraded device needs **one online load** to repopulate its
  cache, and that is automatic.
- **Checkpoints.** A checkpoint whose schema this build does not know is refused
  and its session data deleted, so the transfer starts clean rather than resuming
  onto bytes whose meaning may have changed. Compatible checkpoints resume
  normally. Abandoned sessions are swept on session open, bounded by age and
  count.
- **v1 compatibility.** The receiver accepts both v1 and v2 and never
  reinterprets one as the other. A phone can update independently of the desktop
  it scans.

---

## 12. What the next session should do

1. **Confirm the phone picks up the rebuilt shell** before anything else. Expect
   `caches.keys()` to be exactly `["deqr-mobile-shell-v4"]`.
2. Run the physical matrix's primary ladder at 8 MiB — seven runs, about one
   working day — which settles every variable except size and decides the default
   profile.
3. Only then climb the size tiers, at the profile the ladder selected.
4. Close the packaged-Electron gate (G7) with the artifact from §11.
5. Execute the window-controls and live-transfer lifecycle gates on an unlocked
   desktop.
