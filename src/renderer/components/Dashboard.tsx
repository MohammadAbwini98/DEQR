import React from 'react';
import PwaHostCard from './PwaHostCard';

interface Props {
  onSelectFile: () => void;
  onResumeTransfer: () => void;
  onReceiveFile: () => void;
  isSelecting: boolean;
  error: string | null;
  notice: string;
}

export default function Dashboard({
  onSelectFile,
  onResumeTransfer,
  onReceiveFile,
  isSelecting,
  error,
  notice,
}: Props) {
  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <div className="dashboard-intro">
        <p className="eyebrow">Private by design</p>
        <h1 id="dashboard-heading" data-screen-heading tabIndex={-1}>DEQR Optical Transfer</h1>
        <p className="lede">Move a verified file between isolated devices through a high-contrast animated QR stream.</p>
        {/* This line used to assert a 32 MiB ceiling. That was true of the v1
            container, which had to be held whole in memory at both ends, and
            stopped being true when the sender began streaming segments off disk
            and the receiver began writing them straight to device storage. What
            bounds a transfer now is time and the receiving device's free space,
            and both of those are shown for the actual file after it is read. */}
        <p className="capacity-copy">
          Files are sent as a stream of independently verified segments, so size is limited by the time you
          are willing to spend and by the room on the receiving device — not by a fixed ceiling. Both figures
          are shown for your file before anything is displayed.
        </p>
      </div>

      <div className="action-grid">
        <article className="action-card">
          <div className="action-icon" aria-hidden="true">↑</div>
          <div>
            <h2>Send a file</h2>
            <p>Prepare a local file, show the animated QR code, and keep the transfer fully offline.</p>
          </div>
          <button className="primary" onClick={onSelectFile} disabled={isSelecting}>
            {isSelecting ? 'Opening file picker…' : 'Choose file'}
          </button>
        </article>

        {/* The desktop half of the resume path Phase 07 built. Without an entry
            point here, a receiver could display a resume code that nothing was
            able to accept. */}
        <article className="action-card">
          <div className="action-icon action-icon--resume" aria-hidden="true">↻</div>
          <div>
            <h2>Resume a transfer</h2>
            <p>Enter the code shown by a device that already received part of a file, and continue from there.</p>
          </div>
          <button className="secondary" onClick={onResumeTransfer}>Enter resume code</button>
        </article>

        <article className="action-card">
          <div className="action-icon action-icon--receive" aria-hidden="true">↓</div>
          <div>
            <h2>Receive on this desktop</h2>
            <p>Use the local camera receiver for a controlled desktop receive or verification workflow.</p>
          </div>
          <button className="secondary" onClick={onReceiveFile}>Open receiver</button>
        </article>
      </div>

      <PwaHostCard />

      <p className="privacy-note" role="status">{notice}</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
    </section>
  );
}
