import React from 'react';

interface Props {
  onSelectFile: () => void;
  isSelecting: boolean;
  error: string | null;
}

export default function Dashboard({ onSelectFile, isSelecting, error }: Props) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <h1>DEQR Optical Transfer</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
        Select a file up to 64MB to begin an air-gapped optical transfer.
      </p>
      
      <button 
        className="primary" 
        style={{ padding: '16px 32px', fontSize: '18px', margin: '0 auto', display: 'block' }} 
        onClick={onSelectFile}
        disabled={isSelecting}
      >
        {isSelecting ? 'Opening...' : 'Select File'}
      </button>

      {error && (
        <div style={{ marginTop: '16px', color: 'var(--accent-danger)', padding: '12px', border: '1px solid var(--accent-danger)', borderRadius: 'var(--radius-md)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
