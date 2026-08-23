import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TRANSPORT_PROFILE, TRANSPORT_PROFILES } from '../../src/core/transport-profiles';

const root = path.resolve(__dirname, '../..');
const renderer = (...parts: string[]) => path.join(root, 'src/renderer', ...parts);

async function read(...parts: string[]): Promise<string> {
  return readFile(renderer(...parts), 'utf8');
}

/**
 * The source with its comments removed.
 *
 * Needed because several assertions here are about what a *user* can read, and
 * the modules deliberately explain in prose what they no longer say on screen -
 * the 32 MiB ceiling is named in three module docs precisely so nobody
 * reintroduces it. Matching raw source would make those explanations
 * indistinguishable from the copy they describe.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * Contracts the desktop transfer UX has to keep, asserted against the source
 * that ships.
 *
 * These are deliberately source-level rather than rendered. The repository runs
 * vitest in a Node environment with no DOM and no React testing library, and
 * the properties below - what a screen may claim, whether an element is allowed
 * a transition, whether a live region is throttled - are all statements about
 * the code rather than about a particular render. The behavioural half of this
 * phase is covered by `sender-state.test.ts` and `sender-model.test.ts` against
 * the modules the components read from.
 */
describe('desktop sender: capacity messaging', () => {
  it('states no fixed size ceiling anywhere in the renderer', async () => {
    // The v1 container had to be held whole in memory at both ends, so 32 MiB
    // was true. Since Phase 02 the sender streams segments off disk and since
    // Phase 06 the receiver writes them straight to device storage. A ceiling
    // that stopped being real is the single most misleading thing the old
    // screens said.
    for (const file of ['App.tsx', 'components/Dashboard.tsx', 'components/SenderPreflightCard.tsx']) {
      const source = withoutComments(await read(file));
      expect(source, file).not.toMatch(/32\s*Mi?B/i);
      expect(source, file).not.toMatch(/DEQR v1 capacity/);
    }
  });

  it('replaces it with the architecture that is actually true', async () => {
    const dashboard = await read('components/Dashboard.tsx');
    expect(dashboard).toContain('independently verified segments');
    // What actually bounds a transfer now, named as the two real limits.
    expect(dashboard).toMatch(/room on the receiving device/);
  });
});

describe('desktop sender: stream completion is not verification', () => {
  it('never lets the sender report a verified or saved file', async () => {
    const app = withoutComments(await read('App.tsx'));
    const complete = app.slice(
      app.indexOf('SENDER_STATE.STREAM_COMPLETE && metadata'),
      app.indexOf('SENDER_STATE.FAILED &&'),
    );
    expect(complete.length).toBeGreaterThan(200);

    // The claim surfaces: what the screen is *titled* and what it calls itself.
    // The word "verified" is allowed in the body and is in fact required there,
    // because the caveat's whole job is to point at the device that does the
    // verifying - but it must never appear as this screen's own claim.
    const eyebrow = complete.match(/className="eyebrow">([^<]*)</)?.[1] ?? '';
    const heading = complete.match(/data-screen-heading tabIndex=\{-1\}>([^<]*)</)?.[1] ?? '';
    expect(eyebrow).toBe('Stream complete');
    expect(heading).toBe('Every frame has been displayed');
    for (const claim of [eyebrow, heading]) {
      expect(claim).not.toMatch(/\bverified\b/i);
      expect(claim).not.toMatch(/\bsaved\b/i);
      expect(claim).not.toMatch(/\bsuccess\b/i);
      expect(claim).not.toMatch(/\breceived\b/i);
    }

    // And the body says the difference in as many words.
    expect(complete).toContain('This is not a confirmation that the file arrived');
    expect(complete).toContain('reports a verified file only after its SHA-256 matches');
  });

  it('does not reuse the success styling that the desktop receiver earns', async () => {
    const app = withoutComments(await read('App.tsx'));
    const complete = app.slice(
      app.indexOf('SENDER_STATE.STREAM_COMPLETE && metadata'),
      app.indexOf('SENDER_STATE.FAILED &&'),
    );
    // `status-card--success` is used by the screen that saved a hash-checked
    // file. The sender has not checked anything and must not borrow its panel.
    expect(complete).not.toContain('status-card--success');
    expect(complete).toContain('status-card--stream-complete');
  });

  it('styles the completion screen as a caveat rather than as a success', async () => {
    const styles = await read('styles/index.css');
    expect(styles).toContain('.status-card--stream-complete');
    // The success card is the receiver's green border; this one must not reuse
    // it, because a green panel is read before any sentence on it.
    const card = styles.slice(styles.indexOf('.status-card--stream-complete'));
    expect(card.slice(0, 200)).not.toContain('22, 128, 60');
    expect(styles).toContain('.completion-caveat');
  });

  it('announces completion without implying arrival', async () => {
    const app = await read('App.tsx');
    const announcement = app.slice(app.indexOf('export function shellAnnouncement'));
    expect(announcement).toContain('Every frame has been displayed. The receiving device verifies the file.');
    expect(announcement).not.toMatch(/transfer complete/i);
  });
});

describe('desktop sender: the QR surface', () => {
  it('is drawn by exactly one component', async () => {
    const app = await read('App.tsx');
    const view = await read('components/StreamTransferView.tsx');
    const canvas = await read('components/QRCanvas.tsx');
    // One owner, so the rules below have one place to be broken.
    expect(canvas).toContain('className="qr-canvas"');
    expect(view).toContain('<QRCanvas');
    expect(view).not.toContain('className="qr-canvas"');
    expect(app).not.toContain('className="qr-canvas"');
  });

  it('never animates, scales or filters the symbol', async () => {
    const styles = await read('styles/index.css');
    const start = styles.indexOf('.qr-canvas {');
    const block = styles.slice(start, styles.indexOf('}', start));
    expect(block).toContain('transition: none');
    expect(block).not.toMatch(/animation:/);
    expect(block).not.toMatch(/filter:/);
    expect(block).not.toMatch(/transform:/);
    // Whole-module pixels only; a browser resample is the artefact the integer
    // scale exists to remove.
    expect(block).toContain('image-rendering: pixelated');
  });

  it('keeps the stage itself static too', async () => {
    const styles = await read('styles/index.css');
    const start = styles.indexOf('.qr-stage {');
    const block = styles.slice(start, styles.indexOf('}', start));
    expect(block).toContain('transition: none');
    // The quiet zone is painted into the canvas by `qr-render`; the stage's
    // padding is additive and must never be the only thing providing it.
    expect(block).toMatch(/padding:/);
  });
});

describe('desktop sender: motion', () => {
  it('animates the progress bar and nothing else that carries data', async () => {
    const styles = await read('styles/index.css');
    const start = styles.indexOf('.progress > span {');
    const block = styles.slice(start, styles.indexOf('}', styles.indexOf('*/', start)));
    // A transform on a composited strip, not a width animation that lays out.
    expect(block).toContain('transition: transform');
    expect(block).not.toMatch(/transition:\s*width/);
  });

  it('stops interpolating entirely under reduced motion', async () => {
    const styles = await read('styles/index.css');
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.progress > span');
    expect(reduced).toContain('transition: none');
  });

  it('uses tabular figures wherever a number changes on a poll', async () => {
    const styles = await read('styles/index.css');
    // A proportional digit reflows its line every time it changes, which is the
    // "no layout shift every frame" rule failing in the least visible way.
    for (const selector of ['.progress-percent', '.progress-segment,', '.transfer-headline-metrics dd', '.diagnostics-grid dd']) {
      const start = styles.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      expect(styles.slice(start, styles.indexOf('}', start)), selector).toContain('tabular-nums');
    }
  });
});

describe('desktop sender: the schedule survives rendering', () => {
  /*
   * Two properties that no unit test can reach and that both silently destroy a
   * transfer rather than failing it.
   */
  it('does not rebuild the frame scheduler when a callback identity changes', async () => {
    const view = await read('components/StreamTransferView.tsx');
    // The parent passes inline arrows, so their identity changes every render,
    // and this view re-renders off a 500 ms poll. Keying the scheduler effect
    // on them would stop and rebuild the QR stream twice a second - dropping
    // its queue and resetting its cadence counters each time.
    expect(view).toContain('onFinishedRef');
    expect(view).toContain('onFailedRef');
    expect(view).toContain('}, [sessionId, profile]);');
    expect(view).not.toContain('}, [sessionId, profile, onFinished, onFailed]);');
  });

  it('does not set React state once per painted frame', async () => {
    const view = await read('components/StreamTransferView.tsx');
    const source = view.slice(view.indexOf('next: async () =>'), view.indexOf('return result.frame;'));
    expect(source.length).toBeGreaterThan(200);
    // At Balanced that would be twelve re-renders a second of this whole view,
    // diagnostics grid included, on the same thread that encodes and paints the
    // symbol. The poll is the only thing that updates the readout.
    expect(withoutComments(source)).not.toContain('setProgress');
    expect(view).toContain('PROGRESS_INTERVAL_MS = 500');
  });
});

describe('desktop sender: announcements', () => {
  it('throttles the transfer announcement to coarse milestones', async () => {
    const view = await read('components/StreamTransferView.tsx');
    expect(view).toContain('ANNOUNCE_STEP_PERCENT = 25');
    // Derived from a floored step, so a multi-hour transfer produces four
    // announcements rather than one per progress tick.
    expect(view).toMatch(/Math\.floor\(readout\.fraction \* 100 \/ ANNOUNCE_STEP_PERCENT\)/);
  });

  it('never announces a frame count or a raw percentage', async () => {
    const view = await read('components/StreamTransferView.tsx');
    const region = view.slice(view.indexOf('const announced'), view.indexOf('const toggleHold'));
    expect(region).not.toContain('framesPainted');
    expect(region).not.toContain('framesEmitted');
    expect(region).not.toContain('percent}');
  });

  it('keeps the live regions polite and atomic on both surfaces', async () => {
    const app = await read('App.tsx');
    const view = await read('components/StreamTransferView.tsx');
    for (const [name, source] of [['App', app], ['StreamTransferView', view]] as const) {
      expect(source, name).toContain('role="status" aria-live="polite" aria-atomic="true"');
      expect(source, name).not.toContain('aria-live="assertive"');
    }
  });
});

describe('desktop sender: information hierarchy', () => {
  it('puts engineering data behind a disclosure', async () => {
    const view = await read('components/StreamTransferView.tsx');
    const diagnostics = view.slice(view.indexOf('<details className="diagnostics">'));
    // Every raw counter has to be inside the disclosure, not beside the
    // headline numbers a normal transfer reads.
    for (const field of ['starvedWakeups', 'overruns', 'maxPaintMs', 'repairSymbolsEmitted', 'manifestFramesEmitted']) {
      expect(diagnostics, field).toContain(field);
      expect(view.slice(0, view.indexOf('<details className="diagnostics">')).includes(`{${field}`), field).toBe(false);
    }
  });

  it('leads with the file, not with frames', async () => {
    const view = await read('components/StreamTransferView.tsx');
    const primary = view.slice(
      view.indexOf('<section className="transfer-primary"'),
      view.indexOf('<details className="diagnostics">'),
    );
    expect(primary).toContain('progressSummary');
    expect(primary).toContain('Segment ');
    expect(primary).toContain('Elapsed');
    expect(primary).toContain('Rate');
    expect(primary).toContain('Remaining');
    expect(primary).not.toContain('FPS');
  });

  it('shows both sizes and the compression decision before the stream starts', async () => {
    const card = await read('components/SenderPreflightCard.tsx');
    expect(card).toContain('originalSizeBytes');
    expect(card).toContain('transportSizeBytes');
    expect(card).toContain('summarizeCompression');
    expect(card).toContain('segmentCount');
  });
});

describe('desktop sender: transport profile', () => {
  it('offers every production-selectable profile and no other', async () => {
    const card = await read('components/SenderPreflightCard.tsx');
    expect(card).toContain('profile.productionSelectable');
    const excluded = TRANSPORT_PROFILES.filter((profile) => !profile.productionSelectable);
    expect(excluded.length).toBeGreaterThan(0);
    for (const profile of excluded) {
      // `Experimental` needs a capture resolution nothing has been measured at.
      // A selector that offered it would put an uncertified profile on the wire.
      expect(card, profile.name).not.toContain(`'${profile.name}'`);
    }
  });

  it('defaults to Balanced', async () => {
    const app = await read('App.tsx');
    expect(app).toContain('useState<number>(DEFAULT_TRANSPORT_PROFILE.id)');
    expect(DEFAULT_TRANSPORT_PROFILE.name).toBe('Balanced');
  });

  it('says plainly that no profile has faced a camera', async () => {
    const card = await read('components/SenderPreflightCard.tsx');
    expect(card).toContain('certified against a physical camera');
    for (const profile of TRANSPORT_PROFILES) {
      expect(profile.physicallyCertified, profile.name).toBe(false);
    }
  });

  it('reports the profile the session actually opened with', async () => {
    const card = await read('components/SenderPreflightCard.tsx');
    // The main process falls back for an id it will not honour, so the card
    // reads the manifest's id rather than echoing the request.
    expect(card).toContain('transportProfileById(metadata.transportProfileId)');
    expect(card).toContain('This transfer is running on');
  });
});

describe('desktop sender: resume', () => {
  it('has an entry point on the dashboard', async () => {
    const dashboard = await read('components/Dashboard.tsx');
    expect(dashboard).toContain('onResumeTransfer');
    expect(dashboard).toContain('Enter resume code');
  });

  it('validates the code locally before opening a file dialog', async () => {
    const entry = await read('components/ResumeTokenEntry.tsx');
    expect(entry).toContain('decodeResumeToken');
    // Submission is gated on a successful decode, so a typo is named here
    // rather than after a dialog the user then has to dismiss.
    expect(entry).toContain('disabled={busy || !decoded?.ok}');
  });

  it('gives every decode failure a sentence rather than a code', async () => {
    const entry = await read('components/ResumeTokenEntry.tsx');
    for (const code of [
      'RESUME_TOKEN_LENGTH',
      'RESUME_TOKEN_CHARSET',
      'RESUME_TOKEN_CHECKSUM',
      'RESUME_TOKEN_VERSION',
      'RESUME_TOKEN_RANGE',
    ]) {
      expect(entry, code).toContain(`${code}:`);
    }
    // The codes must not reach the screen; only the sentences do.
    expect(entry).toContain('DECODE_MESSAGE[decoded.code]');
    expect(entry).not.toContain('{decoded.code}');
  });

  it('reserves room for the message so the layout does not jump', async () => {
    const styles = await read('styles/index.css');
    const start = styles.indexOf('.resume-message {');
    expect(styles.slice(start, styles.indexOf('}', start))).toContain('min-height');
  });
});

describe('desktop sender: layout', () => {
  it('collapses every multi-column readout at a narrow window', async () => {
    const styles = await read('styles/index.css');
    const narrow = styles.slice(
      styles.indexOf('@media (max-width: 720px)', styles.indexOf('.completion-caveat')),
    );
    for (const selector of ['.size-grid', '.transfer-headline-metrics', '.metadata-grid']) {
      expect(narrow, selector).toContain(selector);
    }
  });

  it('never gives a layout-sized element a width it cannot shrink below', async () => {
    const styles = await read('styles/index.css');
    // Every *panel* width in the app is a `min()` against 100%, so nothing can
    // push the layout wider than the window. Small fixed sizes are fine and are
    // deliberately allowed: a 46px window control and a 34px file icon are
    // chrome, not layout. The bar is 200px, below the 320px minimum viewport,
    // so anything that could constrain the shell has to be shrinkable.
    const LAYOUT_SIZED_PX = 200;
    const widths = [...styles.matchAll(/^\s*width:\s*([^;]+);/gm)].map((match) => match[1].trim());
    expect(widths.length).toBeGreaterThan(3);
    for (const width of widths) {
      const fixedPx = /^(\d+)px$/.exec(width);
      if (!fixedPx) {
        // `min()`, a percentage, and the intrinsic keywords all shrink with the
        // box that holds them, which is the property being asserted.
        const shrinkable = width.startsWith('min(')
          || width.endsWith('%')
          || width === 'fit-content'
          || width === 'auto'
          || width === 'max-content'
          || width === 'min-content';
        expect(shrinkable, width).toBe(true);
        continue;
      }
      expect(Number.parseInt(fixedPx[1], 10), width).toBeLessThan(LAYOUT_SIZED_PX);
    }
  });

  it('lets the diagnostics grid reflow rather than overflow', async () => {
    const styles = await read('styles/index.css');
    const start = styles.indexOf('.diagnostics-grid {');
    const block = styles.slice(start, styles.indexOf('}', start));
    expect(block).toContain('auto-fit');
    expect(block).toContain('minmax(180px, 1fr)');
  });
});

describe('desktop sender: focus and keyboard', () => {
  it('moves focus to the heading of every screen it switches to', async () => {
    const app = await read('App.tsx');
    expect(app).toContain('[data-screen-heading]');
    // Keyed on the surface and the receive screen too, not just the sender
    // state, or a switch between surfaces would leave focus on a dead button.
    expect(app).toContain('}, [state, surface, receiveScreen]);');
  });

  it('gives every screen a focusable heading', async () => {
    for (const file of [
      'App.tsx',
      'components/Dashboard.tsx',
      'components/SenderPreflightCard.tsx',
      'components/StreamTransferView.tsx',
      'components/ResumeTokenEntry.tsx',
    ]) {
      const source = await read(file);
      expect(source, file).toContain('data-screen-heading tabIndex={-1}');
    }
  });

  it('traps focus in the cancel dialog and closes it on Escape', async () => {
    const app = await read('App.tsx');
    expect(app).toContain('aria-modal="true"');
    expect(app).toContain('const trapFocus');
    expect(app).toContain("if (event.key !== 'Escape') return;");
  });

  it('confirms a cancel only where the state machine says one is warranted', async () => {
    const app = await read('App.tsx');
    // The dialog is driven by the machine rather than by a screen-local guess,
    // so "does this cancel need confirming" has exactly one answer.
    expect(app).toContain('if (!cancelNeedsConfirmation(state))');
    expect(app).toContain('canCancel(state)');
  });
});
