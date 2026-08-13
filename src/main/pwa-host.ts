import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { CertificateSource } from './pwa-certificate';

/**
 * Served as a real response header. The PWA also carries this policy in a
 * `<meta>` tag, but `frame-ancestors` is ignored when delivered that way, so
 * only the header actually forbids framing. Keep the two in sync — a test
 * asserts they match.
 */
export const PWA_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

export const PWA_HOST_DEFAULT_PORT = 5174;

/**
 * The one path the receiver may probe to learn whether this host is reachable.
 * It must be matched before the extensionless single-page fallback, or it would
 * silently answer with the HTML shell and every probe would report "online".
 */
export const PWA_HOST_HEALTH_PATH = '/health';

/**
 * Deliberately constant. The receiver only needs "a DEQR host answered", and a
 * reachability probe is the wrong place to publish addresses, interface names,
 * certificate details, versions, or anything about an active transfer. Anything
 * that can read this can already fetch `index.html`, so it discloses nothing new.
 */
export const PWA_HOST_HEALTH_BODY = '{"service":"deqr-pwa-host","status":"ok"}';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a request URL onto a file inside `rootDirectory`, or null when the
 * request escapes that directory or cannot be decoded. Resolution is purely
 * lexical so it behaves identically for a real directory and for the read-only
 * copy inside the packaged ASAR archive.
 */
export function resolveRequestedFile(rootDirectory: string, requestUrl: string): string | null {
  const root = path.resolve(rootDirectory);

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'https://deqr.invalid').pathname);
  } catch {
    return null;
  }

  if (pathname.includes('\0')) return null;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const resolved = path.resolve(root, pathname.replace(/^[/\\]+/, ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': PWA_CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // The receiver needs the rear camera; nothing else is granted.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    // The shell must never be stale after an app update.
    'Cache-Control': 'no-cache',
  };
}

/**
 * Decodes exactly like `resolveRequestedFile` so a probe and a file request can
 * never disagree about what a URL means. A query string is ignored: the PWA
 * appends a cache-busting parameter.
 */
export function isHealthProbe(requestUrl: string): boolean {
  try {
    return decodeURIComponent(new URL(requestUrl, 'https://deqr.invalid').pathname) === PWA_HOST_HEALTH_PATH;
  } catch {
    return false;
  }
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

export async function handlePwaRequest(
  rootDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders() });
    response.end();
    return;
  }

  // Answered before any file resolution so the single-page fallback can never
  // shadow it. `no-store` matters as much as the body: a cached 200 would make
  // a stopped receiver look reachable, which is the exact failure this exists
  // to rule out.
  if (isHealthProbe(request.url ?? '/')) {
    const body = Buffer.from(PWA_HOST_HEALTH_BODY, 'utf8');
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' ? undefined : body);
    return;
  }

  const requested = resolveRequestedFile(rootDirectory, request.url ?? '/');
  if (!requested) {
    response.writeHead(400, securityHeaders());
    response.end();
    return;
  }

  let filePath = requested;
  let body = await readFileOrNull(filePath);

  // Single-page routes have no file on disk. Only extensionless paths fall back
  // to the shell so a missing asset still reports 404 instead of HTML.
  if (!body && path.extname(filePath) === '') {
    filePath = path.resolve(rootDirectory, 'index.html');
    body = await readFileOrNull(filePath);
  }

  if (!body) {
    response.writeHead(404, securityHeaders());
    response.end();
    return;
  }

  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(body.byteLength),
  });
  response.end(method === 'HEAD' ? undefined : body);
}

export interface StartPwaHostOptions {
  rootDirectory: string;
  certificate: string;
  privateKey: string;
  port?: number;
  bindAddress?: string;
}

export interface RunningPwaHost {
  port: number;
  close(): Promise<void>;
}

export function startPwaHost(options: StartPwaHostOptions): Promise<RunningPwaHost> {
  const port = options.port ?? PWA_HOST_DEFAULT_PORT;
  // Binding every interface is the point of this server: the phone is a
  // separate device. The renderer itself never talks to it.
  const bindAddress = options.bindAddress ?? '0.0.0.0';

  return new Promise<RunningPwaHost>((resolve, reject) => {
    const server = https.createServer(
      { cert: options.certificate, key: options.privateKey },
      (request, response) => {
        void handlePwaRequest(options.rootDirectory, request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(500, securityHeaders());
          }
          response.end();
        });
      },
    );

    const onListenError = (error: Error) => reject(error);
    server.once('error', onListenError);

    server.listen(port, bindAddress, () => {
      server.removeListener('error', onListenError);
      // An 'error' event with no listener is thrown, which would take down the
      // main process. The listen-time handler above is gone by now, and the
      // server can be started and stopped repeatedly, so it needs a durable
      // replacement rather than none.
      server.on('error', () => {
        setPwaHostStatus(failedPwaHostStatus(PWA_HOST_FAILURE_MESSAGE));
      });
      // Keeping the process alive is the window's job, not the server's.
      server.unref();
      resolve({
        port,
        close: () =>
          new Promise<void>((closed) => {
            server.close(() => closed());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

export interface PwaHostAddress {
  address: string;
  interfaceName: string;
  /** `overlay` is a mesh-VPN address such as Tailscale. */
  kind: 'overlay' | 'private' | 'other';
  url: string;
}

/**
 * `stopped` is the launch default and is not a failure. Keeping the two
 * in-progress states here rather than in the renderer is deliberate: the card
 * unmounts whenever the user leaves the dashboard, so anything it must still
 * know after remounting has to live in this process.
 */
export type PwaHostState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface PwaHostStatus {
  state: PwaHostState;
  /** Invariant: always equal to `state === 'running'`. */
  running: boolean;
  /** The preferred URL. Every candidate is listed in `addresses`. */
  url: string | null;
  addresses: PwaHostAddress[];
  subjectAltNames: string[];
  certificateSource: CertificateSource | null;
  error: string | null;
}

/** Surfaced in the desktop UI, so it must stay free of paths and key material. */
export const PWA_HOST_FAILURE_MESSAGE =
  'The iPhone receiver could not be published on this network.';

// Every status is built by one of these five factories. That is what keeps the
// `running`/`state` invariant true in one place instead of at each call site.

export function stoppedPwaHostStatus(): PwaHostStatus {
  return {
    state: 'stopped',
    running: false,
    url: null,
    addresses: [],
    subjectAltNames: [],
    certificateSource: null,
    error: null,
  };
}

export function startingPwaHostStatus(): PwaHostStatus {
  return { ...stoppedPwaHostStatus(), state: 'starting' };
}

export function stoppingPwaHostStatus(previous: PwaHostStatus): PwaHostStatus {
  return { ...previous, state: 'stopping', running: false };
}

export function runningPwaHostStatus(details: {
  url: string;
  addresses: PwaHostAddress[];
  subjectAltNames: string[];
  certificateSource: CertificateSource;
}): PwaHostStatus {
  return {
    state: 'running',
    running: true,
    url: details.url,
    addresses: details.addresses,
    subjectAltNames: details.subjectAltNames,
    certificateSource: details.certificateSource,
    error: null,
  };
}

export function failedPwaHostStatus(message: string): PwaHostStatus {
  return { ...stoppedPwaHostStatus(), state: 'failed', error: message };
}

let currentStatus: PwaHostStatus = stoppedPwaHostStatus();

export type PwaHostStatusListener = (status: PwaHostStatus) => void;

const listeners = new Set<PwaHostStatusListener>();

export function subscribePwaHostStatus(listener: PwaHostStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setPwaHostStatus(status: PwaHostStatus): void {
  currentStatus = status;
  // Snapshot first: a listener may unsubscribe during delivery. One throwing
  // subscriber must not stop the others from seeing the transition.
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch {
      // A display concern must never break the host lifecycle.
    }
  }
}

export function getPwaHostStatus(): PwaHostStatus {
  return currentStatus;
}

export function resetPwaHostStatus(): void {
  currentStatus = stoppedPwaHostStatus();
}
