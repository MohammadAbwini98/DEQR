/**
 * The one authoritative transfer UI state vocabulary, shared by both surfaces.
 *
 * DEQR has two user interfaces that describe the *same* transfer from opposite
 * ends, and until this module they described it in unrelated words. The desktop
 * sender had a fifteen-member `TransferState` union that mixed screens
 * (`selecting-file`) with transfer phases (`streaming`) with outcomes
 * (`completed`), plus a second, dead state machine in `state-machine.ts` that
 * nothing rendered from. The PWA receiver had its own eleven-state machine,
 * well built but named only for itself. Two vocabularies for one process is how
 * "sender finished" and "receiver verified" came to look like the same event.
 *
 * So there is one phase vocabulary here, and each surface declares a transition
 * table over its own states plus a total mapping onto these phases. The
 * vocabulary is the contract; the tables are the behaviour. What the vocabulary
 * buys is the property this phase's gate is written against:
 *
 * **No surface may claim integrity verification it did not perform.** The
 * sender's phase set does not contain `VERIFIED`, and it cannot, because the
 * sender never sees the reconstructed file. A sender that has emitted every
 * frame is `COMPLETED`, which is a statement about the stream and about nothing
 * else. Only the receiver, having hashed the bytes it holds, reaches `VERIFIED`.
 *
 * Imported by `src/renderer/sender-state.ts` and by
 * `mobile-web/src/receiver-state.ts`, so it must stay free of Electron, React,
 * DOM and Node imports.
 */

export const TRANSFER_PHASE = {
  /** Nothing in flight. Home, pre-transfer input, or after a reset. */
  IDLE: 'IDLE',
  /** Deciding whether this transfer can start at all, before committing to it. */
  PREFLIGHTING: 'PREFLIGHTING',
  /** Committed. Resources are opening: a file descriptor, a camera, a store. */
  PREPARING: 'PREPARING',
  /** Armed and waiting for the transfer to move. Nothing has moved yet. */
  READY: 'READY',
  /** Bytes are moving. */
  TRANSFERRING: 'TRANSFERRING',
  /**
   * Stopped without being finished or abandoned, and resumable.
   *
   * Both a receiver whose app was backgrounded and a sender whose stream is
   * held. Neither has failed, neither is done, and both have somewhere to go
   * back to - which is the only property a screen needs to distinguish.
   */
  INTERRUPTED: 'INTERRUPTED',
  /** Integrity work is running over bytes that have all arrived. */
  VERIFYING: 'VERIFYING',
  /** Integrity was proven **on this device**. Never reachable from the sender. */
  VERIFIED: 'VERIFIED',
  /** The verified result is in the hands of the OS share sheet or save dialog. */
  EXPORTING: 'EXPORTING',
  /**
   * This surface finished its own work.
   *
   * Deliberately weaker than `VERIFIED`. A sender that has put every frame on
   * screen is `COMPLETED` and knows nothing about whether the far end
   * reconstructed anything.
   */
  COMPLETED: 'COMPLETED',
  /** The user stopped it. */
  CANCELLED: 'CANCELLED',
  /** It could not finish. */
  FAILED: 'FAILED',
} as const;

export type TransferPhase = (typeof TRANSFER_PHASE)[keyof typeof TRANSFER_PHASE];

export const TRANSFER_PHASES: readonly TransferPhase[] = Object.freeze(
  Object.values(TRANSFER_PHASE) as TransferPhase[],
);

/**
 * The order a transfer moves through, for progress-shaped presentation only.
 *
 * Branch endings share the rank of the phase they replace rather than being
 * ranked past it: a cancelled transfer did not get *further* than a verifying
 * one. Nothing decides behaviour from this - it exists so a stepper can be
 * drawn without a component inventing its own ordering.
 */
const PHASE_RANK: Readonly<Record<TransferPhase, number>> = Object.freeze({
  [TRANSFER_PHASE.IDLE]: 0,
  [TRANSFER_PHASE.PREFLIGHTING]: 1,
  [TRANSFER_PHASE.PREPARING]: 2,
  [TRANSFER_PHASE.READY]: 3,
  [TRANSFER_PHASE.TRANSFERRING]: 4,
  [TRANSFER_PHASE.INTERRUPTED]: 4,
  [TRANSFER_PHASE.VERIFYING]: 5,
  [TRANSFER_PHASE.VERIFIED]: 6,
  [TRANSFER_PHASE.EXPORTING]: 7,
  [TRANSFER_PHASE.COMPLETED]: 8,
  [TRANSFER_PHASE.CANCELLED]: 0,
  [TRANSFER_PHASE.FAILED]: 0,
});

export function phaseRank(phase: TransferPhase): number {
  return PHASE_RANK[phase];
}

/**
 * Phases in which no further user-visible progress will occur unaided.
 *
 * `COMPLETED` is terminal for the surface that reports it even though the
 * transfer as a whole may not be over - the sender is finished with its half
 * and the receiver is still hashing.
 */
const TERMINAL_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>([
  TRANSFER_PHASE.VERIFIED,
  TRANSFER_PHASE.COMPLETED,
  TRANSFER_PHASE.CANCELLED,
  TRANSFER_PHASE.FAILED,
]);

export function isTerminalPhase(phase: TransferPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Phases in which something is actively working and a cancel is meaningful.
 *
 * `INTERRUPTED` is excluded: there is nothing running to stop.
 */
const ACTIVE_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>([
  TRANSFER_PHASE.PREFLIGHTING,
  TRANSFER_PHASE.PREPARING,
  TRANSFER_PHASE.READY,
  TRANSFER_PHASE.TRANSFERRING,
  TRANSFER_PHASE.VERIFYING,
]);

export function isActivePhase(phase: TransferPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

/**
 * Whether a phase entitles its screen to say the file's integrity was proven.
 *
 * The single most load-bearing predicate in this module, and the reason it is
 * shared rather than restated per surface. `COMPLETED` is absent on purpose: a
 * finished stream is not a verified file, and the two look identical to
 * everyone except the code that knows which end it is running on.
 */
const VERIFIED_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>([
  TRANSFER_PHASE.VERIFIED,
  TRANSFER_PHASE.EXPORTING,
]);

export function claimsIntegrityVerified(phase: TransferPhase): boolean {
  return VERIFIED_PHASES.has(phase);
}

/**
 * Which phases each surface may ever occupy.
 *
 * A closed set per surface, asserted against each machine's phase mapping, so
 * that a future state added to either side has to declare which phase it is -
 * and so that adding a sender state that maps to `VERIFIED` fails a test rather
 * than shipping a lie.
 */
export const SENDER_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>([
  TRANSFER_PHASE.IDLE,
  TRANSFER_PHASE.PREFLIGHTING,
  TRANSFER_PHASE.PREPARING,
  TRANSFER_PHASE.READY,
  TRANSFER_PHASE.TRANSFERRING,
  TRANSFER_PHASE.INTERRUPTED,
  TRANSFER_PHASE.COMPLETED,
  TRANSFER_PHASE.CANCELLED,
  TRANSFER_PHASE.FAILED,
]);

export const RECEIVER_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>([
  TRANSFER_PHASE.IDLE,
  TRANSFER_PHASE.PREFLIGHTING,
  TRANSFER_PHASE.PREPARING,
  TRANSFER_PHASE.READY,
  TRANSFER_PHASE.TRANSFERRING,
  TRANSFER_PHASE.INTERRUPTED,
  TRANSFER_PHASE.VERIFYING,
  TRANSFER_PHASE.VERIFIED,
  TRANSFER_PHASE.EXPORTING,
  TRANSFER_PHASE.CANCELLED,
  TRANSFER_PHASE.FAILED,
]);
