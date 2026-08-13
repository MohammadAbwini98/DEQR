import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { PwaHostStatusView } from '../../shared/types';
import { PwaHostPendingAction, presentPwaHost } from '../pwa-host-model';

/**
 * Starts and stops the iPhone receiver, and shows how to reach it while it is
 * running. The receiver is off until someone asks for it: it binds every
 * network interface and writes a private key on first use, so publishing it is
 * a decision rather than a default.
 */
const KIND_LABEL: Record<string, string> = {
  overlay: 'Tailscale',
  private: 'Local network',
  other: 'Other',
};

const KIND_HINT: Record<string, string> = {
  overlay:
    'Works wherever the iPhone is, as long as it is signed in to the same tailnet. It does not need a Windows Firewall rule for this port.',
  private:
    'Requires the iPhone to be on this same network, and Windows Firewall must allow inbound connections on this port.',
  other: 'Reachability depends on how this interface is routed.',
};

export default function PwaHostCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<PwaHostStatusView | null>(null);
  const [pending, setPending] = useState<PwaHostPendingAction>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let disposed = false;

    // Subscribe before the first read so a transition cannot land in the gap
    // between them. The card remounts whenever the user leaves the dashboard,
    // so the read is what recovers state after a remount.
    const unsubscribe = window.deqr.pwaHost.subscribe((next) => {
      setStatus(next);
      if (next.state === 'running' || next.state === 'stopped' || next.state === 'failed') {
        setPending(null);
      }
    });

    void window.deqr.pwaHost
      .getStatus()
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const runAction = async (kind: 'start' | 'stop') => {
    // Set the optimistic state before awaiting: generating a certificate blocks
    // the main process, but this renderer keeps painting, so the button has to
    // respond without waiting for a reply.
    setPending(kind === 'start' ? 'starting' : 'stopping');
    try {
      const next =
        kind === 'start'
          ? await window.deqr.pwaHost.start()
          : await window.deqr.pwaHost.stop();
      setStatus(next);
    } catch {
      setPending(null);
    }
  };

  const view = presentPwaHost(status, pending);

  // Validate the chosen address against the live list rather than holding it,
  // so a stop, a network change, and a start cannot leave a dead URL selected.
  const activeUrl =
    selectedUrl && status?.addresses.some((entry) => entry.url === selectedUrl)
      ? selectedUrl
      : status?.url ?? null;
  const activeEntry = status?.addresses.find((entry) => entry.url === activeUrl);
  const showQr = view.showQr && Boolean(activeUrl);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showQr || !activeUrl) return;

    let disposed = false;
    QRCode.toCanvas(canvas, activeUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 168,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then(() => {
        if (!disposed) setQrFailed(false);
      })
      .catch(() => {
        if (!disposed) setQrFailed(true);
      });

    return () => {
      disposed = true;
    };
  }, [activeUrl, showQr]);

  return (
    <article
      className={`pwa-host-card${view.isFailure ? ' pwa-host-card--unavailable' : ''}`}
      aria-labelledby="pwa-host-heading"
      aria-busy={view.state === 'starting' || view.state === 'stopping'}
    >
      <h2 id="pwa-host-heading">Receive on iPhone</h2>

      {/* One live region for every state. Screen readers routinely miss a
          region that is mounted at the same moment as its text. */}
      <p
        id="pwa-host-status-text"
        className="pwa-host-status"
        role={view.isFailure ? 'alert' : 'status'}
        aria-live="polite"
      >
        {view.message}
      </p>

      {showQr && activeUrl && (
        <>
          <p className="pwa-host-lede">
            Scan this code with the iPhone camera, then add DEQR to the Home Screen.
          </p>

          <div className="pwa-host-body">
            <div className="pwa-host-qr">
              <canvas
                ref={canvasRef}
                width={168}
                height={168}
                role="img"
                aria-label={`QR code linking to the iPhone receiver at ${activeUrl}`}
              />
              {qrFailed && (
                <p className="pwa-host-status" role="alert">
                  The QR code could not be drawn. Type the address below instead.
                </p>
              )}
            </div>

            <div className="pwa-host-details">
              {status && status.addresses.length > 1 && (
                <div className="pwa-host-switch" role="group" aria-label="Choose how the iPhone connects">
                  {status.addresses.map((entry) => (
                    <button
                      key={entry.url}
                      type="button"
                      className={`pwa-host-switch-option${entry.url === activeUrl ? ' is-selected' : ''}`}
                      aria-pressed={entry.url === activeUrl}
                      onClick={() => setSelectedUrl(entry.url)}
                    >
                      {KIND_LABEL[entry.kind] ?? entry.interfaceName}
                    </button>
                  ))}
                </div>
              )}

              <p className="pwa-host-url-label" id="pwa-host-url-label">Address</p>
              <p className="pwa-host-url" aria-describedby="pwa-host-url-label">{activeUrl}</p>

              {activeEntry && (
                <p className="pwa-host-hint">{KIND_HINT[activeEntry.kind]}</p>
              )}
              <p className="pwa-host-hint">
                Safari warns about this certificate until the iPhone trusts it once, because the
                receiver is served by this computer rather than a public website. Moving this
                computer to a different network can require trusting it again.
              </p>
            </div>
          </div>
        </>
      )}

      {view.hint && <p className="pwa-host-hint">{view.hint}</p>}

      {/* Deliberately one button whose label and handler change, not several
          swapped by state. Remounting the control would drop keyboard focus at
          the exact moment the person just pressed it. */}
      <div className="action-row">
        <button
          type="button"
          className={view.actionClassName}
          disabled={view.actionDisabled}
          aria-describedby="pwa-host-status-text"
          onClick={() => void runAction(view.actionKind)}
        >
          {view.actionLabel}
        </button>
      </div>
    </article>
  );
}
