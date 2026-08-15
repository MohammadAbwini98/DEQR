import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Production only. The development server shares origin `:5174` with the
// packaged receiver, so a worker registered while developing goes on serving
// its cached development shell after the packaged host takes the port over —
// and that shell asks for `/src/main.tsx` and `/@vite/*`, which the packaged
// host cannot serve. The result is a blank page with 503s for files that only
// ever existed on a Vite server. Offline caching is a shipping requirement, not
// a development one, so it is registered only where it is needed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async (registration) => {
    await navigator.serviceWorker.ready;
    const urls = [location.href, ...[...document.scripts].map((script) => script.src), ...[...document.querySelectorAll('link[href]')].map((link) => (link as HTMLLinkElement).href)].filter(Boolean);
    registration.active?.postMessage({ type: 'PRECACHE_URLS', urls });
  }).catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
