# DEQR UI/UX Design System Specification

## Visual Layout & Screen Architecture
Aligned with AWKIT custom desktop window frame, navigation sidebar, card containers, and collapsible control panels.

### Screen 1: Dashboard
- Four main navigation cards: **Send File**, **Receive File**, **Transfer History**, **Settings**.

### Screen 2: Send File Workflow
- Drag-and-drop / file picker zone.
- File metadata inspector card (Filename, Type, Size, SHA-256 hash, Compression evaluation, Encryption toggle, Density profile selector, Estimated transfer time).
- Primary Action button: `[Start Optical Transfer]`.

### Screen 3: Active Optical Transfer View
- Centered, dominant animated QR canvas stream.
- Fullscreen mode toggle.
- Collapsible progress sidebar (Session ID, Frame sequence count, Current FPS, Effective throughput KB/s, Elapsed time, Pause/Resume, Cancel).

### Screen 4: Receive View
- Camera selection dropdown & camera preview viewfinder.
- QR alignment box & drop-frame indicator.
- Live progress bar & segment assembly counter.
- Completion verification card showing final SHA-256 hash matching and target output save directory picker.

## User States
All views must implement: Empty State, Loading/Scanning State, Active Stream State, Success Verification State, Warning State, and Error State.
