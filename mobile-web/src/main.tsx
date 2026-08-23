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

/**
 * Everything this document actually loaded from this origin.
 *
 * The DOM half — `<script>` and `<link>` — is the shell's declared graph. The
 * `performance` half is the observed one, and it is not redundant: the receive
 * worker is constructed from JavaScript rather than referenced by the document,
 * so it appears in no element and would otherwise enter the cache only because
 * some earlier session happened to fetch it while the host was reachable. An
 * offline receiver that cannot start its decoder is not an offline receiver.
 */
function shellUrls(): string[] {
  const fromDocument = [
    location.href,
    ...[...document.scripts].map((script) => script.src),
    ...[...document.querySelectorAll('link[href]')].map((link) => (link as HTMLLinkElement).href),
  ];
  const fromNetwork = performance.getEntriesByType('resource').map((entry) => entry.name);
  return [...new Set([...fromDocument, ...fromNetwork])].filter(
    (url) => Boolean(url) && url.startsWith(`${location.origin}/`),
  );
}

/**
 * Hands the *controlling* worker the list, rather than the one that was active
 * when registration resolved.
 *
 * On an upgrade those are different workers, and the difference is a broken
 * offline shell. The sequence: the old worker serves the navigation and caches
 * the new document's assets into *its* cache; the new worker installs, calls
 * `skipWaiting`, and its `activate` deletes every older `deqr-mobile-` cache —
 * including the one those assets just landed in. The new cache is left holding
 * only its own `CORE` list, so the cached `index.html` names an
 * `/assets/index-HASH.js` that is in no cache at all. The next offline launch
 * then reproduces the exact permanent-white-page failure `boot.js` exists for.
 *
 * Posting again on `controllerchange` closes it: by then the new worker owns
 * the cache the document will actually be served from.
 */
function precacheShell(worker: ServiceWorker | null | undefined): void {
  worker?.postMessage({ type: 'PRECACHE_URLS', urls: shellUrls() });
}

// Production only. The development server shares origin `:5174` with the
// packaged receiver, so a worker registered while developing goes on serving
// its cached development shell after the packaged host takes the port over —
// and that shell asks for `/src/main.tsx` and `/@vite/*`, which the packaged
// host cannot serve. The result is a blank page with 503s for files that only
// ever existed on a Vite server. Offline caching is a shipping requirement, not
// a development one, so it is registered only where it is needed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    precacheShell(navigator.serviceWorker.controller);
  });

  // Assets fetched after the shell mounts — the receive worker chunk above all
  // — are not in `performance` yet when registration resolves.
  window.addEventListener('load', () => {
    precacheShell(navigator.serviceWorker.controller);
  });

  navigator.serviceWorker.register('./sw.js').then(async (registration) => {
    boot?.stage('BOOT_SW_CHECK');
    await navigator.serviceWorker.ready;
    precacheShell(navigator.serviceWorker.controller ?? registration.active);
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
