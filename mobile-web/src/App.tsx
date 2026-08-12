import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraController, type CameraMetrics } from './camera';
import { exportVerifiedFile } from './export';
import { ReceiverSession, type ReceiverSnapshot } from './protocol';

const VERSION = 'web-pwa-0.1.0';
const SNAPSHOT_INTERVAL_MS = 150;
const initial: ReceiverSnapshot = { state: 'READY', receivedBlocks: 0, totalBlocks: 0, duplicates: 0 };

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const homeHeading = useRef<HTMLHeadingElement>(null);
  const receiveHeadingRef = useRef<HTMLHeadingElement>(null);
  const receiver = useRef(new ReceiverSession());
  const camera = useRef<CameraController | undefined>(undefined);
  const cameraActive = useRef(false);
  const cameraRequest = useRef(0);
  const pendingCameraRequest = useRef<number | undefined>(undefined);
  const verification = useRef<Promise<void> | undefined>(undefined);
  const verificationRequest = useRef(0);
  const receivingAnnounced = useRef(false);
  const latestSnapshot = useRef<ReceiverSnapshot>(initial);
  const snapshotTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  const [screen, setScreen] = useState<'HOME' | 'RECEIVE'>('HOME');
  const [snapshot, setSnapshot] = useState(initial);
  const [cameraState, setCameraState] = useState<'IDLE' | 'PREPARING' | 'ACTIVE' | 'ERROR'>('IDLE');
  const [message, setMessage] = useState('Ready to receive a DEQR transfer.');
  const [startRequested, setStartRequested] = useState(false);
  const [metrics, setMetrics] = useState<CameraMetrics | undefined>(undefined);

  const publishSnapshot = useCallback((next: ReceiverSnapshot, immediate = false) => {
    latestSnapshot.current = next;
    if (!mounted.current) return;
    if (immediate) {
      if (snapshotTimer.current !== undefined) window.clearTimeout(snapshotTimer.current);
      snapshotTimer.current = undefined;
      setSnapshot(next);
      return;
    }
    if (snapshotTimer.current === undefined) {
      snapshotTimer.current = window.setTimeout(() => {
        snapshotTimer.current = undefined;
        if (mounted.current) setSnapshot(latestSnapshot.current);
      }, SNAPSHOT_INTERVAL_MS);
    }
  }, []);

  const stopCamera = useCallback(() => {
    cameraRequest.current++;
    pendingCameraRequest.current = undefined;
    const controller = camera.current;
    camera.current = undefined;
    controller?.dispose();
    cameraActive.current = false;
    if (mounted.current) setCameraState('IDLE');
  }, []);

  const invalidateVerification = useCallback(() => {
    verificationRequest.current++;
    verification.current = undefined;
  }, []);

  const cancel = useCallback(() => {
    invalidateVerification();
    stopCamera();
    publishSnapshot(receiver.current.cancel(), true);
    receivingAnnounced.current = false;
    setMessage('Reception cancelled and private transfer data cleared.');
  }, [invalidateVerification, publishSnapshot, stopCamera]);

  const reset = useCallback(() => {
    invalidateVerification();
    stopCamera();
    publishSnapshot(receiver.current.reset(), true);
    receivingAnnounced.current = false;
    setMetrics(undefined);
    setMessage('Camera is inactive. Retry when you are ready to scan again.');
  }, [invalidateVerification, publishSnapshot, stopCamera]);

  const beginVerification = useCallback((next: ReceiverSnapshot) => {
    stopCamera();
    publishSnapshot(next, true);
    if (verification.current) return;
    const request = ++verificationRequest.current;
    verification.current = receiver.current.verify().then((verified) => {
      if (request !== verificationRequest.current || !mounted.current) return;
      publishSnapshot(verified, true);
      if (verified.state === 'COMPLETE') {
        setMessage('File verified. Camera access has stopped.');
      } else {
        setMessage('Transfer rejected. Camera access has stopped. Retry when ready.');
      }
    }).catch(() => {
      if (request !== verificationRequest.current || !mounted.current) return;
      publishSnapshot(receiver.current.cancel(), true);
      setMessage('Transfer rejected. Camera access has stopped. Retry when ready.');
    }).finally(() => {
      if (request === verificationRequest.current) verification.current = undefined;
    });
  }, [publishSnapshot, stopCamera]);

  const onBytes = useCallback((bytes: Uint8Array) => {
    const next = receiver.current.receive(bytes);
    if (next.state === 'VERIFYING') {
      beginVerification(next);
      return;
    }
    if (next.state === 'FAILED') {
      stopCamera();
      publishSnapshot(next, true);
      setMessage('Transfer rejected. Camera access has stopped. Retry when ready.');
      return;
    }
    publishSnapshot(next);
    if (next.state === 'RECEIVING' && !receivingAnnounced.current) {
      receivingAnnounced.current = true;
      setMessage('Receiving validated DEQR frames.');
    }
  }, [beginVerification, publishSnapshot, stopCamera]);

  const onCameraError = useCallback((error: string) => {
    cameraActive.current = false;
    if (!mounted.current) return;
    setCameraState('ERROR');
    setMessage(error.replaceAll('_', ' '));
  }, []);

  const onMetrics = useCallback((next: CameraMetrics) => {
    if (mounted.current) setMetrics(next);
  }, []);

  const requestCamera = useCallback(() => {
    invalidateVerification();
    stopCamera();
    publishSnapshot(receiver.current.reset(), true);
    receivingAnnounced.current = false;
    setMetrics(undefined);
    const request = ++cameraRequest.current;
    pendingCameraRequest.current = request;
    setCameraState('PREPARING');
    setStartRequested(true);
    setMessage('Preparing camera access...');
  }, [invalidateVerification, publishSnapshot, stopCamera]);

  const start = useCallback(() => {
    setScreen('RECEIVE');
    requestCamera();
  }, [requestCamera]);

  const returnHome = useCallback(() => {
    cancel();
    setScreen('HOME');
    setMessage('Ready to receive a DEQR transfer.');
  }, [cancel]);

  const share = useCallback(async () => {
    if (!latestSnapshot.current.verified) return;
    try {
      const mode = await exportVerifiedFile(latestSnapshot.current.verified);
      reset();
      setMessage(mode === 'share'
        ? 'Share sheet opened. Complete Save to Files or sharing there.'
        : 'Download was requested. Choose a destination in the browser UI.');
    } catch {
      setMessage('Export failed. The verified file remains available until you reset.');
    }
  }, [reset]);

  useEffect(() => {
    if (!startRequested || screen !== 'RECEIVE' || !video.current || !canvas.current) return;
    const request = pendingCameraRequest.current;
    if (!request) return;
    setStartRequested(false);
    const controller = new CameraController(
      video.current,
      canvas.current,
      onBytes,
      (error) => {
        if (camera.current === controller) onCameraError(error);
      },
      (nextMetrics) => {
        if (camera.current === controller) onMetrics(nextMetrics);
      },
    );
    camera.current = controller;
    void controller.start().then((started) => {
      if (!started || request !== cameraRequest.current || camera.current !== controller || document.hidden) {
        controller.dispose();
        return;
      }
      cameraActive.current = true;
      setCameraState('ACTIVE');
      setMessage('Scanning for an animated DEQR code.');
    }).catch(() => undefined);
  }, [onBytes, onCameraError, onMetrics, screen, startRequested]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) return;
      invalidateVerification();
      stopCamera();
      publishSnapshot(receiver.current.cancel(), true);
      setMessage('Camera was stopped and the active transfer cleared because the app was backgrounded.');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [invalidateVerification, publishSnapshot, stopCamera]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidateVerification();
      stopCamera();
      receiver.current.cancel();
      if (snapshotTimer.current !== undefined) window.clearTimeout(snapshotTimer.current);
    };
  }, [invalidateVerification, stopCamera]);

  const percent = snapshot.totalBlocks ? Math.round(snapshot.receivedBlocks / snapshot.totalBlocks * 100) : 0;
  const cameraStatus = cameraState === 'ACTIVE' ? 'Camera active' : cameraState === 'PREPARING' ? 'Preparing camera' : cameraState === 'ERROR' ? 'Camera unavailable' : 'Camera inactive';
  const receiveHeading = snapshot.state === 'COMPLETE' ? 'File verified' : snapshot.state === 'FAILED' ? 'Transfer not verified' : snapshot.state === 'CANCELLED' ? 'Reception cancelled' : snapshot.state === 'VERIFYING' ? 'Verifying file integrity' : cameraState === 'ERROR' ? 'Camera unavailable' : cameraState === 'PREPARING' ? 'Allow camera access' : cameraState === 'IDLE' ? 'Camera paused' : 'Receiving transfer';
  const canRetryCamera = cameraState === 'IDLE' || cameraState === 'ERROR';
  const scanTiming = metrics ? metrics.capturedFrames + ' scans, ' + metrics.cameraAverageMs.toFixed(1) + ' ms capture, ' + metrics.decodeAverageMs.toFixed(1) + ' ms decode' : undefined;
  const statusMessage = snapshot.state === 'FAILED'
    ? 'This transfer could not be verified. No file was saved.'
    : cameraState === 'ERROR'
      ? 'Camera access did not start. Check the iPhone permission, then try again.'
      : message;
  const focusState = screen === 'HOME'
    ? 'HOME'
    : snapshot.state === 'VERIFYING' || snapshot.state === 'COMPLETE' || snapshot.state === 'FAILED' || snapshot.state === 'CANCELLED'
      ? snapshot.state
      : cameraState === 'ERROR'
        ? 'CAMERA_ERROR'
        : 'RECEIVE';
  const liveStatus = screen === 'HOME'
    ? 'Home. Ready to receive a DEQR transfer.'
    : snapshot.state === 'VERIFYING'
      ? 'Transfer received. Verifying file integrity.'
      : snapshot.state === 'COMPLETE'
        ? 'File verified and ready to save.'
        : snapshot.state === 'FAILED'
          ? 'Transfer failed verification. No file was saved.'
          : snapshot.state === 'CANCELLED'
            ? 'Reception cancelled and temporary transfer data cleared.'
            : cameraState === 'ERROR'
              ? 'Camera unavailable. Check permission and try again.'
              : cameraState === 'PREPARING'
                ? 'Preparing camera access.'
                : snapshot.state === 'RECEIVING'
                  ? 'Receiving validated DEQR frames.'
                  : cameraState === 'ACTIVE'
                    ? 'Camera active and ready to scan.'
                    : 'Camera inactive.';

  useEffect(() => {
    const heading = screen === 'HOME' ? homeHeading.current : receiveHeadingRef.current;
    heading?.focus({ preventScroll: true });
  }, [focusState, screen]);

  return <main className="app-shell">
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src="./icons/deqr.svg" alt="" />
        <div><strong>DEQR</strong><small>Optical Transfer</small></div>
      </div>
      <span className="version" aria-label={'DEQR receiver ' + VERSION}>Receiver</span>
    </header>

    {screen === 'HOME' && <section className="home-screen" aria-labelledby="home-title">
      <div className="home-mark card" aria-hidden="true"><img src="./icons/deqr.svg" alt="" /></div>
      <p className="eyebrow">OFFLINE OPTICAL RECEIVER</p>
      <h1 id="home-title" ref={homeHeading} tabIndex={-1}>Receive a file with your camera.</h1>
      <p className="home-copy">Scan a DEQR animation from another device. Your file is offered for saving only after its size and SHA-256 hash are verified on this iPhone.</p>
      <section className="trust-note" aria-label="Transfer protection">
        <span className="trust-icon" aria-hidden="true">✓</span>
        <p><strong>Private by design</strong><br />The transfer stays local to your devices. No account or network connection is needed after installation.</p>
      </section>
      <div className="home-actions">
        <button className="primary" onClick={start}>Receive File</button>
        <p className="install-note">For the best iPhone experience, install with Safari: Share, Add to Home Screen, then open as an app.</p>
      </div>
    </section>}

    {screen === 'RECEIVE' && <section className="receive-screen" aria-labelledby="receive-title">
      <div className={'camera-panel card camera-' + cameraState.toLowerCase()}>
        <div className="camera-frame">
          <video ref={video} playsInline muted aria-label="Live rear camera preview" />
          <canvas ref={canvas} aria-hidden="true" />
          <div className="scan-guide" aria-hidden="true"><span /></div>
          <div className="camera-indicator"><span aria-hidden="true" />{cameraStatus}</div>
        </div>
        <div className="camera-caption"><strong>Keep the animated code inside the guide.</strong><span>The camera stops before integrity verification.</span></div>
      </div>

      <section className="status-card card">
        <p className="eyebrow">{snapshot.state === 'READY' ? 'READY TO SCAN' : snapshot.state}</p>
        <h1 id="receive-title" ref={receiveHeadingRef} tabIndex={-1}>{receiveHeading}</h1>
        <p className="status-copy">{snapshot.error ? snapshot.error.message : statusMessage}</p>

        {(snapshot.state === 'RECEIVING' || snapshot.state === 'VERIFYING' || snapshot.state === 'COMPLETE') && <div className="progress-row">
          <div className="progress" role="progressbar" aria-label="Unique source blocks recovered" aria-valuemin={0} aria-valuemax={snapshot.totalBlocks || 1} aria-valuenow={snapshot.receivedBlocks}><span style={{ transform: 'scaleX(' + Math.min(percent, 100) / 100 + ')' }} /></div>
          <strong>{percent}%</strong>
        </div>}

        {snapshot.verified && <div className="verified-file">
          <span className="success-mark" aria-hidden="true">✓</span>
          <div><span>Verified file</span><strong>{snapshot.verified.filename}</strong><small>SHA-256 integrity verified</small></div>
        </div>}

        <details className="scan-details">
          <summary>Scanning details</summary>
          <dl>
            <div><dt>Unique blocks</dt><dd>{snapshot.receivedBlocks} / {snapshot.totalBlocks || '—'}</dd></div>
            <div><dt>Duplicates ignored</dt><dd>{snapshot.duplicates}</dd></div>
            {scanTiming && <div className="wide"><dt>Local scanner timing</dt><dd>{scanTiming}</dd></div>}
          </dl>
        </details>
      </section>

      <div className="action-dock">
        {snapshot.state === 'COMPLETE' ? <>
          <button className="primary" onClick={share}>Save verified file</button>
          <button onClick={() => { reset(); setScreen('HOME'); }}>Receive another</button>
        </> : canRetryCamera ? <>
          <button className="primary" onClick={requestCamera}>Try camera again</button>
          <button onClick={returnHome}>Return to home</button>
        </> : <>
          <button className="danger" onClick={cancel}>Cancel transfer</button>
          <button onClick={reset}>Reset</button>
        </>}
      </div>
    </section>}
  </main>;
}
