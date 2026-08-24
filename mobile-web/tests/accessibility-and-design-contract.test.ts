import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function cssVariable(styles: string, name: string): string {
  const value = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing CSS variable --${name}`);
  return value;
}

describe('mobile receiver accessibility and design contracts', () => {
  it('announces only concise state transitions and focuses major state headings', async () => {
    const app = await readFile(path.join(root, 'src/App.tsx'), 'utf8');

    expect(app).toContain('className="visually-hidden" role="status" aria-live="polite" aria-atomic="true"');
    expect(app).not.toContain('className="status-card card" aria-live');
    expect(app).not.toContain('className="camera-indicator" role="status"');
    expect(app).toContain('homeHeading.current : receiveHeadingRef.current');
    expect(app).toContain("heading?.focus({ preventScroll: true })");
    expect(app).toContain('ref={homeHeading} tabIndex={-1}');
    expect(app).toContain('ref={receiveHeadingRef} tabIndex={-1}');
    // Phase 05 replaced the protocol snapshot with one authoritative state, so
    // the cancelled screen is now named by the state machine. The contract this
    // asserts is unchanged: cancellation is a distinct, announced screen.
    expect(app).toContain('RECEIVER_STATE.CANCELLED');
  });

  it('keeps the host indicator readable in both themes and states', async () => {
    const styles = await readFile(path.join(root, 'src/styles.css'), 'utf8');
    const pairs: Array<[string, string, string]> = [
      ['#1c6641', '#f1fbf5', 'light online'],
      ['#8a4a1e', '#fdf6f0', 'light unavailable'],
      ['#8ce0b2', '#14261d', 'dark online'],
      ['#f2bd8c', '#2a1d13', 'dark unavailable'],
      ['#aebdcd', '#182431', 'dark checking'],
    ];

    for (const [foreground, background, name] of pairs) {
      expect(contrast(foreground, background), name).toBeGreaterThanOrEqual(4.5);
    }

    // The state modifier must follow the base rule in both cascades, or the
    // chip renders in its neutral colours whatever the host is doing.
    for (const scope of [styles.slice(0, styles.indexOf('@media (prefers-color-scheme: dark)')), styles.slice(styles.indexOf('@media (prefers-color-scheme: dark)'))]) {
      expect(scope.indexOf('.host-chip')).toBeLessThan(scope.indexOf('.host-online'));
      expect(scope.indexOf('.host-online')).toBeLessThan(scope.indexOf('.host-unavailable'));
    }
  });

  it('keeps all known light-theme normal text pairs at WCAG AA contrast', async () => {
    const styles = await readFile(path.join(root, 'src/styles.css'), 'utf8');
    const pairs = [
      ['#ffffff', cssVariable(styles, 'interactive-blue')],
      [cssVariable(styles, 'accent-blue'), '#f4f7fb'],
      [cssVariable(styles, 'supporting-text'), '#f4f7fb'],
      [cssVariable(styles, 'detail-label'), '#f3f6f9'],
    ];

    for (const [foreground, background] of pairs) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives a secondary action beside a full-width primary the same width', async () => {
    const styles = await readFile(path.join(root, 'src/styles.css'), 'utf8');
    const app = await readFile(path.join(root, 'src/App.tsx'), 'utf8');

    // The dock is a 1.3fr/1fr pair. A primary spans both tracks, which left
    // "Return to home" and "Receive another" stranded at 1.3fr with dead space
    // beside them, reading as a different control from the one above.
    expect(styles).toMatch(/\.action-dock\s+\.primary,\s*\n?\s*\.action-dock\s+\.primary\s*~\s*button\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    expect(styles).not.toMatch(/\.action-dock\s+\.primary\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/);

    // Both affected pairs are a primary followed by a plain secondary; neither
    // may promote the navigation action above the action it returns from.
    //
    // The retry button's *label* became conditional in Phase 09 - an
    // interrupted transfer is continued rather than retried - so the assertion
    // is on the structure it always meant: the retry is the primary, and the
    // navigation beside it is not.
    expect(app).toMatch(/<button className="primary" onClick=\{requestCamera\}>\{?[^<]*\}?<\/button>/);
    expect(app).toContain("'Continue receiving' : 'Try camera again'");
    expect(app).toContain('<button onClick={returnHome}>Return to home</button>');
    expect(app).not.toContain('className="primary" onClick={returnHome}');
  });

  it('shows desktop-host reachability without claiming the app itself is down', async () => {
    const app = await readFile(path.join(root, 'src/App.tsx'), 'utf8');
    const styles = await readFile(path.join(root, 'src/styles.css'), 'utf8');

    expect(app).toContain('role="status"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain('hostStatusCopy(hostStatus)');
    // navigator.onLine reports the radio, not whether this desktop is serving.
    expect(app).not.toContain('navigator.onLine');
    expect(styles).toContain('.host-online');
    expect(styles).toContain('.host-unavailable');
    // Colour alone must not carry the state.
    expect(app).toContain('{host.label}');
  });

  it('uses additive four-edge safe areas, zoom-safe actions, and bounded press motion', async () => {
    const styles = await readFile(path.join(root, 'src/styles.css'), 'utf8');

    expect(styles).toContain('calc(18px + env(safe-area-inset-top))');
    expect(styles).toContain('calc(20px + env(safe-area-inset-right))');
    expect(styles).toContain('calc(24px + env(safe-area-inset-bottom))');
    expect(styles).toContain('calc(20px + env(safe-area-inset-left))');
    expect(styles).toMatch(/\.action-dock\s*\{[^}]*position:\s*sticky/s);
    expect(styles).not.toContain('padding-bottom: 142px');
    expect(styles).toContain('transition: transform 120ms var(--ease-out-strong)');
    expect(styles).toContain('@media (hover: hover) and (pointer: fine)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

/**
 * The action dock, and the overlap a physical iPhone showed.
 *
 * The dock is `position: sticky`, so it reserves its own space and cannot
 * overlay in the layout sense. What it can do — and did — is let content scroll
 * visibly beneath it: the background was 8% transparent with no
 * `backdrop-filter` behind it, so text slid under the buttons in plain view.
 * That is what "the action region overlays receiver content" looks like, and it
 * lands hardest on the screens where a progress figure or a resume code is the
 * thing being read.
 */
describe('the docked actions never show content through themselves', () => {
  const styles = readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');

  /** Every `background` the dock is given, in any theme or media block. */
  function dockBackgrounds(): string[] {
    const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...withoutComments.matchAll(/\.action-dock[^{}]*\{([^}]*)\}/g)]
      .flatMap((rule) => [...rule[1].matchAll(/background:\s*([^;]+);/g)].map((m) => m[1].trim()));
  }

  it('declares an opaque background wherever it declares one at all', () => {
    const backgrounds = dockBackgrounds();
    expect(backgrounds.length, 'the dock no longer sets a background').toBeGreaterThan(0);
    for (const background of backgrounds) {
      if (background === 'transparent') continue; // the wide-viewport rule undocks it entirely
      expect(background, `${background} lets content show through`).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
    }
  });


  it('reserves room so focus cannot park a control beneath the dock', () => {
    // Sticky reserves layout space; it does not teach `scrollIntoView` about
    // itself. Without this, focusing the Save button or the resume code on iOS
    // scrolls it to exactly where the dock is.
    expect(styles).toMatch(/scroll-padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)\)/);
  });
});
