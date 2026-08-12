import React, { useEffect, useState } from 'react';
import { LoopbackStats } from '../../shared/types';

interface Props {
  sessionId: number;
  onCancel: () => void;
}

export default function LoopbackView({ sessionId, onCancel }: Props) {
  const [stats, setStats] = useState<LoopbackStats | null>(null);

  useEffect(() => {
    const unsubscribe = window.deqr.loopback.subscribe(sessionId, setStats);
    return unsubscribe;
  }, [sessionId]);

  const complete = Boolean(stats?.isComplete);
  const passed = Boolean(stats?.verificationPassed && stats?.hashMatched);

  return (
    <section className="verification-view" aria-labelledby="verification-heading">
      <header className="section-heading">
        <p className="eyebrow">Local verification</p>
        <h1 id="verification-heading" data-screen-heading tabIndex={-1}>Checking the optical container</h1>
        <p>A local decoder reconstructs the same prepared stream with simulated 30% frame loss.</p>
      </header>

      <dl className="verification-metrics" aria-label="Loopback verification metrics">
        <div><dt>Frames received</dt><dd>{stats?.receivedFrames ?? '—'}</dd></div>
        <div><dt>Blocks recovered</dt><dd>{stats?.recoveredBlocks ?? '—'}</dd></div>
      </dl>

      <div className={`verification-result ${complete ? (passed ? 'verification-result--success' : 'verification-result--failure') : ''}`} role="status">
        {!complete && <><strong>Reconstructing</strong><span>Waiting for enough validated frames to complete the fountain decode.</span></>}
        {complete && passed && <><strong>Integrity verified</strong><span>The reconstructed container matched its SHA-256 verification check.</span></>}
        {complete && !passed && <><strong>Verification did not pass</strong><span>The reconstructed result was not accepted. No file is saved from this result.</span></>}
      </div>

      <div className="action-row">
        <button className={complete ? 'primary' : 'danger'} onClick={onCancel}>{complete ? 'Done' : 'Cancel verification'}</button>
      </div>
    </section>
  );
}
