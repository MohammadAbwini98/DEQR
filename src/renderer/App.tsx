import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSelectionResult, StreamingSelectionResult, StreamingTransferMetadata } from '../shared/types';
import { DEFAULT_TRANSPORT_PROFILE } from '../core/transport-profiles';
// The titlebar draws this at 23px, where the full mark's arms and focal blades
// fall under two pixels and speckle. `deqr-chip.svg` is the same mark in its
// micro treatment, built for this size band.
import deqrLogo from '../../mobile-web/public/icons/deqr-chip.svg';
import Dashboard from './components/Dashboard';
import LoopbackView from './components/LoopbackView';
import CameraReceiver from './components/CameraReceiver';
import ResumeTokenEntry from './components/ResumeTokenEntry';
import SenderPreflightCard from './components/SenderPreflightCard';
import StreamTransferView from './components/StreamTransferView';
import { getIpcError, getSaveOutcome } from './app-model';
import {
  SENDER_EVENT,
  SENDER_STATE,
  canCancel,
  cancelNeedsConfirmation,
  initialSenderState,
  reduceSender,
  sessionIsCleared,
  type SenderEvent,
  type SenderState,
} from './sender-state';

/**
 * The desktop shell, driven by one sender state machine.
 *
 * Before this phase the send flow was a `useState` over a fifteen-member union,
 * assigned from inside seven async handlers, beside an unused second state
 * machine in `state-machine.ts`. It also drove the **v1** transfer path — a
 * main-process `setInterval` pushing fountain frames for a container that had
 * to fit under 32 MiB — while every part of the v2 streaming sender built in
 * Phases 02 through 08 sat behind an IPC surface nothing called.
 *
 * Both are fixed here. The send half is `sender-state.ts` and nothing else, and
 * it drives `streamTransfer`, which pulls frames, streams segments off disk,
 * compresses when the bytes justify it, and resumes from a receiver's token.
 *
 * Two flows deliberately still use v1, and neither is a transfer:
 *
 * - **Local verification** (loopback) re-decodes a file already on this disk to
 *   prove the container round-trips. It needs a v1 session because that is the
 *   decoder it exercises, and it is behind a disclosure labelled as a self-test.
 * - **The desktop camera receiver** is a development and verification surface.
 *   The shipping receiver is the iOS PWA, which Phase 09 rebuilds on its side.
 *
 * They are separate screens reached only from `IDLE`, so neither can be live
 * while a send is, and neither shares state with the sender machine.
 */

/** Which surface is on screen. Only ever switched from an idle sender. */
type Surface = 'SEND' | 'RECEIVE' | 'LOOPBACK';

/** The desktop receiver's own small flow. Unrelated to the sender machine. */
type ReceiveScreen = 'CAMERA' | 'VERIFYING' | 'SAVED' | 'FAILED';

export default function App() {
  const [machine, setMachine] = useState(initialSenderState());
  const [surface, setSurface] = useState<Surface>('SEND');
  const [session, setSession] = useState<StreamingSelectionResult | null>(null);
  const [profileId, setProfileId] = useState<number>(DEFAULT_TRANSPORT_PROFILE.id);
  const [resumeRejection, setResumeRejection] = useState<string | null>(null);

  const [loopbackSession, setLoopbackSession] = useState<FileSelectionResult | null>(null);
  const [receiveScreen, setReceiveScreen] = useState<ReceiveScreen>('CAMERA');
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receiveNotice, setReceiveNotice] = useState('');

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDialogRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);

  const state = machine.state;
  const epoch = machine.epoch;

  const dispatch = useCallback((event: SenderEvent) => {
    if (!mounted.current) return;
    setMachine((current) => reduceSender(current, event));
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-screen-heading]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state, surface, receiveScreen]);

  /* ------------------------------------------------------ session lifetime */

  // The main process holds a file descriptor for every live session. Every
  // state that clears the session releases it here, from an effect keyed on the
  // state rather than from the handler that caused it - a handler that both
  // dispatches and acts is how the two used to drift apart.
  useEffect(() => {
    if (!sessionIsCleared(state)) return;
    const open = session;
    if (!open) return;
    setSession(null);
    void window.deqr.streamTransfer.cancel(open.sessionId).catch(() => undefined);
  }, [state, session]);

  // PREPARING has one job: confirm the session the renderer is about to stream
  // from is still there. It is a real check rather than a spinner - a session
  // released by a window close or a main-process error would otherwise surface
  // as a QR canvas that never paints.
  useEffect(() => {
    if (state !== SENDER_STATE.PREPARING || !session) return;
    const armedEpoch = epoch;
    let cancelled = false;
    void (async () => {
      try {
        const progress = await window.deqr.streamTransfer.progress(session.sessionId);
        if (cancelled || !mounted.current || armedEpoch !== epoch) return;
        if (!progress) throw new Error('The transfer session is no longer available.');
        dispatch({ type: SENDER_EVENT.STREAM_STARTED });
      } catch (caught) {
        if (cancelled || !mounted.current) return;
        dispatch({
          type: SENDER_EVENT.STREAM_FAILED,
          fault: {
            kind: 'stream',
            code: 'SESSION_UNAVAILABLE',
            message: getIpcError(caught) || (caught instanceof Error ? caught.message : 'The transfer could not start.'),
          },
        });
      }
    })();
    return () => { cancelled = true; };
  }, [state, session, epoch, dispatch]);

  /* ------------------------------------------------------------ selection */

  const openPicker = useCallback(async (resumeToken?: string) => {
    // Captured before the await. A picker the user leaves open for a minute can
    // resolve into a screen that has moved on, and the epoch is how a stale
    // result is recognised as belonging to a session that no longer exists.
    const armedEpoch = machine.epoch + 1;
    try {
      const result = await window.deqr.streamTransfer.select({
        resumeToken,
        transportProfileId: profileId,
      });
      if (!mounted.current) return;
      const ipcError = getIpcError(result);
      if (ipcError) {
        // A refused resume code is not a broken file, and it must land back on
        // the code field rather than on a generic failure screen.
        if (resumeToken) {
          setResumeRejection(ipcError);
          dispatch({ type: SENDER_EVENT.PREFLIGHT_FAILED, fault: { kind: 'resume', code: 'RESUME_REFUSED', message: ipcError } });
          dispatch({ type: SENDER_EVENT.RESUME_REQUESTED });
          return;
        }
        dispatch({ type: SENDER_EVENT.PREFLIGHT_FAILED, fault: { kind: 'preflight', code: 'SELECT_FAILED', message: ipcError } });
        return;
      }
      if (!result) {
        dispatch({ type: SENDER_EVENT.PREFLIGHT_EMPTY });
        return;
      }
      setResumeRejection(null);
      setSession(result);
      dispatch({ type: SENDER_EVENT.PREFLIGHT_READY });
      void armedEpoch;
    } catch (caught) {
      if (!mounted.current) return;
      const message = getIpcError(caught) || (caught instanceof Error ? caught.message : 'The file could not be prepared.');
      if (resumeToken) {
        setResumeRejection(message);
        dispatch({ type: SENDER_EVENT.PREFLIGHT_FAILED, fault: { kind: 'resume', code: 'RESUME_REFUSED', message } });
        dispatch({ type: SENDER_EVENT.RESUME_REQUESTED });
        return;
      }
      dispatch({ type: SENDER_EVENT.PREFLIGHT_FAILED, fault: { kind: 'preflight', code: 'SELECT_FAILED', message } });
    }
  }, [dispatch, machine.epoch, profileId]);

  const selectFile = useCallback(() => {
    setResumeRejection(null);
    dispatch({ type: SENDER_EVENT.SELECT_REQUESTED });
    void openPicker();
  }, [dispatch, openPicker]);

  const submitResume = useCallback((token: string) => {
    dispatch({ type: SENDER_EVENT.RESUME_SUBMITTED });
    void openPicker(token);
  }, [dispatch, openPicker]);

  /* --------------------------------------------------------------- cancel */

  const closeCancelDialog = useCallback(() => {
    setCancelDialogOpen(false);
    window.requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, []);

  const performCancel = useCallback(() => {
    setCancelDialogOpen(false);
    dispatch({ type: SENDER_EVENT.CANCELLED });
  }, [dispatch]);

  const requestCancel = useCallback(() => {
    if (!cancelNeedsConfirmation(state)) {
      performCancel();
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCancelDialogOpen(true);
  }, [performCancel, state]);

  useEffect(() => {
    if (!cancelDialogOpen) return;
    continueButtonRef.current?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(cancelDialogRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', trapFocus);
    return () => window.removeEventListener('keydown', trapFocus);
  }, [cancelDialogOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (cancelDialogOpen) {
        event.preventDefault();
        closeCancelDialog();
        return;
      }
      if (surface === 'SEND' && canCancel(state)) {
        event.preventDefault();
        requestCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [cancelDialogOpen, closeCancelDialog, requestCancel, state, surface]);

  /* ------------------------------------------------- loopback and receiver */

  const startLoopback = useCallback(async () => {
    try {
      setReceiveError(null);
      // Loopback exercises the v1 decoder against a v1 container, so it opens
      // its own v1 selection rather than borrowing the streaming session.
      const selected = await window.deqr.files.selectForTransfer();
      const ipcError = getIpcError(selected);
      if (ipcError) throw new Error(ipcError);
      if (!selected?.sessionId) return;
      await window.deqr.loopback.start(selected.sessionId, {
        lossPercentage: 30,
        shuffle: true,
        duplicateInjection: false,
      });
      if (!mounted.current) return;
      setLoopbackSession(selected);
      setSurface('LOOPBACK');
    } catch (caught) {
      if (!mounted.current) return;
      setReceiveError(getIpcError(caught) || (caught instanceof Error ? caught.message : 'Local verification could not start.'));
      setReceiveScreen('FAILED');
      setSurface('RECEIVE');
    }
  }, []);

  const leaveLoopback = useCallback(() => {
    const open = loopbackSession;
    setLoopbackSession(null);
    setSurface('SEND');
    if (open) void window.deqr.loopback.cancel(open.sessionId).catch(() => undefined);
  }, [loopbackSession]);

  const openReceiver = useCallback(() => {
    setReceiveError(null);
    setReceiveNotice('The camera remains off until you choose Start camera.');
    setReceiveScreen('CAMERA');
    setSurface('RECEIVE');
  }, []);

  const leaveReceiver = useCallback(() => {
    setReceiveError(null);
    setReceiveScreen('CAMERA');
    setSurface('SEND');
  }, []);

  const handleVerifiedReceive = useCallback(async (payload: Uint8Array, metadata: unknown) => {
    setReceiveError(null);
    setReceiveScreen('VERIFYING');
    const defaultName = typeof metadata === 'object' && metadata && 'filename' in metadata
      ? String((metadata as { filename: string }).filename)
      : 'received_transfer.deqr';

    try {
      const success = await window.deqr.receive.saveReceivedFile(payload, defaultName);
      if (!mounted.current) return;
      const outcome = getSaveOutcome(success);
      if (outcome.notice) setReceiveNotice(outcome.notice);
      if (outcome.error) setReceiveError(outcome.error);
      setReceiveScreen(outcome.state === 'completed' ? 'SAVED' : 'FAILED');
    } catch (caught) {
      if (!mounted.current) return;
      setReceiveError(getIpcError(caught) || (caught instanceof Error ? caught.message : 'The received file could not be verified or saved.'));
      setReceiveScreen('FAILED');
    }
  }, []);

  /* ---------------------------------------------------------------- render */

  const metadata: StreamingTransferMetadata | null = session?.metadata ?? null;
  const fault = machine.fault;

  return (
    <div className="app-container">
      <header className="titlebar">
        <div className="titlebar-brand" aria-label="DEQR Optical Transfer">
          <img src={deqrLogo} alt="" className="brand-mark" />
          <span>DEQR</span>
          <span className="titlebar-separator" aria-hidden="true">/</span>
          <span className="titlebar-context">Optical Transfer</span>
        </div>
        <div className="titlebar-controls" aria-label="Window controls">
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.minimize()} aria-label="Minimize window">−</button>
          <button className="titlebar-button" onClick={() => window.deqr.windowControls.maximizeOrRestore()} aria-label="Maximize or restore window">□</button>
          <button className="titlebar-button close" onClick={() => window.deqr.windowControls.close()} aria-label="Close window">×</button>
        </div>
      </header>

      {/* One polite region for the shell. The transfer screen owns its own,
          throttled to milestones, so this one never narrates progress. */}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {shellAnnouncement(surface, state, receiveScreen)}
      </p>

      <main className={`content content--${surface.toLowerCase()}-${state.toLowerCase()}`}>
        {surface === 'SEND' && (state === SENDER_STATE.IDLE || state === SENDER_STATE.CANCELLED) && (
          <Dashboard
            onSelectFile={selectFile}
            onResumeTransfer={() => dispatch({ type: SENDER_EVENT.RESUME_REQUESTED })}
            onReceiveFile={openReceiver}
            isSelecting={false}
            error={null}
            notice={state === SENDER_STATE.CANCELLED
              ? 'Transfer cancelled. Temporary sender data was released by the main process.'
              : 'Ready for a local, screen-to-camera transfer.'}
          />
        )}

        {surface === 'SEND' && state === SENDER_STATE.RESUME_ENTRY && (
          <ResumeTokenEntry
            onSubmit={submitResume}
            onCancel={() => dispatch({ type: SENDER_EVENT.CANCELLED })}
            rejection={resumeRejection}
            busy={false}
          />
        )}

        {surface === 'SEND' && state === SENDER_STATE.PREFLIGHTING && (
          <section className="status-card" aria-labelledby="preflight-progress-heading">
            <p className="eyebrow">Preparing</p>
            <h1 id="preflight-progress-heading" data-screen-heading tabIndex={-1}>Reading the file</h1>
            {/* The honest description of a step that takes seconds on a small
                file and minutes on a large one. The old copy said the IPC
                bridge was "preparing the optical stream", which described the
                cheap half. */}
            <p>
              DEQR reads the file once to compute its SHA-256 and to measure whether compressing it would
              shorten the transfer. A large file takes a while, and nothing is displayed until it finishes.
            </p>
          </section>
        )}

        {surface === 'SEND' && state === SENDER_STATE.READY && metadata && (
          <SenderPreflightCard
            metadata={metadata}
            selectedProfileId={profileId}
            onSelectProfile={setProfileId}
            onStart={() => dispatch({ type: SENDER_EVENT.START_REQUESTED })}
            onChooseAnother={selectFile}
            onRunLoopback={() => void startLoopback()}
            busy={false}
          />
        )}

        {surface === 'SEND' && state === SENDER_STATE.PREPARING && (
          <section className="status-card" aria-labelledby="preparing-heading">
            <p className="eyebrow">Preparing</p>
            <h1 id="preparing-heading" data-screen-heading tabIndex={-1}>Starting the optical stream</h1>
            <p>The local, context-isolated IPC bridge is arming the frame schedule. No network transfer is used.</p>
          </section>
        )}

        {surface === 'SEND'
          && (state === SENDER_STATE.TRANSFERRING || state === SENDER_STATE.HELD)
          && session && metadata && (
          <StreamTransferView
            sessionId={session.sessionId}
            metadata={metadata}
            held={state === SENDER_STATE.HELD}
            onHold={() => dispatch({ type: SENDER_EVENT.HOLD })}
            onRelease={() => dispatch({ type: SENDER_EVENT.RELEASE })}
            onFinished={() => dispatch({ type: SENDER_EVENT.STREAM_FINISHED })}
            onFailed={(code, message) => dispatch({
              type: SENDER_EVENT.STREAM_FAILED,
              fault: { kind: 'stream', code, message },
            })}
            onCancel={requestCancel}
          />
        )}

        {surface === 'SEND' && state === SENDER_STATE.STREAM_COMPLETE && metadata && (
          <section className="status-card status-card--stream-complete" aria-labelledby="stream-complete-heading">
            <p className="eyebrow">Stream complete</p>
            <h1 id="stream-complete-heading" data-screen-heading tabIndex={-1}>Every frame has been displayed</h1>
            {/* The single most important sentence on the sender. This machine
                cannot know whether the file arrived; only the receiving device,
                having hashed what it holds, can say that. A success screen that
                blurred the two is what this phase's gate forbids. */}
            <p className="completion-caveat">
              <strong>This is not a confirmation that the file arrived.</strong> Check the receiving device: it
              reports a verified file only after its SHA-256 matches. If it is still missing segments, enter
              its resume code here and send the same file again.
            </p>
            <dl className="metadata-grid">
              <div><dt>File</dt><dd title={metadata.filename}>{metadata.filename}</dd></div>
              <div><dt>Segments sent</dt><dd>{metadata.segmentCount.toLocaleString()}</dd></div>
              <div><dt>Integrity</dt><dd className="monospace">{metadata.sha256.slice(0, 16)}…</dd></div>
            </dl>
            <div className="action-row">
              <button className="primary" onClick={selectFile}>Send another file</button>
              <button className="secondary" onClick={() => dispatch({ type: SENDER_EVENT.RESUME_REQUESTED })}>Enter a resume code</button>
              <button className="tertiary" onClick={() => dispatch({ type: SENDER_EVENT.RESET })}>Return to dashboard</button>
            </div>
          </section>
        )}

        {surface === 'SEND' && state === SENDER_STATE.FAILED && (
          <section className="status-card status-card--failure" aria-labelledby="failed-heading">
            <p className="eyebrow">Action not completed</p>
            <h1 id="failed-heading" data-screen-heading tabIndex={-1}>{senderFailureHeading(fault?.kind)}</h1>
            <p className="error-banner" role="alert">
              {fault?.message || 'The requested action could not be completed.'}
            </p>
            <div className="action-row">
              <button className="primary" onClick={selectFile}>Choose a file</button>
              <button className="tertiary" onClick={() => dispatch({ type: SENDER_EVENT.RESET })}>Return to dashboard</button>
            </div>
          </section>
        )}

        {surface === 'LOOPBACK' && loopbackSession && (
          <LoopbackView sessionId={loopbackSession.sessionId} onCancel={leaveLoopback} />
        )}

        {surface === 'RECEIVE' && receiveScreen === 'CAMERA' && (
          <CameraReceiver onCancel={leaveReceiver} onVerified={handleVerifiedReceive} />
        )}

        {surface === 'RECEIVE' && receiveScreen === 'VERIFYING' && (
          <section className="status-card" aria-labelledby="verifying-heading">
            <p className="eyebrow">Verifying</p>
            <h1 id="verifying-heading" data-screen-heading tabIndex={-1}>Checking the received file</h1>
            <p>The main process is validating the reconstructed container before a save can be reported.</p>
          </section>
        )}

        {surface === 'RECEIVE' && receiveScreen === 'SAVED' && (
          <section className="status-card status-card--success" aria-labelledby="completed-heading">
            <p className="eyebrow">Completed</p>
            <h1 id="completed-heading" data-screen-heading tabIndex={-1}>File verified and saved</h1>
            <p>{receiveNotice || 'The verified received file was saved to the location selected in the save dialog.'}</p>
            <div className="action-row">
              <button className="primary" onClick={openReceiver}>Receive another file</button>
              <button className="tertiary" onClick={leaveReceiver}>Return to dashboard</button>
            </div>
          </section>
        )}

        {surface === 'RECEIVE' && receiveScreen === 'FAILED' && (
          <section className="status-card status-card--failure" aria-labelledby="receive-failed-heading">
            <p className="eyebrow">Action not completed</p>
            <h1 id="receive-failed-heading" data-screen-heading tabIndex={-1}>Something prevented completion</h1>
            <p className="error-banner" role="alert">{receiveError || 'The requested action could not be completed.'}</p>
            <div className="action-row">
              <button className="primary" onClick={leaveReceiver}>Return to dashboard</button>
            </div>
          </section>
        )}
      </main>

      {cancelDialogOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section ref={cancelDialogRef} className="cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-heading" aria-describedby="cancel-description">
            <h2 id="cancel-heading">Cancel the active transfer?</h2>
            <p id="cancel-description">
              The receiving device keeps whatever it has already verified, and can resume from it later. This
              display stops sending immediately.
            </p>
            <div className="action-row">
              <button ref={continueButtonRef} className="primary" onClick={closeCancelDialog}>Continue transfer</button>
              <button className="danger" onClick={performCancel}>Cancel transfer</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- copy */

/**
 * What the shell announces, as a pure function of what is on screen.
 *
 * Deliberately coarse. It fires on a state transition and nothing else, so a
 * multi-hour transfer produces a handful of announcements rather than one per
 * progress tick.
 */
export function shellAnnouncement(surface: Surface, state: SenderState, receive: ReceiveScreen): string {
  if (surface === 'LOOPBACK') return 'Local verification active.';
  if (surface === 'RECEIVE') {
    switch (receive) {
      case 'VERIFYING': return 'Verifying the received file.';
      case 'SAVED': return 'The received file was saved.';
      case 'FAILED': return 'The requested operation failed.';
      default: return 'Desktop camera receiver ready.';
    }
  }
  switch (state) {
    case SENDER_STATE.RESUME_ENTRY: return 'Enter a resume code.';
    case SENDER_STATE.PREFLIGHTING: return 'Reading the file and measuring it.';
    case SENDER_STATE.READY: return 'File prepared and ready to send.';
    case SENDER_STATE.PREPARING: return 'Starting the optical stream.';
    case SENDER_STATE.TRANSFERRING: return 'Optical stream active.';
    case SENDER_STATE.HELD: return 'Optical stream held.';
    // Says what happened and no more. The receiver's verification is a separate
    // event on a separate device and this announcement must not imply it.
    case SENDER_STATE.STREAM_COMPLETE: return 'Every frame has been displayed. The receiving device verifies the file.';
    case SENDER_STATE.CANCELLED: return 'Transfer cancelled.';
    case SENDER_STATE.FAILED: return 'The requested operation failed.';
    default: return 'Ready for a local, screen-to-camera transfer.';
  }
}

/** Four faults, four headings. Only one of them is about the file. */
export function senderFailureHeading(kind: string | undefined): string {
  switch (kind) {
    case 'resume': return 'That resume code was not accepted';
    case 'preflight': return 'The file could not be prepared';
    case 'display': return 'The QR display stopped';
    default: return 'The transfer could not continue';
  }
}
