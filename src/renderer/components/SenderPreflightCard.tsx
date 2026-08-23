import React from 'react';
import {
  DEFAULT_TRANSPORT_PROFILE,
  TRANSPORT_PROFILES,
  nominalBytesPerSecond,
  transportProfileById,
  type TransportProfile,
} from '../../core/transport-profiles';
import type { StreamingTransferMetadata } from '../../shared/types';
import {
  formatByteString,
  formatDuration,
  formatRate,
  nominalTransferSeconds,
  parseByteCount,
  summarizeCompression,
} from '../sender-model';

/**
 * What the user is shown before a single frame is drawn.
 *
 * The screen this replaces said one thing about the file - its size - and then
 * asserted a 32 MiB ceiling that stopped being true two phases ago. The
 * decisions that actually shape the next several minutes were all made during
 * preflight and none of them were visible: whether the bytes were compressed
 * and by how much, how much has to cross the optical link as opposed to how
 * much the file weighs, which profile is driving the display, and - for a
 * resumed transfer - how much of the file the receiver already has.
 *
 * Every figure here comes from `StreamingTransferMetadata`, which is measured
 * during preflight rather than estimated. The one exception is the transfer
 * time, which is derived from the profile's nominal rate and is labelled as an
 * estimate wherever it appears, because no profile in this build has been
 * certified against a real camera.
 */

interface Props {
  metadata: StreamingTransferMetadata;
  /** Profile the user has chosen for the *next* selection. */
  selectedProfileId: number;
  onSelectProfile: (id: number) => void;
  onStart: () => void;
  onChooseAnother: () => void;
  onRunLoopback: () => void;
  /** Disables the controls while a re-selection is in flight. */
  busy: boolean;
}

const SELECTABLE_PROFILES: readonly TransportProfile[] = TRANSPORT_PROFILES.filter(
  (profile) => profile.productionSelectable,
);

export default function SenderPreflightCard({
  metadata,
  selectedProfileId,
  onSelectProfile,
  onStart,
  onChooseAnother,
  onRunLoopback,
  busy,
}: Props) {
  const compression = summarizeCompression(metadata);
  const transportSize = parseByteCount(metadata.transportSizeBytes);
  // The profile the session was actually opened with, which is not necessarily
  // the one the selector shows: the main process falls back when asked for one
  // it will not honour, and the card must report what is on the wire.
  const activeProfile = transportProfileById(metadata.transportProfileId) ?? DEFAULT_TRANSPORT_PROFILE;
  const estimateSeconds = nominalTransferSeconds(transportSize, nominalBytesPerSecond(activeProfile));

  return (
    <section className="preflight-card" aria-labelledby="preflight-heading">
      <div className="section-heading">
        <p className="eyebrow">{metadata.resumed ? 'Resume transfer' : 'Send file'}</p>
        <h1 id="preflight-heading" data-screen-heading tabIndex={-1}>
          {metadata.resumed ? 'Ready to resume' : 'Ready to transfer'}
        </h1>
        <p>
          The file was read once to compute its hash and decide how it travels. Review this, then present
          the QR stream to the receiving camera.
        </p>
      </div>

      <article className="file-card">
        <div className="file-card-name">
          <span className="file-card-icon" aria-hidden="true">▤</span>
          <div>
            <strong title={metadata.filename}>{metadata.filename}</strong>
            <span className="monospace file-card-hash">SHA-256 {metadata.sha256.slice(0, 16)}…</span>
          </div>
        </div>

        <dl className="size-grid">
          <div>
            <dt>File size</dt>
            <dd>{formatByteString(metadata.originalSizeBytes)}</dd>
          </div>
          <div>
            {/* The second size only earns its place when it differs. Showing
                two identical numbers side by side teaches a reader that the
                distinction is decorative, and then they stop reading it on the
                transfer where it matters. */}
            <dt>{compression.active ? 'Sent over the link' : 'Optical payload'}</dt>
            <dd>
              {formatByteString(metadata.transportSizeBytes)}
              {compression.ratioText && <span className="size-delta"> · {compression.ratioText} of original</span>}
            </dd>
          </div>
          <div>
            <dt>Segments</dt>
            <dd>
              {metadata.segmentCount.toLocaleString()}
              {metadata.resumed && metadata.resumeFromSegment > 0 && (
                <span className="size-delta"> · resuming at {(metadata.resumeFromSegment + 1).toLocaleString()}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Estimated time</dt>
            {/* Nominal: the profile's own rate, with no camera in the loop. The
                transfer screen replaces it with a measured one. */}
            <dd>{estimateSeconds === null ? '—' : `about ${formatDuration(estimateSeconds * 1000)}`}</dd>
          </div>
        </dl>

        <p className={`compression-note compression-note--${compression.active ? 'on' : 'off'}`}>
          <strong>{compression.label}.</strong> {compression.detail}
        </p>
      </article>

      {metadata.resumed && (
        <aside className="resume-note" aria-label="Resumed transfer">
          <span aria-hidden="true">↻</span>
          <p>
            This pass starts at segment {(metadata.resumeFromSegment + 1).toLocaleString()} of{' '}
            {metadata.segmentCount.toLocaleString()}. The receiver already holds everything before it, and
            will still verify the whole file&apos;s hash before offering to save it.
          </p>
        </aside>
      )}

      <fieldset className="profile-selector" disabled={busy}>
        <legend>Transport profile</legend>
        <p className="profile-hint">
          Applies to the next file you choose. This transfer is running on <strong>{activeProfile.name}</strong>.
        </p>
        <div className="profile-options">
          {SELECTABLE_PROFILES.map((profile) => (
            <label key={profile.id} className={`profile-option${selectedProfileId === profile.id ? ' profile-option--active' : ''}`}>
              <input
                type="radio"
                name="transport-profile"
                value={profile.id}
                checked={selectedProfileId === profile.id}
                onChange={() => onSelectProfile(profile.id)}
              />
              <span className="profile-option-body">
                <strong>
                  {profile.name}
                  {profile.id === DEFAULT_TRANSPORT_PROFILE.id && <span className="profile-badge">Default</span>}
                </strong>
                <span className="profile-summary">{profile.summary}</span>
                <span className="profile-numbers">
                  {formatRate(nominalBytesPerSecond(profile))} nominal · needs {profile.minCameraPxPerModule} camera
                  pixels per module
                </span>
              </span>
            </label>
          ))}
        </div>
        {/* Not a disclaimer bolted on. No profile in this build has been put in
            front of a real camera, and a selector that implied otherwise would
            be the most consequential false claim on the screen. */}
        <p className="profile-caveat">
          These rates are what the display puts out, not what a receiver verifies. No profile has been
          certified against a physical camera yet.
        </p>
      </fieldset>

      <div className="action-row">
        <button className="primary" onClick={onStart} disabled={busy}>
          {metadata.resumed ? 'Resume optical transfer' : 'Start optical transfer'}
        </button>
        <button className="tertiary" onClick={onChooseAnother} disabled={busy}>Choose another file</button>
      </div>

      <details className="advanced-disclosure">
        <summary>Advanced local verification</summary>
        <p>
          Run a local decoder against a separately prepared stream with simulated frame loss. This is a
          self-test of the optical container and does not replace a physical camera test.
        </p>
        <button className="secondary" onClick={onRunLoopback} disabled={busy}>Run local verification</button>
      </details>
    </section>
  );
}
