import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { PwaHostStatusView } from '../../shared/types';

/**
 * Shows how to reach the iPhone receiver this desktop app is publishing. The QR
 * code encodes the LAN URL so the phone camera can open it directly; the URL is
 * also shown as text because a QR is useless if the phone cannot focus on it.
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
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let disposed = false;

    // The host starts in parallel with the window, so the first read can race it.
    const poll = async (attempt: number): Promise<void> => {
      if (disposed) return;
      try {
        const next = await window.deqr.pwaHost.getStatus();
        if (disposed) return;
        setStatus(next);
        if (next.running || next.error || attempt >= 10) return;
      } catch {
        if (disposed || attempt >= 10) return;
      }
      window.setTimeout(() => void poll(attempt + 1), 500);
    };

    void poll(0);
    return () => {
      disposed = true;
    };
  }, []);

  // Follow the main process's preferred address until the user picks one.
  const activeUrl = selectedUrl ?? status?.url ?? null;
  const activeEntry = status?.addresses.find((entry) => entry.url === activeUrl);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeUrl) return;

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
  }, [activeUrl]);

  if (!status) {
    return (
      <article className="pwa-host-card" aria-labelledby="pwa-host-heading">
        <h2 id="pwa-host-heading">Receive on iPhone</h2>
        <p className="pwa-host-status" role="status">Publishing the iPhone receiver…</p>
      </article>
    );
  }

  if (!status.running || !activeUrl) {
    return (
      <article className="pwa-host-card pwa-host-card--unavailable" aria-labelledby="pwa-host-heading">
        <h2 id="pwa-host-heading">Receive on iPhone</h2>
        <p className="pwa-host-status" role="status">
          {status.error ?? 'The iPhone receiver is not available on this network.'}
        </p>
        <p className="pwa-host-hint">
          The desktop sender still works. Connect this computer to the same Wi-Fi as the
          iPhone and restart DEQR to publish the receiver.
        </p>
      </article>
    );
  }

  return (
    <article className="pwa-host-card" aria-labelledby="pwa-host-heading">
      <h2 id="pwa-host-heading">Receive on iPhone</h2>
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
          {status.addresses.length > 1 && (
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
            receiver is served by this computer rather than a public website.
          </p>
        </div>
      </div>
    </article>
  );
}
