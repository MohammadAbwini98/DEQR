# DEQR Troubleshooting

Symptoms first, because a symptom is what anyone actually arrives with. Each
entry says what the symptom means, how to tell it apart from the things it looks
like, and what to do.

Two rules run through all of it:

- **A transfer that was not verified saved nothing.** DEQR offers a file only
  after its size and SHA-256 both match what the sender declared. "Failed" never
  means "partially saved".
- **The optical link is one-way.** The receiver cannot tell the sender anything.
  Where the remedy is on the other device, the receiver's screen says so
  explicitly, because nothing else can.

---

## The receiver PWA

### The app opens to a blank page

The historical worst failure, and the one with the most machinery behind it.

**What it was.** An installed phone held a cached `index.html` naming
`/assets/index-OLDHASH.js`, the host no longer had that file, the module never
executed, and `#root` stayed empty — permanently, because the cached document
never reached the network again.

**What happens now.** `boot.js` is an unhashed classic script loaded before the
application module. It watches for a script or stylesheet that fails to load and
for a mount that does not happen within 8 seconds. On the first failure it
unregisters DEQR's own service workers, deletes only caches this app named, and
reloads exactly once. On a second failure in the same tab it shows a diagnostic
with the boot stages and a **Clear cache and reload** button, rather than
reloading again — a persistent fault must not become a reload loop.

**If you still see a blank page**, it is not this failure. Check that the page
is being served at all: a white page with no `#root` content and no diagnostic
means `boot.js` itself did not load.

### The app opens but shows an old version after an update

Should not happen, and there is a test for each half.

The service worker is **network-first for the document**, so a reachable host
always wins. Its `activate` deletes every `deqr-mobile-` cache that is not the
current one, so no earlier release's shell can survive. The current name is
`deqr-mobile-shell-v4`.

If it does happen: Safari, Settings → clear website data for the host, then
reinstall from the Home Screen. On the desktop side confirm the host is actually
serving the new build — `npm run release:verify` reports which commit the
packaged artifact was built from.

### It worked offline before the update, and now offline is blank

**Fixed in Phase 12; here for anyone on an older build.** On an upgrade the
outgoing worker served the navigation and cached the new document's hashed
assets into *its* cache, the incoming worker's `activate` then deleted that
cache, and the page's one and only precache message had already gone to the
worker that was about to lose it. The new cache was left holding its `CORE` list
alone, so the shell it served named a module that was in no cache at all.

The receiver now re-offers its asset list whenever the controlling worker
changes, and assembles that list from the requests the document actually made —
which is also how the receive-worker chunk gets cached, since it is constructed
from JavaScript and appears in no `<script>` tag.

**Recovery on an affected device:** open it once while the desktop host is
reachable. That is enough.

### "Receiver unavailable" / "Offline app mode"

The PWA cannot reach the desktop host's `/health` probe. **Scanning still
works** — this banner is about the host that served the app, not about the
transfer, which is optical and needs no network at all.

Press **Start receiver** in the DEQR desktop app. The receiver host is off at
launch and binds nothing until it is started, so an unattended desktop opens no
inbound port. Reachability is measured on every check and never cached: the
service worker deliberately refuses to answer or store the probe.

### "Camera unavailable"

Camera access did not start. In iOS Settings, find this app (or Safari) and
allow camera access, then press **Try camera again**. Recovery is
user-initiated by design — a receiver that silently retried would burn battery
against a permission the user has to grant elsewhere.

Note that an installed Home-Screen PWA holds its own camera permission,
separate from Safari's.

### "This browser cannot expand the transfer"

The sender compressed the file and this browser has no `DecompressionStream`.
There is no back channel, so the sender could not have known.

**On the sending device, turn compression off for this file and send it again.**
It will take longer and it will arrive.

### "Transfer too large for this receiver"

Refused at the manifest, before the camera was asked for anything — so nothing
was scanned, nothing was saved, and there is no resume code to offer. The sender
described a transfer beyond `src/core/receiver-policy.ts`. Send a smaller file
or choose a different transport profile.

This is a *policy* refusal, not a protocol one: `V2_LIMITS` says what the wire
format can express, and receiver policy may narrow that and may never widen it.

### "File type refused" / "Encrypted transfer"

The receiver blocks executable extensions outright (`.exe`, `.dll`, `.ps1`,
`.bat`, `.cmd`, `.js`, `.vbs`, `.msi`, `.scr`, `.com`, `.pif`, `.hta`, `.wsh`,
`.wsf`) and refuses containers marked encrypted, for which it holds no key.
Payload encryption is reserved in the format and is not implemented.

### The scan counter climbs but "QR codes read" stays at 0

The camera is working and the frames are not being decoded. This is optical, not
protocol — the protocol path has compositional test coverage.

In order of likelihood: the symbol is too small in the frame (each profile needs
a minimum number of camera pixels per QR module — Reliable 2.5, Balanced 4,
Turbo 5); the screen is too dim or is being washed out; the phone is too far
away or at too sharp an angle; or the sender is running a profile the camera
cannot resolve at this distance. Move closer, or drop the sender to a more
reliable profile.

### The transfer is running but will clearly never finish

Loss above roughly 20% costs far more than it looks like it should, and the
relationship is not gradual. A segment that misses its window loses all partial
progress, because the receiver holds only two active segments. Measured: 20%
loss is free, 30% costs 17 passes and 17.7×, and **above 40% at Balanced no
number of sender passes can ever complete a transfer.**

Stop, fix the physical setup — mount the phone, stop moving it, raise screen
brightness, drop a profile — and start again.

### A large transfer is impossibly slow

It is not a defect; it is arithmetic. Measured verified throughput at zero loss:
Reliable 1,195 B/s, Balanced 4,631 B/s, Turbo 9,763 B/s. **1 GiB at Balanced is a
64-hour continuous scan.** Before starting anything above a few tens of MiB,
disable every sleep, screen-dim, auto-lock and screensaver on both devices: a
display that dims mid-transfer is a loss burst of several thousand frames, and
afterwards there is no way to tell that apart from a defect.

### A transfer was interrupted

The partial data is kept deliberately so it can be resumed, and the receiver
adopts its own checkpoint automatically when the same transfer is offered again.
Across the air gap, the sender is told where to restart by the 40-character
resume code shown on the receiver.

A resume is refused — and the partial data deleted — whenever the two runs
disagree: a different file digest, a different segmentation, a different
session, a checkpoint whose bitmap disagrees with its own counters, a data file
whose length does not match the plan, or a checkpoint written by a DEQR release
whose schema this build does not know. In every case the transfer starts clean
rather than failing, because the honest answer to unusable partial data is a
fresh transfer.

Abandoned data does not accumulate: a sweep runs when a session opens, bounded
by both age and count.

### "Not enough space"

The receiver pre-sizes the whole file before writing a single payload byte, so
a device without room fails at the start rather than at 90%. The home screen
shows what is available. Free space and try again.

---

## The desktop application

### The window has two title bars, or cannot be dragged

`frame: false` plus the renderer's own custom title bar. Exactly one header must
render, and dragging, minimize, maximize and close must all work from it.

### Windows Firewall prompts on first run

Only when the LAN receiver host is started. The app binds nothing at launch; the
dashboard card starts stopped and publishes nothing until **Start** is pressed.
When running it serves static application assets only — `GET`/`HEAD`, no
transferred payload passes through it.

### The iPhone cannot reach the receiver URL

Prefer the mesh-VPN address. On a typical host the Ethernet adapter is on the
**Public** firewall profile with no inbound rule for port 5174, so an ordinary
LAN address is unreachable from the phone even though it looks right. The
dashboard lists every reachable address with a Tailscale / Local network switch
so the choice is explicit rather than guessed, and logs it as
`DEQR_PWA_HOST_READY ... preferred=overlay`.

The certificate is generated once per set of addresses and then reused, so the
phone should only have to trust it once. It is issued when **Start** is pressed,
which is what makes it cover the network the machine is actually on at that
moment.

### An error dialog appears after closing the app

A historical defect — an interval kept encoding for a renderer that no longer
existed, and the throw surfaced as an Electron main-process crash dialog. The
main process now checks `isRendererAlive` before every delivery and disposes
every session on shutdown. If this reappears, capture the dialog text: it is a
regression in that guard, not a user error.

---

## Diagnostics

| What | How |
|---|---|
| Which build an artifact is | `npm run release:verify` — hashes, commit, and whether HEAD has moved past it |
| What was built when | `npm run release:list` |
| PWA boot stages | `window.__deqrBoot.report()` in the page console |
| Which service-worker cache is live | `caches.keys()` — expect exactly `deqr-mobile-shell-v4` |
| Whether the offline shell is complete | for each of the document's scripts and stylesheets, `await (await caches.open(k)).match(path)` must be defined |
| Receiver storage in use | the home screen states available space; sessions live under `/deqr/sessions/` in OPFS |
| Desktop readiness | `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available` on stdout |
| Real-OPFS certification | the `phase11-opfs` preview configuration, port 5312 |

**Never build a release with `npm run package`.** It passes `--dir`, refreshes
only `release/win-unpacked/`, and leaves the portable `.exe` at whatever it
already was — that is how a stale portable shipped twice, once still carrying a
crash that had already been fixed. `npm run release` is the only path that
records what it built.
