# DEQR Session Handoff

## Current status

- **Date**: 2026-08-14
- **Branch / HEAD**: `main` at `f0e43db`, level with `origin/main`, worktree clean
- **Active workstream**: WEB-IOS Safari PWA receiver (`mobile-web/`)
- **Desktop suite**: 24 files / 278 tests PASS
- **PWA suite**: 10 files / 47 tests PASS
- **Typechecks, builds, `test:packaged`, doctor (0 warnings), drift**: PASS
- **Release / physical acceptance**: **NOT ACCEPTED** — `WEB-IOS-10` fully unexecuted, `DESKTOP-SEC-050` conditional

## Read this first — corrections to older sections below

The dated sections further down are kept as history. Four of their statements are
now wrong, and one of them instructs you to assert something false. Trust this
list over anything below it.

1. **The packaged app no longer opens a port by itself.** The 2026-08-11 section
   says the app "accepts inbound LAN connections" and prompts Windows Firewall on
   first run, and tells you not to restate the no-listener claim. `DESKTOP-PWA-HOST-006`
   (`831ddb8`) retired that. The receiver is **off at launch** and binds nothing
   until someone presses **Start receiver**. An unattended launch opens no inbound
   port and raises no firewall prompt. The original characterisation still applies
   only *while it is running*: static assets only, no transferred payload through it.
2. **The repository path is `D:\Projects\DEQR`.** The old "safe next task" says
   `D:\Projects\DEQR-ios2`, which does not exist here.
3. **Do not use `run-local` for iPhone work.** `scripts/run-local.ps1` defaults to
   `-PwaPort 5174`, the exact port the desktop receiver now wants, so the launcher
   and **Start receiver** fight over it. The launcher is for desktop-browser PWA
   development. For a phone, use the packaged app, which serves the receiver itself.
4. **Committing and pushing is no longer withheld.** The old closing line predates
   the current arrangement; work has been committed and pushed through `f0e43db`.

`WEB-IOS-SEC-003` has also moved: the response-header half is **closed for the
shipping path**, because the packaged host sends the CSP as a real header, so
`frame-ancestors` is enforced rather than ignored. The `<meta>` limitation still
applies to any separate web deployment of the PWA.

## 2026-08-13 / 08-14 — most recent work

### WEB-IOS-PWA-011 — reported iPhone receiver failure (`1041a0b`, `1f6131d`)

Four symptoms were reported: no data received, the app opening whether or not the
receiver ran, no service indicator, and a misaligned "Return to home".

- **The receive path was cleared by evidence, not assumption.**
  `mobile-web/tests/desktop-to-pwa-composition.test.ts` drives real desktop frames
  through real painted QR codes and jsQR into `ReceiverSession` to a verified
  SHA-256, covering repair-only recovery, duplicate oversampling and a foreign
  session. The shipped worker chunk was separately confirmed in a browser to return
  a 532-byte frame byte-exact. **Do not re-investigate the protocol first.**
- **The defect that can strand a phone was the service worker.** It answered every
  same-origin GET from a fixed `deqr-mobile-shell-v1` cache, including the HTML
  document, with no `skipWaiting` and no update path, and `sw.js` had not changed
  since it was introduced while `mobile-web/src` had. A phone that installed before
  `0e3e6dc` could never be given a fix. Now: network-first for documents with a
  cached offline fallback, cache-first only for hashed `/assets/`, `-v2` cache,
  immediate claim, `/health` never intercepted. Offline installability is retained
  deliberately — an installed receiver is meant to open with no host at all.
- **Host reachability is now measurable.** The desktop answers a constant,
  `no-store` `GET /health`, matched before the single-page fallback that would
  otherwise return the HTML shell for it. The PWA polls it while visible and shows
  *Checking receiver* / *Receiver online* / *Receiver unavailable* in text.
- **A dead scanner now says so** instead of resolving empty forever, and scan
  details count QR reads and frames belonging to another transfer.
- Tracked follow-up: **ISSUE-006** — a session that latches onto one transfer
  silently discards a second one. The count is now visible; whether to offer an
  explicit "switch transfer" action is an open product decision.

### DESKTOP-IPC-007 — dead preload channel (`780cb51`)

`loopback.saveVerifiedResult` was exposed and typed but no handler ever answered
it, and nothing ever called it. Removed rather than implemented: loopback
re-decodes a file already on local disk and releases the session the moment
decoding completes, so there was never an artifact to save.
`tests/main/ipc-contract.test.ts` now derives both sides from production and fails
if any preload invoke channel lacks a main handler.

### DESKTOP-SEC-008 — privileged IPC authenticates its caller (`d875249`, ADR-010)

All 15 renderer-to-main channels register through a `handleTrusted` wrapper backed
by `src/main/ipc-sender-policy.ts`. Trusts the packaged `file:` renderer always and
the exact development origin **only when unpackaged**; rejects `data:`,
`devtools:`, the PWA origin on 5174, every subframe, and any unreadable sender
frame. Fail-closed with a sanitized `IPC_SENDER_REJECTED`; the frame URL is never
logged because it can carry a filesystem path.

`isTrustedRendererOrigin` was deliberately **not** reused: it also accepts `data:`
and `devtools:`, and takes no `isPackaged`, so reusing it would have trusted
`http://localhost:5173` inside a shipped app. **If you add an IPC channel, register
it with `handleTrusted`** — the enumeration test will fail by name otherwise.

Test mocks of `electron` must now supply `app.isPackaged` and a `senderFrame`.

### DESKTOP-UI-009 — orphaned renderer model (`d448ec3`)

`src/renderer/ui-model.ts` was deleted. It was stranded by the `b4eb147` merge; two
of its exports were dead (one also stale, defaulting to 30 FPS against a shipped
10) and two were duplicated in `App.tsx` in better form. `formatFileSize` and
`getIpcError` now live in `app-model.ts` with coverage there.

### DESKTOP-UI-010 — merged window chrome verified against the packaged binary

The `frame: false` / custom-title-bar combination from the `b4eb147` merge is
**confirmed correct**. Everything below was driven against
`release/win-unpacked/deqr.exe`, not the development shell.

- **Exactly one header.** The renderer reports `headerCount: 1`, and no native
  caption is drawn: restored, `GetClientRect` equals `GetWindowRect`
  (1024x768 both), so the native frame contributes zero pixels. `WS_CAPTION` and
  `WS_THICKFRAME` remain set, which is how Electron keeps snap, animation and
  resize — the style bits alone would have been misleading.
- **Drag region is live**, probed with `WM_NCHITTEST` from a DPI-aware process:
  title-bar empty area and brand text both return **HTCAPTION**, while all three
  controls and the page body return **HTCLIENT**. That is exactly the split
  `-webkit-app-region: drag` / `no-drag` is supposed to produce.
- **Minimize, maximize/restore and close** were driven by **real clicks** on the
  custom buttons through Chromium's input pipeline (CDP `Input.dispatchMouseEvent`
  against a `--remote-debugging-port` launch), not `element.click()`. Each was
  confirmed by Win32 state: minimize -> `IsIconic` true; maximize -> `IsZoomed`
  true; second click -> restored; close -> process exited in 0 s with no stray
  process and no port left listening. This exercises the whole path, renderer
  button -> preload -> `handleTrusted` IPC -> `BrowserWindow`.
- **Maximize does not clip the title bar.** Maximized the window rect is
  `-7,-7 1453x873` against a `1440x860` work area, but the *client* rect is
  exactly `1440x860`, so the 7 px overhang is invisible resize border and the
  custom title bar starts at the top of the visible area. Confirmed visually.
- **Keyboard traversal works.** Real `Tab` key events move focus
  Minimize -> Maximize/restore -> Close, and the focus ring renders: computed
  `box-shadow` becomes `rgba(0, 113, 227, 0.34) 0 0 0 3px`, matching
  `--focus-ring`. The buttons are 46x44 px.

Caveats, stated rather than buried: the click and keyboard evidence comes from a
launch with `--remote-debugging-port` attached, which is not the shipping
configuration — the renderer, preload and IPC path exercised are identical, but
the run itself was debug-enabled. Screen-reader announcement was **not** tested.
No screenshot of a physically dragged window exists; `HTCAPTION` is the mechanism
Windows uses to move a window, which is why the hit test stands in for it.

### DESKTOP-UI-011 — receiver control verified, and a focus defect fixed

Pressing Start and Stop by real keyboard input against the packaged binary
worked, and the receiver lifecycle is sound: `stopped -> running` bound
`0.0.0.0:5174`, `GET /health` answered `200 application/json` with `no-store`
and the CSP header over real HTTPS, and stop released the port. `aria-busy`
toggled `false -> true -> false`, the live region text tracked each state, and
the control was **not** remounted across the transition.

**The gate did not pass on first run.** Keyboard focus was dropped to `<body>`
and never came back. The mechanism was isolated rather than guessed: focusing
the control and setting `disabled = true` gives `stillFocusedWhenDisabled:
false`, `focusLandedOn: BODY`, and re-enabling gives `refocusedOnReenable:
false`. So the single-non-remounted-button design — which does work, and is why
`sameNode` stayed true — was defeated anyway by `actionDisabled`. A keyboard
user pressing Enter on *Start receiver* landed at the top of the document and
had to tab back to reach *Stop receiver*.

Fixed by `shouldRestoreActionFocus` in `pwa-host-model.ts`, called from an
effect that runs when the control is enabled again. It reclaims focus **only**
when the control had it, the transition has settled, and focus is sitting on
`<body>` — if someone moved focus somewhere real while the receiver was
starting, taking it back would be its own bug. The decision lives in the model
because the renderer suite is node-environment with no component-testing
harness, which keeps it unit-testable without adding one.

Re-verified against a rebuilt package: Start now ends on `activeEl: THE BUTTON`
where it previously read `BODY (focus lost)`, and the Stop trace ends
`Stopping… (disabled, BODY) -> Start receiver (enabled, BODY) -> BUTTON`. Focus
necessarily leaves during the disabled phase — a disabled element cannot hold
it — so returning it once the control is usable is the achievable behaviour.

### WEB-IOS-10 preparation (`f0e43db`) — gate still unexecuted

Physical verification was requested and **was not performed**: no device, and
`tailscale status` showed `iphone-13-mini` offline, last seen 2 days ago.

One hazard was caught: `release/deqr 0.1.0.exe` was a week stale while
`release/win-unpacked/` was current, because **`npm run package` uses `--dir` and
never rebuilds the portable**. Rebuilt with `npm run dist`.

| Artifact | SHA-256 |
| --- | --- |
| `release/deqr 0.1.0.exe` (portable) | `135A15FC240B8867E63070C575DECC24C41E181BC2724B5D8D928B1A332DF1A8` |
| `release/deqr Setup 0.1.0.exe` (NSIS) | `6F4DA9A3C1B64C8E67EFD88783EC2483691743BB41D56C939CD42396319187E8` |
| `resources/app.asar` | `FED5A9609C2A10AE69A36C221CE622D08EDC8363AB1CB943B484466C188B6490` |

The packaged receiver was confirmed by extracting it from `app.asar`, not inferred:
`sw.js` carries `deqr-mobile-shell-v2`, `documentStrategy`, `skipWaiting` and the
`/health` bypass. Portable readiness proven by control experiment, because a
portable wrapper does not surface child stdout: autoclose on → self-exited at
5.6 s; autoclose off → still running at 20 s.

## Product direction

ADR-008 is the active mobile decision. The preserved `mobile/` .NET MAUI sources
and ADR-007 are historical reference only. Do not restart, extend, or require a
Mac/Xcode path.

Development origins are intentionally separate, and the PWA is **not** an Electron
renderer — it is a distinct trust domain (ADR-010):

- Electron renderer: `http://localhost:5173/` (exact loopback development exception)
- PWA: port `5174`, served by the packaged desktop app over LAN HTTPS for phone work

Receiver address selection prefers the **Tailscale** address. On this host the LAN
address cannot work unaided: the Ethernet adapter holding `192.168.100.41` is on
the **Public** firewall profile with no inbound rule for 5174, while the iPhone is
an enrolled tailnet node. Current advertised addresses are
`https://100.95.40.3:5174/` (overlay) and `https://192.168.100.41:5174/` (private).
Choosing Local network requires adding an inbound rule and keeping the phone on
that subnet.

## Open gates and risks — do not relabel as passed

1. **Physical iPhone (`WEB-IOS-10`) is NOT EXECUTED.** Trusted CA install,
   reachability, camera permission/denial/recovery, installed standalone PWA,
   offline shell, export to Files, VoiceOver, the appearance/accessibility matrix,
   sustained/thermal behaviour, lifecycle and session isolation, and the corrected
   desktop-to-iPhone optical transfer with byte/hash comparison all remain open.
   No automated, compositional, or local-browser result substitutes for any of them.
2. **Packaged optical transfer to a physical iPhone is NOT EXECUTED** — the only
   remaining `DESKTOP-SEC-050` criterion. Packaging, fuses, ASAR structure and ASAR
   integrity are verified against the artifact and are no longer open.
3. ~~**Desktop window chrome is UNVERIFIED.**~~ **CLOSED 2026-08-14 by DESKTOP-UI-010.**
   Exactly one header renders, the drag region hit-tests as `HTCAPTION` while the
   controls hit-test as `HTCLIENT`, and minimize, maximize/restore, close and
   keyboard traversal were all driven by real input against the packaged binary.
   See the section below.
4. **Receiver control click-through: CLOSED 2026-08-14 by DESKTOP-UI-011.**
   Start and Stop were both pressed by real keyboard input against the packaged
   binary; the receiver bound `0.0.0.0:5174`, answered `/health` over real HTTPS,
   and released the port on stop. Verification found and fixed a focus defect —
   see the section below. **Screen-reader announcement remains UNVERIFIED** and
   still needs a human with a screen reader; `aria-busy` and the polite live
   region are correctly wired, which is the machinery, not the announcement.
5. **Sender FPS is unchanged at 10** and remains an unvalidated hypothesis. The
   planned sweep is 6/8/10/12/15, measured by useful unique recovered payload
   throughput, not frames displayed. Do not raise it without device evidence.
6. `WEB-IOS-DATA-004` and the `style-src 'unsafe-inline'` residual of
   `WEB-IOS-SEC-003` are **accepted documented residual risk**, not closed.
7. Optical payloads remain **unencrypted** by the accepted M1 decision (ADR-003).
   Do not claim confidentiality.
8. The ASAR ships third-party development residue pulled in transitively by
   `qrcode`. No DEQR-private material and no secrets — hygiene and bloat only.
9. ASAR integrity is validated lazily on read plus a header hash. Bytes in files
   that are never loaded are not checked at launch. State that accurately.
10. **DESKTOP-SEC-008 is unit-level evidence.** No test drives a hostile frame
    against a running packaged binary; the guard is proven against the policy as
    implemented, not against a real compromised renderer.

## Safe next task

A physical iPhone is the only blocker for both open release gates. Items 3 and 4
above are desktop-only and need nothing but an unlocked session.

### Step 0 — prove the phone picked up the new shell

Do this before anything else. A stale shell reproduces the original bug report
exactly and would make every later result meaningless.

Launch the packaged app, press **Start receiver**, open the installed PWA, and
confirm the topbar reads **Receiver online** and that Scanning details lists
**QR codes read** and **Other transfer**. Those exist only in the new build. If the
old shell persists, clear the site data or reinstall the PWA, then repeat.

### Then run the matrix

```powershell
cd D:\Projects\DEQR
Start-Process "D:\Projects\DEQR\release\deqr 0.1.0.exe"
```

Verify the artifact first — use the 2026-08-14 hash in the table above, not the
`80D42022…B66A` build, which predates the merge, the receiver lifecycle, the PWA
shell fix and the IPC sender policy:

```powershell
Get-FileHash "D:\Projects\DEQR\release\deqr 0.1.0.exe" -Algorithm SHA256
```

Do **not** start `run-local` alongside it; it takes port 5174.

Deterministic fixtures with exact sizes and SHA-256 digests:

```powershell
node scripts/ci/generate-acceptance-fixtures.js
```

They land in `.local-run/acceptance-fixtures/` with a `MANIFEST.txt` to compare
received files against. Repeat the 5 KiB / 100 KiB / 1 MiB subset against the
portable artifact to close `DESKTOP-SEC-050`.

While scanning, watch **QR codes read** in Scanning details. If it stays at 0 while
the scan count climbs, the failure is optical or scanner-side, not protocol — the
protocol path already has compositional coverage. If unique blocks stall while
**Other transfer** climbs, the phone latched onto a different session (ISSUE-006);
reset and rescan.

Record evidence without exposing file contents or certificate key material.

## Evidence index

- `.ai-team/reports/testing/WEB-IOS-UXPERF-003-FINAL-REPORT.md`
- `.ai-team/reports/testing/WEB-IOS-PHYSICAL-PACKAGED-ACCEPTANCE-REPORT.md`
- `.ai-team/reports/testing/WEB-IOS-STARTUP-REMEDIATION-QA-REPORT.md`
- `.ai-team/reports/security/WEB-IOS-STARTUP-SECURITY-REVIEW.md`
- `.ai-team/engineering/ARCHITECTURE.md`
- `.ai-team/project-control/DECISIONS.md` — ADR-010 covers the IPC trust boundary
