/**
 * HT-10 — Four-code transfer view (2×2 staggered 0/¼/½/¾).
 * Same guarantees as HT-09 but 4 lanes, update only due cell rect, density guardrail moduleScale>=2.
 */

import React, { useEffect, useRef } from 'react';
import { layoutForGrid } from '../multiplexer';
import { QrFrameScheduler } from '../qr-frame-scheduler';
import { resolveQrRenderPlan, applyCanvasGeometry, paintQrFrame } from '../qr-render';
import type { TransportProfile } from '../../core/transport-profiles';

export function FourCodeTransferView({ profile, sessionId }: { profile: TransportProfile; sessionId: number }) {
  const canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const layout = layoutForGrid(4, 480, 480, 800, 600);

  useEffect(() => {
    const schedulers: QrFrameScheduler[] = [];
    for (let lane = 0; lane < 4; lane++) {
      const phase = layout.cellPhases[lane];
      const scheduler = new QrFrameScheduler(
        profile,
        {
          next: async () => {
            const res = await (window as unknown as { deqr: { streamTransfer: { nextFrame(id:number): Promise<{ frame: Uint8Array|null }> } } }).deqr.streamTransfer.nextFrame(sessionId);
            return res.frame;
          },
        },
        async (frame) => {
          const canvas = canvases[lane].current;
          if (!canvas) return;
          const plan = resolveQrRenderPlan({ frameBytes: frame.length, eccLevel: profile.eccLevel, budgetCssPx: 110, version: profile.qrVersion });
          applyCanvasGeometry(canvas, plan.geometry);
          await paintQrFrame(canvas, frame, plan);
        },
        undefined,
        { maxPrefetchedFrames: 3, useRaf: true },
      );
      setTimeout(() => scheduler.start(), phase * (1000 / profile.targetFps));
      schedulers.push(scheduler);
    }
    return () => schedulers.forEach(s => s.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, sessionId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '8px' }}>
      {canvases.map((ref, i) => <canvas key={i} ref={ref} style={{ width: '100%', aspectRatio: '1' }} />)}
    </div>
  );
}
