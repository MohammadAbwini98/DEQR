import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PWA_CONTENT_SECURITY_POLICY,
  PWA_HOST_HEALTH_BODY,
  contentTypeFor,
  failedPwaHostStatus,
  handlePwaRequest,
  isHealthProbe,
  getPwaHostStatus,
  resetPwaHostStatus,
  resolveRequestedFile,
  runningPwaHostStatus,
  setPwaHostStatus,
  startingPwaHostStatus,
  stoppedPwaHostStatus,
  stoppingPwaHostStatus,
  subscribePwaHostStatus,
} from '../../src/main/pwa-host';
import { classifyAddress, collectLanAddresses } from '../../src/main/lan-addresses';
import { evaluateStoredCertificate, parseSubjectAltNames } from '../../src/main/pwa-certificate';
import type { PwaHostStatusView } from '../../src/shared/types';

const ROOT = path.resolve('C:\\deqr\\dist\\pwa');

describe('PWA host request resolution', () => {
  it.each([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/assets/app.js', path.join('assets', 'app.js')],
    ['/icons/deqr-192.png', path.join('icons', 'deqr-192.png')],
    ['/sw.js', 'sw.js'],
    ['/manifest.webmanifest', 'manifest.webmanifest'],
    // Query strings and fragments must not affect the resolved file.
    ['/assets/app.js?v=2', path.join('assets', 'app.js')],
  ])('maps %s inside the served directory', (requestUrl, expectedRelative) => {
    expect(resolveRequestedFile(ROOT, requestUrl)).toBe(path.join(ROOT, expectedRelative));
  });

  // The invariant that matters is containment. A request whose traversal the URL
  // parser already collapses (`/../x` becomes `/x`) is safe to serve; one that
  // would still reach outside the directory must resolve to null.
  it.each([
    ['parent traversal', '/../secret.txt'],
    ['nested traversal', '/assets/../../secret.txt'],
    ['encoded traversal', '/%2e%2e/secret.txt'],
    ['double encoded traversal', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt'],
    ['encoded backslash traversal', '/..%5c..%5csecret.txt'],
    ['absolute windows path', '/C:/Windows/System32/drivers/etc/hosts'],
    ['unc-style path', '//evil.example/share/secret.txt'],
    ['dot padded segments', '/....//....//secret.txt'],
    ['null byte', '/index.html%00.png'],
    ['malformed percent escape', '/%zz'],
  ])('never escapes the served directory for %s', (_label, requestUrl) => {
    const resolved = resolveRequestedFile(ROOT, requestUrl);
    if (resolved === null) return;
    expect(resolved === ROOT || resolved.startsWith(ROOT + path.sep)).toBe(true);
    expect(resolved).not.toContain('\0');
  });

  it.each([
    ['percent-encoded traversal separators', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt'],
    ['percent-encoded backslashes', '/..%5c..%5csecret.txt'],
    ['a drive-qualified absolute path', '/C:/Windows/System32/drivers/etc/hosts'],
    ['an embedded null byte', '/index.html%00.png'],
    ['an undecodable escape', '/%zz'],
  ])('rejects %s outright', (_label, requestUrl) => {
    expect(resolveRequestedFile(ROOT, requestUrl)).toBeNull();
  });

  it('never escapes the served directory at any traversal depth', () => {
    for (let depth = 1; depth <= 8; depth += 1) {
      for (const template of ['../', '%2e%2e/', '..%2f', '..%5c']) {
        const resolved = resolveRequestedFile(ROOT, `/${template.repeat(depth)}secret.txt`);
        expect(resolved === null || resolved === ROOT || resolved.startsWith(ROOT + path.sep)).toBe(
          true,
        );
      }
    }
  });
});

describe('PWA host content types', () => {
  it.each([
    ['/a/index.html', 'text/html; charset=utf-8'],
    ['/a/app.js', 'text/javascript; charset=utf-8'],
    ['/a/app.css', 'text/css; charset=utf-8'],
    ['/a/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/a/icon.png', 'image/png'],
    ['/a/logo.svg', 'image/svg+xml'],
  ])('types %s', (filePath, expected) => {
    expect(contentTypeFor(filePath)).toBe(expected);
  });

  it('falls back to an opaque type rather than guessing', () => {
    expect(contentTypeFor('/a/payload.unknown')).toBe('application/octet-stream');
  });
});

describe('PWA host security policy', () => {
  it('serves the same policy the PWA declares in its meta tag', async () => {
    const html = await readFile(path.resolve('mobile-web/index.html'), 'utf8');
    const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);

    expect(match, 'the PWA must keep a reviewable meta CSP').not.toBeNull();
    expect(PWA_CONTENT_SECURITY_POLICY).toBe(match![1]);
  });

  it('forbids framing, which a meta tag cannot enforce', () => {
    expect(PWA_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(PWA_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(PWA_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(PWA_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(PWA_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });
});

describe('PWA host health probe', () => {
  const respond = async (url: string, method = 'GET') => {
    const written: { status?: number; headers?: Record<string, string> } = {};
    let body: unknown;
    const response = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string>) {
        written.status = status;
        written.headers = headers;
        this.headersSent = true;
      },
      end(chunk?: unknown) { body = chunk; },
    };
    await handlePwaRequest(ROOT, { method, url } as never, response as never);
    return { ...written, body };
  };

  it.each(['/health', '/health?t=1', '/%68ealth'])('answers %s with the constant marker', async (url) => {
    expect(isHealthProbe(url)).toBe(true);

    const result = await respond(url);
    expect(result.status).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('application/json; charset=utf-8');
    expect(String(result.body)).toBe(PWA_HOST_HEALTH_BODY);
    expect(JSON.parse(String(result.body))).toEqual({ service: 'deqr-pwa-host', status: 'ok' });
  });

  it('forbids caching, so a stopped receiver can never look reachable', async () => {
    const result = await respond('/health');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
  });

  it('carries the same security headers as every other response', async () => {
    const result = await respond('/health');
    expect(result.headers?.['Content-Security-Policy']).toBe(PWA_CONTENT_SECURITY_POLICY);
    expect(result.headers?.['X-Content-Type-Options']).toBe('nosniff');
    expect(result.headers?.['Referrer-Policy']).toBe('no-referrer');
  });

  it('publishes no address, interface, certificate, or transfer detail', () => {
    // A reachability probe answers one question. Anything else here would be
    // new disclosure on an interface reachable by the whole local network.
    expect(PWA_HOST_HEALTH_BODY.length).toBeLessThan(80);
    expect(PWA_HOST_HEALTH_BODY).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    // `deqr-pwa-host` is the fixed service name and identifies nothing.
    for (const term of ['cert', 'key', 'san', 'path', 'user', 'session', 'file', 'port', 'version', 'hostname']) {
      expect(PWA_HOST_HEALTH_BODY.toLowerCase()).not.toContain(term);
    }
  });

  it('answers HEAD without a body and refuses a write method', async () => {
    const head = await respond('/health', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();

    const post = await respond('/health', 'POST');
    expect(post.status).toBe(405);
  });

  it('is not shadowed by, and does not shadow, the single-page fallback', async () => {
    expect(isHealthProbe('/healthz')).toBe(false);
    expect(isHealthProbe('/health/sub')).toBe(false);
    expect(isHealthProbe('/HEALTH')).toBe(false);
    expect(isHealthProbe('/api/health')).toBe(false);
    // Without the early return these would resolve to a file under the served
    // directory and answer 200 with the HTML shell.
    expect(resolveRequestedFile(ROOT, '/health')).toBe(path.join(ROOT, 'health'));
  });
});

describe('LAN address selection', () => {
  // A mesh-VPN address reaches an enrolled phone from any network and does not
  // depend on an inbound firewall rule for the physical adapter, which is often
  // on the Public profile. It is therefore the stronger default.
  it('prefers a mesh-VPN address over an ordinary LAN address', () => {
    const addresses = collectLanAddresses({
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      Ethernet: [{ address: '192.168.100.41', family: 'IPv4', internal: false } as never],
      Unplugged: [{ address: '169.254.10.2', family: 'IPv4', internal: false } as never],
      Tailscale: [
        { address: '100.95.40.3', family: 'IPv4', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
    });

    expect(addresses.map((entry) => entry.address)).toEqual(['100.95.40.3', '192.168.100.41']);
    expect(addresses[0].kind).toBe('overlay');
    expect(addresses[1].kind).toBe('private');
  });

  it('still offers the LAN address when no mesh VPN is present', () => {
    const addresses = collectLanAddresses({
      WiFi: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as never],
    });

    expect(addresses.map((entry) => entry.address)).toEqual(['192.168.1.42']);
    expect(addresses[0].kind).toBe('private');
  });

  it.each([
    ['100.64.0.1', 'overlay'],
    ['100.127.255.254', 'overlay'],
    // 100.x outside 100.64.0.0/10 is ordinary public space, not a tailnet.
    ['100.63.0.1', 'other'],
    ['100.128.0.1', 'other'],
    ['192.168.0.5', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.9', 'private'],
    ['172.32.0.9', 'other'],
    ['203.0.113.7', 'other'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('returns nothing when only internal interfaces exist', () => {
    expect(
      collectLanAddresses({
        Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      }),
    ).toEqual([]);
  });
});

describe('stored certificate reuse', () => {
  it('parses Node subject alternative name strings', () => {
    expect(parseSubjectAltNames('DNS:localhost, IP Address:192.168.1.42')).toEqual([
      'localhost',
      '192.168.1.42',
    ]);
    expect(parseSubjectAltNames(undefined)).toEqual([]);
  });

  it('rejects an unreadable certificate rather than trusting it', () => {
    const result = evaluateStoredCertificate('not a certificate', ['192.168.1.42']);
    expect(result.usable).toBe(false);
    expect(result.reason).toBe('unreadable');
  });
});

describe('PWA host status store', () => {
  beforeEach(() => {
    resetPwaHostStatus();
  });

  it('starts stopped, which is the launch default rather than a failure', () => {
    const status = getPwaHostStatus();

    expect(status.state).toBe('stopped');
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
    expect(status.url).toBeNull();
  });

  it('keeps running equal to the running state in every factory', () => {
    const running = runningPwaHostStatus({
      url: 'https://192.168.1.20:5174/',
      addresses: [],
      subjectAltNames: [],
      certificateSource: 'stored',
    });

    for (const status of [
      stoppedPwaHostStatus(),
      startingPwaHostStatus(),
      stoppingPwaHostStatus(running),
      running,
      failedPwaHostStatus('nope'),
    ]) {
      expect(status.running).toBe(status.state === 'running');
    }
  });

  it('clears the published details when it goes back to stopped', () => {
    setPwaHostStatus(
      runningPwaHostStatus({
        url: 'https://192.168.1.20:5174/',
        addresses: [
          { address: '192.168.1.20', interfaceName: 'Wi-Fi', kind: 'private', url: 'https://192.168.1.20:5174/' },
        ],
        subjectAltNames: ['192.168.1.20'],
        certificateSource: 'stored',
      }),
    );
    setPwaHostStatus(stoppedPwaHostStatus());

    expect(getPwaHostStatus().url).toBeNull();
    expect(getPwaHostStatus().addresses).toEqual([]);
  });

  it('delivers transitions to subscribers until they unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribePwaHostStatus((status) => seen.push(status.state));

    setPwaHostStatus(startingPwaHostStatus());
    unsubscribe();
    setPwaHostStatus(stoppedPwaHostStatus());

    expect(seen).toEqual(['starting']);
  });

  it('stores the status even when a subscriber throws', () => {
    const unsubscribe = subscribePwaHostStatus(() => {
      throw new Error('a display concern');
    });

    expect(() => setPwaHostStatus(startingPwaHostStatus())).not.toThrow();
    expect(getPwaHostStatus().state).toBe('starting');
    unsubscribe();
  });

  it('stays assignable to the renderer view type', () => {
    // Compile-time guard: the main and renderer shapes are deliberate
    // duplicates, so drift between them must fail the typecheck.
    const view: PwaHostStatusView = getPwaHostStatus();
    expect(view.state).toBe('stopped');
  });
});
