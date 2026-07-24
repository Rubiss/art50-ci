import { describe, expect, it } from "vitest";
import {
  canonicalOrigin,
  createNetworkPolicy,
  isPublicAddress,
  resolveAndAuthorize,
  type LookupAll,
} from "../src/network-policy.js";

describe("network policy", () => {
  it("canonicalizes exact origins without broadening their scope", () => {
    expect(canonicalOrigin("HTTP://Example.COM.:80")).toBe(
      "http://example.com",
    );
    expect(canonicalOrigin("https://[2001:4860:4860::8888]:443")).toBe(
      "https://[2001:4860:4860::8888]",
    );
    expect(() => canonicalOrigin("https://example.com/private")).toThrow(
      /only a scheme, hostname, and optional port/i,
    );
    expect(() => canonicalOrigin("https://user:secret@example.com")).toThrow(
      /credentials/i,
    );
  });

  it.each([
    "http://127.0.0.1",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://192.168.1.1",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
  ])("denies a non-public literal without an explicit runtime grant: %s", async (url) => {
    const policy = createNetworkPolicy({ configuredTargets: [url] });
    await expect(
      resolveAndAuthorize(url, "browser", policy),
    ).rejects.toMatchObject({
      code: "PRIVATE_ORIGIN_NOT_TRUSTED",
    });
  });

  it("allows a private origin only with matching config request and CLI trust", async () => {
    const url = "http://127.0.0.1:4173/path";
    const policy = createNetworkPolicy({
      configuredTargets: [url],
      trustedPrivateOrigins: ["http://127.0.0.1:4173"],
    });
    await expect(resolveAndAuthorize(url, "browser", policy)).resolves.toMatchObject({
      origin: "http://127.0.0.1:4173",
      selected: { address: "127.0.0.1", family: 4 },
      privateAccess: true,
    });
  });

  it("rejects a mixed public and private DNS answer", async () => {
    const lookup: LookupAll = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      resolveAndAuthorize(
        "https://example.com",
        "provenance",
        createNetworkPolicy(),
        lookup,
      ),
    ).rejects.toMatchObject({
      code: "NON_PUBLIC_DESTINATION",
    });
  });

  it("returns the vetted public address for the connector to pin", async () => {
    const lookup: LookupAll = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    await expect(
      resolveAndAuthorize(
        "https://example.com/asset.png",
        "provenance",
        createNetworkPolicy(),
        lookup,
      ),
    ).resolves.toMatchObject({
      hostname: "example.com",
      selected: { address: "93.184.216.34", family: 4 },
      privateAccess: false,
    });
  });

  it("classifies representative public and special-purpose addresses", () => {
    expect(isPublicAddress("8.8.8.8", 4)).toBe(true);
    expect(isPublicAddress("192.0.2.1", 4)).toBe(false);
    expect(isPublicAddress("2001:4860:4860::8888", 6)).toBe(true);
    expect(isPublicAddress("2001:db8::1", 6)).toBe(false);
    expect(isPublicAddress("64:ff9b::7f00:1", 6)).toBe(false);
    expect(isPublicAddress("2002:7f00:1::", 6)).toBe(false);
  });
});
