import React, { useEffect, useState } from 'react';
import { TransferState, FileSelectionResult } from '../shared/types';
import Dashboard from './components/Dashboard';
import QRCanvas from './components/QRCanvas';
import LoopbackView from './components/LoopbackView';
import CameraReceiver from './components/CameraReceiver';
import { estimateMinimumStreamSeconds, formatFileSize, getIpcErrorMessage } from './ui-model';

export default function App() {
  const [state, setState] = useState<TransferState>('idle');
  const [session, setSession] = useState<FileSelectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCancelConfirmationOpen, setIsCancelConfirmationOpen] = useState(false);
  const [completedReceive, setCompletedReceive] = useState(false);

  const handleSelectFile = async () => {
    try {
      setError(null);
      setState('selecting-file');
      const res = await window.deqr.files.selectForTransfer();
      const ipcError = getIpcErrorMessage(res);
      if (ipcError) throw new Error(ipcError);
      if (res && res.sessionId) {
        setSession(res);
        setState('file-selected');
      } else {
        setState('idle');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to select file');
      setState('failed');
    }
  };

  const handleStartTransfer = async () => {
    if (!session) return;
    try {
      setState('preparing');
      const result = await window.deqr.transfer.start(session.sessionId);
      const ipcError = getIpcErrorMessage(result);
      if (ipcError) throw new Error(ipcError);
      setState('streaming');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Transfer failed');
      setState('failed');
    }
  };

  const handleStartLoopback = async () => {
    if (!session) return;
    try {
      setState('preparing');
      const result = await window.deqr.loopback.start(session.sessionId, {
        lossPercentage: 30,
        shuffle: true,
        duplicateInjection: false,
      });
      const ipcError = getIpcErrorMessage(result);
      if (ipcError) throw new Error(ipcError);
      setState('loopback-receiving');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Loopback failed');
      setState('failed');
    }
  };

  const handleReceiveFile = () => {
    setError(null);
    setState('receive-camera');
  };

  const handleVerifiedReceive = async (payload: Uint8Array, metadata: { filename: string }) => {
    setState('verifying');
    const success = await window.deqr.receive.saveReceivedFile(payload, metadata.filename);
    if (success) {
      setCompletedReceive(true);
      setState('completed');
    } else {
      setError('The received file could not be saved. Its integrity was not accepted as a successful transfer.');
      setState('failed');
    }
  };

  const handleCancel = async () => {
    if (session) {
      try {
        await window.deqr.transfer.cancel(session.sessionId);
        await window.deqr.loopback.cancel(session.sessionId);
      } catch {
        // Sessions can have already ended; the UI still returns to a safe idle state.
      }
    }
    setSession(null);
    setIsCancelConfirmationOpen(false);
    setState('idle');
  };

  const requestCancel = () => setIsCancelConfirmationOpen(true);

  const returnToDashboard = () => {
    setCompletedReceive(false);
    setSession(null);
    setError(null);
    setState('idle');
  };

  useEffect(() => {
    const isCancellable = state === 'streaming' || state === 'loopback-receiving' || state === 'receive-camera';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isCancellable && !isCancelConfirmationOpen) {
        event.preventDefault();
        setIsCancelConfirmationOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCancelConfirmationOpen, state]);

  return (
    <div className="app-container">
      <header className="titlebar" aria-label="Window controls">
        <div className="titlebar-title">DEQR — Optical Transfer</div>
        <div className="titlebar-controls">
          <button className="titlebar-button" aria-label="Minimize window" onClick={() => window.deqr.windowControls.minimize()}>-</button>
          <button className="titlebar-button" aria-label="Maximize or restore window" onClick={() => window.deqr.windowControls.maximizeOrRestore()}>□</button>
          <button className="titlebar-button close" aria-label="Close window" onClick={() => window.deqr.windowControls.close()}>×</button>
        </div>
      </header>

      <main className="content">
        {(state === 'idle' || state === 'selecting-file' || state === 'failed') && (
          <Dashboard
            onSelectFile={handleSelectFile}
            onReceiveFile={handleReceiveFile}
            error={error}
            isSelecting={state === 'selecting-file'}
          />
        )}

        {state === 'file-selected' && session && (
          <section className="card" aria-labelledby="send-ready-title">
            <div>
              <h2 id="send-ready-title">Ready to Transfer</h2>
              <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Review the transfer details before displaying the optical stream.</p>
            </div>
            <dl className="metadata-grid">
              <dt>Filename</dt><dd>{session.metadata.filename}</dd>
              <dt>Type</dt><dd>{session.metadata.mimeType}</dd>
              <dt>Size</dt><dd>{formatFileSize(session.metadata.size)}</dd>
              <dt>SHA-256</dt><dd>{session.metadata.sha256}</dd>
              <dt>Compression</dt><dd>{session.metadata.compressed ? 'Applied' : 'Not applied'}</dd>
              <dt>Stream profile</dt><dd>Fixed 30 FPS; selectable profiles are not yet implemented.</dd>
              <dt>Estimated lower bound</dt><dd>{estimateMinimumStreamSeconds(session.metadata.size).toFixed(1)} seconds before container and frame-recovery overhead.</dd>
            </dl>
            <div className="button-row">
              <button className="primary" onClick={handleStartTransfer}>Start Optical Transfer</button>
              <button onClick={handleStartLoopback}>Run Loopback Test (30% Loss)</button>
              <button className="danger" onClick={requestCancel}>Cancel</button>
            </div>
          </section>
        )}

        {state === 'streaming' && session && <QRCanvas sessionId={session.sessionId} onCancel={requestCancel} />}
        {state === 'loopback-receiving' && session && <LoopbackView sessionId={session.sessionId} onCancel={requestCancel} />}
        {state === 'receive-camera' && <CameraReceiver onCancel={requestCancel} onVerified={handleVerifiedReceive} />}

        {state === 'completed' && completedReceive && (
          <section className="card" aria-labelledby="result-title">
            <div className="status-message success" role="status">
              <h2 id="result-title">Transfer Verified</h2>
              <p style={{ marginTop: '8px' }}>The received payload passed SHA-256 verification and was saved through the native file dialog.</p>
            </div>
            <p style={{ color: 'var(--text-secondary)' }}>The native save dialog uses the verified filename from the received container.</p>
            <div className="button-row">
              <button className="primary" onClick={handleReceiveFile}>Receive Another</button>
              <button onClick={returnToDashboard}>Return to Dashboard</button>
            </div>
          </section>
        )}
      </main>

      {isCancelConfirmationOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section className="card dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title">
            <h2 id="cancel-dialog-title">Cancel transfer?</h2>
            <p>Current transfer data will be discarded.</p>
            <div className="button-row">
              <button className="danger" onClick={handleCancel}>Cancel Transfer</button>
              <button className="primary" autoFocus onClick={() => setIsCancelConfirmationOpen(false)}>Continue Transfer</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
