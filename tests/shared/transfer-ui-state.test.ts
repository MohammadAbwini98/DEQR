import { describe, expect, it } from 'vitest';
import {
  RECEIVER_PHASES,
  SENDER_PHASES,
  TRANSFER_PHASE,
  TRANSFER_PHASES,
  claimsIntegrityVerified,
  isActivePhase,
  isTerminalPhase,
  phaseRank,
} from '../../src/shared/transfer-ui-state';

describe('shared transfer phase vocabulary', () => {
  it('covers the whole lifecycle the program plan names', () => {
    // The plan's list, verbatim: idle -> preflighting -> preparing -> ready ->
    // transferring -> interrupted -> verifying -> verified -> exporting ->
    // completed, with cancelled and failed branches. A phase missing from the
    // vocabulary is a screen with nowhere to live.
    expect([...TRANSFER_PHASES].sort()).toEqual([
      'CANCELLED',
      'COMPLETED',
      'EXPORTING',
      'FAILED',
      'IDLE',
      'INTERRUPTED',
      'PREFLIGHTING',
      'PREPARING',
      'READY',
      'TRANSFERRING',
      'VERIFIED',
      'VERIFYING',
    ]);
  });

  it('ranks every phase, and does not rank a branch ending past what it replaced', () => {
    for (const phase of TRANSFER_PHASES) {
      expect(Number.isInteger(phaseRank(phase)), phase).toBe(true);
    }
    expect(phaseRank(TRANSFER_PHASE.PREFLIGHTING)).toBeLessThan(phaseRank(TRANSFER_PHASE.READY));
    expect(phaseRank(TRANSFER_PHASE.READY)).toBeLessThan(phaseRank(TRANSFER_PHASE.TRANSFERRING));
    expect(phaseRank(TRANSFER_PHASE.VERIFYING)).toBeLessThan(phaseRank(TRANSFER_PHASE.VERIFIED));
    // A cancelled transfer did not get further than a verifying one.
    expect(phaseRank(TRANSFER_PHASE.CANCELLED)).toBeLessThan(phaseRank(TRANSFER_PHASE.VERIFYING));
    expect(phaseRank(TRANSFER_PHASE.FAILED)).toBeLessThan(phaseRank(TRANSFER_PHASE.VERIFYING));
    // An interrupted transfer is stopped where a transferring one is running,
    // so they sit at the same distance through the process.
    expect(phaseRank(TRANSFER_PHASE.INTERRUPTED)).toBe(phaseRank(TRANSFER_PHASE.TRANSFERRING));
  });

  /*
   * The gate this phase is written against, stated as one assertion.
   *
   * Exactly two phases entitle a screen to say the bytes were checked, and
   * `COMPLETED` is deliberately not one of them: a sender that has displayed
   * every frame has finished its own work and knows nothing about the file at
   * the far end.
   */
  it('lets only a verified or exporting phase claim integrity', () => {
    const claiming = TRANSFER_PHASES.filter(claimsIntegrityVerified);
    expect([...claiming].sort()).toEqual(['EXPORTING', 'VERIFIED']);
    expect(claimsIntegrityVerified(TRANSFER_PHASE.COMPLETED)).toBe(false);
    expect(claimsIntegrityVerified(TRANSFER_PHASE.TRANSFERRING)).toBe(false);
  });

  it('never lets a sender occupy a phase that claims integrity', () => {
    // The structural half of the same rule: it is not merely that the sender
    // does not currently reach VERIFIED, it is that the phase is not in its
    // declared set at all, so a state added later cannot quietly acquire it.
    for (const phase of TRANSFER_PHASES) {
      if (claimsIntegrityVerified(phase)) expect(SENDER_PHASES.has(phase), phase).toBe(false);
    }
    expect(SENDER_PHASES.has(TRANSFER_PHASE.VERIFYING)).toBe(false);
    expect(SENDER_PHASES.has(TRANSFER_PHASE.COMPLETED)).toBe(true);
  });

  it('lets the receiver occupy the verification phases and not the sender-only one', () => {
    expect(RECEIVER_PHASES.has(TRANSFER_PHASE.VERIFYING)).toBe(true);
    expect(RECEIVER_PHASES.has(TRANSFER_PHASE.VERIFIED)).toBe(true);
    expect(RECEIVER_PHASES.has(TRANSFER_PHASE.EXPORTING)).toBe(true);
    // The receiver never reports COMPLETED: its ending is a verified file, and
    // a "completed" that did not mean "verified" would be the same ambiguity
    // this vocabulary exists to remove.
    expect(RECEIVER_PHASES.has(TRANSFER_PHASE.COMPLETED)).toBe(false);
  });

  it('every phase belongs to at least one surface', () => {
    for (const phase of TRANSFER_PHASES) {
      expect(SENDER_PHASES.has(phase) || RECEIVER_PHASES.has(phase), phase).toBe(true);
    }
  });

  it('treats a stopped-but-resumable transfer as neither active nor terminal', () => {
    expect(isActivePhase(TRANSFER_PHASE.INTERRUPTED)).toBe(false);
    expect(isTerminalPhase(TRANSFER_PHASE.INTERRUPTED)).toBe(false);
  });

  it('marks the four endings terminal and nothing else', () => {
    const terminal = TRANSFER_PHASES.filter(isTerminalPhase);
    expect([...terminal].sort()).toEqual(['CANCELLED', 'COMPLETED', 'FAILED', 'VERIFIED']);
  });

  it('offers a meaningful cancel in exactly the working phases', () => {
    const active = TRANSFER_PHASES.filter(isActivePhase);
    expect([...active].sort()).toEqual([
      'PREFLIGHTING',
      'PREPARING',
      'READY',
      'TRANSFERRING',
      'VERIFYING',
    ]);
    // Nothing terminal is also active; the two sets are disjoint by design.
    for (const phase of active) expect(isTerminalPhase(phase), phase).toBe(false);
  });
});
