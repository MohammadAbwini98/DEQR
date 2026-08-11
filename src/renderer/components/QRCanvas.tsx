import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { TransferStats } from '../../shared/types';

interface Props {
  sessionId: number;
  fileName: string;
  onCancel: () => void;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

export default function QRCanvas({ sessionId, fileName, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let renderInFlight = false;
    let latestPayload: Uint8Array | null = null;
    let latestStats: TransferStats | null = null;
    let statsTimer: number | undefined;

    const flushStats = () => {
      statsTimer = undefined;
      if (!disposed && latestStats) {
        setStats(latestStats);
        latestStats = null;
      }
    };

    const queueStats = (nextStats: TransferStats) => {
      latestStats = nextStats;
      if (statsTimer === undefined) {
        // Metrics are visual feedback only. Limit React updates to 5 Hz while
        // retaining every incoming QR frame for the independent paint queue.
        statsTimer = window.setTimeout(flushStats, 200);
      }
    };

    // The main process may emit a new frame while qrcode is still painting the
    // previous one. Retain only the newest payload and render serially so QR
    // paint promises cannot queue or overwrite frames out of order.
    const renderLatestFrame = async (): Promise<void> => {
      if (disposed || renderInFlight) return;
      renderInFlight = true;

      try {
        while (!disposed && latestPayload) {
          const payload = latestPayload;
          latestPayload = null;
          const canvas = canvasRef.current;
          if (!canvas) continue;

          try {
            // Byte mode is the established optical contract. Margin only
            // controls the visual quiet zone; it never alters frame bytes.
            await QRCode.toCanvas(canvas, [{ data: payload, mode: 'byte' }], {
              errorCorrectionLevel: 'L',
              margin: 4,
              width: 400,
              color: { dark: '#000000', light: '#ffffff' },
            });
            if (!disposed) setRenderError(false);
          } catch {
            if (!disposed) setRenderError(true);
          }
        }
      } finally {
        renderInFlight = false;
        if (!disposed && latestPayload) void renderLatestFrame();
      }
    };

    const unsubscribe = window.deqr.transfer.subscribe(sessionId, (payload, nextStats) => {
      if (disposed) return;
      queueStats(nextStats);
      latestPayload = payload;
      void renderLatestFrame();
    });

    return () => {
      disposed = true;
      latestPayload = null;
      latestStats = null;
      if (statsTimer !== undefined) window.clearTimeout(statsTimer);
      unsubscribe();
    };
  }, [sessionId]);

  const togglePause = async () => {
    if (isPaused) {
      await window.deqr.transfer.resume(sessionId);
    } else {
      await window.deqr.transfer.pause(sessionId);
    }
    setIsPaused((paused) => !paused);
  };

  return (
    <section className="transfer-view" aria-labelledby="transfer-heading">
      <header className="transfer-header">
        <div>
          <p className="eyebrow">Sending securely</p>
          <h1 id="transfer-heading" data-screen-heading tabIndex={-1}>Keep this QR code in view</h1>
          <p className="transfer-file" title={fileName}>{fileName}</p>
        </div>
        <span className={`transfer-state ${isPaused ? 'transfer-state--paused' : ''}`} role="status">
          <span className="state-dot" aria-hidden="true" />
          {isPaused ? 'Paused' : 'Streaming'}
        </span>
      </header>

      <div className="qr-stage" aria-describedby="qr-guidance">
        <canvas
          ref={canvasRef}
          width={400}
          height={400}
          className="qr-canvas"
          role="img"
          aria-label="Animated DEQR optical transfer QR code"
        />
      </div>
      <p id="qr-guidance" className="qr-guidance">Keep the entire white boundary visible to the receiving camera. Avoid overlays or motion near the code.</p>

      {renderError && <p className="error-banner transfer-error" role="alert">The QR display could not be refreshed. Pause and resume the transfer to retry.</p>}

      <dl className="transfer-metrics" aria-label="Live transfer metrics">
        <div><dt>Frames emitted</dt><dd>{stats?.framesGenerated ?? '—'}</dd></div>
        <div><dt>Source blocks</dt><dd>{stats?.sourceBlocks ?? '—'}</dd></div>
        <div><dt>Target cadence</dt><dd>{stats ? `${stats.targetFps.toFixed(0)} FPS` : '—'}</dd></div>
        <div><dt>Effective cadence</dt><dd>{stats ? `${stats.effectiveFps.toFixed(1)} FPS` : '—'}</dd></div>
        <div><dt>Active time</dt><dd>{stats ? formatElapsed(stats.elapsedMs) : '—'}</dd></div>
      </dl>

      <div className="action-row transfer-actions">
        <button className="primary" onClick={togglePause}>{isPaused ? 'Resume stream' : 'Pause stream'}</button>
        <button className="danger" onClick={onCancel}>Cancel transfer</button>
      </div>
    </section>
  );
}
