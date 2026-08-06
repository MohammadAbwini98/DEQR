import React from 'react';

interface Props {
  onSelectFile: () => void;
  onReceiveFile: () => void;
  isSelecting: boolean;
  error: string | null;
}

export default function Dashboard({ onSelectFile, onReceiveFile, isSelecting, error }: Props) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <h1>DEQR Optical Transfer</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
        Select a file up to 64MB to begin an air-gapped optical transfer.
      </p>
      
      <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
        <button 
          className="primary" 
          style={{ padding: '16px 32px', fontSize: '18px' }} 
          onClick={onSelectFile}
          disabled={isSelecting}
        >
          {isSelecting ? 'Opening...' : 'Send File'}
        </button>

        <button 
          className="secondary" 
          style={{ padding: '16px 32px', fontSize: '18px' }} 
          onClick={onReceiveFile}
        >
          Receive File
        </button>
      </div>

      {error && (
        <div style={{ marginTop: '16px', color: 'var(--accent-danger)', padding: '12px', border: '1px solid var(--accent-danger)', borderRadius: 'var(--radius-md)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
