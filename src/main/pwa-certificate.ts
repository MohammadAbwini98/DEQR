import { X509Certificate } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { generate } from 'selfsigned';

export const CERTIFICATE_FILE = 'deqr-pwa-host.pem';
export const PRIVATE_KEY_FILE = 'deqr-pwa-host-key.pem';

/**
 * Safari rejects TLS certificates with a lifetime longer than 398 days, and the
 * host certificate is its own root here, so it must stay under that ceiling.
 */
const VALIDITY_DAYS = 397;

/** Re-issue before expiry so a long-running install never serves a dead cert. */
const RENEW_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

export type CertificateSource = 'environment' | 'stored' | 'generated';

export interface PwaCertificate {
  certificate: string;
  privateKey: string;
  subjectAltNames: string[];
  source: CertificateSource;
}

/**
 * Parses the `subjectAltName` string Node exposes, e.g.
 * `DNS:localhost, IP Address:192.168.1.5`.
 */
export function parseSubjectAltNames(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => {
      const separator = entry.indexOf(':');
      return separator === -1 ? entry : entry.slice(separator + 1).trim();
    })
    .filter((entry) => entry.length > 0);
}

export interface CertificateSuitability {
  usable: boolean;
  subjectAltNames: string[];
  reason?: string;
}

/**
 * A stored certificate is reused only when it is currently valid, is not about
 * to expire, and already covers every address we intend to advertise. Reuse
 * matters because each new certificate forces the user to trust a new profile
 * on the iPhone.
 */
export function evaluateStoredCertificate(
  certificatePem: string,
  requiredAddresses: string[],
  now: number = Date.now(),
): CertificateSuitability {
  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificatePem);
  } catch {
    return { usable: false, subjectAltNames: [], reason: 'unreadable' };
  }

  const subjectAltNames = parseSubjectAltNames(parsed.subjectAltName);
  const validTo = Date.parse(parsed.validTo);
  const validFrom = Date.parse(parsed.validFrom);

  if (Number.isFinite(validFrom) && now < validFrom) {
    return { usable: false, subjectAltNames, reason: 'not-yet-valid' };
  }
  if (!Number.isFinite(validTo) || validTo - now <= RENEW_WITHIN_MS) {
    return { usable: false, subjectAltNames, reason: 'expired-or-expiring' };
  }

  const missing = requiredAddresses.filter((address) => !subjectAltNames.includes(address));
  if (missing.length > 0) {
    return { usable: false, subjectAltNames, reason: 'address-not-covered' };
  }

  return { usable: true, subjectAltNames };
}

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function createCertificate(addresses: string[]): PwaCertificate {
  // type 2 = DNS name, type 7 = IP address.
  const altNames: Array<Record<string, unknown>> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...addresses.map((address) => ({ type: 7, ip: address })),
  ];

  const pems = generate([{ name: 'commonName', value: addresses[0] ?? 'localhost' }], {
    days: VALIDITY_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  return {
    certificate: pems.cert,
    privateKey: pems.private,
    subjectAltNames: parseSubjectAltNames(new X509Certificate(pems.cert).subjectAltName),
    source: 'generated',
  };
}

export interface ResolveCertificateOptions {
  storageDirectory: string;
  addresses: string[];
  environment?: NodeJS.ProcessEnv;
}

/**
 * Resolves the TLS material for the PWA host.
 *
 * Order: an explicit `DEQR_HTTPS_CERT`/`DEQR_HTTPS_KEY` pair, then a previously
 * generated certificate that still covers the current addresses, then a freshly
 * generated one persisted for next time.
 */
export function resolvePwaCertificate(options: ResolveCertificateOptions): PwaCertificate {
  const environment = options.environment ?? process.env;
  const certificatePath = environment.DEQR_HTTPS_CERT;
  const privateKeyPath = environment.DEQR_HTTPS_KEY;

  if (certificatePath && privateKeyPath) {
    const certificate = fs.readFileSync(certificatePath, 'utf8');
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    let subjectAltNames: string[] = [];
    try {
      subjectAltNames = parseSubjectAltNames(new X509Certificate(certificate).subjectAltName);
    } catch {
      subjectAltNames = [];
    }
    return { certificate, privateKey, subjectAltNames, source: 'environment' };
  }
  if (Boolean(certificatePath) !== Boolean(privateKeyPath)) {
    throw new Error('Set both DEQR_HTTPS_CERT and DEQR_HTTPS_KEY, or neither.');
  }

  const storedCertificatePath = path.join(options.storageDirectory, CERTIFICATE_FILE);
  const storedKeyPath = path.join(options.storageDirectory, PRIVATE_KEY_FILE);
  const storedCertificate = readIfPresent(storedCertificatePath);
  const storedKey = readIfPresent(storedKeyPath);

  if (storedCertificate && storedKey) {
    const suitability = evaluateStoredCertificate(storedCertificate, options.addresses);
    if (suitability.usable) {
      return {
        certificate: storedCertificate,
        privateKey: storedKey,
        subjectAltNames: suitability.subjectAltNames,
        source: 'stored',
      };
    }
  }

  const created = createCertificate(options.addresses);
  fs.mkdirSync(options.storageDirectory, { recursive: true });
  // The private key must not be world-readable; it authenticates this host to
  // every phone that has trusted it.
  fs.writeFileSync(storedKeyPath, created.privateKey, { mode: 0o600 });
  fs.writeFileSync(storedCertificatePath, created.certificate, { mode: 0o644 });
  return created;
}
