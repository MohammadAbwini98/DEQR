/**
 * HT-09 — Two-code transfer view (2×1 staggered 0/0.5).
 * Each lane: same sessionId/fileId, unique sequence, independent fountain symbol, identical version/ECC/scale/quietZone.
 * Staggered: per-code FPS F, lane A phase 0, lane B phase 0.5 — exposure crossing one update leaves other stable.
 * Update only due cell rectangle when possible; paint all due cells if multiple deadlines coincide.
 */

import React, { useEffect, useRef } from 'react';
import { layoutForGrid } from '../multiplexer';
import { QrFrameScheduler } from '../qr-frame-scheduler';
import { resolveQrRenderPlan, applyCanvasGeometry, paintQrFrame } from '../qr-render';
import type { TransportProfile } from '../../core/transport-profiles';

export function TwoCodeTransferView({ profile, sessionId }: { profile: TransportProfile; sessionId: number }) {
  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const layout = layoutForGrid(2, 480, 480, 800, 600);

  useEffect(() => {
    const schedulers: QrFrameScheduler[] = [];
    for (let lane = 0; lane < 2; lane++) {
      const phase = layout.cellPhases[lane];
      const scheduler = new QrFrameScheduler(
        { ...profile, targetFps: profile.targetFps }, // per-code FPS
        {
          next: async () => {
            const res = await (window as unknown as { deqr: { streamTransfer: { nextFrame(id:number): Promise<{ frame: Uint8Array|null }> } } }).deqr.streamTransfer.nextFrame(sessionId);
            return res.frame;
          },
        },
        async (frame) => {
          const canvas = lane === 0 ? canvasA.current : canvasB.current;
          if (!canvas) return;
          const plan = resolveQrRenderPlan({ frameBytes: frame.length, eccLevel: profile.eccLevel, budgetCssPx: 220, version: profile.qrVersion });
          applyCanvasGeometry(canvas, plan.geometry);
          await paintQrFrame(canvas, frame, plan);
        },
        undefined,
        { maxPrefetchedFrames: 3, useRaf: true },
      );
      // Stagger start by phase * intervalMs
      setTimeout(() => scheduler.start(), phase * (1000 / profile.targetFps));
      schedulers.push(scheduler);
    }
    return () => schedulers.forEach(s => s.stop());
  }, [profile, sessionId, layout.cellPhases]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
      <canvas ref={canvasA} style={{ width: '100%', aspectRatio: '1' }} />
      <canvas ref={canvasB} style={{ width: '100%', aspectRatio: '1' }} />
    </div>
  );
}
