import { useEffect, useRef, useState } from 'react';
import { CameraController } from './camera';
import { exportVerifiedFile } from './export';
import { ReceiverSession, type ReceiverSnapshot } from './protocol';

const VERSION = 'web-pwa-0.1.0';
const initial: ReceiverSnapshot = { state: 'READY', receivedBlocks: 0, totalBlocks: 0, duplicates: 0 };

export default function App() {
  const video = useRef<HTMLVideoElement>(null); const canvas = useRef<HTMLCanvasElement>(null); const receiver = useRef(new ReceiverSession()); const camera = useRef<CameraController | undefined>(undefined); const cameraActive = useRef(false);
  const [screen, setScreen] = useState<'HOME' | 'RECEIVE'>('HOME'); const [snapshot, setSnapshot] = useState(initial); const [cameraState, setCameraState] = useState<'IDLE' | 'ACTIVE' | 'ERROR'>('IDLE'); const [message, setMessage] = useState('Ready to receive a DEQR transfer.'); const [startRequested, setStartRequested] = useState(false);
  const update = (next: ReceiverSnapshot) => { setSnapshot(next); if (next.state === 'VERIFYING') receiver.current.verify().then(update); };
  const stopCamera = () => { camera.current?.stop(); cameraActive.current = false; setCameraState('IDLE'); };
  const start = () => { receiver.current.reset(); setSnapshot(receiver.current.snapshot()); setScreen('RECEIVE'); setStartRequested(true); setMessage('Preparing the receiver…'); };
  const cancel = () => { stopCamera(); update(receiver.current.cancel()); setMessage('Reception cancelled and private transfer data cleared.'); };
  const reset = () => { stopCamera(); update(receiver.current.reset()); setMessage('Ready to start a new receiver session.'); };
  const share = async () => { if (!snapshot.verified) return; try { const mode = await exportVerifiedFile(snapshot.verified); setMessage(mode === 'share' ? 'Share sheet opened. Complete Save to Files or sharing there.' : 'Download was requested. Choose a destination in the browser UI.'); reset(); } catch { setMessage('EXPORT FAILED. The verified file remains available until you reset.'); } };
  useEffect(() => { if (!startRequested || screen !== 'RECEIVE' || !video.current || !canvas.current) return; setStartRequested(false); camera.current?.dispose(); const controller = new CameraController(video.current, canvas.current, (bytes) => { const next = receiver.current.receive(bytes); update(next); if (next.state === 'RECEIVING') setMessage('Receiving validated DEQR frames.'); }, (error) => { cameraActive.current = false; setCameraState('ERROR'); setMessage(error.replaceAll('_', ' ')); }); camera.current = controller; void controller.start().then(() => { cameraActive.current = true; setCameraState('ACTIVE'); setMessage('Scanning for an animated DEQR code.'); }).catch(() => undefined); }, [screen, startRequested]);
  useEffect(() => { const onVisibility = () => { if (document.hidden && cameraActive.current) { camera.current?.stop(); cameraActive.current = false; setCameraState('IDLE'); update(receiver.current.cancel()); setMessage('Camera was stopped and the active transfer cleared because the app was backgrounded.'); } }; document.addEventListener('visibilitychange', onVisibility); return () => { document.removeEventListener('visibilitychange', onVisibility); camera.current?.dispose(); }; }, []);
  const percent = snapshot.totalBlocks ? Math.round(snapshot.receivedBlocks / snapshot.totalBlocks * 100) : 0;
  return <main className="app-shell">
    <header><div className="brand"><span aria-hidden="true">▣</span><div><strong>DEQR</strong><small>Optical Receiver</small></div></div><span className="version">{VERSION} · v1</span></header>
    {screen === 'HOME' && <section className="hero card"><p className="eyebrow">PRIVATE · OFFLINE AFTER INSTALL</p><h1>Receive a file by camera</h1><p>Point your iPhone at the animated DEQR stream. A file is never offered for export until its exact size and SHA-256 hash have been verified.</p><button className="primary" onClick={start}>Receive File</button><p className="install-note">Install: Safari → Share → Add to Home Screen → Open as Web App.</p></section>}
    {screen === 'RECEIVE' && <section className="receive">
      <div className="camera card"><video ref={video} playsInline muted aria-label="Live rear camera preview" /><canvas ref={canvas} aria-hidden="true" /><div className="scan-guide" aria-hidden="true" /><p role="status">{cameraState === 'ACTIVE' ? 'Camera active' : cameraState === 'ERROR' ? 'Camera unavailable' : 'Preparing camera'}</p></div>
      <section className="card status" aria-live="polite"><p className="eyebrow">{snapshot.state}</p><h1>{snapshot.state === 'COMPLETE' ? 'File verified' : snapshot.state === 'FAILED' ? 'Transfer rejected' : snapshot.state === 'CANCELLED' ? 'Reception cancelled' : snapshot.state === 'VERIFYING' ? 'Verifying integrity' : 'Scanning'}</h1><p>{snapshot.error ? `${snapshot.error.code}: ${snapshot.error.message}` : message}</p>
        <div className="progress-row"><div className="progress" role="progressbar" aria-label="Unique source blocks recovered" aria-valuemin={0} aria-valuemax={snapshot.totalBlocks || 1} aria-valuenow={snapshot.receivedBlocks}><span style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>
        <dl><div><dt>Unique blocks</dt><dd>{snapshot.receivedBlocks} / {snapshot.totalBlocks || '—'}</dd></div><div><dt>Duplicates ignored</dt><dd>{snapshot.duplicates}</dd></div>{snapshot.verified && <><div><dt>File</dt><dd>{snapshot.verified.filename}</dd></div><div><dt>Integrity</dt><dd className="success">SHA-256 verified</dd></div></>}</dl>
        <div className="actions">{snapshot.state === 'COMPLETE' ? <><button className="primary" onClick={share}>Save or Share Verified File</button><button onClick={() => { reset(); setScreen('HOME'); }}>Receive Another</button></> : <><button className="danger" onClick={cancel}>Cancel</button><button onClick={reset}>Reset</button></>}</div>
      </section>
    </section>}
  </main>;
}
