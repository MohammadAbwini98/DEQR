# IOS Transfer — Physical Certification Matrix (Phase 13)

**Status: PENDING — NOT EXECUTED.** No physical iPhone was available to the
engineering session that wrote this. Every row below is an instruction, not a
result. Nothing here has been measured, and no number in this document may be
cited as evidence that DEQR works on a phone.

This supersedes nothing. `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` remains the
document that explains *why* camera pixels per module is the variable that
matters, and should be read first. This one exists because Phase 11's matrix was
written before a real device had ever been tried, and the attempt that followed
failed in a way no row of it would have caught: the desktop finished its pass,
the phone stayed in `Receiving transfer`, and nothing was delivered.

---

## 0. Read this before starting

**The build under test must be the one carrying Phase 13.** The worker protocol
moved 5 → 6, and a service worker cached from an earlier build serves a receiver
that cannot read the new progress contract. Confirm before anything else:

1. Open the receiver, then in Safari's console (or via the desktop host) check
   `caches.keys()` — it must be exactly `["deqr-mobile-shell-v4"]`.
2. The status line while scanning must be able to say **"The sender stopped
   before every part arrived"**. That sentence does not exist in any earlier
   build. If a stall shows anything else, you are testing the old shell: clear
   website data, or delete and re-add the Home Screen app, and repeat.

Every result below is meaningless until that passes, because a stale shell
reproduces the original symptom exactly.

**Do not skip a failed tier.** A tier that fails is the tier to diagnose. Moving
up after a failure produces a matrix that says nothing.

---

## 1. Environment record — fill in once per session

| Field | Value |
|---|---|
| Date / operator | |
| Desktop commit (`git rev-parse --short HEAD`) | |
| Desktop artifact (portable SHA-256, from `npm run release:verify`) | |
| Electron mode (dev / packaged) | |
| PWA build (hashed asset name from `dist/pwa/assets/`) | |
| Service worker cache name | must be `deqr-mobile-shell-v4` |
| iPhone model / iOS version | |
| Safari tab or Home-Screen app | |
| Display resolution / scaling / refresh rate | |
| Desktop window: maximized? | **maximize it** — see §2 |
| Transport profile | |
| Room lighting / stand used | |

---

## 2. Two setup rules that change the result

**Maximize the desktop window.** The symbol is sized from the room the window
has. On a 1024×768 window the Balanced symbol drops to roughly 2 screen pixels
per module, which is marginal for a camera; maximized it reaches the 4 px the
profile was designed around. A run done in a small window is measuring the
window, not the profile.

**Disable every sleep, dim, auto-lock and screensaver on both devices** before
any tier above 8 MiB. A display that dims mid-transfer is a loss burst of
several thousand frames, and afterwards there is no way to tell that apart from
a defect.

---

## 3. Fixtures

Deterministic, so a mismatch is diagnosable rather than mysterious. Generate on
the desktop and record the digest before sending:

```bash
node -e "const c=require('crypto'),f=require('fs');const n=Number(process.argv[1]);const b=Buffer.alloc(n);let s=1;for(let i=0;i<n;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;b[i]=s>>>24;}f.writeFileSync(process.argv[2],b);console.log(c.createHash('sha256').update(b).digest('hex'));" 1048576 fixture-1MiB.bin
```

Record the printed digest. That is the **source SHA-256** every row compares
against.

---

## 4. The size ladder

Run in order. Do not skip a failure.

| Tier | Size | Runs required | Status | Source SHA-256 | Verified SHA-256 | Exported SHA-256 |
|---|---|---|---|---|---|---|
| A | 1 MiB | 5 consecutive | **PENDING** | | | |
| B | 8 MiB | 5 consecutive | **PENDING** | | | |
| C | 16 MiB | 5 consecutive | **PENDING** | | | |
| D | 32 MiB | 5 consecutive | **PENDING** | | | |
| E | 64 MiB | 5 consecutive | **PENDING** | | | |
| F | 128 MiB | 3 consecutive | **PENDING** | | | |
| G | 256 MiB | 3 consecutive | **PENDING** | | | |
| H | 512 MiB | 3 consecutive | **PENDING** | | | |
| I | 1 GiB | 2 consecutive | **PENDING** | | | |

**A tier passes only when all three digests are identical** on every required
run, with bounded memory, no crash, a clean camera shutdown, and a usable UI
throughout. Anything less is a FAIL or a PENDING — never an inferred PASS.

At Balanced's modelled 4,631 B/s, tier E is about four hours and tier I about
sixty-four. Plan the session; do not compress it by skipping runs.

---

## 5. Per-run measurements

Record from the receiver's scan details and the sender's diagnostics. **Rank
profiles by verified original bytes per second — never by configured FPS.**

| Measurement | Where | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| Elapsed wall-clock | stopwatch | | | |
| Sender configured FPS | sender diagnostics | | | |
| Sender measured FPS (`effectiveFps`) | sender diagnostics | | | |
| Camera frames observed | scan details | | | |
| Decode attempts / successes | scan details | | | |
| Unique frames per second | scan details | | | |
| **Verified original bytes/sec** | derived — the ranking metric | | | |
| Duplicate ratio | scan details | | | |
| Refusals by reason (top three) | scan details | | | |
| Systematic vs repair accepted | scan details | | | |
| Segments completed / expected | scan details | | | |
| Recovery frames needed | sender diagnostics | | | |
| Decode P50 / P95 | scan details | | | |
| Camera pixels per module | scan details | | | |
| Peak receiver held bytes | scan details | | | |
| Export elapsed | stopwatch | | | |

---

## 6. Behaviours to exercise deliberately, not just observe

These are the Phase 13 changes. A tier that transfers cleanly proves none of
them, so provoke each at least once at tier B (8 MiB), where a run is short.

| # | Provoke | Expected |
|---|---|---|
| P1 | Cover the camera for ~15 s mid-transfer | Receiver leaves `Receiving` and says the sender stopped; **partial progress is retained**, segment count does not reset |
| P2 | Uncover it while the sender is still running | Returns to receiving and continues from where it was — not from zero |
| P3 | Let the sender finish while the receiver is short | Sender says "Stream complete / Every frame has been displayed" — **never "delivered"**; receiver shows incomplete with a resume code |
| P4 | Read the resume code into the desktop, send recovery | Only the missing segments are re-sent; transfer completes; digests match |
| P5 | Type one wrong character into the resume code | Refused immediately as a typo, not accepted and failed hours later |
| P6 | Enter a resume code from a *different* file | Refused as a different file, before any frame is displayed |
| P7 | Background the app mid-transfer, return | Interrupted state; kept data offered for resume |
| P8 | Decline the camera permission, then grant it | Recoverable without reloading |
| P9 | Cancel the iOS share sheet | **Verified file is still offered** — Save can be pressed again |
| P10 | Scroll the receiver while the action bar is docked | No content visible *through* the bar; nothing obscured |
| P11 | Rotate the phone mid-transfer | Guide stays aligned with the decode region |
| P12 | Two senders visible at once | Foreign frames counted as foreign, own transfer unaffected |

---

## 7. Failure capture

When a tier fails, capture **before** retrying — a retry destroys the evidence:

1. The receiver's full scan details, including **refusals by reason**. This is
   the field that names the fault: mostly `CRC_MISMATCH` is optical; mostly
   `SESSION_MISMATCH` is a second sender; mostly `V1_FRAME` is a desktop on an
   old build; **no refusals at all alongside no progress** means frames are not
   reaching the decoder.
2. The segment count and which segments are missing.
3. The resume code shown.
4. The sender's diagnostics panel.
5. A photograph of the desktop screen as the phone sees it, from the phone's
   position — this is what catches a clipped, dim or too-small symbol.

---

## 8. What a PASS at each tier licenses

Nothing beyond that tier. The programme's rule is that the supported maximum is
the largest size that has passed physical certification **and** the receiver's
storage preflight. A pass at 64 MiB licenses 64 MiB, and says nothing about 128.

Until tier A passes, **the certified maximum transfer size remains 0 bytes.**
