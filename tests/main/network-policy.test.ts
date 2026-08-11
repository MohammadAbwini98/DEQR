import { describe, expect, it } from 'vitest';
import {
  isAllowedDesktopDevelopmentRequest,
  isAllowedLocalRendererResource,
  isAllowedRendererRequest,
  isDesktopDevelopmentOrigin,
} from '../../src/main/development-request-policy';

describe('development request policy', () => {
  it('allows only the exact desktop loopback origin', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:5173/assets/index.js',
      'http://[::1]:5173/@vite/client',
    ]) {
      expect(isDesktopDevelopmentOrigin(url), url).toBe(true);
    }

    for (const url of [
      'http://localhost:5174/',
      'https://localhost:5173/',
      'http://localhost.evil.test:5173/',
      'http://localhost:5173@evil.test/',
      'http://user:password@localhost:5173/',
      'http://[::1]:5174/',
    ]) {
      expect(isDesktopDevelopmentOrigin(url), url).toBe(false);
    }
  });

  it('allows only the exact local Vite HTTP and HMR WebSocket requests', () => {
    expect(isAllowedDesktopDevelopmentRequest('http://localhost:5173/index.tsx')).toBe(true);
    expect(isAllowedDesktopDevelopmentRequest('ws://localhost:5173/?token=local-vite-hmr')).toBe(true);

    for (const url of [
      'wss://localhost:5173/',
      'ws://localhost:5174/',
      'ws://localhost:5173@evil.test/',
      'ws://user@localhost:5173/',
      'http://localhost.evil.test:5173/',
    ]) {
      expect(isAllowedDesktopDevelopmentRequest(url), url).toBe(false);
    }
  });

  it('keeps production fail-closed for network requests and validates local schemes', () => {
    expect(isAllowedLocalRendererResource('file:///C:/DEQR/dist/renderer/index.html')).toBe(true);
    expect(isAllowedLocalRendererResource('data:image/png;base64,AA==')).toBe(true);
    expect(isAllowedLocalRendererResource('devtools://devtools/bundled/inspector.html')).toBe(true);
    expect(isAllowedLocalRendererResource('file://evil.test/renderer.html')).toBe(false);
    expect(isAllowedLocalRendererResource('javascript:alert(1)')).toBe(false);

    expect(isAllowedRendererRequest('http://localhost:5173/index.tsx', false)).toBe(true);
    expect(isAllowedRendererRequest('http://localhost:5173/index.tsx', true)).toBe(false);
    expect(isAllowedRendererRequest('https://example.test/', false)).toBe(false);
    expect(isAllowedRendererRequest('ws://example.test/', false)).toBe(false);
  });
});
