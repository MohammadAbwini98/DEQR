import React, { forwardRef } from 'react';

/**
 * The optical surface, and the only place the QR symbol is drawn.
 *
 * This file used to be the whole v1 transfer screen: a canvas, a subscription
 * to a main-process frame push, a stats grid and the transfer controls. The
 * frame pulling and every number moved to `StreamTransferView` when the sender
 * became segmented, and what is left here is deliberately the smallest possible
 * component - because the design rules this phase has to hold are all rules
 * about *this* element, and one owner is what makes them assertable:
 *
 * - **The symbol is never animated, scaled or filtered.** No transition, no
 *   transform, no opacity fade, no blur. A CSS transition on a canvas that
 *   swaps content twelve times a second does not make anything look smoother;
 *   it puts a half-rendered symbol in front of a camera that is integrating
 *   over the whole exposure.
 * - **The quiet zone is part of the image, not part of the layout.** It is
 *   painted into the canvas by `qr-render`, so no amount of surrounding CSS can
 *   eat it. The stage's own padding is separate and additive.
 * - **The canvas is sized in whole module pixels.** `applyCanvasGeometry` sets
 *   the backing store; nothing here resizes it, and `image-rendering: pixelated`
 *   in the stylesheet keeps the browser from resampling it if the window forces
 *   a fractional scale.
 *
 * The caller owns the frame source and paints through the forwarded ref. That
 * inversion is what keeps the pulling, the pacing and the drawing in one place
 * upstream while the presentation stays here.
 */

interface Props {
  /** Shown under the symbol. Guidance, never status. */
  guidance?: string;
  /** Set when a paint failed, so the surface can say so without hiding the code. */
  renderError?: boolean;
}

const DEFAULT_GUIDANCE =
  'Keep the entire white boundary visible to the receiving camera. Avoid overlays or motion near the code.';

const QRCanvas = forwardRef<HTMLCanvasElement, Props>(function QRCanvas(
  { guidance = DEFAULT_GUIDANCE, renderError = false },
  ref,
) {
  return (
    <>
      <div className="qr-stage">
        <canvas
          ref={ref}
          className="qr-canvas"
          role="img"
          aria-label="Animated DEQR optical transfer QR code"
        />
      </div>
      <p className="qr-guidance">{guidance}</p>
      {renderError && (
        <p className="error-banner transfer-error" role="alert">
          The QR display could not be refreshed. Hold and release the stream to retry.
        </p>
      )}
    </>
  );
});

export default QRCanvas;
