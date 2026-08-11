import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PWA_CONTENT_SECURITY_POLICY,
  contentTypeFor,
  resolveRequestedFile,
} from '../../src/main/pwa-host';
import { classifyAddress, collectLanAddresses } from '../../src/main/lan-addresses';
import { evaluateStoredCertificate, parseSubjectAltNames } from '../../src/main/pwa-certificate';

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
