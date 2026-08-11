import React from 'react';
import PwaHostCard from './PwaHostCard';

interface Props {
  onSelectFile: () => void;
  onReceiveFile: () => void;
  isSelecting: boolean;
  error: string | null;
  notice: string;
}

export default function Dashboard({ onSelectFile, onReceiveFile, isSelecting, error, notice }: Props) {
  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <div className="dashboard-intro">
        <p className="eyebrow">Private by design</p>
        <h1 id="dashboard-heading" data-screen-heading tabIndex={-1}>DEQR Optical Transfer</h1>
        <p className="lede">Move a verified file between isolated devices through a high-contrast animated QR stream.</p>
        <p className="capacity-copy">DEQR v1 supports a serialized transfer below <strong>32 MiB</strong>. Choose a source file slightly smaller to leave room for required metadata.</p>
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
