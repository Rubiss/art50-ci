import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type NetworkPurpose = "browser" | "provenance";

export interface AddressRecord {
  address: string;
  family: 4 | 6;
}

export interface NetworkPolicy {
  maxRedirects: number;
  requestedPrivateOrigins: ReadonlySet<string>;
  trustedPrivateOrigins: ReadonlySet<string>;
}

export interface PinnedDestination {
  url: URL;
  origin: string;
  hostname: string;
  port: number;
  addresses: readonly AddressRecord[];
  selected: AddressRecord;
  privateAccess: boolean;
}

export type NetworkPolicyErrorCode =
  | "UNSUPPORTED_PROTOCOL"
  | "URL_CREDENTIALS_FORBIDDEN"
  | "DNS_LOOKUP_FAILED"
  | "NON_PUBLIC_DESTINATION"
  | "PRIVATE_ORIGIN_NOT_REQUESTED"
  | "PRIVATE_ORIGIN_NOT_TRUSTED"
  | "TOO_MANY_REDIRECTS";

export class NetworkPolicyError extends Error {
  readonly code: NetworkPolicyErrorCode;

  constructor(code: NetworkPolicyErrorCode, message: string) {
    super(message);
    this.name = "NetworkPolicyError";
    this.code = code;
  }
}

export type LookupAll = (hostname: string) => Promise<readonly AddressRecord[]>;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

const allowedProtocols: Readonly<Record<NetworkPurpose, ReadonlySet<string>>> = {
  browser: new Set(["http:", "https:", "ws:", "wss:"]),
  provenance: new Set(["http:", "https:"]),
};

export function normalizeHostname(value: string): string {
  const unbracketed =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const lowered = unbracketed.toLocaleLowerCase().replace(/\.+$/u, "");
  if (isIP(lowered) === 6) {
    const canonical = new URL(`http://[${lowered}]/`).hostname;
    return canonical.slice(1, -1);
  }
  if (isIP(lowered) === 4) {
    return new URL(`http://${lowered}/`).hostname;
  }
  return lowered;
}

function parseNetworkUrl(rawUrl: string, purpose: NetworkPurpose): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NetworkPolicyError(
      "UNSUPPORTED_PROTOCOL",
      "Network targets must be absolute HTTP(S) URLs.",
    );
  }
  if (!allowedProtocols[purpose].has(parsed.protocol)) {
    throw new NetworkPolicyError(
      "UNSUPPORTED_PROTOCOL",
      `Network protocol "${parsed.protocol}" is not allowed for ${purpose} checks.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new NetworkPolicyError(
      "URL_CREDENTIALS_FORBIDDEN",
      "URLs containing embedded credentials are not supported.",
    );
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new NetworkPolicyError(
      "DNS_LOOKUP_FAILED",
      "The network target has no hostname.",
    );
  }
  parsed.hostname = hostname;
  return parsed;
}

export function canonicalOrigin(value: string): string {
  const parsed = parseNetworkUrl(value, "browser");
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new NetworkPolicyError(
      "NON_PUBLIC_DESTINATION",
      "Private-origin grants must contain only a scheme, hostname, and optional port.",
    );
  }
  return parsed.origin;
}

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (address.includes("%")) {
    return false;
  }
  if (family === 4) {
    return isIP(address) === 4 && !blockedIpv4.check(address, "ipv4");
  }
  return (
    isIP(address) === 6 &&
    globalIpv6.check(address, "ipv6") &&
    !blockedIpv6.check(address, "ipv6")
  );
}

async function defaultLookupAll(
  hostname: string,
): Promise<readonly AddressRecord[]> {
  const records = await dnsLookup(hostname, {
    all: true,
    verbatim: true,
  });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

export function createNetworkPolicy(options?: {
  maxRedirects?: number;
  requestedPrivateOrigins?: readonly string[];
  trustedPrivateOrigins?: readonly string[];
  configuredTargets?: readonly string[];
}): NetworkPolicy {
  const requested = new Set<string>();
  const trusted = new Set<string>();

  for (const origin of options?.requestedPrivateOrigins ?? []) {
    requested.add(canonicalOrigin(origin));
  }
  for (const target of options?.configuredTargets ?? []) {
    try {
      requested.add(canonicalOrigin(new URL(target).origin));
    } catch {
      // Local files do not participate in the network-origin policy.
    }
  }
  for (const origin of options?.trustedPrivateOrigins ?? []) {
    trusted.add(canonicalOrigin(origin));
  }

  return {
    maxRedirects: options?.maxRedirects ?? 5,
    requestedPrivateOrigins: requested,
    trustedPrivateOrigins: trusted,
  };
}

export async function resolveAndAuthorize(
  rawUrl: string,
  purpose: NetworkPurpose,
  policy: NetworkPolicy,
  lookupAll: LookupAll = defaultLookupAll,
): Promise<PinnedDestination> {
  const url = parseNetworkUrl(rawUrl, purpose);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses: readonly AddressRecord[];

  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookupAll(hostname);
    } catch {
      throw new NetworkPolicyError(
        "DNS_LOOKUP_FAILED",
        `DNS lookup failed for ${url.origin}.`,
      );
    }
  }

  if (
    addresses.length === 0 ||
    addresses.some(
      (record) =>
        (record.family !== 4 && record.family !== 6) ||
        isIP(record.address) !== record.family,
    )
  ) {
    throw new NetworkPolicyError(
      "DNS_LOOKUP_FAILED",
      `DNS lookup returned no usable addresses for ${url.origin}.`,
    );
  }

  const publicStates = addresses.map((record) =>
    isPublicAddress(record.address, record.family),
  );
  if (publicStates.some(Boolean) && publicStates.some((state) => !state)) {
    throw new NetworkPolicyError(
      "NON_PUBLIC_DESTINATION",
      `${url.origin} resolved to a mixed public/private address set and was blocked.`,
    );
  }

  const privateAccess = publicStates.every((state) => !state);
  if (
    privateAccess &&
    !policy.requestedPrivateOrigins.has(url.origin)
  ) {
    throw new NetworkPolicyError(
      "PRIVATE_ORIGIN_NOT_REQUESTED",
      `${url.origin} is non-public and was not requested by the configuration.`,
    );
  }
  if (privateAccess && !policy.trustedPrivateOrigins.has(url.origin)) {
    throw new NetworkPolicyError(
      "PRIVATE_ORIGIN_NOT_TRUSTED",
      `${url.origin} is non-public. Re-run with --allow-private-origin ${url.origin} only if you trust that destination.`,
    );
  }

  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:" || url.protocol === "wss:"
      ? 443
      : 80;
  return {
    url,
    origin: url.origin,
    hostname,
    port,
    addresses,
    selected:
      addresses.find((record) => record.family === 4) ?? addresses[0]!,
    privateAccess,
  };
}
