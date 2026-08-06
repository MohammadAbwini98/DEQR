import React, { useState } from 'react';
import { TransferState, FileSelectionResult } from '../shared/types';
import Dashboard from './components/Dashboard';
import QRCanvas from './components/QRCanvas';
import LoopbackView from './components/LoopbackView';
import CameraReceiver from './components/CameraReceiver';

export default function App() {
  const [state, setState] = useState<TransferState>('idle');
  const [session, setSession] = useState<FileSelectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const handleSelectFile = async () => {
    try {
      setError(null);
      setState('selecting-file');
      const res = await window.deqr.files.selectForTransfer();
      if (res && res.sessionId) {
        setSession(res);
        setState('file-selected');
      } else {
        setState('idle'); // cancelled
      }
    } catch (e: any) {
      setError(e.error?.message || 'Failed to select file');
      setState('failed');
    }
  };

  const handleStartTransfer = async () => {
    if (!session) return;
    try {
      setState('preparing');
      await window.deqr.transfer.start(session.sessionId);
      setState('streaming');
    } catch (e: any) {
      setError(e.error?.message || 'Transfer failed');
      setState('failed');
    }
  };

  const handleStartLoopback = async () => {
    if (!session) return;
    try {
      setState('preparing');
      await window.deqr.loopback.start(session.sessionId, {
        lossPercentage: 30, // Default 30% drop for testing
        shuffle: true,
        duplicateInjection: false
      });
      setState('loopback-receiving');
    } catch (e: any) {
      setError(e.error?.message || 'Loopback failed');
      setState('failed');
    }
  };

  const handleReceiveFile = () => {
    setState('receive-camera');
  };

  const handleVerifiedReceive = async (payload: Uint8Array, metadata: any) => {
    setState('verifying');
    const success = await window.deqr.receive.saveReceivedFile(payload, metadata.filename);
    if (success) {
      setState('verified');
      alert('File successfully received and saved!');
      setState('idle');
    } else {
      setError('Failed to save file');
      setState('failed');
    }
  };

  const handleCancel = async () => {
    if (session) {
      try {
        await window.deqr.transfer.cancel(session.sessionId);
        await window.deqr.loopback.cancel(session.sessionId);
      } catch (e) {}
    }
    setSession(null);
    setState('idle');
  };

  return (
    <div className="app-container">
      <div className="titlebar">
        <div className="titlebar-controls">
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.minimize()}>—</button>
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.maximizeOrRestore()}>□</button>
          <button className="titlebar-button close" onClick={() => window.deqr.windowControls.close()}>✕</button>
        </div>
      </div>
      <div className="content">
        {(state === 'idle' || state === 'selecting-file' || state === 'failed') && (
          <Dashboard 
            onSelectFile={handleSelectFile} 
            onReceiveFile={handleReceiveFile}
            error={error} 
            isSelecting={state === 'selecting-file'} 
          />
        )}
        
        {state === 'file-selected' && session && (
          <div className="card">
            <h2>Ready to Transfer</h2>
            <div><strong>File:</strong> {session.metadata.filename}</div>
            <div><strong>Size:</strong> {(session.metadata.size / 1024).toFixed(2)} KB</div>
            <div><strong>Hash:</strong> {session.metadata.sha256?.substring(0, 16)}...</div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button className="primary" onClick={handleStartTransfer}>Start Optical Transfer</button>
              <button onClick={handleStartLoopback}>Run Loopback Test (30% Loss)</button>
              <button className="danger" onClick={handleCancel}>Cancel</button>
            </div>
          </div>
        )}

        {state === 'streaming' && session && (
          <QRCanvas sessionId={session.sessionId} onCancel={handleCancel} />
        )}

        {state === 'loopback-receiving' && session && (
          <LoopbackView sessionId={session.sessionId} onCancel={handleCancel} />
        )}

        {state === 'receive-camera' && (
          <CameraReceiver onCancel={handleCancel} onVerified={handleVerifiedReceive} />
        )}
      </div>
    </div>
  );
}
