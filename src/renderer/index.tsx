import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/theme.css';
import './styles/index.css';

// Install the browser Buffer polyfill before importing the application tree.
// App transitively imports core modules that create Buffer values at module load
// time, so a static App import can crash the renderer before React mounts.
(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Renderer bootstrap failed: #root element was not found');
}

const root = ReactDOM.createRoot(rootElement);

async function bootstrap() {
  try {
    const { default: App } = await import('./App');

    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (error) {
    console.error('DEQR renderer bootstrap failed:', error);

    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <div
        style={{
          minHeight: '100vh',
          padding: '24px',
          background: '#121212',
          color: '#ffffff',
          fontFamily: 'Segoe UI, sans-serif',
        }}
      >
        <h1>DEQR failed to start</h1>
        <p style={{ marginTop: '12px', whiteSpace: 'pre-wrap' }}>{message}</p>
      </div>
    );
  }
}

void bootstrap();
