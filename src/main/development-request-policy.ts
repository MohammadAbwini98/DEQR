const DESKTOP_DEVELOPMENT_PORT = '5173';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasNoCredentials(url: URL): boolean {
  return url.username.length === 0 && url.password.length === 0;
}

/**
 * Returns true only for the explicit loopback Vite origin used by the desktop
 * development shell. This deliberately excludes alternate ports, credentials,
 * and every non-loopback host.
 */
export function isDesktopDevelopmentOrigin(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(
    url &&
      hasNoCredentials(url) &&
      url.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.port === DESKTOP_DEVELOPMENT_PORT,
  );
}

/**
 * Allows only HTTP page/module requests and the local Vite HMR websocket for
 * the exact desktop development server origin.
 */
export function isAllowedDesktopDevelopmentRequest(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(
    url &&
      hasNoCredentials(url) &&
      (url.protocol === 'http:' || url.protocol === 'ws:') &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.port === DESKTOP_DEVELOPMENT_PORT,
  );
}

/**
 * Packaged renderer resources are local file/data URLs. DevTools is local to
 * Electron and retained for development troubleshooting; none of these URLs
 * can name a remote network origin.
 */
export function isAllowedLocalRendererResource(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !hasNoCredentials(url)) {
    return false;
  }

  if (url.protocol === 'file:') {
    return url.hostname.length === 0;
  }

  return url.protocol === 'data:' || url.protocol === 'devtools:';
}

/**
 * Production is fail-closed for network URLs. Development adds only the
 * explicit loopback Vite server above; the mobile PWA LAN origin is never an
 * Electron renderer origin.
 */
export function isAllowedRendererRequest(value: string, isPackaged: boolean): boolean {
  return isAllowedLocalRendererResource(value) ||
    (!isPackaged && isAllowedDesktopDevelopmentRequest(value));
}

/**
 * The only renderer origins DEQR ever trusts: the exact loopback development
 * server and local packaged renderer resources.
 */
export function isTrustedRendererOrigin(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return isDesktopDevelopmentOrigin(value) || isAllowedLocalRendererResource(value);
}

export interface MediaPermissionRequest {
  /** Electron permission name. */
  permission: string;
  /** `webContents.getURL()`; null/undefined when there is no sender. */
  frameUrl: string | null | undefined;
  /**
   * Present only for the permission *check* handler. When supplied it must be
   * trusted in addition to `frameUrl`, so a trusted frame cannot be used to
   * answer a check on behalf of an untrusted origin.
   */
  requestingOrigin?: string | null;
  isMainFrame: boolean;
  mediaTypes?: string[];
}

/**
 * Single deny-by-default decision shared by `setPermissionRequestHandler` and
 * `setPermissionCheckHandler`. DEQR only ever needs main-frame video capture
 * from a trusted local renderer; every other permission, frame, origin, or
 * media combination is refused.
 *
 * Both Electron handlers delegate here so the shipped policy and its tests
 * cannot drift apart.
 */
export function evaluateMediaPermission(request: MediaPermissionRequest): boolean {
  if (request.permission !== 'media') {
    return false;
  }
  if (request.isMainFrame !== true) {
    return false;
  }
  if (!isTrustedRendererOrigin(request.frameUrl)) {
    return false;
  }
  if (request.requestingOrigin !== undefined && !isTrustedRendererOrigin(request.requestingOrigin)) {
    return false;
  }

  const mediaTypes = request.mediaTypes;
  if (!Array.isArray(mediaTypes)) {
    return false;
  }
  return mediaTypes.includes('video') && !mediaTypes.includes('audio');
}
