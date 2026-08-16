import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
  detail: string | null;
}

/**
 * Last line of defence for the receiver shell.
 *
 * Without this, a throw anywhere in the tree unmounts React and leaves an empty
 * `#root` — indistinguishable from the module never loading, and equally
 * permanent. The boot watchdog in `public/boot.js` cannot help here, because by
 * this point the module has loaded and reported `BOOT_REACT_MOUNT`.
 *
 * The recovery offered is deliberately in-page first: re-rendering the tree
 * costs nothing and clears transient faults, and a reload is one tap away if it
 * does not. Neither path clears storage — a component fault is not evidence of
 * a poisoned cache, and discarding one on that basis would be guesswork.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, detail: null };

  static getDerivedStateFromError(error: unknown): State {
    // The message only. A stack can carry file paths, and this renders on a
    // user's phone; the transferred payload must never reach it either.
    return { failed: true, detail: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    window.__deqrBoot?.stage('BOOT_REACT_ERROR', error.message);
    // Component stacks name components, not data, so this is safe to keep and
    // is the only thing that makes a field report actionable.
    console.error('DEQR shell failed to render', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ failed: false, detail: null });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="boot-failure" role="alert">
        <h1>DEQR couldn&rsquo;t start</h1>
        <p>The receiver hit an unexpected error. Retrying rebuilds the screen without losing your place in the app.</p>
        <div className="boot-failure-actions">
          <button type="button" className="primary" onClick={this.retry}>Retry</button>
          <button type="button" onClick={() => location.reload()}>Reload application</button>
        </div>
        {this.state.detail && <pre className="boot-failure-detail">{this.state.detail}</pre>}
      </main>
    );
  }
}
