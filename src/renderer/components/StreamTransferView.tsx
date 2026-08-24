import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TRANSPORT_PROFILE,
  effectiveFps,
  transportProfileById,
} from '../../core/transport-profiles';
import type { StreamingProgressView, StreamingTransferMetadata } from '../../shared/types';
import QRCanvas from './QRCanvas';
import { QrFrameScheduler, type SchedulerStats } from '../qr-frame-scheduler';
import {
  QrRenderPlan,
  applyCanvasGeometry,
  measureQrBudget,
  paintQrFrame,
  planMatches,
  resolveQrRenderPlan,
} from '../qr-render';
import {
  EtaEstimator,
  etaCopy,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  progressSummary,
  readTransfer,
  summarizeCompression,
} from '../sender-model';

/**
 * The DEQR v2 transfer screen.
 *
 * Three things changed from the v1 screen it replaces, and all three are the
 * point of this phase.
 *
 * **Frames are pulled.** The old screen subscribed to a main-process
 * `setInterval` that pushed frames at it - the same timer that kept encoding
 * for a destroyed renderer. Here the scheduler asks `streamTransfer.nextFrame`
 * for one when it is ready to paint, so a slow display stops the encoder and
 * the file reader by construction. Backpressure is the shape of the code rather
 * than an agreement between two components.
 *
 * **The numbers are about the file.** v1 counted frames and blocks, which are
 * the two things a person transferring a 4 GiB video cannot use. The primary
 * readout is original bytes covered, the measured rate, elapsed time, a
 * remaining estimate that is withheld until it is trustworthy, and the current
 * segment. Frames, cadence, starvation and the repair ratio are still there and
 * still exact; they are behind a disclosure, because they are engineering data
 * and a normal transfer should not open onto them.
 *
 * **Finishing is not verifying.** When the last frame goes up, this screen says
 * the stream is complete and says explicitly that the receiver has not yet
 * confirmed anything. The sender has no way to know whether the far end
 * reconstructed the file, and the previous screen's success state did not
 * distinguish the two.
 */


/**
 * How often progress is read back from the main process.
 *
 * 500 ms rather than per frame: at 12 FPS a per-frame poll is 12 IPC round
 * trips and 12 React renders per second for numbers that a person reads twice a
 * minute. It is also the sampling period the ETA window is sized against.
 */
const PROGRESS_INTERVAL_MS = 500;

/**
 * How often the announced status is allowed to change.
 *
 * The live region must never track the progress bar. Announcing every tick of a
 * multi-hour transfer is what makes a screen reader unusable, so the polite
 * region carries state transitions and a coarse milestone, nothing else.
 */
const ANNOUNCE_STEP_PERCENT = 25;

interface Props {
  sessionId: number;
  metadata: StreamingTransferMetadata;
  /** True while the machine is in HELD. The scheduler follows this, not a local flag. */
  held: boolean;
  onHold: () => void;
  onRelease: () => void;
  onFinished: () => void;
  /** The pass ran out and the recovery tail took over. The QR never stops. */
  onRecovering: () => void;
  /** True once the tail is running, so the screen can say the stream continues. */
  recovering: boolean;
  onFailed: (code: string, message: string) => void;
  onCancel: () => void;
}

export default function StreamTransferView({
  sessionId,
  metadata,
  held,
  onHold,
  onRelease,
  onFinished,
  onRecovering,
  recovering,
  onFailed,
  onCancel,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const schedulerRef = useRef<QrFrameScheduler | null>(null);
  /**
   * The symbol currently being drawn.
   *
   * A ref rather than an effect-local, because the resize observer below has to
   * be able to discard it: the plan encodes a module scale, and a window that
   * no longer has room for that scale needs a new one.
   */
  const planRef = useRef<QrRenderPlan | null>(null);
  const estimatorRef = useRef<EtaEstimator>(undefined as unknown as EtaEstimator);
  estimatorRef.current ??= new EtaEstimator();

  /*
   * The two callbacks, held by reference rather than by identity.
   *
   * The parent passes inline arrows, so their identity changes on every render
   * - and this component re-renders twice a second off the progress poll. With
   * them in the effect's dependency list, the scheduler would be stopped and
   * rebuilt on every one of those renders: a QR stream that restarts from the
   * current frame twice a second, with its queue dropped and its cadence
   * counters reset each time. Reading them through a ref keeps the effect
   * keyed on the session and the profile, which are the only two things that
   * should ever rebuild it.
   */
  const onFinishedRef = useRef(onFinished);
  const onRecoveringRef = useRef(onRecovering);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onFinishedRef.current = onFinished;
    onRecoveringRef.current = onRecovering;
    onFailedRef.current = onFailed;
  }, [onFinished, onFailed, onRecovering]);

  const [progress, setProgress] = useState<StreamingProgressView | null>(null);
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [renderError, setRenderError] = useState(false);

  const profile = useMemo(
    () => transportProfileById(metadata.transportProfileId) ?? DEFAULT_TRANSPORT_PROFILE,
    [metadata.transportProfileId],
  );
  const compression = useMemo(() => summarizeCompression(metadata), [metadata]);

  /* ---------------------------------------------------------- frame source */

  useEffect(() => {
    let disposed = false;
    let finishedReported = false;
    let recoveryStarted = false;

    const scheduler = new QrFrameScheduler(
      profile,
      {
        next: async () => {
          if (disposed) return null;
          const result = await window.deqr.streamTransfer.nextFrame(sessionId);
          // The handler answers `{ error }` instead of throwing, so a failure
          // reaches here as a shape rather than as a rejection.
          const failure = (result as unknown as { error?: { message?: string } })?.error;
          if (failure) {
            if (!disposed) onFailedRef.current('STREAM_READ_FAILED', failure.message ?? 'The optical stream could not continue.');
            return null;
          }
          // Deliberately not `setProgress` here. The frame source runs at the
          // profile's cadence - twelve times a second on Balanced - and setting
          // state from it would re-render this whole view, diagnostics grid
          // included, on every frame. The 500 ms poll below is the only thing
          // that updates the readout, which keeps React work off the same
          // thread that is encoding and painting QR symbols.
          if (result.frame) return result.frame;

          // The pass is out of frames. **This is not the end of the transfer**,
          // and treating it as one is what stranded a real receiver.
          //
          // A one-segment file is about 170 frames: the whole pass is over in
          // fifteen seconds, while someone is still lining up a phone. The
          // sender then removed the only thing the camera was reading and
          // waited for a button press that the person holding the phone was in
          // no position to give. There is no back channel, so the sender can
          // never learn that the receiver is done - which means stopping is
          // always a guess, and the wrong one costs the entire transfer.
          //
          // So the pass rolls straight into a recovery tail and keeps
          // displaying fresh symbols until someone stops it. Frames the
          // receiver already holds cost it one bit test to discard.
          if (!recoveryStarted) {
            recoveryStarted = true;
            const started = await window.deqr.streamTransfer
              .beginRecovery(sessionId)
              .catch(() => null);
            if (typeof started === 'number' && started > 0) {
              if (!disposed) onRecoveringRef.current();
              const next = await window.deqr.streamTransfer.nextFrame(sessionId);
              if (next?.frame) return next.frame;
            }
          }

          // Recovery could not start, or produced nothing. Only now is the
          // sender genuinely out of things to show.
          if (!finishedReported) {
            finishedReported = true;
            if (!disposed) onFinishedRef.current();
          }
          return null;
        },
      },
      async (frame) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
          if (!planMatches(planRef.current, frame)) {
            // Resolved once and then held. Every frame in a pass is the same
            // length, so the QR version is constant; re-resolving per frame
            // would cost an encode and, worse, could resize the symbol
            // mid-stream and make the camera re-acquire its framing.
            //
            // The budget is read here rather than captured, so the plan that
            // replaces a discarded one is built against the window as it is
            // now. Discarding is the resize observer's decision, not this one's.
            const next = resolveQrRenderPlan({
              frameBytes: frame.length,
              eccLevel: profile.eccLevel,
              budgetCssPx: measureQrBudget(canvas),
              devicePixelRatio: window.devicePixelRatio || 1,
            });
            planRef.current = next;
            applyCanvasGeometry(canvas, next.geometry);
          }
          await paintQrFrame(canvas, frame, planRef.current!);
          if (!disposed) setRenderError(false);
        } catch {
          if (!disposed) setRenderError(true);
          throw new Error('paint failed');
        }
      },
    );

    schedulerRef.current = scheduler;
    scheduler.start();

    return () => {
      disposed = true;
      scheduler.stop();
      schedulerRef.current = null;
      planRef.current = null;
    };
    // Deliberately not keyed on the callbacks; see the refs above.
  }, [sessionId, profile]);

  /* ------------------------------------------------------ keeping it in view */

  /**
   * Re-plans the symbol when the window stops having room for the one on screen.
   *
   * The trade-off is real and it is decided in one direction: resizing the
   * symbol mid-stream makes the receiving camera re-acquire its framing, which
   * costs frames. Letting it overflow costs the transfer, because the part of
   * the code that is off-screen is not dim or small — it is absent, and no
   * amount of error correction recovers a symbol that was never displayed.
   *
   * So the plan is discarded only when the *module scale* would actually
   * change. Dragging a window edge by a few pixels usually does not change it,
   * and nothing happens; crossing a threshold does, and the next frame is drawn
   * at the new size.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement?.parentElement?.parentElement;
    if (!canvas || !container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const held = planRef.current;
      if (!held) return;
      try {
        const next = resolveQrRenderPlan({
          frameBytes: held.frameBytes,
          eccLevel: held.eccLevel,
          budgetCssPx: measureQrBudget(canvas),
          devicePixelRatio: window.devicePixelRatio || 1,
          version: held.version,
        });
        if (next.geometry.moduleScale !== held.geometry.moduleScale) planRef.current = null;
      } catch {
        // The window is now too small for a whole-pixel symbol at this version.
        // Discarding makes the next paint re-plan and surface that on the
        // render-error path, which says so, rather than drawing something a
        // camera cannot read.
        planRef.current = null;
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [sessionId]);

  /* ---------------------------------------------------- hold, from the state */

  // The scheduler follows the machine rather than a local boolean. A second
  // source of truth for "is this paused" is exactly the class of bug the state
  // model exists to remove.
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (held) {
      scheduler.pause();
      // A hold is not slowness, and measuring it as slowness would make the
      // ETA wrong for as long as the window remembers it.
      estimatorRef.current.reset();
    } else {
      scheduler.resume();
    }
  }, [held]);

  /* ------------------------------------------------------------- polling */

  useEffect(() => {
    let disposed = false;
    const tick = async () => {
      if (disposed) return;
      const scheduler = schedulerRef.current;
      if (scheduler) setStats(scheduler.stats());
      setElapsedMs(Date.now() - startedAt);
      try {
        const next = await window.deqr.streamTransfer.progress(sessionId);
        if (disposed || !next) return;
        setProgress(next);
        // Sampled here, at a fixed period, rather than inside the frame source:
        // an estimator fed at the frame rate would have its window span a few
        // seconds at Turbo and half a minute at Reliable.
        estimatorRef.current.observe(
          performance.now(),
          BigInt(/^\d+$/.test(next.transportBytesCovered) ? next.transportBytesCovered : '0'),
        );
      } catch {
        // A progress read for a session that is going away is not worth
        // surfacing; the frame source is what reports a real failure.
      }
    };
    void tick();
    const handle = window.setInterval(() => void tick(), PROGRESS_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(handle);
    };
  }, [sessionId, startedAt]);

  /* --------------------------------------------------------- derivations */

  const readout = useMemo(() => (progress ? readTransfer(progress) : null), [progress]);
  const reading = useMemo(
    () => estimatorRef.current.read(readout?.transportTotal ?? 0n),
    // Re-read whenever a new sample has landed; the estimator itself is stable.
    [readout],
  );

  const percent = readout ? formatPercent(readout.fraction) : '0%';
  const announced = useMemo(() => {
    if (held) return 'Optical stream held.';
    if (!readout) return 'Optical stream starting.';
    const step = Math.floor(readout.fraction * 100 / ANNOUNCE_STEP_PERCENT) * ANNOUNCE_STEP_PERCENT;
    return step <= 0 ? 'Optical stream active.' : `Optical stream ${step} percent sent.`;
  }, [held, readout]);

  const toggleHold = useCallback(() => {
    if (held) onRelease();
    else onHold();
  }, [held, onHold, onRelease]);

  return (
    <section className="transfer-view" aria-labelledby="transfer-heading">
      {/* Coarse by construction: this changes at most four times in a transfer
          plus once per hold, however long the transfer runs. */}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announced}</p>

      <header className="transfer-header">
        <div>
          <p className="eyebrow">
            {recovering ? 'Sending recovery frames' : metadata.resumed ? 'Resuming transfer' : 'Sending'}
          </p>
          <h1 id="transfer-heading" data-screen-heading tabIndex={-1}>Keep this QR code in view</h1>
          {/* Said plainly, because the alternative is a screen that looks
              stuck. The first pass is over and the sender is now cycling fresh
              symbols for whatever the receiver missed - it will keep doing that
              until someone stops it, which is the only safe behaviour on a link
              with no way to hear back. */}
          {recovering && (
            <p className="transfer-recovery-note">
              Every frame has been shown once. Still sending — keep scanning until the
              receiving device says the file is verified.
            </p>
          )}
          <p className="transfer-file" title={metadata.filename}>{metadata.filename}</p>
        </div>
        <span className={`transfer-state ${held ? 'transfer-state--paused' : ''}`}>
          <span className="state-dot" aria-hidden="true" />
          {held ? 'Held' : 'Streaming'}
        </span>
      </header>

      {/* The only QR surface in the app. Every rule about not animating,
          scaling or filtering the symbol lives in that one component. */}
      <QRCanvas ref={canvasRef} renderError={renderError} />

      {/* One dominant status. Everything above the disclosure answers "how far
          along is my file", and nothing here is a frame count. */}
      <section className="transfer-primary" aria-label="Transfer progress">
        <div className="progress-headline">
          <strong className="progress-percent">{percent}</strong>
          <span className="progress-segment">
            {readout && readout.segmentCount > 0
              ? `Segment ${readout.segmentPosition.toLocaleString()} of ${readout.segmentCount.toLocaleString()}`
              : 'Preparing segments'}
          </span>
        </div>

        <div
          className="progress progress--wide"
          role="progressbar"
          aria-label="Optical stream sent"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={readout ? Math.round(readout.fraction * 100) : 0}
          aria-valuetext={percent}
        >
          <span style={{ transform: `scaleX(${readout ? Math.min(1, readout.fraction) : 0})` }} />
        </div>

        <p className="progress-bytes">
          {readout ? progressSummary(readout, compression.active) : 'Waiting for the first frame'}
        </p>

        <dl className="transfer-headline-metrics">
          <div>
            <dt>Elapsed</dt>
            <dd>{formatDuration(elapsedMs)}</dd>
          </div>
          <div>
            <dt>Rate</dt>
            <dd>{formatRate(reading.bytesPerSecond)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            {/* Absent until the window is long enough and steady enough. The
                waiting text is deliberate: several minutes of a long transfer
                are spent here. */}
            <dd>{etaCopy(reading)}</dd>
          </div>
        </dl>
      </section>

      <details className="diagnostics">
        <summary>Engineering diagnostics</summary>
        <dl className="diagnostics-grid">
          <div><dt>Profile</dt><dd>{profile.name} · QR v{profile.qrVersion} · ECC {profile.eccLevel}</dd></div>
          <div><dt>Target cadence</dt><dd>{effectiveFps(profile).toFixed(1)} FPS</dd></div>
          {/* Measured over painted frames, not the target restated. */}
          <div><dt>Measured cadence</dt><dd>{stats ? `${stats.effectiveFps.toFixed(1)} FPS` : '—'}</dd></div>
          <div><dt>Display health</dt><dd>{stats?.health ?? '—'}</dd></div>
          <div><dt>Frames painted</dt><dd>{stats ? stats.framesPainted.toLocaleString() : '—'}</dd></div>
          <div><dt>Frames emitted</dt><dd>{progress ? progress.framesEmitted.toLocaleString() : '—'}</dd></div>
          <div><dt>Manifest frames</dt><dd>{progress ? progress.manifestFramesEmitted.toLocaleString() : '—'}</dd></div>
          {/* Repair symbols as a share of payload. This is the loss budget
              being spent, and it is the number that separates "slow" from
              "sending the same segment again". */}
          <div><dt>Repair share</dt><dd>{readout ? formatPercent(readout.repairFraction) : '—'}</dd></div>
          <div><dt>Source symbols</dt><dd>{progress ? progress.sourceSymbolsEmitted.toLocaleString() : '—'}</dd></div>
          <div><dt>Repair symbols</dt><dd>{progress ? progress.repairSymbolsEmitted.toLocaleString() : '—'}</dd></div>
          <div><dt>Bytes on the wire</dt><dd>{readout ? formatBytes(readout.wireBytes) : '—'}</dd></div>
          <div><dt>Starved wake-ups</dt><dd>{stats ? stats.starvedWakeups.toLocaleString() : '—'}</dd></div>
          <div><dt>Paint overruns</dt><dd>{stats ? stats.overruns.toLocaleString() : '—'}</dd></div>
          <div><dt>Slowest paint</dt><dd>{stats ? `${stats.maxPaintMs.toFixed(1)} ms` : '—'}</dd></div>
          {/* Why an estimate is being withheld, in the estimator's own words. */}
          <div><dt>Rate samples</dt><dd>{reading.samples} {reading.withheld ? `· ${reading.withheld.toLowerCase().replace(/_/g, ' ')}` : '· stable'}</dd></div>
        </dl>
      </details>

      <div className="action-row transfer-actions">
        <button className="primary" onClick={toggleHold}>{held ? 'Release stream' : 'Hold stream'}</button>
        <button className="danger" onClick={onCancel}>Cancel transfer</button>
      </div>
    </section>
  );
}
