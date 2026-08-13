import { isDesktopDevelopmentOrigin, isLocalRendererFileUrl } from './development-request-policy';

/**
 * Who is allowed to invoke privileged main-process operations.
 *
 * The preload bridge is a capability surface, not a private channel: context
 * isolation stops the page from tampering with the bridge, but it does not say
 * anything about who called it. Any script running in the renderer's context
 * can reach `window.deqr`, and through it a native file dialog, a file write,
 * and a 2048-bit key plus a listener on every interface.
 *
 * Navigation denial, popup denial, `frame-src 'none'` and the fail-closed
 * request policy already make it hard to get foreign code into that context,
 * so this is defence in depth rather than a patch for a known hole. It is
 * cheap, and privileged IPC is a boundary worth authenticating.
 *
 * Deliberately narrower than `isTrustedRendererOrigin`, which additionally
 * accepts `data:` and `devtools:`. Those are fine to load and must never be
 * trusted as a caller: a `data:` document is an opaque origin. The origin rules
 * themselves are imported rather than restated, so there is one definition of
 * "the development server" and one of "the packaged renderer document".
 */
export function isTrustedIpcSenderUrl(
  value: string | null | undefined,
  isPackaged: boolean,
): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (isLocalRendererFileUrl(value)) {
    return true;
  }
  // Only an unpackaged build may trust the Vite origin. Sharing one predicate
  // with the packaged case would silently make `http://localhost:5173` a
  // trusted caller in a shipped app.
  return !isPackaged && isDesktopDevelopmentOrigin(value);
}

/** The subset of `IpcMainInvokeEvent` this policy reads. */
export interface IpcSenderFrameLike {
  url?: string | null;
  /** `null` for the top-level frame; a frame object for any subframe. */
  parent?: unknown;
}

export interface IpcSenderEventLike {
  senderFrame?: IpcSenderFrameLike | null;
}

/**
 * Fail-closed sender check.
 *
 * Rejects a destroyed or absent frame, rejects every subframe, and rejects any
 * frame URL outside the trusted set. `parent` must be exactly `null`: if a
 * future Electron stopped reporting it that way, every privileged call would
 * break loudly in development rather than quietly accepting subframes.
 */
export function isTrustedIpcSender(event: IpcSenderEventLike, isPackaged: boolean): boolean {
  let frame: IpcSenderFrameLike | null | undefined;
  try {
    // Accessing `senderFrame` can throw once the frame has gone away.
    frame = event?.senderFrame;
  } catch {
    return false;
  }

  if (!frame || frame.parent !== null) {
    return false;
  }
  return isTrustedIpcSenderUrl(frame.url, isPackaged);
}
