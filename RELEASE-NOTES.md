# DEQR Release Notes

## 0.1.0 — Large-File / Maximum-Speed architecture

### What changed

DEQR's transfer path was rebuilt so that **no component ever holds the file.**
The previous design read a file into memory, containerised it, fountain-coded
the buffer and displayed the result, which put a practical ceiling near 32 MB on
both sides — and made that ceiling a memory limit rather than a protocol one.

- **A new optical wire format, v2.** Segmented, with a session manifest frame and
  per-segment systematic-first fountain coding, so the unit of recovery is a
  segment rather than the whole transfer. Specified normatively in
  `.ai-team/engineering/PROTOCOL-V2.md`.
- **A streaming sender.** The desktop reads windows off disk at 64-bit offsets
  and never materialises the file.
- **A receiver that writes to disk, not to a tab.** Each recovered segment goes
  straight to its final offset in a pre-sized OPFS file; at most two segments are
  in memory at once. Export hands over a `File` that references the OPFS entry,
  so the share sheet reads from disk.
- **Integrity without the file.** `crypto.subtle.digest` needs its whole input
  resident, so DEQR ships an incremental SHA-256 that runs over bounded windows
  read back from storage.
- **Resume.** The receiver adopts its own checkpoint automatically. Across the
  air gap the sender is told where to restart by a 40-character code the user
  carries by hand.
- **Content-based compression.** The decision is made from sampled bytes and has
  no parameter that could carry a filename, so no file extension can influence
  the transport. In GZIP mode the stream is a container of independently
  decodable windows, which is what lets compression survive out-of-order
  recovery and resume.
- **Transport profiles.** Reliable, Balanced, Turbo and Experimental, each a QR
  version, ECC level, payload size and target frame rate.
- **Storage preflight.** The receiving file is pre-sized before a payload byte is
  written, so a device without room fails at the start rather than at 90%.

### Release claim

> **DEQR has no 32 MB protocol-level limit.** The architecture is streaming and
> multi-gigabyte safe: a 4 GiB transfer has been verified end to end, byte for
> byte, with receiver memory held flat at 1.34 MiB and sender memory at 1.37 MiB.
>
> **Certified maximum transfer size: 0 bytes.** No size has been certified on a
> physical device. The supported maximum is defined as the largest size that
> passes the current release's physical-device certification matrix and the
> receiver's available-storage preflight, and that matrix has not been run.

Those two statements are both true and neither replaces the other. DEQR does not
claim an unlimited file size, and it does not claim a maximum speed.

### Measured performance

Verified throughput at zero loss, from the automated certification harness:

| Profile | Verified B/s | 8 MiB | 64 MiB | 1 GiB |
|---|---|---|---|---|
| Reliable | 1,195 | 1.95 h | 15.6 h | 250 h |
| Balanced | 4,631 | 30 min | 4.0 h | 64.4 h |
| Turbo | 9,763 | 14 min | 1.9 h | 30.5 h |

**1 GiB at Balanced is a 64-hour continuous scan.** Plan accordingly: a phone on
a stand, mains power at both ends, and every sleep, screen-dim and auto-lock
disabled on both devices.

Small files move faster per byte — 1 MiB at 7,864 B/s against 100 MiB at 4,631 —
entirely because the receiver completes before the repair symbols are sent. A
small-file rate is not the product's rate.

### Known limitations

- **No physical-device certification.** Seven named gates are open, including iOS
  Safari's OPFS behaviour, the share-sheet export size limit, camera and thermal
  behaviour over a multi-hour transfer, and the resume code being read aloud by a
  person. See `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md`.
- **The default transport profile is not certified.** Which profile should be the
  default depends on camera pixels per QR module at a realistic scanning
  distance, and no one has measured it on a phone.
- **43% of a clean link carries repair symbols nobody needed.** The repair budget
  is emitted unconditionally because there is no back channel. Removing it is
  worth 1.78×, and it is a protocol change, so it is recorded rather than done.
- **Loss fails as a cliff.** `(1 + r)(1 − p) ≥ 1.05`. Above 40% frame loss at
  Balanced, no number of sender passes completes a transfer.
- **Payload encryption is not implemented.** The container reserves the flag and
  the receiver refuses anything marked encrypted.
- **`frame-ancestors` is not enforced in the development server.** The packaged
  desktop host delivers CSP as a real response header, where it is enforced; a
  `<meta>` tag cannot carry that directive. Any other deployment of the PWA must
  serve the header itself.

### Upgrade and migration

- **Service worker / shell cache.** The receiver's cache is `deqr-mobile-shell-v4`.
  On activation it deletes every earlier `deqr-mobile-*` cache, so no previous
  release's shell can survive an update. The document is fetched network-first,
  so a reachable host always wins.
- **Upgrading an installed receiver.** Open it once while the desktop host is
  reachable. That single online load is what populates the new cache; it is
  automatic and needs no action.
- **v1 transfers still work.** The desktop sender emits v2 for every optical
  transfer, and the receiver accepts both v1 and v2. A phone updates
  independently of the desktop it scans, so v1 decoding is retained on purpose.
  A v1 frame is never reinterpreted as v2.
- **Checkpoints.** A checkpoint written under a schema this build does not know
  is refused and its session data deleted, so the transfer starts clean rather
  than resuming onto bytes whose meaning may have changed. Checkpoints from a
  compatible release resume normally.
- **Abandoned session data** is swept when a session opens, bounded by both age
  and count.

### Rollback

Packaged artifacts are recorded with their SHA-256 and the commit they were built
from. `npm run release:verify` re-checks the files on disk against that manifest
and warns when HEAD has moved past them; `npm run release:list` shows what was
built when. To roll back, reinstall an earlier recorded artifact.

On the receiver, rolling the desktop host back to a build whose shell is older
is safe: the service worker's `activate` removes newer caches by the same rule
that removes older ones, and the document is fetched network-first. An installed
phone follows whatever the host is serving.

---

*Nothing in this document, the product, or any listing may claim a maximum file
size or a maximum speed until the physical certification matrix has rows in it.*
