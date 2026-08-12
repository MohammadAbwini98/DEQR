import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/theme.css';
import './styles/index.css';

const rootElement = document.getElementById('root');

function renderBootstrapFailure(error: unknown) {
  console.error('DEQR renderer bootstrap failed:', error);

  const message = error instanceof Error ? error.message : String(error);
  const appRoot = rootElement ?? document.body;
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

interface BootstrapErrorBoundaryProps {
  children: React.ReactNode;
}

interface BootstrapErrorBoundaryState {
  failed: boolean;
}

class BootstrapErrorBoundary extends React.Component<BootstrapErrorBoundaryProps, BootstrapErrorBoundaryState> {
  public state: BootstrapErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): BootstrapErrorBoundaryState {
    return { failed: true };
  }

  public componentDidCatch(error: Error): void {
    renderBootstrapFailure(error);
  }

  public render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

async function bootstrap() {
  try {
    if (!rootElement) {
      throw new Error('Renderer bootstrap failed: #root element was not found');
    }

    // Electron may already provide Buffer. Do not overwrite a non-writable
    // sandbox global; only load and install the browser shim when it is absent.
    // This import stays inside the guarded path so an optimizer/module failure
    // produces an actionable page instead of an empty Electron window.
    const globals = globalThis as typeof globalThis & { Buffer?: (typeof import('buffer'))['Buffer'] };
    if (typeof globals.Buffer === 'undefined') {
      const { Buffer } = await import('buffer');
      globals.Buffer = Buffer;
    }

    const root = ReactDOM.createRoot(rootElement);
    const { default: App } = await import('./App');

    root.render(
      <BootstrapErrorBoundary>
        <React.StrictMode>
          <App />
        </React.StrictMode>
      </BootstrapErrorBoundary>
    );
  } catch (error) {
    renderBootstrapFailure(error);
  }
}

void bootstrap();
