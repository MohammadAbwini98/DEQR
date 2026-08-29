import { ErrorCode } from './errors';

export interface SafeDisplayMetadata {
  filename: string;
  extension: string;
  size: number;
  mimeType: string;
  sha256?: string;
  compressed: boolean;
  blockCount?: number;
  estimatedFrames?: number;
}

export interface FileSelectionResult {
  sessionId: number;
  metadata: SafeDisplayMetadata;
}

/*
 * `TransferState` lived here until Phase 09. It was a fifteen-member union that
 * mixed screens (`selecting-file`), transfer phases (`streaming`) and outcomes
 * (`completed`) in one list, which is what let the renderer hold two states
 * that disagreed. The vocabulary both surfaces now share is
 * `TRANSFER_PHASE` in `src/shared/transfer-ui-state.ts`; the sender's own
 * states are `SENDER_STATE` in `src/renderer/sender-state.ts` and the
 * receiver's are `RECEIVER_STATE` in `mobile-web/src/receiver-state.ts`.
 */

export interface TransferStats {
  framesGenerated: number;
  sourceBlocks: number;
  elapsedMs: number;
  targetFps: number;
  effectiveFps: number;
}

export interface LoopbackOptions {
  lossPercentage: number;
  shuffle: boolean;
  duplicateInjection: boolean;
}

export interface LoopbackStats {
  receivedFrames: number;
  recoveredBlocks: number;
  isComplete: boolean;
  verificationPassed: boolean;
  hashMatched: boolean;
}

export interface PwaHostAddressView {
  address: string;
  interfaceName: string;
  /** `overlay` is a mesh-VPN address such as Tailscale. */
  kind: 'overlay' | 'private' | 'other';
  url: string;
}

/** Mirrors `PwaHostState` in the main process. `stopped` is not a failure. */
export type PwaHostStateView = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface PwaHostStatusView {
  state: PwaHostStateView;
  /** Always equal to `state === 'running'`. */
  running: boolean;
  /** Preferred HTTPS URL for the iPhone, or null when hosting is unavailable. */
  url: string | null;
  /** Every address the receiver is reachable on, best candidate first. */
  addresses: PwaHostAddressView[];
  subjectAltNames: string[];
  certificateSource: 'environment' | 'stored' | 'generated' | null;
  /** Human-readable, redacted failure reason. */
  error: string | null;
}

/* ------------------------------------------------ DEQR v2 streaming transfer */

/**
 * Everything the renderer is allowed to know about a selected file.
 *
 * No path, no bytes. 64-bit sizes cross as decimal strings: structured clone
 * can carry a `BigInt`, but the renderer only formats these for display, and a
 * string cannot be accidentally coerced into a lossy `number` on the way.
 */
export interface StreamingTransferMetadata {
  filename: string;
  originalSizeBytes: string;
  sha256: string;
  segmentCount: number;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  sourceSymbolsTotal: number;
  /** What three bounded sample windows measured, before anything was decided. */
  sampledCompressionRatio: number;
  /**
   * Bytes the segments will actually carry.
   *
   * Equal to `originalSizeBytes` when nothing is compressed, and reported
   * separately because for a compressed transfer they are two different facts:
   * what the file weighs, and what has to cross the optical link.
   */
  transportSizeBytes: string;
  /** `V2_COMPRESSION` mode. Zero means the segments are the file. */
  compressionMode: number;
  /** `transportSize / originalSize`. 1 when uncompressed. */
  compressionRatio: number;
  /** Which policy rule produced the decision. See `compression-policy.ts`. */
  compressionReason: string;
  /** Original bytes per second through the sizing walk. Zero when not compressed. */
  compressionBytesPerSecond: number;
  preflightHashMs: number;
  /** True when a resume token was accepted and this pass starts partway in. */
  resumed: boolean;
  /** First segment this pass will emit. Zero for a fresh transfer. */
  resumeFromSegment: number;
  /**
   * Transport profile this session was opened with. See `transport-profiles.ts`.
   *
   * Reported rather than assumed by the renderer, because the main process is
   * free to refuse an unknown or uncertified id and fall back to the default.
   * The display reads its cadence and symbol geometry from this, so a renderer
   * that guessed would schedule a transfer the encoder is not producing.
   */
  transportProfileId: number;
}

export interface StreamingSelectOptions {
  /**
   * The forty characters shown by a receiver that already holds part of the file.
   *
   * The main process refuses it unless the selected file's digest and
   * segmentation both match, so a mistyped or foreign token fails at selection
   * rather than after a transfer that cannot verify.
   */
  resumeToken?: string;
  /**
   * Which transport profile to open the session with.
   *
   * Advisory. An id that is unknown, or that names a profile not marked
   * production-selectable, falls back to the default rather than failing - a
   * renderer must not be able to put an uncertified profile on the wire by
   * sending a number.
   */
  transportProfileId?: number;
}

export interface StreamingSelectionResult {
  sessionId: number;
  metadata: StreamingTransferMetadata;
}

/**
 * Progress with its three meanings kept apart.
 *
 * Original bytes covered, bytes put on the wire, and frames emitted answer
 * different questions. Collapsing them is how v1 came to report a transfer as
 * further along than it was the moment repair symbols entered the stream.
 */
export interface StreamingProgressView {
  originalBytesTotal: string;
  /** Total bytes the segments carry. Differs from the above only under compression. */
  transportBytesTotal: string;
  transportBytesCovered: string;
  bytesOnTheWire: string;
  segmentCount: number;
  segmentsCompleted: number;
  currentSegmentIndex: number;
  framesEmitted: number;
  manifestFramesEmitted: number;
  sourceSymbolsEmitted: number;
  repairSymbolsEmitted: number;
  /**
   * Repair symbols emitted by the recovery tail, counted apart from the pass.
   *
   * The pass's own repair budget is spent whether or not anything was missed;
   * these are the fresh symbols produced after the pass ran out. A climbing
   * count beside a full progress bar is the honest picture of an open-ended
   * recovery tail, and it is what keeps the screen from reading as stuck.
   */
  recoverySymbolsEmitted: number;
  /** True while the recovery tail is producing. Never true during the first pass. */
  recovering: boolean;
  complete: boolean;
  /** First segment this pass emits. Non-zero only for a resumed transfer. */
  resumeFromSegment: number;
}

export interface StreamingFrameResult {
  /** The next QR-ready frame, or null once the pass is finished. */
  frame: Uint8Array | null;
  progress: StreamingProgressView;
}

export interface DeqrAPI {
  windowControls: {
    minimize: () => void;
    maximizeOrRestore: () => void;
    close: () => void;
    /** Read-only state of the caller's own window, so the icon can match it. */
    isMaximized: () => Promise<boolean>;
    /** Maximize/restore changes pushed from main; returns an unsubscribe. */
    onMaximizeChanged: (listener: (maximized: boolean) => void) => () => void;
  };
  files: {
    selectForTransfer: () => Promise<FileSelectionResult | null>;
    discardSelection: (sessionId: number) => Promise<void>;
  };
  transfer: {
    start: (sessionId: number) => Promise<void>;
    pause: (sessionId: number) => Promise<void>;
    resume: (sessionId: number) => Promise<void>;
    cancel: (sessionId: number) => Promise<void>;
    subscribe: (sessionId: number, listener: (framePayload: Uint8Array, stats: TransferStats) => void) => () => void;
  };
  /**
   * Loopback is a self-test: it re-decodes a file the user already selected
   * from local disk, to prove the optical container round-trips. It therefore
   * has no save operation — the source file is already on this filesystem, and
   * `loopbackFrame` releases the session the moment decoding completes. Bytes
   * that genuinely arrived from outside are persisted by `receive` instead.
   */
  loopback: {
    start: (sessionId: number, options: LoopbackOptions) => Promise<void>;
    cancel: (sessionId: number) => Promise<void>;
    subscribe: (sessionId: number, listener: (stats: LoopbackStats) => void) => () => void;
  };
  /**
   * DEQR v2 streaming sender.
   *
   * Frames are **pulled**: the renderer asks for the next one when it is ready
   * to paint, so a slow display stops the encoder and the file reader by
   * construction rather than by agreement. Pausing is simply not asking.
   */
  streamTransfer: {
    /**
     * Opens a file for transfer, optionally resuming one already in progress
     * and optionally naming a transport profile.
     *
     * Both options are validated on the privileged side. See
     * `StreamingSelectOptions` for what each one may and may not cause.
     */
    select: (options?: StreamingSelectOptions) => Promise<StreamingSelectionResult | null>;
    nextFrame: (sessionId: number) => Promise<StreamingFrameResult>;
    progress: (sessionId: number) => Promise<StreamingProgressView | null>;
    /**
     * Starts a recovery pass on a session whose first pass has finished.
     *
     * Resolves with the number of segments the tail will generate for, or an
     * error shape. `targets` are segment indices; omitting them recovers every
     * segment, which is the only honest default when nothing has said which
     * are missing - the optical link is one-way.
     */
    beginRecovery: (sessionId: number, targets?: number[]) => Promise<number | { error: unknown }>;
    cancel: (sessionId: number) => Promise<void>;
  };
  receive: {
    saveReceivedFile: (fileData: Uint8Array, defaultName: string) => Promise<boolean>;
  };
  pwaHost: {
    getStatus: () => Promise<PwaHostStatusView>;
    /** Resolves with the acknowledgement, usually `starting`, not the outcome. */
    start: () => Promise<PwaHostStatusView>;
    stop: () => Promise<PwaHostStatusView>;
    subscribe: (listener: (status: PwaHostStatusView) => void) => () => void;
  };
}

// Ensure the global Window interface includes our typed API
declare global {
  interface Window {
    deqr: DeqrAPI;
  }
}
