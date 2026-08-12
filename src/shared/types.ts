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

export type TransferState = 
  | 'idle'
  | 'selecting-file'
  | 'file-selected'
  | 'preparing'
  | 'ready'
  | 'streaming'
  | 'paused'
  | 'loopback-receiving'
  | 'receive-camera'
  | 'verifying'
  | 'verified'
  | 'saving'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

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

export interface PwaHostStatusView {
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

export interface DeqrAPI {
  windowControls: {
    minimize: () => void;
    maximizeOrRestore: () => void;
    close: () => void;
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
  loopback: {
    start: (sessionId: number, options: LoopbackOptions) => Promise<void>;
    cancel: (sessionId: number) => Promise<void>;
    saveVerifiedResult: (sessionId: number) => Promise<void>;
    subscribe: (sessionId: number, listener: (stats: LoopbackStats) => void) => () => void;
  };
  receive: {
    saveReceivedFile: (fileData: Uint8Array, defaultName: string) => Promise<boolean>;
  };
  pwaHost: {
    getStatus: () => Promise<PwaHostStatusView>;
  };
}

// Ensure the global Window interface includes our typed API
declare global {
  interface Window {
    deqr: DeqrAPI;
  }
}
