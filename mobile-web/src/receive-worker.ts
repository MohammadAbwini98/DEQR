/**
 * The worker entry point. Glue only - the behaviour is in `receive-worker-core.ts`.
 *
 * Everything here is what cannot be tested outside a real worker: the global
 * scope, the message handler, and the handshake. Keeping it this thin is what
 * lets the interesting half be driven directly by tests.
 */

import { OFFSCREEN_CANVAS_AVAILABLE, ReceiveWorker } from './receive-worker-core';
import {
  RECEIVE_WORKER_PROTOCOL,
  boundReason,
  isReceiveWorkerRequest,
  type ReceiveWorkerEvent,
} from './worker-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

const worker = new ReceiveWorker((event, transfer) => scope.postMessage(event, transfer));

scope.onmessage = (event: MessageEvent<unknown>) => {
  if (!isReceiveWorkerRequest(event.data)) {
    // A message this build did not write, or one from a mismatched bundle.
    // Dropped rather than acted on, and never logged - it may hold pixels.
    return;
  }
  try {
    worker.handle(event.data);
  } catch (error) {
    // The core is written not to throw. If it does anyway the client has to
    // hear about it, because otherwise capture keeps posting frames into a
    // worker that will never answer and stalls on its in-flight cap.
    scope.postMessage({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'fatal',
      epoch: (event.data as { epoch?: number }).epoch ?? 0,
      code: error instanceof Error ? boundReason(error.name) : 'WORKER_ERROR',
    } satisfies ReceiveWorkerEvent);
  }
};

scope.postMessage({
  v: RECEIVE_WORKER_PROTOCOL,
  type: 'ready',
  acceptsBitmap: OFFSCREEN_CANVAS_AVAILABLE,
} satisfies ReceiveWorkerEvent);
