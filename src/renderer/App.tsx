import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSelectionResult, TransferState } from '../shared/types';
import deqrLogo from '../../mobile-web/public/icons/deqr.svg';
import Dashboard from './components/Dashboard';
import QRCanvas from './components/QRCanvas';
import LoopbackView from './components/LoopbackView';
import CameraReceiver from './components/CameraReceiver';
import { getSaveOutcome, isActiveTransferState } from './app-model';

interface IpcErrorResult {
  error?: { message?: string };
}

function getIpcError(value: unknown): string | null {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as IpcErrorResult).error;
    return error?.message || 'The requested action could not be completed.';
  }
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export default function App() {
  const [state, setState] = useState<TransferState>('idle');
  const [session, setSession] = useState<FileSelectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('Ready for a local, screen-to-camera transfer.');
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-screen-heading]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  const closeCancelDialog = useCallback(() => {
    setCancelDialogOpen(false);
    window.requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, []);

  const requestCancel = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCancelDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!cancelDialogOpen) return;
    continueButtonRef.current?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(cancelDialogRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', trapFocus);
    return () => window.removeEventListener('keydown', trapFocus);
  }, [cancelDialogOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (cancelDialogOpen) {
        event.preventDefault();
        closeCancelDialog();
        return;
      }
      if (isActiveTransferState(state)) {
        event.preventDefault();
        requestCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [cancelDialogOpen, closeCancelDialog, requestCancel, state]);

  const handleSelectFile = async () => {
    try {
      setError(null);
      setNotice('Opening the secure file picker.');
      setState('selecting-file');
      const result = await window.deqr.files.selectForTransfer();
      const ipcError = getIpcError(result);
      if (ipcError) {
        setError(ipcError);
        setState('failed');
        return;
      }
      if (result?.sessionId) {
        setSession(result);
        setNotice('File prepared. Review its details before starting the optical stream.');
        setState('file-selected');
      } else {
        setNotice('No file was selected.');
        setState('idle');
      }
    } catch (caught) {
      setError(getIpcError(caught) || 'Failed to select a file.');
      setState('failed');
    }
  };

  const handleStartTransfer = async () => {
    if (!session) return;
    try {
      setError(null);
      setState('preparing');
      const result = await window.deqr.transfer.start(session.sessionId);
      const ipcError = getIpcError(result);
      if (ipcError) throw new Error(ipcError);
      setNotice('Optical stream is active. Keep the QR code unobstructed and high contrast.');
      setState('streaming');
    } catch (caught) {
      setError(getIpcError(caught) || (caught instanceof Error ? caught.message : 'Transfer failed.'));
      setState('failed');
    }
  };

  const handleStartLoopback = async () => {
    if (!session) return;
    try {
      setError(null);
      setState('preparing');
      const result = await window.deqr.loopback.start(session.sessionId, {
        lossPercentage: 30,
        shuffle: true,
        duplicateInjection: false,
      });
      const ipcError = getIpcError(result);
      if (ipcError) throw new Error(ipcError);
      setNotice('Loopback verification is reconstructing the prepared container.');
      setState('loopback-receiving');
    } catch (caught) {
      setError(getIpcError(caught) || (caught instanceof Error ? caught.message : 'Loopback failed.'));
      setState('failed');
    }
  };

  const handleReceiveFile = () => {
    setError(null);
    setNotice('The camera remains off until you choose Start camera.');
    setState('receive-camera');
  };

  const handleVerifiedReceive = useCallback(async (payload: Uint8Array, metadata: unknown) => {
    setError(null);
    setState('verifying');
    const defaultName = typeof metadata === 'object' && metadata && 'filename' in metadata
      ? String((metadata as { filename: string }).filename)
      : 'received_transfer.deqr';

    try {
      const success = await window.deqr.receive.saveReceivedFile(payload, defaultName);
      const outcome = getSaveOutcome(success);
      if (outcome.notice) setNotice(outcome.notice);
      if (outcome.error) setError(outcome.error);
      setState(outcome.state);
    } catch (caught) {
      setError(getIpcError(caught) || (caught instanceof Error ? caught.message : 'The received file could not be verified or saved.'));
      setState('failed');
    }
  }, []);

  const handleCancel = useCallback(async () => {
    setCancelDialogOpen(false);
    if (session) {
      try {
        await window.deqr.transfer.cancel(session.sessionId);
        await window.deqr.loopback.cancel(session.sessionId);
      } catch {
        // Cancellation is intentionally idempotent; the main process owns cleanup.
      }
    }
    setSession(null);
    setError(null);
    setNotice(session
      ? 'Transfer cancelled. Temporary sender data was released by the main process.'
      : 'Ready for a local, screen-to-camera transfer.');
    setState('idle');
  }, [session]);

  return (
    <div className="app-container">
      <header className="titlebar">
        <div className="titlebar-brand" aria-label="DEQR Optical Transfer">
          <img src={deqrLogo} alt="" className="brand-mark" />
          <span>DEQR</span>
          <span className="titlebar-separator" aria-hidden="true">/</span>
          <span className="titlebar-context">Optical Transfer</span>
        </div>
        <div className="titlebar-controls" aria-label="Window controls">
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.minimize()} aria-label="Minimize window">−</button>
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.maximizeOrRestore()} aria-label="Maximize or restore window">□</button>
          <button className="titlebar-button close" onClick={() => window.deqr.windowControls.close()} aria-label="Close window">×</button>
        </div>
      </header>

      <p className="visually-hidden" role="status" aria-live="polite">
        {state === 'preparing' && 'Preparing the local optical stream.'}
        {state === 'streaming' && 'Optical stream active.'}
        {state === 'loopback-receiving' && 'Local verification active.'}
        {state === 'receive-camera' && 'Desktop camera receiver ready.'}
        {state === 'verifying' && 'Verifying the received file.'}
        {state === 'completed' && 'The received file was saved.'}
        {state === 'failed' && 'The requested operation failed.'}
      </p>
      <main className={`content content--${state}`}>
        {(state === 'idle' || state === 'selecting-file') && (
          <Dashboard
            onSelectFile={handleSelectFile}
            onReceiveFile={handleReceiveFile}
            error={null}
            notice={notice}
            isSelecting={state === 'selecting-file'}
          />
        )}

        {state === 'file-selected' && session && (
          <section className="selection-card" aria-labelledby="ready-heading">
            <div className="section-heading">
              <p className="eyebrow">Send file</p>
              <h1 id="ready-heading" data-screen-heading tabIndex={-1}>Ready to transfer</h1>
              <p>Review the local metadata, then present the QR stream to the receiving camera.</p>
            </div>

            <dl className="metadata-grid">
              <div><dt>File</dt><dd title={session.metadata.filename}>{session.metadata.filename}</dd></div>
              <div><dt>Size</dt><dd>{formatFileSize(session.metadata.size)}</dd></div>
              <div><dt>Type</dt><dd>{session.metadata.mimeType}</dd></div>
              <div><dt>Integrity</dt><dd className="monospace">{session.metadata.sha256?.slice(0, 16)}…</dd></div>
            </dl>

            <aside className="capacity-note" aria-label="DEQR v1 transfer capacity">
              <span aria-hidden="true">i</span>
              <p><strong>DEQR v1 capacity:</strong> the serialized optical container must be below 32 MiB. Filename and metadata use part of that capacity.</p>
            </aside>

            <div className="action-row">
              <button className="primary" onClick={handleStartTransfer}>Start optical transfer</button>
              <button className="tertiary" onClick={handleCancel}>Choose another file</button>
            </div>

            <details className="advanced-disclosure">
              <summary>Advanced local verification</summary>
              <p>Run a local decoder against the prepared stream with simulated frame loss. This does not replace a physical camera test.</p>
              <button className="secondary" onClick={handleStartLoopback}>Run local verification</button>
            </details>
          </section>
        )}

        {state === 'preparing' && (
          <section className="status-card" aria-labelledby="preparing-heading">
            <p className="eyebrow">Preparing</p>
            <h1 id="preparing-heading" data-screen-heading tabIndex={-1}>Starting a local transfer</h1>
            <p role="status">The local, context-isolated IPC bridge is preparing the optical stream. No network transfer is used.</p>
          </section>
        )}

        {state === 'streaming' && session && (
          <QRCanvas sessionId={session.sessionId} fileName={session.metadata.filename} onCancel={requestCancel} />
        )}

        {state === 'loopback-receiving' && session && (
          <LoopbackView sessionId={session.sessionId} onCancel={requestCancel} />
        )}

        {state === 'receive-camera' && (
          <CameraReceiver onCancel={requestCancel} onVerified={handleVerifiedReceive} />
        )}

        {state === 'verifying' && (
          <section className="status-card" aria-labelledby="verifying-heading">
            <p className="eyebrow">Verifying</p>
            <h1 id="verifying-heading" data-screen-heading tabIndex={-1}>Checking the received file</h1>
            <p role="status">The main process is validating the reconstructed container before a save can be reported.</p>
          </section>
        )}

        {state === 'completed' && (
          <section className="status-card status-card--success" aria-labelledby="completed-heading">
            <p className="eyebrow">Completed</p>
            <h1 id="completed-heading" data-screen-heading tabIndex={-1}>File verified and saved</h1>
            <p>The verified received file was saved to the location selected in the save dialog.</p>
            <div className="action-row">
              <button className="primary" onClick={handleReceiveFile}>Receive another file</button>
              <button className="tertiary" onClick={() => setState('idle')}>Return to dashboard</button>
            </div>
          </section>
        )}

        {state === 'failed' && (
          <section className="status-card status-card--failure" aria-labelledby="failed-heading">
            <p className="eyebrow">Action not completed</p>
            <h1 id="failed-heading" data-screen-heading tabIndex={-1}>Something prevented completion</h1>
            <p className="error-banner" role="alert">{error || 'The requested action could not be completed.'}</p>
            <div className="action-row">
              <button className="primary" onClick={handleCancel}>Return to dashboard</button>
            </div>
          </section>
        )}
      </main>

      {cancelDialogOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section ref={cancelDialogRef} className="cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-heading" aria-describedby="cancel-description">
            <h2 id="cancel-heading">Cancel the active transfer?</h2>
            <p id="cancel-description">Progress from this send or receive session will be discarded. This action cannot be undone.</p>
            <div className="action-row">
              <button ref={continueButtonRef} className="primary" onClick={closeCancelDialog}>Continue transfer</button>
              <button className="danger" onClick={handleCancel}>Cancel transfer</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
