import { describe, expect, it } from 'vitest';
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
    expect(app).toContain("snapshot.state === 'CANCELLED'");
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
