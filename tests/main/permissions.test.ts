import { describe, it, expect } from 'vitest';
import { evaluateMediaPermission } from '../../src/main/development-request-policy';

// These cases exercise the exact function both Electron permission handlers in
// src/main/index.ts delegate to. An earlier version of this file re-declared the
// handler logic locally, which silently diverged from production once the
// prefix-based origin checks were replaced with parsed-URL policy.

const DEV_FRAME = 'http://localhost:5173/';
const DEV_ORIGIN = 'http://localhost:5173';
const PACKAGED_FRAME = 'file:///C:/app/index.html';

describe('evaluateMediaPermission — request-handler shape (no requestingOrigin)', () => {
  it('allows main-frame video from the trusted development origin', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(true);
  });

  it('allows main-frame video from the packaged local renderer', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: PACKAGED_FRAME,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(true);
  });

  it.each([
    ['audio requested alongside video', { mediaTypes: ['video', 'audio'] }],
    ['audio only', { mediaTypes: ['audio'] }],
    ['no media types', {}],
    ['empty media types', { mediaTypes: [] }],
  ])('denies %s', (_label, overrides) => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        isMainFrame: true,
        ...overrides,
      }),
    ).toBe(false);
  });

  it('denies a subframe', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        isMainFrame: false,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });

  it('denies non-media permissions', () => {
    expect(
      evaluateMediaPermission({
        permission: 'geolocation',
        frameUrl: DEV_FRAME,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });

  it.each([
    ['a remote origin', 'https://malicious.com/'],
    ['an alternate loopback port', 'http://localhost:5174/'],
    ['credentials on the development origin', 'http://user:pass@localhost:5173/'],
    // A host-bearing file URL is not a local renderer resource. The previous
    // duplicated `startsWith('file://')` test logic accepted these.
    ['a host-bearing file URL', 'file://evil.com/C:/app/index.html'],
    ['a remote-looking file URL', 'file://attacker.example/payload.html'],
    ['a missing frame URL', null],
    ['an unparseable frame URL', ''],
  ])('denies %s', (_label, frameUrl) => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });
});

describe('evaluateMediaPermission — check-handler shape (with requestingOrigin)', () => {
  it('allows video when both the frame and the requesting origin are trusted', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        requestingOrigin: DEV_ORIGIN,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(true);
  });

  it('allows the packaged renderer origin Electron reports for file frames', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: PACKAGED_FRAME,
        requestingOrigin: 'file://',
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(true);
  });

  it('denies when the frame URL is untrusted even if the origin is trusted', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: 'https://malicious.com/',
        requestingOrigin: DEV_ORIGIN,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });

  it('denies when the requesting origin is untrusted even if the frame is trusted', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        requestingOrigin: 'https://malicious.com',
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });

  it('denies a null requesting origin', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        requestingOrigin: null,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    ).toBe(false);
  });

  it('denies audio in the check shape', () => {
    expect(
      evaluateMediaPermission({
        permission: 'media',
        frameUrl: DEV_FRAME,
        requestingOrigin: DEV_ORIGIN,
        isMainFrame: true,
        mediaTypes: ['audio'],
      }),
    ).toBe(false);
  });
});
