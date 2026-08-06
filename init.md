## DEQR project direction

This application is feasible using the same core desktop stack and visual language as AWKIT:

* **Electron**
* **React + TypeScript**
* **Vite**
* AWKIT-style custom window frame, navigation, cards, dialogs, dark/light themes, accent colors, animations, and portable packaging
* Fully offline operation
* No administrator privileges
* A portable Windows `.exe`

The application should be named **DEQR** unless we later select another product name.

## Important correction: it is an animated QR stream

For ordinary files, DEQR will not generate one static QR code. A QR code cannot hold a PDF, spreadsheet, archive, or other normal-sized file.

Instead, it will:

1. Read the selected file as binary bytes.
2. Optionally compress it.
3. Divide it into blocks.
4. Generate an endless sequence of fountain-coded frames.
5. Display each frame as a rapidly changing QR code.
6. Let a receiving camera collect enough frames to reconstruct the file.
7. Verify the reconstructed file before saving it.

That is the method used by **Decimen Optical Transfer**. Its current implementation uses Luby-transform fountain coding so the receiver can reconstruct the file after receiving approximately `K × 1.15` distinct frames, without needing frames in a fixed order. Missed or blurred frames delay completion but do not normally invalidate the transfer. ([GitHub][1])

## File-type support

DEQR should treat files as **opaque binary data**, not parse their internal contents.

That means the same transfer engine can support:

* PDF
* TXT and LOG
* XLS and XLSX
* DOC and DOCX
* MSG
* SQL
* ZIP and RAR
* CSV and JSON
* Images
* Executables, subject to security policy
* Any other file extension

For each transfer, DEQR preserves:

* Original filename
* Extension
* File size
* MIME type, when detectable
* SHA-256 hash
* Creation of a unique transfer/session ID

Unknown formats can use `application/octet-stream`.

This approach is safer and simpler because DEQR does not need Microsoft Office, Outlook, WinRAR, Adobe Reader, or any file-specific parser.

## Recommended product scope

Although the initial requirement is to generate QR codes, I recommend that the same portable application support both modes:

### Send mode

Select a file and display the animated QR stream.

### Receive mode

Use an attached or built-in camera to scan another device’s QR stream and reconstruct the file.

This is important because an isolated receiving computer cannot visit an online website to obtain the Decimen receiver. Both sender and receiver components should therefore be bundled inside the portable executable.

A sender-only first release is possible, but it would require a separately preinstalled compatible receiver on a phone or another computer.

## Proposed architecture

```text
DEQR Desktop
│
├── Electron Main Process
│   ├── Application lifecycle
│   ├── Portable paths
│   ├── File-selection dialog
│   ├── Safe file reading/writing
│   ├── Offline/network guard
│   ├── Audit and policy service
│   └── Narrow IPC handlers
│
├── Preload Bridge
│   ├── selectFile()
│   ├── inspectFile()
│   ├── startTransfer()
│   ├── cancelTransfer()
│   ├── selectOutputFolder()
│   └── saveReceivedFile()
│
├── React Renderer
│   ├── Dashboard
│   ├── Send File
│   ├── Receive File
│   ├── Transfer History
│   ├── Security Confirmation
│   └── Settings
│
├── Optical Transfer Core
│   ├── File container format
│   ├── Compression
│   ├── Fountain encoder
│   ├── Fountain decoder
│   ├── Frame protocol
│   ├── SHA-256 verification
│   └── Session recovery
│
├── QR Processing
│   ├── QR matrix generation
│   ├── Canvas/WebGL rendering
│   ├── Frame scheduler
│   ├── Camera capture
│   └── WASM QR decoder workers
│
└── Local Storage
    ├── Settings
    ├── Transfer audit history
    └── Optional resumable session data
```

The upstream Decimen project already separates its fountain coding, protocol, QR capacity calculation, raster generation, display sizing, progress calculation, and worker-pool logic into reusable TypeScript modules. Its receiver uses WASM-based QR decoding in workers, while the sender renders QR frames to a canvas. ([GitHub][2])

## Decimen components we can reuse or adapt

The project is MIT-licensed, permitting use, modification, and distribution as long as the required copyright and license notice are retained. ([GitHub][3])

The most useful components are:

* `fountain.ts`
* `protocol.ts`
* `frame-capacity.ts`
* `qr-raster.ts`
* `display.ts`
* `worker-pool.ts`
* Progress estimation
* Transfer settings and QR tuning logic
* Golden protocol test vectors
* `node-qrcode`
* `zxing-wasm`

The current protocol includes:

* A 20-byte self-describing frame header
* Session ID
* Frame sequence number
* Block count
* Block size
* Total payload length
* Payload hash
* Original filename
* Media type
* Optional gzip compression
* SHA-256 verification before offering the reconstructed file ([GitHub][1])

We should preserve compatibility initially, then create a versioned **DEQR protocol extension** for enterprise security and larger files.

## Recommended DEQR protocol

Each transfer should have three layers.

### 1. File container

```text
DEQR Container
├── Magic: "DEQR"
├── Protocol version
├── Filename
├── MIME type
├── Original file size
├── Compression algorithm
├── Encryption metadata
├── Creation timestamp
├── SHA-256 of original file
└── File bytes
```

### 2. Segmentation layer

The current Decimen implementation documents support for files up to 64 MB. ([GitHub][4])

For DEQR:

* **Phase 1:** maximum 64 MB
* **Phase 2:** segmented transfers up to 250 MB
* **Phase 3:** configurable enterprise maximum

Large files should be divided into independent segments, for example 4–16 MB each. Every segment gets its own fountain block set and hash. This prevents one enormous transfer from consuming excessive RAM and makes recovery easier.

### 3. Optical frames

```text
Frame
├── Protocol version
├── Session ID
├── Segment number
├── Fountain sequence number
├── Block count
├── Block size
├── Total segment length
├── Header checksum/hash
└── Fountain payload
```

## Compression policy

Compression should run only when it actually reduces the payload.

Good candidates:

* TXT
* SQL
* CSV
* LOG
* JSON
* Uncompressed XML

Often already compressed:

* ZIP
* RAR
* XLSX
* DOCX
* Most PDFs
* JPEG
* PNG
* Video files

The existing Decimen behavior similarly applies gzip only when compression makes the payload smaller. ([GitHub][4])

## Transfer performance expectations

The upstream project reports approximately **128 KB/s** in demonstrated phone-to-phone operation, with files currently limited to 64 MB. ([GitHub][4])

At approximately 128 KB/s:

* 1 MB: around 8 seconds
* 10 MB: around 80 seconds
* 25 MB: around 3.3 minutes
* 64 MB: around 8.5 minutes before additional real-world overhead

Actual performance will depend on:

* Display resolution and brightness
* Camera quality
* Autofocus
* Distance and angle
* QR density
* Error-correction level
* Frame rate
* Screen refresh rate
* Receiver decoding performance
* Ambient light
* Compression effectiveness

DEQR should provide profiles such as:

* **Reliable:** lower density and frame rate
* **Balanced:** default
* **Fast:** higher density and frame rate
* **Custom:** advanced configuration

## Security requirements

This point is critical: optical transfer is still a data-transfer channel.

An offline computer can use DEQR to send files outside the isolated environment. Therefore, the application must not treat “no internet” as equivalent to “no data exfiltration.”

The original Decimen implementation explicitly states that its transfer is **not encrypted** and that any camera aimed at the screen can read the transmitted data. Its security property is lack of a network path, not confidentiality. ([GitHub][4])

DEQR should add:

* Optional or mandatory AES-256-GCM payload encryption
* Password-based transfer keys
* Optional organization-managed pre-shared keys
* File-extension allowlist and denylist
* Maximum file-size policy
* Confirmation before transmitting
* User and workstation identification where applicable
* Local audit history
* File SHA-256
* Receiver-side integrity verification
* No automatic opening of received files
* Malware-scanning integration where the isolated environment provides an approved scanner
* Secure deletion of temporary transfer data
* Screen-capture warning
* Automatic blanking when the app loses focus, as an optional high-security setting
* Transfer approval or maker/checker workflow as a later enterprise feature

Executable and script types such as `.exe`, `.dll`, `.ps1`, `.bat`, `.cmd`, `.js`, `.vbs`, and `.msi` should be blocked by default unless explicitly allowed by policy.

## Strict offline behavior

DEQR should inherit AWKIT’s offline controls:

* No remote URLs
* No analytics
* No telemetry
* No update checker
* No cloud fonts
* No CDN libraries
* No external images
* No DNS or HTTP requests
* All JavaScript, WASM, icons, fonts, and assets bundled locally
* Runtime denial of `http`, `https`, `ws`, and `wss`
* Navigation and popup denial
* Offline dependency manifest
* Clean-environment validation

For Electron security:

* `nodeIntegration: false`
* `contextIsolation: true`
* `sandbox: true`
* Strict preload API
* Strict Content Security Policy
* No arbitrary IPC channels
* ASAR packaging and integrity validation
* Electron fuses such as `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`

Electron documents ASAR integrity as runtime verification of the packaged application archive and recommends combining embedded integrity validation with loading only from ASAR. ([Electron][5])

## Portable Windows packaging

`electron-builder` supports a Windows `portable` target that creates a no-install `.exe`, requires no administrator access, does not create Start-menu entries, and is appropriate for USB or no-install scenarios. ([Electron Builder][6])

We should produce two artifacts:

```text
DEQR-Portable-x64.exe
DEQR-Portable-x64.sha256
```

Optionally:

```text
DEQR-Offline-Bundle.zip
├── DEQR-Portable-x64.exe
├── checksums.sha256
├── LICENSES/
├── SECURITY.md
├── USER-GUIDE.pdf
└── validation-manifest.json
```

Code signing is still recommended even for isolated systems, because it allows users and administrators to verify that the executable has not been replaced.

## AWKIT-aligned UI

### Dashboard

Four principal cards:

* Send File
* Receive File
* Transfer History
* Settings

### Send File screen

```text
┌────────────────────────────────────────────────────┐
│ Select or drop a file                              │
├────────────────────────────────────────────────────┤
│ Filename      monthly-report.xlsx                  │
│ Type          Excel Workbook                       │
│ Size          8.4 MB                               │
│ SHA-256       0F7A...93CD                           │
│ Compression   Not beneficial                       │
│ Encryption    Enabled                              │
│ Profile       Balanced                             │
│ Estimated     ~75 seconds                          │
├────────────────────────────────────────────────────┤
│               [Start Optical Transfer]             │
└────────────────────────────────────────────────────┘
```

### Active-transfer screen

* Large centered QR stream
* Full-screen mode
* Session ID
* File name and size
* Current frame rate
* Effective transfer rate
* Estimated progress
* Elapsed time
* Pause
* Restart with new session
* Cancel
* Brightness guidance
* “Keep receiver camera steady” status

The QR must remain visually dominant. AWKIT-style sidebars and configuration panels should collapse automatically during transfer.

### Receive screen

* Camera selector
* Camera preview
* QR detection indicator
* Session information
* Frames received
* Estimated completion
* Segment progress
* Integrity verification
* Save location
* Final SHA-256 result

### History

* Sent/received
* Filename
* Size
* Timestamp
* Duration
* Result
* SHA-256
* Encryption status
* Session ID

History should never store the transferred file content unless explicitly configured.

## Development phases

### Phase 0 — Repository and requirements

* Create DEQR repository
* Reuse approved AWKIT Electron shell and design system
* Record Decimen attribution and MIT license
* Define threat model
* Define supported Windows versions
* Define initial file-size limit
* Define sender/receiver scope

### Phase 1 — Optical-core proof

* Import and isolate Decimen protocol modules
* Encode arbitrary local files
* Render animated QR frames
* Build a compatible browser/test receiver
* Verify byte-perfect reconstruction
* Add SHA-256 validation
* Test TXT, PDF, DOCX, XLSX, ZIP, RAR, MSG, SQL, and LOG

### Phase 2 — Desktop application

* Electron shell
* AWKIT-style UI
* File picker and drag/drop
* Send workflow
* Receive workflow
* Camera integration
* Settings
* Local history
* Portable packaging

### Phase 3 — Security hardening

* Payload encryption
* Policy engine
* Extension controls
* Audit logging
* Temporary-data cleanup
* Electron fuses
* ASAR integrity
* Network blocking
* Code signing
* Dependency audit

### Phase 4 — Performance

* Worker-based QR generation
* Worker-pool decoding
* Adaptive FPS
* Adaptive QR density
* Camera capability probing
* Large-file segmentation
* Memory profiling
* Long-running transfer tests

### Phase 5 — Offline validation

* Clean Windows Sandbox/VM
* Network adapters disabled
* No cached dependencies
* Portable execution without admin rights
* Send/receive interoperability
* Corrupted and missing-frame scenarios
* Low-quality camera tests
* Interrupted transfer tests
* Hash mismatch tests
* Security-policy tests

## Initial acceptance criteria

The first usable DEQR release should meet these conditions:

1. Runs as a portable `.exe` without installation or administrator rights.
2. Makes zero network requests.
3. Accepts any permitted file as binary data.
4. Successfully transfers files up to 64 MB.
5. Preserves filename and extension.
6. Verifies the received bytes using SHA-256.
7. Handles dropped and out-of-order QR frames.
8. Never opens received files automatically.
9. Supports sender and receiver modes.
10. Works after the network adapters are disabled.
11. Contains all required JavaScript, WASM, fonts, and assets locally.
12. Provides clear local audit records without retaining file contents.
13. Uses the approved AWKIT visual design and desktop interaction patterns.
14. Includes required Decimen MIT attribution.

The best implementation strategy is therefore **not to rebuild the optical protocol from zero**. We should reuse and independently validate the Decimen fountain/protocol core, wrap it in an AWKIT-derived Electron architecture, and add the security, segmentation, policy, offline packaging, and enterprise controls required for an isolated environment.

[1]: https://github.com/bashalarmistalt/decimen-optical-transfer/blob/main/docs/technical/protocol.md "decimen-optical-transfer/docs/technical/protocol.md at main · bashalarmistalt/decimen-optical-transfer · GitHub"
[2]: https://github.com/bashalarmistalt/decimen-optical-transfer/blob/main/docs/technical/architecture.md "decimen-optical-transfer/docs/technical/architecture.md at main · bashalarmistalt/decimen-optical-transfer · GitHub"
[3]: https://github.com/bashalarmistalt/decimen-optical-transfer/blob/main/LICENSE "decimen-optical-transfer/LICENSE at main · bashalarmistalt/decimen-optical-transfer · GitHub"
[4]: https://github.com/bashalarmistalt/decimen-optical-transfer "GitHub - bashalarmistalt/decimen-optical-transfer · GitHub"
[5]: https://www.electronjs.org/docs/latest/tutorial/asar-integrity?utm_source=chatgpt.com "ASAR Integrity | Electron"
[6]: https://www.electron.build/docs/targets/?utm_source=chatgpt.com "Target Selection Guide | electron-builder"
