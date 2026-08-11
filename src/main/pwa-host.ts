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

export interface PwaHostStatus {
  running: boolean;
  /** The preferred URL. Every candidate is listed in `addresses`. */
  url: string | null;
  addresses: PwaHostAddress[];
  subjectAltNames: string[];
  certificateSource: CertificateSource | null;
  error: string | null;
}

const IDLE_STATUS: PwaHostStatus = {
  running: false,
  url: null,
  addresses: [],
  subjectAltNames: [],
  certificateSource: null,
  error: null,
};

let currentStatus: PwaHostStatus = IDLE_STATUS;

export function setPwaHostStatus(status: PwaHostStatus): void {
  currentStatus = status;
}

export function getPwaHostStatus(): PwaHostStatus {
  return currentStatus;
}

export function resetPwaHostStatus(): void {
  currentStatus = IDLE_STATUS;
}
