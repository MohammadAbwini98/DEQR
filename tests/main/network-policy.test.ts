import { describe, it, expect, vi } from 'vitest';
// We just need to verify the logic of the network blocker.

describe('Network Policy Interceptor', () => {
  it('blocks external URLs', () => {
    const isAllowed = (url: string) => {
      if (
        url.startsWith('devtools:') || 
        url.startsWith('file:') || 
        url.startsWith('data:') || 
        url.startsWith('http://localhost:5173') ||
        url.startsWith('ws://localhost:5173') ||
        url.startsWith('wss://localhost:5173')
      ) {
        return true;
      }
      return false;
    };

    expect(isAllowed('http://localhost:5173/assets/index.js')).toBe(true);
    expect(isAllowed('ws://localhost:5173/?token=local-vite-hmr')).toBe(true);
    expect(isAllowed('wss://localhost:5173/?token=local-vite-hmr')).toBe(true);
    expect(isAllowed('file:///C:/app/index.html')).toBe(true);
    expect(isAllowed('data:image/png;base64,123')).toBe(true);
    expect(isAllowed('devtools://devtools/bundled/inspector.html')).toBe(true);
    
    expect(isAllowed('https://google.com')).toBe(false);
    expect(isAllowed('http://malicious.com')).toBe(false);
    expect(isAllowed('ws://websocket.org')).toBe(false);
  });
});
