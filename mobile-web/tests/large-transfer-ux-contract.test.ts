import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RECEIVER_PHASES,
  TRANSFER_PHASE,
  claimsIntegrityVerified,
} from '../../src/shared/transfer-ui-state';
import {
  RECEIVER_STATE,
  receiverPhase,
  receiverPhasesAreDeclared,
  receiverPhasesInUse,
  type ReceiverState,
} from '../src/receiver-state';

const root = path.resolve(__dirname, '..');
const ALL_STATES = Object.values(RECEIVER_STATE) as ReceiverState[];

async function read(...parts: string[]): Promise<string> {
  return readFile(path.join(root, ...parts), 'utf8');
}

/** Source with comments stripped, so prose about a rule is not read as the rule. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('receiver: the shared transfer vocabulary', () => {
  it('places every receiver state in the vocabulary the sender also uses', () => {
    expect(receiverPhasesAreDeclared()).toBe(true);
    for (const state of ALL_STATES) {
      expect(receiverPhase(state), state).toBeDefined();
      expect(RECEIVER_PHASES.has(receiverPhase(state)), state).toBe(true);
    }
  });

  it('is the only surface that reaches a phase claiming integrity', () => {
    const claiming = ALL_STATES.filter((state) => claimsIntegrityVerified(receiverPhase(state)));
    // COMPLETE holds a hashed file; EXPORTING is reached only from it.
    expect([...claiming].sort()).toEqual(['COMPLETE', 'EXPORTING']);
    expect(receiverPhase(RECEIVER_STATE.COMPLETE)).toBe(TRANSFER_PHASE.VERIFIED);
    // VERIFYING is work in progress and must never carry the claim.
    expect(claimsIntegrityVerified(receiverPhase(RECEIVER_STATE.VERIFYING))).toBe(false);
  });

  it('never reports the sender-only COMPLETED phase', () => {
    // The receiver's ending is a verified file. A weaker "completed" would
    // reintroduce exactly the ambiguity the shared vocabulary removes.
    expect(receiverPhasesInUse()).not.toContain(TRANSFER_PHASE.COMPLETED);
  });
});

describe('receiver: no success before verification', () => {
  it('gates the save control on the one predicate that means the hash matched', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('mayOfferExport(state) ?');
    expect(app).toContain('Save verified file');
    // Exactly one place in the component may offer a save.
    expect(app.match(/Save verified file/g)).toHaveLength(1);
  });

  it('gives verification its own panel instead of a frozen transfer bar', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    // The camera panel is replaced, not left showing a dead frame beside a bar
    // that is measuring something else.
    expect(app).toContain('state === RECEIVER_STATE.VERIFYING');
    expect(app).toContain('className="verify-panel card"');
    expect(app).toContain('onVerifyProgress');
  });

  it('shows the segment bar only while it means something', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    // RECEIVING and COMPLETE. Not VERIFYING - that has its own progress, over a
    // different total - and not FAILED, where a bar implies partial success.
    expect(app).toContain('(state === RECEIVER_STATE.RECEIVING || state === RECEIVER_STATE.COMPLETE)');
  });
});

describe('receiver: the transfer is described, not just counted', () => {
  it('shows the file and both of its sizes once the manifest arrives', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('summarizeTransfer');
    expect(app).toContain('transferSizeLine');
    expect(app).toContain('transfer.compressionText');
  });

  it('shows the storage decision the receiver already made', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('summarizeStorage');
    // And a device-level estimate before any transfer exists to size against.
    expect(app).toContain('estimateDeviceStorage');
    expect(app).toContain('className="storage-preflight"');
  });

  it('explains a resumed transfer rather than letting the bar jump', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('resumeLine(transfer)');
    expect(app).toContain('checkpointRejectionCopy');
  });

  it('offers the resume code and a way to erase what it refers to', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('summarizeInterruption');
    expect(app).toContain('groupResumeToken');
    expect(app).toContain('Erase kept data');
    expect(app).toContain('discardRetainedSessions');
  });

  it('stops telling an interrupted user their data was cleared', async () => {
    const app = await read('src/App.tsx');
    const live = app.slice(app.indexOf('function liveStatusCopy'));
    const interrupted = live.slice(live.indexOf('case RECEIVER_STATE.INTERRUPTED:'));
    const announcement = interrupted.slice(0, interrupted.indexOf('case RECEIVER_STATE.PREFLIGHT'));
    // The bytes are kept for a resume. The old copy described the cancelled
    // path, which is the one that deletes.
    expect(announcement).toContain('kept on this device');
    expect(announcement).not.toContain('was cleared');

    // And the backgrounding message the user actually sees says the same.
    const backgrounded = app.slice(app.indexOf('backgrounded'), app.indexOf('backgrounded') + 200);
    expect(backgrounded).toContain('kept on this device');
  });
});

describe('receiver: announcements stay quiet', () => {
  it('has exactly one polite region and never an assertive one', async () => {
    const app = await read('src/App.tsx');
    expect(app).toContain('className="visually-hidden" role="status" aria-live="polite" aria-atomic="true"');
    expect(app).not.toContain('aria-live="assertive"');
  });

  it('announces states, never percentages or frame counts', async () => {
    const app = await read('src/App.tsx');
    const live = app.slice(app.indexOf('function liveStatusCopy'));
    expect(live.length).toBeGreaterThan(200);
    // The live region is a switch over the state and nothing else, so a
    // multi-hour transfer produces one announcement per transition.
    expect(live).not.toContain('percent');
    expect(live).not.toContain('progress.');
    expect(live).not.toContain('telemetry');
  });

  it('gives the progress bars a text value rather than leaving a screen reader the raw number', async () => {
    const app = await read('src/App.tsx');
    // Three progressbars on this screen; each needs a label and a value.
    const bars = app.match(/role="progressbar"/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(app.match(/aria-valuetext=/g)?.length).toBeGreaterThanOrEqual(bars.length);
  });
});

describe('receiver: motion and layout', () => {
  it('never animates a progress fill on a page that is decoding frames', async () => {
    const styles = await read('src/styles.css');
    const start = styles.indexOf('.progress span {');
    const block = styles.slice(start, styles.indexOf('}', start));
    // A compositor animation on a page running jsQR is the decorative motion
    // the design rules forbid; the bar advances per segment and reads as
    // continuous without one.
    expect(block).not.toContain('transition');
    expect(block).not.toContain('animation');
  });

  it('honours reduced motion at the top level', async () => {
    const styles = await read('src/styles.css');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('transition-duration: 0.01ms !important');
    expect(reduced).toContain('transform: none');
  });

  it('keeps every new panel inside the safe-area padding the shell already sets', async () => {
    const styles = await read('src/styles.css');
    // The new surfaces are all children of `.app-shell` and `.status-card`, so
    // they inherit the insets rather than each re-deriving them - and none of
    // them may set its own left or right inset and drift out of alignment.
    for (const selector of ['.transfer-file {', '.storage-summary {', '.resume-card {', '.verify-panel {']) {
      const start = styles.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      const block = styles.slice(start, styles.indexOf('}', start));
      expect(block, selector).not.toContain('safe-area-inset');
      expect(block, selector).not.toMatch(/position:\s*fixed/);
    }
  });

  it('lets long content wrap rather than scroll the page sideways', async () => {
    const styles = await read('src/styles.css');
    // A resume code is 47 characters with separators and does not fit a 390px
    // viewport on one line. A filename can be arbitrarily long.
    const token = styles.slice(styles.indexOf('.resume-token {'));
    expect(token.slice(0, token.indexOf('}'))).toContain('overflow-wrap: anywhere');
    const file = styles.slice(styles.indexOf('.transfer-file strong {'));
    expect(file.slice(0, file.indexOf('}'))).toContain('text-overflow: ellipsis');
  });

  it('gives the numbers that change tabular figures', async () => {
    const styles = await read('src/styles.css');
    for (const selector of ['.segment-line,', '.verify-bytes {']) {
      const start = styles.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      expect(styles.slice(start, styles.indexOf('}', start)), selector).toContain('tabular-nums');
    }
  });

  it('raises the border weight of every new panel under increased contrast', async () => {
    const styles = await read('src/styles.css');
    const contrast = styles.slice(styles.indexOf('@media (prefers-contrast: more)'));
    const block = contrast.slice(0, contrast.indexOf('}'));
    for (const selector of ['.transfer-file', '.storage-summary', '.fault-action', '.resume-card', '.resume-token']) {
      expect(block, selector).toContain(selector);
    }
  });
});

describe('receiver: the compression refusal has a screen', () => {
  it('carries an instruction for the other device', async () => {
    const app = withoutComments(await read('src/App.tsx'));
    expect(app).toContain('failure.senderSide');
    expect(app).toContain('On the sending device');
    expect(app).toContain('fault-action--sender');
  });

  it('announces it as its own outcome rather than as a failed verification', async () => {
    const app = await read('src/App.tsx');
    const live = app.slice(app.indexOf('function liveStatusCopy'));
    expect(live).toContain("faultCode === 'UNSUPPORTED_COMPRESSION'");
    expect(live).toContain('This browser cannot expand the transfer');
  });
});
