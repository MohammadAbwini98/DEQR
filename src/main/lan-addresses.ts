import * as os from 'os';

export type LanAddressKind = 'overlay' | 'private' | 'other';

export interface LanAddress {
  address: string;
  interfaceName: string;
  kind: LanAddressKind;
}

/**
 * 100.64.0.0/10 is the shared address space used by mesh VPNs such as Tailscale.
 */
function isOverlayAddress(address: string): boolean {
  const match = /^100\.(\d+)\./.exec(address);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 64 && secondOctet <= 127;
}

function isPrivateLanAddress(address: string): boolean {
  if (address.startsWith('192.168.') || address.startsWith('10.')) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

export function classifyAddress(address: string): LanAddressKind {
  if (isOverlayAddress(address)) return 'overlay';
  if (isPrivateLanAddress(address)) return 'private';
  return 'other';
}

/**
 * Ranks candidate host addresses by how likely a phone is to actually reach
 * them.
 *
 * Mesh-VPN addresses come first on purpose. A phone enrolled in the same tailnet
 * reaches the host whatever network it is on, and that traffic does not depend
 * on an inbound Windows Firewall rule for the physical adapter — which is
 * frequently on the Public profile and blocks inbound connections by default.
 * An ordinary LAN address only works when the phone is on that same subnet and
 * the firewall permits the port, so it is the weaker default even though it
 * looks like the obvious choice.
 */
const KIND_RANK: Record<LanAddressKind, number> = {
  overlay: 0,
  private: 1,
  other: 2,
};

function normalizeFamily(family: string | number): string {
  if (typeof family === 'number') {
    return family === 4 ? 'IPv4' : 'IPv6';
  }
  return family;
}

/**
 * Collects the non-loopback IPv4 addresses this machine can advertise to a
 * phone. Link-local 169.254/16 addresses are excluded: they only appear when
 * DHCP failed and are never usable for this workflow.
 */
export function collectLanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanAddress[] {
  const found: LanAddress[] = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (normalizeFamily(entry.family) !== 'IPv4') continue;
      if (entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      if (found.some((candidate) => candidate.address === entry.address)) continue;
      found.push({
        address: entry.address,
        interfaceName,
        kind: classifyAddress(entry.address),
      });
    }
  }

  return found.sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.address.localeCompare(b.address),
  );
}
