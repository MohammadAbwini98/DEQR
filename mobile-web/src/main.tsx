import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async (registration) => {
    await navigator.serviceWorker.ready;
    const urls = [location.href, ...[...document.scripts].map((script) => script.src), ...[...document.querySelectorAll('link[href]')].map((link) => (link as HTMLLinkElement).href)].filter(Boolean);
    registration.active?.postMessage({ type: 'PRECACHE_URLS', urls });
  }).catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
