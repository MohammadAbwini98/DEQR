import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';

declare global {
  interface Window {
    __deqrBoot?: {
      stages: { stage: string; atMs: number; detail: string | null }[];
      stage(name: string, detail?: string): void;
      fail(reason: string): void;
      report(): string;
    };
  }
}

const boot = window.__deqrBoot;
boot?.stage('BOOT_JS_LOADED');

// Mount before anything optional runs. Service worker registration is a
// promise chain, not an await, precisely so a worker that never becomes ready
// cannot hold up the shell — the receiver has to render even when caching,
// storage or the host are all unavailable.
try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  boot?.stage('BOOT_REACT_MOUNT');
} catch (error) {
  // A throw here means React could not mount at all, so no boundary exists to
  // catch it and the page would stay blank. Hand it to the watchdog, which owns
  // the single-recovery-then-diagnose policy.
  boot?.fail(`REACT_MOUNT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

// Production only. The development server shares origin `:5174` with the
// packaged receiver, so a worker registered while developing goes on serving
// its cached development shell after the packaged host takes the port over —
// and that shell asks for `/src/main.tsx` and `/@vite/*`, which the packaged
// host cannot serve. The result is a blank page with 503s for files that only
// ever existed on a Vite server. Offline caching is a shipping requirement, not
// a development one, so it is registered only where it is needed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async (registration) => {
    boot?.stage('BOOT_SW_CHECK');
    await navigator.serviceWorker.ready;
    const urls = [location.href, ...[...document.scripts].map((script) => script.src), ...[...document.querySelectorAll('link[href]')].map((link) => (link as HTMLLinkElement).href)].filter(Boolean);
    registration.active?.postMessage({ type: 'PRECACHE_URLS', urls });
  }).catch((error: unknown) => {
    // Registration failing costs offline support, not the session. Record it so
    // a later blank-page report can distinguish "no worker" from "bad worker".
    boot?.stage('BOOT_SW_FAILED', error instanceof Error ? error.message : String(error));
  });
}

// A worker that finds the shell stale asks for exactly one reload. The flag it
// sets survives the navigation, so `boot.js` can tell a recovery reload from a
// fresh visit and refuses to loop.
navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type === 'DEQR_SHELL_STALE') {
    boot?.fail(`SHELL_STALE:${typeof event.data.asset === 'string' ? event.data.asset : 'unknown'}`);
  }
});
