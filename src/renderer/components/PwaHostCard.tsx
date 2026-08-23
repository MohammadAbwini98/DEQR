import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { PwaHostStatusView } from '../../shared/types';
import { QR_QUIET_ZONE_MODULES, planQrGeometry } from '../../core/qr-capacity';
import { PwaHostPendingAction, presentPwaHost, shouldRestoreActionFocus } from '../pwa-host-model';
import { applyCanvasGeometry } from '../qr-render';

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

/**
 * The layout's allowance for the address symbol, in CSS pixels.
 *
 * A *budget*, not a size: the symbol drawn is the largest whole-module square
 * that fits inside it, so it is usually a few pixels smaller. See the effect
 * below for why a fixed size cannot work here.
 */
const QR_ADDRESS_BUDGET_CSS_PX = 168;
/** This is read across a desk from a phone held in a hand, not at a distance. */
const QR_ADDRESS_ECC = 'M' as const;
/**
 * The spec's minimum, taken from the shared constant rather than restated.
 *
 * This call previously passed `margin: 2` — half the required quiet zone, which
 * is precisely the drift `QR_QUIET_ZONE_MODULES` exists to prevent. The card's
 * white tile supplies the visual padding; it is not a substitute for the quiet
 * zone, because a decoder measures the quiet zone in modules.
 */
const QR_ADDRESS_QUIET_ZONE_MODULES = QR_QUIET_ZONE_MODULES;

export default function PwaHostCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const reclaimFocus = useRef(false);
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
    // Disabling the control below blurs it, so note whether it is losing focus
    // that has to be handed back once the transition settles.
    reclaimFocus.current = document.activeElement === actionRef.current;
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

  // Runs after the control is enabled again. The label has changed by now, so
  // focus returns to the action the person is most likely to want next rather
  // than to the top of the document.
  useEffect(() => {
    if (!shouldRestoreActionFocus({
      hadFocus: reclaimFocus.current,
      actionDisabled: view.actionDisabled,
      activeIsBody: document.activeElement === document.body,
    })) {
      if (!view.actionDisabled) reclaimFocus.current = false;
      return;
    }
    reclaimFocus.current = false;
    actionRef.current?.focus();
  }, [view.actionDisabled]);

  // Validate the chosen address against the live list rather than holding it,
  // so a stop, a network change, and a start cannot leave a dead URL selected.
  const activeUrl =
    selectedUrl && status?.addresses.some((entry) => entry.url === selectedUrl)
      ? selectedUrl
      : status?.url ?? null;
  const activeEntry = status?.addresses.find((entry) => entry.url === activeUrl);
  const showQr = view.showQr && Boolean(activeUrl);

  /**
   * Draws the address symbol on whole pixels.
   *
   * This asked for `width: 168` and let `qrcode` divide 168 by whatever module
   * count fell out of the URL. A tailnet address is a version-2 symbol, 25
   * modules plus 4 of quiet zone, so the scale was 168 / 29 = 5.79: the library
   * maps each destination pixel back through `floor(px / scale)`, so most
   * modules got five pixels and roughly one in five got six. Every edge in the
   * symbol landed on a fractional boundary, and the module grid a decoder looks
   * for was no longer regular.
   *
   * A fixed pixel width cannot be right here, because unlike a transfer frame
   * the payload length varies: a longer address crosses into version 3 and the
   * divisor changes underneath the same 168. So the budget is a *maximum* and
   * the symbol is built up from it — `QR_ADDRESS_BUDGET_CSS_PX` bounds the
   * layout, `planQrGeometry` picks the largest integer module scale that fits,
   * and the canvas is exactly that many device pixels with a CSS box to match.
   * Usually a few pixels smaller than the budget, which is the trade: a symbol
   * leaving pixels unused beats one filling its box with uneven modules.
   *
   * `scale` and `margin` rather than `width`, for the same reason as
   * `qr-render.ts` — the first multiplies module count by whole pixels, the
   * second divides a pixel budget by module count.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showQr || !activeUrl) return;

    let disposed = false;
    void (async () => {
      try {
        // The version is a property of this address, so it has to be resolved
        // before the geometry rather than assumed.
        const { version } = QRCode.create(activeUrl, { errorCorrectionLevel: QR_ADDRESS_ECC });
        const geometry = planQrGeometry({
          version,
          budgetCssPx: QR_ADDRESS_BUDGET_CSS_PX,
          devicePixelRatio: window.devicePixelRatio || 1,
          quietZoneModules: QR_ADDRESS_QUIET_ZONE_MODULES,
        });
        if (disposed) return;
        applyCanvasGeometry(canvas, geometry);

        await QRCode.toCanvas(canvas, activeUrl, {
          errorCorrectionLevel: QR_ADDRESS_ECC,
          version,
          scale: geometry.moduleScale,
          margin: geometry.quietZoneModules,
          color: { dark: '#000000', light: '#ffffff' },
        });
        if (!disposed) setQrFailed(false);
      } catch {
        if (!disposed) setQrFailed(true);
      }
    })();

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
              {/* Deliberately unsized here. The backing store and the CSS box
                  are both set by `applyCanvasGeometry` from the resolved module
                  scale, and an attribute here would be a second opinion about a
                  size that depends on the address and the display. */}
              <canvas
                ref={canvasRef}
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
          the exact moment the person just pressed it. That alone was not
          enough: the control is disabled while the transition runs, which
          blurs it to `<body>` and does not restore it, so the effect above
          hands focus back. */}
      <div className="action-row">
        <button
          ref={actionRef}
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
