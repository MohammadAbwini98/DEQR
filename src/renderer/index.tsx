import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/theme.css';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Renderer bootstrap failed: #root element was not found');
}

const appRoot = rootElement;

function renderBootstrapFailure(error: unknown) {
  console.error('DEQR renderer bootstrap failed:', error);

  const message = error instanceof Error ? error.message : String(error);
  appRoot.replaceChildren();

  const container = document.createElement('div');
  container.style.cssText = 'min-height: 100vh; padding: 24px; background: #121212; color: #ffffff; font-family: Segoe UI, sans-serif;';

  const heading = document.createElement('h1');
  heading.textContent = 'DEQR failed to start';
  container.append(heading);

  const detail = document.createElement('p');
  detail.style.cssText = 'margin-top: 12px; white-space: pre-wrap;';
  detail.textContent = message;
  container.append(detail);

  appRoot.append(container);
}

async function bootstrap() {
  let root: ReturnType<typeof ReactDOM.createRoot> | null = null;

  try {
    // Electron may already provide Buffer. Do not overwrite a non-writable
    // sandbox global; only install the browser shim when it is absent.
    if (typeof (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer === 'undefined') {
      (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;
    }

    root = ReactDOM.createRoot(appRoot);
    const { default: App } = await import('./App');

    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (error) {
    renderBootstrapFailure(error);
  }
}

void bootstrap();
