import React, { useEffect, useState } from 'react';
import { LoopbackStats } from '../../shared/types';

interface Props {
  sessionId: number;
  onCancel: () => void;
}

export default function LoopbackView({ sessionId, onCancel }: Props) {
  const [stats, setStats] = useState<LoopbackStats | null>(null);

  useEffect(() => {
    const unsubscribe = window.deqr.loopback.subscribe(sessionId, (newStats) => {
      setStats(newStats);
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return (
    <div className="card">
      <h2>Loopback Test</h2>
      <p style={{ color: 'var(--text-secondary)' }}>
        Simulating 30% optical frame loss in the main process and reconstructing using the Stage 2 Decoder.
      </p>
      
      {stats ? (
        <div style={{ margin: '16px 0' }}>
          <div><strong>Frames Received:</strong> {stats.receivedFrames}</div>
          <div><strong>Blocks Recovered:</strong> {stats.recoveredBlocks}</div>
          
          {stats.isComplete && (
            <div style={{ 
              marginTop: '16px', 
              padding: '12px', 
              borderRadius: 'var(--radius-md)',
              background: stats.verificationPassed ? 'rgba(40, 200, 64, 0.1)' : 'rgba(255, 59, 48, 0.1)',
              color: stats.verificationPassed ? '#34c759' : '#ff3b30',
              border: `1px solid ${stats.verificationPassed ? '#34c759' : '#ff3b30'}`
            }}>
              <strong>{stats.verificationPassed ? 'VERIFICATION PASSED' : 'VERIFICATION FAILED'}</strong>
              <br/>
              Hash Match: {stats.hashMatched ? 'Yes' : 'No'}
            </div>
          )}
        </div>
      ) : (
        <div style={{ margin: '16px 0' }}>Initializing decoder...</div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="danger" onClick={onCancel}>
          {stats?.isComplete ? 'Close' : 'Cancel Loopback'}
        </button>
      </div>
    </div>
  );
}
