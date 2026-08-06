import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { TransferStats } from '../../shared/types';

interface Props {
  sessionId: number;
  onCancel: () => void;
}

export default function QRCanvas({ sessionId, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const unsubscribe = window.deqr.transfer.subscribe(sessionId, async (payload, newStats) => {
      setStats(newStats);
      if (canvasRef.current) {
        try {
          // Pass the Uint8Array natively to qrcode to prevent UTF-8 mangling
          await QRCode.toCanvas(canvasRef.current, [{ data: payload as Uint8Array, mode: 'byte' }], {
            errorCorrectionLevel: 'L',
            margin: 2,
            width: 400,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });
        } catch (e) {
          console.error('QR Render Failed:', e);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  const togglePause = async () => {
    if (isPaused) {
      await window.deqr.transfer.resume(sessionId);
    } else {
      await window.deqr.transfer.pause(sessionId);
    }
    setIsPaused(!isPaused);
  };

  return (
    <div className="card" style={{ alignItems: 'center' }}>
      <h2>Active Transfer</h2>
      <div style={{ background: '#fff', padding: '16px', borderRadius: '8px', marginBottom: '16px' }}>
        <canvas ref={canvasRef} width={400} height={400} style={{ display: 'block' }}></canvas>
      </div>
      
      {stats && (
        <div style={{ width: '100%', textAlign: 'left', marginBottom: '16px', display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <strong>Frames:</strong> {stats.framesGenerated}<br/>
            <strong>Source Blocks:</strong> {stats.sourceBlocks}
          </div>
          <div>
            <strong>Time:</strong> {(stats.elapsedMs / 1000).toFixed(1)}s<br/>
            <strong>Status:</strong> {isPaused ? 'Paused' : 'Streaming'}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="primary" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button className="danger" onClick={onCancel}>Cancel Transfer</button>
      </div>
    </div>
  );
}
