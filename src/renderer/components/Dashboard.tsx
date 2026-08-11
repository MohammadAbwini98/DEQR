import React from 'react';

interface Props {
  onSelectFile: () => void;
  onReceiveFile: () => void;
  isSelecting: boolean;
  error: string | null;
}

export default function Dashboard({ onSelectFile, onReceiveFile, isSelecting, error }: Props) {
  return (
    <section className="card" aria-labelledby="dashboard-title">
      <div>
        <h1 id="dashboard-title">DEQR Optical Transfer</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>
          Transfer files offline using an optical QR stream.
        </p>
      </div>

      <div className="dashboard-actions">
        <button className="action-card primary" onClick={onSelectFile} disabled={isSelecting}>
          <strong>{isSelecting ? 'Opening file picker…' : 'Send File'}</strong>
          <span>Select a permitted file up to 64 MB and start an optical transfer.</span>
        </button>
        <button className="action-card" onClick={onReceiveFile}>
          <strong>Receive File</strong>
          <span>Use a local camera to decode a DEQR transfer and verify its integrity.</span>
        </button>
      </div>

      {error && (
        <div className="status-message error" role="alert">
          {error}
        </div>
      )}

      <footer style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
        DEQR 0.1.0 · Offline mode · Ready for a local transfer
      </footer>
    </section>
  );
}
