import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraController, type CameraErrorCode } from './camera';
import { discardExportedSession, exportVerifiedFile } from './export';
import { HostMonitor, hostStatusCopy, type HostStatus } from './host-status';
import { TelemetryCollector, type ReceiverTelemetry } from './metrics';
import { ReceiverClient, type VerifiedTransfer } from './receiver-client';
import { discardRetainedSessions, estimateDeviceStorage } from './receiver-storage';
import {
  RECEIVER_EVENT,
  RECEIVER_STATE,
  cameraShouldRun,
  canCancel,
  initialReceiverState,
  reduceReceiver,
  type ReceiverEvent,
  type ReceiverFault,
  type ReceiverState,
} from './receiver-state';
import {
  checkpointRejectionCopy,
  describeVerification,
  faultCopy,
  formatBytes,
  formatPercent,
  groupResumeToken,
  isCapacityFault,
  isStorageFault,
  mayOfferExport,
  mayOfferResume,
  resumeLine,
  summarizeInterruption,
  summarizeStorage,
  summarizeTransfer,
  transferHasStalled,
  transferSizeLine,
  type VerifyView,
} from './receiver-view-model';
import { emptyProgress, type ReceiveProgress } from './worker-protocol';

const VERSION = 'web-pwa-0.3.0';
const TELEMETRY_INTERVAL_MS = 500;
/**
 * How often the stall watcher looks, in ms.
 *
 * Far finer than the stall threshold itself, so the reported stall lands within
 * a second of the real one. Cheap enough to be uninteresting: it compares two
 * numbers and does nothing else.
 */
const STALL_CHECK_INTERVAL_MS = 1_000;

/**
 * The receive screen, driven by exactly one state.
 *
 * Everything this component renders is a function of `state`, `progress`,
 * `verify` and `telemetry`. There is no `isScanning`, no `cameraActive`, no
 * `receivingAnnounced` - the three flags that used to be able to disagree with
 * each other and with the protocol snapshot. Whether the camera runs, whether
 * cancel does anything, which heading is announced: all derived, in
 * `receiver-state.ts`, from the one state this component holds. What each
 * derived fact *says* lives in `receiver-view-model.ts`, so this file is
 * layout, side effects and nothing else.
 *
 * Phase 09 added the screens the architecture had earned and never shown. Every
 * one of them is a fact that was already crossing the worker port and being
 * dropped: two sizes and a compression mode, the storage decision, the segments
 * adopted from a checkpoint, the resume code, and a verification that runs in
 * two passes over totals a frozen transfer bar cannot represent.
 *
 * The component's remaining job is the side effects that state implies -
 * starting and stopping a camera, opening and closing a worker session - and it
 * does them from effects keyed on the state, never from the event handlers. A
 * handler that both dispatches and acts is how the two used to drift apart.
 */
export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const homeHeading = useRef<HTMLHeadingElement>(null);
  const receiveHeadingRef = useRef<HTMLHeadingElement>(null);

  const telemetryRef = useRef<TelemetryCollector>(undefined as unknown as TelemetryCollector);
  telemetryRef.current ??= new TelemetryCollector();
  const client = useRef<ReceiverClient | undefined>(undefined);
  const camera = useRef<CameraController | undefined>(undefined);
  const verified = useRef<VerifiedTransfer | undefined>(undefined);
  const mounted = useRef(true);
  /**
   * The last unique-frame stamp this screen has seen.
   *
   * Held in a ref rather than derived from `progress`, because the comparison
   * has to happen against the *previous* snapshot and a render can coalesce two
   * of them.
   */
  const lastUniqueAt = useRef(0);
  /**
   * The newest progress snapshot, readable from a timer.
   *
   * The stall watcher runs on an interval keyed only on the state. Without this
   * it would close over the `progress` of the render that created it and
   * conclude, correctly but uselessly, that nothing had arrived since.
   */
  const progressRef = useRef<ReceiveProgress>(emptyProgress());

  const [machine, setMachine] = useState(initialReceiverState());
  const [screen, setScreen] = useState<'HOME' | 'RECEIVE'>('HOME');
  const [progress, setProgress] = useState<ReceiveProgress>(emptyProgress());
  const [verify, setVerify] = useState<VerifyView | null>(null);
  const [telemetry, setTelemetry] = useState<ReceiverTelemetry | undefined>(undefined);
  const [message, setMessage] = useState('Ready to receive a DEQR transfer.');
  const [hostStatus, setHostStatus] = useState<HostStatus>('CHECKING');
  const [device, setDevice] = useState<{ availableBytes: number; measured: boolean } | null>(null);
  const [discarded, setDiscarded] = useState(false);

  const state = machine.state;
  const epoch = machine.epoch;

  const dispatch = useCallback((event: ReceiverEvent) => {
    if (!mounted.current) return;
    setMachine((current) => reduceReceiver(current, event));
  }, []);

  /* ------------------------------------------------------------------ client */

  // Created once and kept for the life of the component. Rebuilding it per
  // session would mean recompiling the worker bundle on every retry, which on
  // a phone is the slowest thing in the whole start path.
  useEffect(() => {
    mounted.current = true;
    const telemetry = telemetryRef.current;
    const receiver = new ReceiverClient(
      {
        onProgress: (next) => {
          if (!mounted.current) return;
          setProgress(next);
          progressRef.current = next;
          if (next.fault) {
            dispatch({
              type: RECEIVER_EVENT.SESSION_FAILED,
              // Classified by the code, not by `storagePressure`. A broken
              // writer sets no pressure flag and is still a storage fault, and
              // reporting it as a transfer fault would tell someone the
              // sender's file was corrupt when the sender was never involved.
              fault: {
                kind: isStorageFault(next.fault) || next.storagePressure ? 'storage' : 'transfer',
                code: next.fault,
              },
            });
            return;
          }
          // Two different questions, and Phase 13 needs both answered.
          //
          // A completed *unit* is what promotes SCANNING to RECEIVING: it means
          // the session is genuinely reconstructing rather than merely parsing.
          //
          // A newer unique *frame* is what ends a stall. It has to be the finer
          // signal, because a segment can take minutes and INCOMPLETE must
          // return to RECOVERING on the first sign of life rather than on the
          // first completed segment - which, on a recovery tail sent for one
          // missing segment, might be the last thing that ever happens.
          if (next.unitsRecovered > 0) dispatch({ type: RECEIVER_EVENT.FRAME_ACCEPTED });
          else if (next.lastUniqueFrameAtMs > lastUniqueAt.current) {
            dispatch({ type: RECEIVER_EVENT.FRAME_ACCEPTED });
          }
          lastUniqueAt.current = next.lastUniqueFrameAtMs;
        },
        onComplete: () => dispatch({ type: RECEIVER_EVENT.SESSION_COMPLETE }),
        // The event Phase 08 emitted and nothing drew. Without it the receiver
        // shows a transfer bar frozen at 100% for the nine seconds a gigabyte
        // takes to hash - at the exact moment it is doing the work the product
        // exists for.
        onVerifyProgress: (next) => {
          if (!mounted.current) return;
          setVerify(describeVerification(next, next.phase === 'decompressing'));
        },
        onVerified: (file) => {
          verified.current = file;
          dispatch({ type: RECEIVER_EVENT.VERIFIED });
        },
        onFailed: (code, detail) => dispatch({
          type: RECEIVER_EVENT.SESSION_FAILED,
          // A transfer that failed to verify and one that had nowhere to go are
          // different problems with different remedies, and only one of them is
          // about the sender's data.
          fault: { kind: isStorageFault(code) ? 'storage' : 'transfer', code, message: detail },
        }),
        onFatal: (code) => dispatch({
          type: RECEIVER_EVENT.WORKER_FATAL,
          fault: { kind: 'scanner', code },
        }),
      },
      { telemetry },
    );
    client.current = receiver;
    telemetry.startLongTaskMonitor();

    return () => {
      mounted.current = false;
      telemetry.stopLongTaskMonitor();
      camera.current?.dispose();
      camera.current = undefined;
      receiver.dispose();
      client.current = undefined;
      clearVerified();
    };
  }, [dispatch]);

  /**
   * Drops a verified file that is not going to be exported.
   *
   * Two shapes to clear, because since Phase 06 there are two places a verified
   * file can be. Bytes are zeroed, as every other buffer in this receiver is.
   * A file on the device is deleted outright - the session is over and nothing
   * is reading it, so leaving plaintext in the origin's private storage would
   * be a quieter version of the same leak.
   */
  const clearVerified = () => {
    const file = verified.current;
    verified.current = undefined;
    if (!file) return;
    file.sha256.fill(0);
    if (file.source.kind === 'bytes') new Uint8Array(file.source.bytes).fill(0);
    else void discardExportedSession(file.source);
  };

  /* ------------------------------------------------------- state side effects */

  // Preflight: decide whether a camera prompt can succeed before raising one.
  useEffect(() => {
    if (state !== RECEIVER_STATE.PREFLIGHT) return;
    clearVerified();
    setProgress(emptyProgress());
    setVerify(null);
    setTelemetry(undefined);
    setDiscarded(false);
    telemetryRef.current.reset();

    if (!navigator.mediaDevices?.getUserMedia) {
      // No `mediaDevices` at all means an insecure origin or an unsupported
      // browser. A permission dialog would never appear, so do not imply one.
      dispatch({
        type: RECEIVER_EVENT.CAMERA_FAILED,
        fault: { kind: 'camera', code: 'CAMERA_UNAVAILABLE' },
      });
      return;
    }
    // Resume is asked for on every session, and costs nothing when there is
    // nothing to resume. What it cannot do is adopt the wrong thing: working
    // data is only ever taken up when the incoming manifest's session, file,
    // digest and segmentation all match what was left behind, and even then the
    // final SHA-256 runs over the whole reconstruction exactly as it would for
    // a transfer that started from zero.
    client.current?.open({ resume: true });
    setMessage('Preparing camera access...');
    dispatch({ type: RECEIVER_EVENT.PREFLIGHT_PASSED });
  }, [state, dispatch]);

  // The camera runs in exactly the states that say so, and in no others.
  useEffect(() => {
    if (!cameraShouldRun(state)) {
      camera.current?.dispose();
      camera.current = undefined;
      return;
    }
    if (camera.current || state !== RECEIVER_STATE.CAMERA_WARMING) return;
    if (!video.current || !canvas.current || !client.current) return;

    const receiver = client.current;
    const controller = new CameraController(
      video.current,
      canvas.current,
      receiver,
      (code: CameraErrorCode) => {
        if (camera.current !== controller) return;
        dispatch({ type: RECEIVER_EVENT.CAMERA_FAILED, fault: { kind: 'camera', code } });
      },
      telemetryRef.current,
    );
    camera.current = controller;

    void controller.start().then((started) => {
      // `epoch` is captured from the render that armed this effect. A start that
      // resolves after a cancel belongs to a session that no longer exists.
      if (!mounted.current || camera.current !== controller) return;
      if (!started) {
        controller.dispose();
        if (camera.current === controller) camera.current = undefined;
        return;
      }
      dispatch({ type: RECEIVER_EVENT.CAMERA_READY });
      setMessage('Scanning for an animated DEQR code.');
    }).catch(() => undefined);
  }, [state, epoch, dispatch]);

  // Verification is the worker's, not this thread's. The camera is already
  // stopped by the time this runs, because VERIFYING is not a camera state.
  useEffect(() => {
    if (state !== RECEIVER_STATE.VERIFYING) return;
    setMessage('Verifying file integrity. Camera access has stopped.');
    client.current?.verify();
  }, [state]);

  useEffect(() => {
    if (state === RECEIVER_STATE.COMPLETE) setMessage('File verified. Camera access has stopped.');
  }, [state]);

  // Every state that clears the session closes the worker's session with it, so
  // a cancelled transfer's buffers do not outlive the screen that showed it.
  //
  // The reason travels with the close because it decides the fate of the
  // partial file on the device, and only this side can tell these apart.
  // `INTERRUPTED` is the one that keeps it: the user did not choose to stop and
  // is likely to come back, so the bytes are kept for a resume and the storage
  // sweep's bounds - 24 hours, three sessions - decide how long that lasts.
  // Every other ending here is a choice or a dead end, and deletes.
  useEffect(() => {
    if (
      state === RECEIVER_STATE.CANCELLED
      || state === RECEIVER_STATE.FAILED
      || state === RECEIVER_STATE.INTERRUPTED
      || state === RECEIVER_STATE.IDLE
    ) {
      client.current?.close(state === RECEIVER_STATE.INTERRUPTED ? 'interrupted' : 'cancelled');
      // Reached only from states that have already ended the session, so the
      // verified file - if one was ever produced - is no longer offerable.
      clearVerified();
    }
  }, [state]);

  /* --------------------------------------------------------------- telemetry */

  useEffect(() => {
    if (!cameraShouldRun(state)) return;
    const receiver = client.current;
    const collector = telemetryRef.current;
    const tick = () => {
      if (!mounted.current || !receiver) return;
      setTelemetry(collector.snapshot(
        performance.now(),
        receiver.framesInFlight,
        receiver.maxInFlight,
        receiver.supportsBitmapTransfer,
      ));
    };
    tick();
    const handle = window.setInterval(tick, TELEMETRY_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [state]);

  /* ------------------------------------------------------------------ stalls */

  /**
   * Watches the transfer's own liveness, which is not the camera's.
   *
   * This is the loop the physical failure needed and did not have. The camera
   * watchdog in `camera.ts` asks whether the video element is presenting
   * frames; during the failure it was, at full rate, aimed at a desktop that
   * had finished transmitting. Every component reported itself healthy and the
   * transfer was dead.
   *
   * A timer rather than a check inside `onProgress`, because the failure is the
   * *absence* of progress: a receiver that has stopped being fed stops getting
   * progress callbacks, so the one place that could notice is the only place
   * that never runs.
   */
  useEffect(() => {
    if (state !== RECEIVER_STATE.RECEIVING && state !== RECEIVER_STATE.RECOVERING) return;

    const check = () => {
      if (!mounted.current) return;
      if (transferHasStalled({
        sessionActive: progressRef.current.sessionActive,
        complete: progressRef.current.complete,
        lastUniqueFrameAtMs: progressRef.current.lastUniqueFrameAtMs,
        nowMs: Date.now(),
      })) {
        dispatch({ type: RECEIVER_EVENT.STALLED });
      }
    };
    const handle = window.setInterval(check, STALL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [state]);

  /* --------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const onVisibility = () => {
      dispatch({ type: document.hidden ? RECEIVER_EVENT.BACKGROUNDED : RECEIVER_EVENT.FOREGROUNDED });
      if (document.hidden) {
        setMessage('Camera was stopped because the app was backgrounded. What had already arrived is kept on this device.');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [dispatch]);

  // Host reachability is independent of the camera and of this app running at
  // all: an installed receiver opens offline by design. Polling stops while the
  // page is hidden and re-probes immediately on return, so a desktop Start
  // pressed in the meantime is noticed without a background timer.
  useEffect(() => {
    const monitor = new HostMonitor({
      fetch: (...args) => fetch(...args),
      onChange: (next) => { if (mounted.current) setHostStatus(next); },
      setTimeout: (handler, ms) => window.setTimeout(handler, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
    });
    const onVisibility = () => { if (!document.hidden) monitor.refresh(); };
    monitor.start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      monitor.stop();
    };
  }, []);

  // The storage preflight the home screen can actually run: a device-level
  // estimate, before any transfer exists to size against. Read once on mount
  // and again whenever a session ends, because an ended session may have
  // written or freed gigabytes.
  useEffect(() => {
    let cancelled = false;
    void estimateDeviceStorage().then((next) => {
      if (!cancelled && mounted.current) setDevice(next);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [epoch]);

  /* ------------------------------------------------------------------ actions */

  const requestCamera = useCallback(() => {
    dispatch({ type: RECEIVER_EVENT.RECEIVE_REQUESTED });
  }, [dispatch]);

  const start = useCallback(() => {
    setScreen('RECEIVE');
    requestCamera();
  }, [requestCamera]);

  const cancel = useCallback(() => {
    dispatch({ type: RECEIVER_EVENT.CANCELLED });
    setMessage('Reception cancelled and private transfer data cleared.');
  }, [dispatch]);

  const reset = useCallback(() => {
    dispatch({ type: RECEIVER_EVENT.RESET });
    setMessage('Camera is inactive. Retry when you are ready to scan again.');
  }, [dispatch]);

  const returnHome = useCallback(() => {
    dispatch({ type: RECEIVER_EVENT.CANCELLED });
    setScreen('HOME');
    setMessage('Ready to receive a DEQR transfer.');
  }, [dispatch]);

  /**
   * Throws away what an interrupted transfer left on the device.
   *
   * The bytes are in origin-private storage, which the Files app cannot see and
   * the user cannot clear. Without this control the only way to reclaim them
   * was to wait out the retention sweep or delete the whole site's data.
   */
  const discard = useCallback(async () => {
    await discardRetainedSessions().catch(() => undefined);
    if (!mounted.current) return;
    setDiscarded(true);
    setProgress(emptyProgress());
    dispatch({ type: RECEIVER_EVENT.RESET });
    setScreen('HOME');
    setMessage('Partly received data was erased from this device.');
  }, [dispatch]);

  const share = useCallback(async () => {
    const file = verified.current;
    if (!file) return;
    dispatch({ type: RECEIVER_EVENT.EXPORT_STARTED });
    try {
      const mode = await exportVerifiedFile(file);
      // Who deletes the working file, and when, depends on which route ran.
      // `share` resolves once iOS has taken the file, so removing it then is
      // safe. A download hands a blob URL to the browser's own downloader,
      // which reads it on its own schedule - deleting underneath that would
      // truncate a large save - so that copy is left for the retention sweep
      // the next session runs.
      if (mode === 'share') clearVerified();
      else verified.current = undefined;
      dispatch({ type: RECEIVER_EVENT.EXPORT_SETTLED });
      setScreen('HOME');
      setMessage(mode === 'share'
        ? 'Share sheet opened. Complete Save to Files or sharing there.'
        : 'Download was requested. Choose a destination in the browser UI.');
    } catch {
      // The file is still held, so returning to COMPLETE is the honest state.
      dispatch({ type: RECEIVER_EVENT.VERIFIED });
      setMessage('Export failed. The verified file remains available until you reset.');
    }
  }, [dispatch]);

  /* -------------------------------------------------------------- derivations */

  const fault = machine.fault;
  // A failed scanner is not a failed camera, and neither is a failed transfer.
  // Reporting a scanner fault as a camera fault sent people to the iPhone
  // permission screen to fix something that was never wrong there; reporting a
  // camera fault as "Transfer not verified" tells them their file was corrupt
  // when the camera never opened. The fault's `kind` decides all three.
  const faultKind = fault?.kind;
  const scannerFailed = faultKind === 'scanner';
  const failure = useMemo(() => faultCopy(fault), [fault]);

  const transfer = useMemo(() => summarizeTransfer(progress), [progress]);
  const storage = useMemo(() => summarizeStorage(progress), [progress]);
  const interruption = useMemo(
    () => (mayOfferResume(state) ? summarizeInterruption(progress) : null),
    [state, progress],
  );
  const rejection = useMemo(
    () => checkpointRejectionCopy(progress.checkpointRejection),
    [progress.checkpointRejection],
  );

  const percent = transfer ? formatPercent(transfer.fraction) : '0%';
  const cameraStatus = cameraStatusCopy(state, scannerFailed);
  const receiveHeading = receiveHeadingCopy(state, faultKind, fault?.code, failure.heading);
  const canRetryCamera = state === RECEIVER_STATE.IDLE
    || state === RECEIVER_STATE.FAILED
    || state === RECEIVER_STATE.CANCELLED
    || state === RECEIVER_STATE.INTERRUPTED;
  const scanTiming = useMemo(() => {
    if (!telemetry || !telemetry.decodedFrames) return undefined;
    const decode = telemetry.decodeP50Ms?.toFixed(1) ?? '—';
    const decodeTail = telemetry.decodeP95Ms?.toFixed(1) ?? '—';
    return `${telemetry.capturedFrames} scans, ${decode} ms decode p50, ${decodeTail} ms p95`;
  }, [telemetry]);
  const host = hostStatusCopy(hostStatus);
  const statusMessage = state === RECEIVER_STATE.FAILED ? failure.message : message;
  const liveStatus = screen === 'HOME'
    ? 'Home. Ready to receive a DEQR transfer.'
    : liveStatusCopy(state, faultKind, fault?.code);

  useEffect(() => {
    const heading = screen === 'HOME' ? homeHeading.current : receiveHeadingRef.current;
    heading?.focus({ preventScroll: true });
  }, [state, screen]);

  return <main className="app-shell">
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src="./icons/deqr-chip.svg" alt="" />
        <div><strong>DEQR</strong><small>Optical Transfer</small></div>
      </div>
      {/* Replaces a static "Receiver" chip that only ever restated the app's
          own name. Its own polite region, changing text only on a real
          transition, so a poll that confirms the current state says nothing. */}
      <span
        className={'host-chip host-' + hostStatus.toLowerCase()}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={'DEQR receiver ' + VERSION}
      >
        <span className="host-dot" aria-hidden="true" />
        {host.label}
        <span className="visually-hidden">. {host.detail}</span>
      </span>
    </header>

    {/* Already announced above; shown for the eye, and only when it is
        actionable, so the normal case costs no vertical space. */}
    {hostStatus !== 'ONLINE' && <p className="host-detail" aria-hidden="true">{host.detail}</p>}

    {screen === 'HOME' && <section className="home-screen" aria-labelledby="home-title">
      <div className="home-mark card" aria-hidden="true"><img src="./icons/deqr-chip.svg" alt="" /></div>
      <p className="eyebrow">OFFLINE OPTICAL RECEIVER</p>
      <h1 id="home-title" ref={homeHeading} tabIndex={-1}>Receive a file with your camera.</h1>
      <p className="home-copy">Scan a DEQR animation from another device. Your file is offered for saving only after its size and SHA-256 hash are verified on this iPhone.</p>
      <section className="trust-note" aria-label="Transfer protection">
        <span className="trust-icon" aria-hidden="true">✓</span>
        <p><strong>Private by design</strong><br />The transfer stays local to your devices. No account or network connection is needed after installation.</p>
      </section>
      {/* The storage preflight the home screen can honestly run. There is no
          transfer to size against yet, so this reports the device rather than
          the file - and says nothing at all when the browser will not answer,
          rather than turning silence into reassurance. */}
      {device?.measured && <p className="storage-preflight">
        About <strong>{formatBytes(device.availableBytes)}</strong> is available on this device for transfers.
        A large file needs room for all of it before the transfer starts.
      </p>}
      {discarded && <p className="storage-preflight" role="status">Partly received data was erased from this device.</p>}
      <div className="home-actions">
        <button className="primary" onClick={start}>Receive File</button>
        <p className="install-note">For the best iPhone experience, install with Safari: Share, Add to Home Screen, then open as an app.</p>
      </div>
    </section>}

    {screen === 'RECEIVE' && <section className="receive-screen" aria-labelledby="receive-title">
      {/* Verification runs with the camera already stopped, so the preview is
          replaced rather than left showing a dead frame beside a progress bar
          that is about something else entirely. */}
      {state === RECEIVER_STATE.VERIFYING
        ? <section className="verify-panel card" aria-label="Verifying the received file">
            <span className="verify-mark" aria-hidden="true">◈</span>
            <strong>{verify?.headline ?? 'Verifying file integrity'}</strong>
            <p>{verify?.detail ?? 'The camera has stopped. Nothing is offered to save until the hash matches.'}</p>
            {verify && verify.steps > 1 && <p className="verify-step">Step {verify.step} of {verify.steps}</p>}
            <div
              className="progress"
              role="progressbar"
              aria-label={verify?.phase === 'decompressing' ? 'Expanding the transfer' : 'Checking the file hash'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={verify ? Math.round(verify.fraction * 100) : 0}
              aria-valuetext={verify ? formatPercent(verify.fraction) : '0%'}
            >
              <span style={{ transform: 'scaleX(' + (verify ? Math.min(1, verify.fraction) : 0) + ')' }} />
            </div>
            {verify && <p className="verify-bytes">{formatBytes(verify.bytesHashed)} of {formatBytes(verify.bytesTotal)}</p>}
          </section>
        : <div className={'camera-panel card camera-' + cameraPanelModifier(state)}>
            <div className="camera-frame">
              <video ref={video} playsInline muted aria-label="Live rear camera preview" />
              <canvas ref={canvas} aria-hidden="true" />
              <div className="scan-guide" aria-hidden="true"><span /></div>
              <div className="camera-indicator"><span aria-hidden="true" />{cameraStatus}</div>
            </div>
            <div className="camera-caption"><strong>Keep the animated code inside the guide.</strong><span>The camera stops before integrity verification.</span></div>
          </div>}

      <section className="status-card card">
        <p className="eyebrow">{eyebrowCopy(state)}</p>
        <h1 id="receive-title" ref={receiveHeadingRef} tabIndex={-1}>{receiveHeading}</h1>
        <p className="status-copy">{fault?.message ?? statusMessage}</p>

        {/* What to do next, when there is something. `senderSide` marks the
            cases where nothing done on this phone will help - the compression
            refusal above all, which has no back channel and can only be closed
            by a sentence telling someone what to ask the desktop for. */}
        {state === RECEIVER_STATE.FAILED && failure.action && <p className={'fault-action' + (failure.senderSide ? ' fault-action--sender' : '')}>
          {failure.senderSide && <span className="fault-action-label">On the sending device</span>}
          {failure.action}
        </p>}

        {/* The file, once the manifest says what it is. Two sizes when they
            differ, because under compression they differ by a factor of four
            and one number would make a healthy transfer look like a lost one. */}
        {transfer && state !== RECEIVER_STATE.FAILED && <div className="transfer-summary">
          <div className="transfer-file">
            <span className="transfer-file-icon" aria-hidden="true">▤</span>
            <div>
              <strong title={transfer.filename}>{transfer.filename}</strong>
              <small>{transferSizeLine(transfer)}</small>
            </div>
          </div>
          {transfer.compressionText && <p className="transfer-note">
            Sent compressed at {transfer.compressionText} of its size. It is expanded and hash-checked on this device.
          </p>}
        </div>}

        {storage && state !== RECEIVER_STATE.COMPLETE && <div className={'storage-summary' + (storage.sufficient ? '' : ' storage-summary--short')}>
          <strong>{storage.headline}</strong>
          <small>{storage.detail}</small>
        </div>}

        {rejection && <p className="checkpoint-note">{rejection}</p>}

        {transfer && (state === RECEIVER_STATE.RECEIVING
          || state === RECEIVER_STATE.RECOVERING
          || state === RECEIVER_STATE.INCOMPLETE
          || state === RECEIVER_STATE.COMPLETE) && <>
          <div className="progress-row">
            <div className="progress" role="progressbar" aria-label="Segments recovered" aria-valuemin={0} aria-valuemax={transfer.segmentsTotal || 1} aria-valuenow={transfer.segmentsRecovered} aria-valuetext={percent}><span style={{ transform: 'scaleX(' + Math.min(1, transfer.fraction) + ')' }} /></div>
            <strong>{percent}</strong>
          </div>
          <p className="segment-line">Segment {transfer.segmentsRecovered.toLocaleString()} of {transfer.segmentsTotal.toLocaleString()}</p>
          {/* A bar that opens at 90% has to be able to say why, or a resume
              looks like a transfer that skipped most of the file. */}
          {resumeLine(transfer) && <p className="resume-line">{resumeLine(transfer)}</p>}
        </>}

        {state === RECEIVER_STATE.COMPLETE && verified.current && <div className="verified-file">
          <span className="success-mark" aria-hidden="true">✓</span>
          <div><span>Verified file</span><strong>{verified.current.filename}</strong><small>{formatBytes(verified.current.size)} · SHA-256 verified on this device</small></div>
        </div>}

        {/* An interruption is the one ending that keeps its bytes. Saying how
            much was kept, and offering both ways out of it, is what turns
            Phase 07's retained data from a mechanism into a feature. */}
        {interruption && <div className="resume-card">
          <p className="resume-card-title">Kept on this device</p>
          <p className="resume-card-body">
            <strong>{interruption.segmentsRetained.toLocaleString()} of {interruption.segmentsTotal.toLocaleString()} segments</strong>
            {interruption.bytesRetained > 0 && <> · {formatBytes(interruption.bytesRetained)}</>}
          </p>
          {interruption.resumeToken && <>
            <p className="resume-card-body">On the sending device, choose <strong>Enter resume code</strong> and type this, then pick the same file again.</p>
            {/* Grouped in fives, matching the sender's field, because this is
                transcribed one character at a time across an air gap. */}
            <p className="resume-token monospace" aria-label={'Resume code ' + interruption.resumeToken.split('').join(' ')}>
              {groupResumeToken(interruption.resumeToken)}
            </p>
          </>}
          <button className="danger resume-discard" onClick={() => void discard()}>Erase kept data</button>
        </div>}

        <details className="scan-details">
          <summary>Scanning details</summary>
          {/* Counts only. These separate "the camera never resolved a code"
              from "codes decode but belong to another transfer" from "blocks
              are arriving"; no payload byte is ever surfaced here. */}
          <dl>
            <div><dt>{progress.protocol === 2 ? 'Segments' : 'Unique blocks'}</dt><dd>{progress.unitsRecovered} / {progress.unitsTotal || '—'}</dd></div>
            <div><dt>QR codes read</dt><dd>{telemetry?.decodedFrames ?? 0}</dd></div>
            <div><dt>Duplicates ignored</dt><dd>{progress.framesDuplicate}</dd></div>
            <div><dt>Other transfer</dt><dd>{progress.framesForeign}</dd></div>
            {/* Where this transfer's bytes are going. `memory` is the no-OPFS
                fallback and is bounded at about nine megabytes, which is worth
                knowing before a four-gigabyte scan. */}
            {progress.storageKind !== 'none' && <div><dt>Working storage</dt><dd>{progress.storageKind === 'opfs' ? 'Device storage' : 'Memory (limited)'}</dd></div>}
            {progress.bytesCommitted > 0 && <div><dt>Written so far</dt><dd>{formatBytes(progress.bytesCommitted)}</dd></div>}
            {/* The three numbers that say whether the pipeline is keeping up.
                Frames in flight is capped by construction; skipped and stale
                are what the cap costs when decode falls behind capture. */}
            {telemetry && <div><dt>Frames in flight</dt><dd>{telemetry.inFlight} / {telemetry.maxInFlight}</dd></div>}
            {Boolean(telemetry?.skippedBusy) && <div><dt>Skipped while busy</dt><dd>{telemetry!.skippedBusy}</dd></div>}
            {Boolean(telemetry?.droppedStale) && <div><dt>Dropped stale</dt><dd>{telemetry!.droppedStale}</dd></div>}
            {/* Non-zero means the video stopped presenting frames and the
                watchdog restarted the loop. It separates "the scanner died"
                from "the code will not decode". */}
            {Boolean(telemetry?.stalledRecoveries) && <div><dt>Scanner restarts</dt><dd>{telemetry!.stalledRecoveries}</dd></div>}
            {/* The number Phase 04 could only guess at. Below the profile's
                requirement means move closer; a low skew means straighten up. */}
            {telemetry?.optical && <div className="wide"><dt>Camera resolution on the code</dt><dd>{telemetry.optical.pxPerModule.toFixed(2)} px per module, v{telemetry.optical.qrVersion}, {Math.round(telemetry.optical.spanSkew * 100)}% square</dd></div>}
            {scanTiming && <div className="wide"><dt>Local scanner timing</dt><dd>{scanTiming}</dd></div>}
          </dl>
        </details>
      </section>

      <div className="action-dock">
        {/* Export is gated on the one predicate that means the hash matched.
            Nothing else in this component may offer a save. */}
        {mayOfferExport(state) ? <>
          <button className="primary" onClick={() => void share()}>Save verified file</button>
          <button onClick={() => { reset(); setScreen('HOME'); }}>Receive another</button>
        </> : canRetryCamera ? <>
          <button className="primary" onClick={requestCamera}>{state === RECEIVER_STATE.INTERRUPTED ? 'Continue receiving' : 'Try camera again'}</button>
          <button onClick={returnHome}>Return to home</button>
        </> : <>
          <button className="danger" onClick={cancel} disabled={!canCancel(state)}>Cancel transfer</button>
          <button onClick={reset}>Reset</button>
        </>}
      </div>
    </section>}
  </main>;
}

/* ------------------------------------------------------------------- copy */

/**
 * Every string below is a pure function of the state.
 *
 * Kept outside the component so that the mapping is one switch per question
 * rather than a chain of ternaries in the render, and so that a test can read
 * them without a DOM.
 */
function cameraPanelModifier(state: ReceiverState): string {
  if (state === RECEIVER_STATE.SCANNING || state === RECEIVER_STATE.RECEIVING) return 'active';
  if (state === RECEIVER_STATE.PREFLIGHT || state === RECEIVER_STATE.CAMERA_WARMING) return 'preparing';
  if (state === RECEIVER_STATE.FAILED) return 'error';
  return 'idle';
}

function cameraStatusCopy(state: ReceiverState, scannerFailed: boolean): string {
  switch (state) {
    case RECEIVER_STATE.SCANNING:
    case RECEIVER_STATE.RECEIVING:
    case RECEIVER_STATE.RECOVERING:
      return 'Camera active';
    // Still watching, deliberately: the act that ends a stall happens on the
    // sending device and there is no back channel to announce it.
    case RECEIVER_STATE.INCOMPLETE:
      return 'Camera active, waiting for frames';
    case RECEIVER_STATE.PREFLIGHT:
    case RECEIVER_STATE.CAMERA_WARMING:
      return 'Preparing camera';
    case RECEIVER_STATE.FAILED:
      return scannerFailed ? 'Scanner unavailable' : 'Camera unavailable';
    default:
      return 'Camera inactive';
  }
}

function receiveHeadingCopy(
  state: ReceiverState,
  faultKind: ReceiverFault['kind'] | undefined,
  faultCode: string | undefined,
  failureHeading: string,
): string {
  switch (state) {
    case RECEIVER_STATE.COMPLETE:
      return 'File verified';
    case RECEIVER_STATE.EXPORTING:
      return 'Saving verified file';
    case RECEIVER_STATE.FAILED:
      // Every failure heading comes from one place now, so a code that needs a
      // different sentence gets one without a second switch to keep in step.
      return failureHeading;
    case RECEIVER_STATE.CANCELLED:
      return 'Reception cancelled';
    case RECEIVER_STATE.INTERRUPTED:
      return 'Reception interrupted';
    case RECEIVER_STATE.VERIFYING:
      return 'Verifying file integrity';
    case RECEIVER_STATE.PREFLIGHT:
    case RECEIVER_STATE.CAMERA_WARMING:
      return 'Allow camera access';
    case RECEIVER_STATE.IDLE:
      return 'Camera paused';
    default:
      void faultKind;
      void faultCode;
      return 'Receiving transfer';
  }
}

function eyebrowCopy(state: ReceiverState): string {
  return state === RECEIVER_STATE.SCANNING ? 'READY TO SCAN' : state;
}

function liveStatusCopy(
  state: ReceiverState,
  faultKind: ReceiverFault['kind'] | undefined,
  faultCode?: string,
): string {
  switch (state) {
    case RECEIVER_STATE.VERIFYING:
      return 'Transfer received. Verifying file integrity.';
    case RECEIVER_STATE.COMPLETE:
      return 'File verified and ready to save.';
    case RECEIVER_STATE.EXPORTING:
      return 'Saving the verified file.';
    case RECEIVER_STATE.FAILED:
      if (faultCode === 'UNSUPPORTED_COMPRESSION') {
        return 'This browser cannot expand the transfer. No file was saved.';
      }
      if (faultKind === 'scanner') return 'Scanner unavailable. Reload the app and try again.';
      if (faultKind === 'camera') return 'Camera unavailable. Check permission and try again.';
      if (faultKind === 'storage') {
        return isCapacityFault(faultCode)
          ? 'Not enough room for this transfer. No file was saved.'
          : 'This device could not store the transfer. No file was saved.';
      }
      return 'Transfer failed verification. No file was saved.';
    case RECEIVER_STATE.CANCELLED:
      return 'Reception cancelled and temporary transfer data cleared.';
    case RECEIVER_STATE.INTERRUPTED:
      // Changed in Phase 09: the bytes are kept, and a screen that said they
      // were cleared was describing the cancelled path, not this one.
      return 'Reception was interrupted. What arrived is kept on this device and can be resumed.';
    case RECEIVER_STATE.PREFLIGHT:
    case RECEIVER_STATE.CAMERA_WARMING:
      return 'Preparing camera access.';
    case RECEIVER_STATE.RECEIVING:
      return 'Receiving validated DEQR frames.';
    case RECEIVER_STATE.RECOVERING:
      return 'Receiving recovery frames for the segments still missing.';
    case RECEIVER_STATE.INCOMPLETE:
      // Says what happened, what survived, and what to do - in that order.
      // "Incomplete" on its own reads as failure, and the whole point of this
      // state is that nothing has been lost and the transfer can still finish.
      return 'The sender stopped before every part arrived. What was received is kept. '
        + 'On the sending device, choose Send recovery frames or enter the code below.';
    case RECEIVER_STATE.SCANNING:
      return 'Camera active and ready to scan.';
    default:
      return 'Camera inactive.';
  }
}
