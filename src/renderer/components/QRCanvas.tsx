import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { TransferStats } from '../../shared/types';
import { getQrRasterSize } from '../ui-model';

interface Props {
  sessionId: number;
  onCancel: () => void;
}

export default function QRCanvas({ sessionId, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [canvasDisplaySize, setCanvasDisplaySize] = useState(400);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  const canvasRasterSize = getQrRasterSize(canvasDisplaySize, devicePixelRatio);

  useEffect(() => {
    if (!canvasFrameRef.current) return;

    const updateCanvasSize = () => {
      const nextSize = Math.max(180, Math.min(480, Math.floor(canvasFrameRef.current?.clientWidth ?? 400)));
      setCanvasDisplaySize((currentSize) => currentSize === nextSize ? currentSize : nextSize);
      setDevicePixelRatio(window.devicePixelRatio || 1);
    };

    const observer = new ResizeObserver(updateCanvasSize);

    observer.observe(canvasFrameRef.current);
    window.addEventListener('resize', updateCanvasSize);
    updateCanvasSize();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateCanvasSize);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.deqr.transfer.subscribe(sessionId, async (payload, newStats) => {
      setStats(newStats);
      const targetCanvas = canvasRef.current;
      if (targetCanvas) {
        try {
          // Render outside the document. qrcode sets inline dimensions on the
          // canvas it receives, so handing it the visible canvas causes DPI
          // raster dimensions to leak into layout and create scrollbars.
          const rasterCanvas = document.createElement('canvas');
          await QRCode.toCanvas(rasterCanvas, [{ data: payload as Uint8Array, mode: 'byte' }], {
            errorCorrectionLevel: 'L',
            margin: 2,
            width: canvasRasterSize,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });
          targetCanvas.width = canvasRasterSize;
          targetCanvas.height = canvasRasterSize;
          const context = targetCanvas.getContext('2d');
          if (!context) throw new Error('QR display canvas is unavailable.');
          context.imageSmoothingEnabled = false;
          context.clearRect(0, 0, canvasRasterSize, canvasRasterSize);
          context.drawImage(rasterCanvas, 0, 0, canvasRasterSize, canvasRasterSize);
        } catch (e) {
          console.error('QR Render Failed:', e);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [canvasDisplaySize, canvasRasterSize, sessionId]);

  const togglePause = async () => {
    if (isPaused) {
      await window.deqr.transfer.resume(sessionId);
    } else {
      await window.deqr.transfer.pause(sessionId);
    }
    setIsPaused(!isPaused);
  };

  return (
    <section className="card transfer-surface" aria-labelledby="transfer-title">
      <h2 id="transfer-title">Active Transfer</h2>
      <p style={{ color: 'var(--text-secondary)' }}>Keep this QR surface unobstructed and square for reliable scanning.</p>
      <div className="qr-quiet-zone">
        <div className="qr-canvas-frame" ref={canvasFrameRef}>
          <canvas
            ref={canvasRef}
            width={canvasRasterSize}
            height={canvasRasterSize}
            aria-label="Animated DEQR transfer QR code"
          ></canvas>
        </div>
      </div>
      
      {stats && (
        <div className="stats-grid" role="status" aria-live="polite">
          <strong>Frames generated</strong><span>{stats.framesGenerated}</span>
          <strong>Source blocks</strong><span>{stats.sourceBlocks}</span>
          <strong>Frame rate</strong><span>{stats.currentFps} FPS</span>
          <strong>Elapsed time</strong><span>{(stats.elapsedMs / 1000).toFixed(1)} seconds</span>
          <strong>Transfer status</strong><span>{isPaused ? 'Paused' : 'Streaming'}</span>
        </div>
      )}

      <div className="button-row">
        <button className="primary" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button className="danger" onClick={onCancel}>Cancel Transfer</button>
      </div>
    </section>
  );
}
