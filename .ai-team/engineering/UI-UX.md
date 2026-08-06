# DEQR UI/UX Design Specification

## Status
- **M1 Screens**: PROPOSED — Implementation-ready specifications below
- **M2 Screens**: DEFERRED — Documented for future reference
- **AWKIT Alignment**: PROPOSED — Dark-first theme with AWKIT-derived design tokens, pending Product Owner approval of visual language

---

## M1 Screen Specifications

### Screen 1: Dashboard

**Purpose**: Primary navigation hub.

**Layout**:
- AWKIT-style dark card grid layout with centered content area
- Two primary action cards arranged horizontally:
  - **Send File** — Icon + label, navigates to Send workflow
  - **Receive File** — Icon + label, navigates to Receive workflow (loopback in M1)
- Bottom status bar: application version, last transfer timestamp

**States**:
- **Empty**: First launch — welcome text, both cards enabled
- **Post-transfer**: Cards enabled, last transfer result summary shown

---

### Screen 2: Send File

**Purpose**: Select a file, inspect metadata, configure transfer, and initiate optical stream.

**Layout**:
```text
┌────────────────────────────────────────────────────┐
│  ← Back to Dashboard                               │
├────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Drop a file here, or click to browse        │  │
│  │          (file picker / drag-drop zone)       │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Filename      monthly-report.xlsx            │  │
│  │  Type          application/vnd.openxml...     │  │
│  │  Size          8.4 MB                         │  │
│  │  SHA-256       0F7A...93CD                    │  │
│  │  Compression   Not beneficial (skipped)       │  │
│  │  Profile       Balanced                       │  │
│  │  Estimated     ~75 seconds                    │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│           [ Start Optical Transfer ]                │
│                                                     │
├────────────────────────────────────────────────────┤
│  ⚠ .exe files are blocked by security policy       │
└────────────────────────────────────────────────────┘
```

**States**:
- **Empty**: No file selected — drop zone prominent, Start button disabled
- **File Selected**: Metadata card populated, Start button enabled
- **Blocked Extension**: File selected but blocked by policy — warning banner, Start disabled
- **Oversized File**: File >64 MB selected — error banner with size limit message, Start disabled
- **Computing Hash**: SHA-256 calculation in progress — spinner on hash field
- **Ready**: All checks passed — Start button enabled with accent color

---

### Screen 3: Active Transfer (QR Stream)

**Purpose**: Display the animated QR code sequence during active sending.

**Critical Rule**: The QR code canvas MUST be the visually dominant element. All metadata and controls collapse to a minimal overlay or sidebar.

**Layout**:
```text
┌────────────────────────────────────────────────────┐
│  DEQR — Sending: monthly-report.xlsx     [■ Close] │
├────────────────────────────────────────────────────┤
│                                                     │
│                                                     │
│              ┌──────────────────┐                   │
│              │                  │                   │
│              │   Animated QR    │                   │
│              │   Canvas         │                   │
│              │   (dominant)     │                   │
│              │                  │                   │
│              └──────────────────┘                   │
│                                                     │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░  62%               │
│  Frame 1247 / ~2000  │  18 FPS  │  ~42 sec left    │
│                                                     │
│         [ ⏸ Pause ]    [ ✕ Cancel ]                 │
└────────────────────────────────────────────────────┘
```

**States**:
- **Streaming**: QR animating, progress bar advancing, frame counter incrementing
- **Paused**: QR frozen on current frame, "Resume" button replaces Pause
- **Cancelling**: Confirmation dialog: "Cancel transfer? Data will be lost."
- **Cancelled**: Return to Send File screen with "Transfer cancelled" message

---

### Screen 4: Receive File (M1 Loopback)

**Purpose**: In M1, display loopback decode verification results. In M2, this becomes the camera capture screen.

**M1 Layout**:
```text
┌────────────────────────────────────────────────────┐
│  ← Back to Dashboard                               │
├────────────────────────────────────────────────────┤
│                                                     │
│  Loopback Transfer Verification                     │
│                                                     │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  100%            │
│  Frames decoded: 2048 / 2048                        │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Original SHA-256:    0F7A...93CD             │  │
│  │  Received SHA-256:    0F7A...93CD             │  │
│  │  Status:              ✅ VERIFIED MATCH       │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│         [ Save Received File ]                      │
│                                                     │
└────────────────────────────────────────────────────┘
```

**States**:
- **Decoding**: Progress bar advancing, frame counter incrementing
- **Verifying**: Hash comparison in progress — spinner
- **Verified Match**: Green success banner, Save button enabled
- **Hash Mismatch**: Red error banner: "File integrity check FAILED. The reconstructed file does not match the original." Save button disabled.
- **Decode Error**: Orange warning: "Insufficient frames collected for reconstruction." Retry suggestion.

---

### Screen 5: Transfer Result

**Purpose**: Final summary after a completed or failed transfer.

**States**:
- **Success**: Green banner, file details, SHA-256 verification confirmed, duration, option to start new transfer
- **Failure**: Red banner, error type (hash mismatch, cancellation, decode error), details, option to retry or return to dashboard

---

## Interaction Patterns

### Navigation
- Back button always returns to previous screen
- Dashboard is the root
- Active transfer cannot be navigated away from without explicit cancel

### Keyboard Accessibility
- All interactive elements must be keyboard-focusable (Tab order)
- Enter/Space activates buttons
- Escape triggers cancel confirmation during active transfer
- Focus ring visible on all focusable elements (2px solid accent color)

### Semantic HTML
- Use `<main>`, `<nav>`, `<section>`, `<article>` appropriately
- All images/icons have `aria-label` or `alt` text
- Progress bars use `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
- Status messages use `role="status"` or `role="alert"` for screen readers

---

## Design Tokens Reference
See `.ai-team/engineering/BRANDING.md` for CSS variable definitions.

Key token usage:
- Background: `--deqr-bg-dark` (#0f141c)
- Card surfaces: `--deqr-surface-card` (#18202c)
- Accent / primary actions: `--deqr-accent-cyan` (#00f2fe) → `--deqr-accent-blue` (#4facfe) gradient
- Success: `--deqr-status-success` (#10b981)
- Warning: `--deqr-status-warning` (#f59e0b)
- Error: `--deqr-status-danger` (#ef4444)
- Text primary: `--deqr-text-primary` (#f8fafc)
- Font: Inter, system fallback stack
