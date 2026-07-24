import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, LocalSigner } from "@contentauth/c2pa-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateSourceManifestInDeliveredChain,
  runAudit,
} from "../src/audit.js";
import { parseConfigText } from "../src/config.js";
import { createNetworkPolicy } from "../src/network-policy.js";
import {
  collectManifestAncestryLabels,
  inspectProvenance,
} from "../src/provenance.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

let temporaryDirectory: string;
let assetServer: Server;
let assetOrigin: string;
let redirectDestinationServer: Server;
let redirectDestinationOrigin: string;
let blockedPathRequests = 0;
let redirectLoopRequests = 0;
let redirectDestinationRequests = 0;
let signedSourcePath: string;
let deliveredChainPath: string;
let tamperedSourcePath: string;
let decoySourcePath: string;

const digitalSourceType =
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tamperPngHeader(buffer: Buffer): Buffer {
  const tampered = Buffer.from(buffer);
  const firstChunkOffset = 8;
  const chunkLength = tampered.readUInt32BE(firstChunkOffset);
  const typeOffset = firstChunkOffset + 4;
  const dataOffset = typeOffset + 4;
  if (
    tampered.subarray(typeOffset, dataOffset).toString("ascii") !== "IHDR" ||
    chunkLength !== 13
  ) {
    throw new Error("Expected the signed test asset to begin with a PNG IHDR.");
  }
  tampered.writeUInt32BE(2, dataOffset);
  const crc = crc32(
    tampered.subarray(typeOffset, dataOffset + chunkLength),
  );
  tampered.writeUInt32BE(crc, dataOffset + chunkLength);
  return tampered;
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "art50-ci-provenance-"),
  );
  redirectDestinationServer = createServer((_request, response) => {
    redirectDestinationRequests += 1;
    response.writeHead(200, { "content-type": "image/png" });
    response.end(onePixelPng);
  });
  await new Promise<void>((resolve, reject) => {
    redirectDestinationServer.once("error", reject);
    redirectDestinationServer.listen(0, "127.0.0.1", resolve);
  });
  const redirectAddress = redirectDestinationServer.address() as AddressInfo;
  redirectDestinationOrigin = `http://127.0.0.1:${redirectAddress.port}`;

  assetServer = createServer((request, response) => {
    if (request.url === "/blocked.png") {
      blockedPathRequests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(onePixelPng);
      return;
    }
    if (request.url === "/redirect-private") {
      response.writeHead(302, {
        location: `${redirectDestinationOrigin}/asset.png`,
      });
      response.end();
      return;
    }
    if (request.url === "/redirect-loop") {
      redirectLoopRequests += 1;
      response.writeHead(302, { location: "/redirect-loop" });
      response.end();
      return;
    }
    if (request.url === "/large.png") {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(onePixelPng.length),
      });
      response.end(onePixelPng);
      return;
    }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(onePixelPng);
  });
  await new Promise<void>((resolve, reject) => {
    assetServer.once("error", reject);
    assetServer.listen(0, "127.0.0.1", resolve);
  });
  const address = assetServer.address() as AddressInfo;
  assetOrigin = `http://127.0.0.1:${address.port}`;

  const certificate = await readFile(
    path.join(testDirectory, "fixtures", "certs", "es256.pub"),
  );
  const privateKey = await readFile(
    path.join(testDirectory, "fixtures", "certs", "es256.pem"),
  );
  const signer = LocalSigner.newSigner(certificate, privateKey, "es256");
  const sourceBuilder = Builder.withJson({
    claim_generator_info: [
      { name: "art50-ci integration tests", version: "0.1.0" },
    ],
    title: "generated.png",
    format: "image/png",
    instance_id: "xmp:iid:art50-ci-source",
  });
  sourceBuilder.setIntent({ create: digitalSourceType });
  const sourceDestination = { buffer: null as Buffer | null };
  sourceBuilder.sign(
    signer,
    { buffer: onePixelPng, mimeType: "image/png" },
    sourceDestination,
  );
  if (!sourceDestination.buffer) {
    throw new Error("C2PA source fixture signing produced no bytes.");
  }

  const deliveryBuilder = Builder.withJson({
    claim_generator_info: [
      { name: "art50-ci integration tests", version: "0.1.0" },
    ],
    title: "delivered.png",
    format: "image/png",
    instance_id: "xmp:iid:art50-ci-delivered",
  });
  deliveryBuilder.setIntent("update");
  const deliveredDestination = { buffer: null as Buffer | null };
  deliveryBuilder.sign(
    signer,
    { buffer: sourceDestination.buffer, mimeType: "image/png" },
    deliveredDestination,
  );
  if (!deliveredDestination.buffer) {
    throw new Error("C2PA delivery fixture signing produced no bytes.");
  }

  const decoyBuilder = Builder.withJson({
    claim_generator_info: [
      { name: "art50-ci integration tests", version: "0.1.0" },
    ],
    title: "decoy.png",
    format: "image/png",
    instance_id: "xmp:iid:art50-ci-decoy",
  });
  decoyBuilder.addAssertion(
    "org.art50-ci.decoy",
    JSON.stringify({ digitalSourceType }),
    "Json",
  );
  decoyBuilder.addAssertion(
    "c2pa.actions",
    {
      actions: [
        {
          action: "c2pa.edited",
          description: `Untrusted prose containing ${digitalSourceType}`,
        },
      ],
    },
    "Cbor",
  );
  const decoyDestination = { buffer: null as Buffer | null };
  decoyBuilder.sign(
    signer,
    { buffer: onePixelPng, mimeType: "image/png" },
    decoyDestination,
  );
  if (!decoyDestination.buffer) {
    throw new Error("C2PA decoy fixture signing produced no bytes.");
  }

  signedSourcePath = path.join(temporaryDirectory, "signed-source.png");
  deliveredChainPath = path.join(temporaryDirectory, "delivered-chain.png");
  tamperedSourcePath = path.join(temporaryDirectory, "tampered-source.png");
  decoySourcePath = path.join(temporaryDirectory, "decoy-source.png");
  await Promise.all([
    writeFile(signedSourcePath, sourceDestination.buffer),
    writeFile(deliveredChainPath, deliveredDestination.buffer),
    writeFile(
      tamperedSourcePath,
      tamperPngHeader(sourceDestination.buffer),
    ),
    writeFile(decoySourcePath, decoyDestination.buffer),
  ]);
});

afterAll(async () => {
  await Promise.all(
    [assetServer, redirectDestinationServer].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  if (
    temporaryDirectory.startsWith(
      `${path.resolve(os.tmpdir())}${path.sep}`,
    )
  ) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("inspectProvenance", () => {
  const trustedPolicy = (maxRedirects = 5) =>
    createNetworkPolicy({
      configuredTargets: [assetOrigin],
      trustedPrivateOrigins: [assetOrigin],
      maxRedirects,
    });

  it("excludes unlinked manifest-store labels from recursive ancestry", () => {
    const activeLabel = "urn:c2pa:active";
    const intermediateLabel = "urn:c2pa:intermediate";
    const sourceLabel = "urn:c2pa:source";
    const unlinkedLabel = "urn:c2pa:unlinked";

    const ancestry = collectManifestAncestryLabels({
      active_manifest: activeLabel,
      manifests: {
        [activeLabel]: {
          ingredients: [{ active_manifest: intermediateLabel }],
        },
        [intermediateLabel]: {
          ingredients: [{ active_manifest: sourceLabel }],
        },
        [sourceLabel]: { ingredients: [] },
        [unlinkedLabel]: { ingredients: [] },
      },
    });

    expect(ancestry).toEqual(
      [activeLabel, intermediateLabel, sourceLabel].sort(),
    );
    expect(ancestry).not.toContain(unlinkedLabel);
  });

  it("rejects a source label that is present but unlinked in the delivered store", () => {
    const sourceLabel = "urn:c2pa:source";
    const deliveredActiveLabel = "urn:c2pa:delivered";
    const delivered = {
      manifestPresent: true,
      activeLabel: deliveredActiveLabel,
      manifestLabels: [deliveredActiveLabel, sourceLabel],
      manifestAncestryLabels: [deliveredActiveLabel],
    };

    expect(delivered.manifestLabels).toContain(sourceLabel);
    expect(
      evaluateSourceManifestInDeliveredChain(
        "unlinked-source",
        {
          manifestPresent: true,
          activeLabel: sourceLabel,
          manifestAncestryLabels: [sourceLabel],
        },
        delivered,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "SOURCE_MANIFEST_NOT_IN_DELIVERED_CHAIN",
        target: "comparison",
      }),
    ]);
  });

  it("fails closed when the source manifest has no active label", () => {
    expect(
      evaluateSourceManifestInDeliveredChain(
        "missing-source-label",
        {
          manifestPresent: true,
          activeLabel: null,
          manifestAncestryLabels: [],
        },
        {
          manifestPresent: true,
          activeLabel: "urn:c2pa:delivered",
          manifestAncestryLabels: ["urn:c2pa:delivered"],
        },
      ),
    ).toEqual([
      expect.objectContaining({
        code: "SOURCE_ACTIVE_MANIFEST_LABEL_MISSING",
        target: "comparison",
      }),
    ]);
  });

  it("hashes a local asset and records an absent C2PA manifest", async () => {
    const assetPath = path.join(temporaryDirectory, "plain.png");
    const evidenceDirectory = path.join(temporaryDirectory, "evidence");
    await writeFile(assetPath, onePixelPng);

    const result = await inspectProvenance({
      id: "plain-image",
      target: assetPath,
      baseDirectory: temporaryDirectory,
      evidenceDirectory,
    });

    expect(result).toMatchObject({
      id: "plain-image",
      sourceKind: "file",
      mimeType: "image/png",
      bytes: onePixelPng.length,
      c2pa: {
        manifestPresent: false,
        embedded: null,
        activeLabel: null,
      },
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.resultMeaning).toMatch(/not a legal compliance/i);
    await expect(access(result.evidencePath)).resolves.toBeUndefined();
  });

  it("writes immutable evidence paths for repeated observations", async () => {
    const assetPath = path.join(temporaryDirectory, "repeated.png");
    const evidenceDirectory = path.join(temporaryDirectory, "evidence");
    await writeFile(assetPath, onePixelPng);

    const first = await inspectProvenance({
      id: "repeated-image",
      target: assetPath,
      baseDirectory: temporaryDirectory,
      evidenceDirectory,
    });
    const second = await inspectProvenance({
      id: "repeated-image",
      target: assetPath,
      baseDirectory: temporaryDirectory,
      evidenceDirectory,
    });

    expect(first.evidencePath).not.toBe(second.evidencePath);
    await expect(access(first.evidencePath)).resolves.toBeUndefined();
    await expect(access(second.evidencePath)).resolves.toBeUndefined();
  });

  it.each([
    ["document", Buffer.from("%PDF-1.7\n"), "application/pdf"],
    [
      "wave",
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WAVE"),
      ]),
      "audio/wav",
    ],
    ["gif", Buffer.from("GIF89a"), "image/gif"],
    [
      "tiff",
      Buffer.from([0x49, 0x49, 0x2a, 0x00]),
      "image/tiff",
    ],
    [
      "avif",
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from("ftyp"),
        Buffer.from("avif"),
      ]),
      "image/avif",
    ],
  ])(
    "infers %s MIME type from an extensionless asset signature",
    async (name, contents, expectedMimeType) => {
      const assetPath = path.join(temporaryDirectory, name);
      await writeFile(assetPath, contents);

      const result = await inspectProvenance({
        id: `${name}-signature`,
        target: assetPath,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      });

      expect(result.mimeType).toBe(expectedMimeType);
    },
  );

  it("rejects unsupported target protocols before making a request", async () => {
    await expect(
      inspectProvenance({
        id: "bad-protocol",
        target: "ftp://example.com/image.png",
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      }),
    ).rejects.toThrow(/unsupported provenance target protocol/i);
  });

  it("enforces the configured local-file size limit", async () => {
    const assetPath = path.join(temporaryDirectory, "large.png");
    await writeFile(assetPath, onePixelPng);

    await expect(
      inspectProvenance({
        id: "too-large",
        target: assetPath,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
        maxBytes: 8,
      }),
    ).rejects.toThrow(/exceeds the 8-byte/i);
  });

  it("confines local provenance files to the configuration directory", async () => {
    const allowedDirectory = path.join(temporaryDirectory, "confined");
    const outsidePath = path.join(temporaryDirectory, "outside.png");
    await mkdir(allowedDirectory, { recursive: true });
    await writeFile(outsidePath, onePixelPng);

    await expect(
      inspectProvenance({
        id: "outside-root",
        target: outsidePath,
        baseDirectory: allowedDirectory,
        evidenceDirectory: path.join(allowedDirectory, "evidence"),
      }),
    ).rejects.toThrow(/inside the configuration directory/i);
  });

  it("downloads an HTTP asset without uploading its bytes elsewhere", async () => {
    const result = await inspectProvenance({
      id: "remote-image",
      target: `${assetOrigin}/plain.png`,
      baseDirectory: temporaryDirectory,
      evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      networkPolicy: trustedPolicy(),
    });

    expect(result).toMatchObject({
      sourceKind: "url",
      resolvedTarget: `${assetOrigin}/plain.png`,
      mimeType: "image/png",
      bytes: onePixelPng.length,
    });
  });

  it("pins hostname-based HTTP downloads on Node auto-family lookup", async () => {
    const hostnameOrigin = assetOrigin.replace("127.0.0.1", "localhost");
    const result = await inspectProvenance({
      id: "hostname-image",
      target: `${hostnameOrigin}/plain.png`,
      baseDirectory: temporaryDirectory,
      evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      networkPolicy: createNetworkPolicy({
        configuredTargets: [hostnameOrigin],
        trustedPrivateOrigins: [hostnameOrigin],
      }),
    });

    expect(result).toMatchObject({
      sourceKind: "url",
      mimeType: "image/png",
      bytes: onePixelPng.length,
    });
  });

  it("rejects a remote asset from Content-Length before reading its body", async () => {
    await expect(
      inspectProvenance({
        id: "remote-too-large",
        target: `${assetOrigin}/large.png`,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
        maxBytes: 8,
        networkPolicy: trustedPolicy(),
      }),
    ).rejects.toThrow(/exceeds the 8-byte/i);
  });

  it("blocks a private provenance target before contacting it by default", async () => {
    await expect(
      inspectProvenance({
        id: "blocked-private",
        target: `${assetOrigin}/blocked.png`,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      }),
    ).rejects.toMatchObject({
      code: "PRIVATE_ORIGIN_NOT_TRUSTED",
    });
    expect(blockedPathRequests).toBe(0);
  });

  it("reports a distinct provenance network-policy failure", async () => {
    const requestsBefore = blockedPathRequests;
    const config = parseConfigText(`
version: 1
project:
  name: blocked-provenance-network
provenance:
  - id: blocked-asset
    delivered: ${assetOrigin}/blocked.png
`);

    const report = await runAudit(config, {
      baseDirectory: temporaryDirectory,
      outputDirectory: path.join(temporaryDirectory, "blocked-network-audit"),
    });

    expect(report.provenance[0]?.failures).toEqual([
      expect.objectContaining({
        code: "PROVENANCE_NETWORK_BLOCKED",
      }),
    ]);
    expect(blockedPathRequests).toBe(requestsBefore);
  });

  it("revalidates private redirect destinations before connecting", async () => {
    await expect(
      inspectProvenance({
        id: "redirect-private",
        target: `${assetOrigin}/redirect-private`,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
        networkPolicy: trustedPolicy(),
      }),
    ).rejects.toMatchObject({
      code: "PRIVATE_ORIGIN_NOT_REQUESTED",
    });
    expect(redirectDestinationRequests).toBe(0);
  });

  it("enforces a total redirect limit", async () => {
    await expect(
      inspectProvenance({
        id: "redirect-loop",
        target: `${assetOrigin}/redirect-loop`,
        baseDirectory: temporaryDirectory,
        evidenceDirectory: path.join(temporaryDirectory, "evidence"),
        networkPolicy: trustedPolicy(1),
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
    expect(redirectLoopRequests).toBe(2);
  });

  it("does not persist signed query values or fragments in evidence", async () => {
    const result = await inspectProvenance({
      id: "signed-url",
      target: `${assetOrigin}/plain.png?signature=private-token#oauth-token`,
      baseDirectory: temporaryDirectory,
      evidenceDirectory: path.join(temporaryDirectory, "evidence"),
      networkPolicy: trustedPolicy(),
    });
    const evidence = await readFile(result.evidencePath, "utf8");

    expect(result.target).toBe(
      `${assetOrigin}/plain.png?__redacted__#__redacted__`,
    );
    expect(result.resolvedTarget).toBe(
      `${assetOrigin}/plain.png?__redacted__`,
    );
    expect(evidence).not.toContain("private-token");
    expect(evidence).not.toContain("oauth-token");
  });

  it("runs an asset-only audit and applies the declared manifest expectation", async () => {
    const assetPath = path.join(temporaryDirectory, "audit-plain.png");
    const outputDirectory = path.join(temporaryDirectory, "audit-output");
    await writeFile(assetPath, onePixelPng);
    const config = parseConfigText(`
version: 1
project:
  name: asset-only-audit
provenance:
  - id: delivered-image
    delivered: ${JSON.stringify(assetPath)}
    requireManifest: true
`);

    const report = await runAudit(config, {
      baseDirectory: temporaryDirectory,
      outputDirectory,
      mode: "audit",
    });

    expect(report.passed).toBe(false);
    expect(report.surfaces).toEqual([]);
    expect(report.summary).toMatchObject({
      totalProvenance: 1,
      failedProvenance: 1,
    });
    expect(report.provenance[0]?.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MANIFEST_MISSING",
          target: "delivered",
        }),
      ]),
    );
  });

  it("inspects a real embedded manifest and its active action source type", async () => {
    const result = await inspectProvenance({
      id: "signed-source",
      target: signedSourcePath,
      baseDirectory: temporaryDirectory,
      evidenceDirectory: path.join(temporaryDirectory, "evidence"),
    });

    expect(result.c2pa).toMatchObject({
      manifestPresent: true,
      embedded: true,
      digitalSourceTypes: [digitalSourceType],
    });
    expect(result.c2pa.activeLabel).toMatch(/^urn:c2pa:/);
    expect(result.c2pa.manifestLabels).toContain(result.c2pa.activeLabel);
    expect(result.c2pa.manifestAncestryLabels).toContain(
      result.c2pa.activeLabel,
    );
  });

  it("detects a tampered signed asset through C2PA validation", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: tampered-c2pa
provenance:
  - id: tampered-source
    delivered: ${JSON.stringify(tamperedSourcePath)}
    requireManifest: true
    requireEmbedded: true
    failOnInvalid: true
`);

    const report = await runAudit(config, {
      baseDirectory: temporaryDirectory,
      outputDirectory: path.join(temporaryDirectory, "tampered-audit"),
      mode: "audit",
    });

    expect(
      report.provenance[0]?.delivered?.c2pa.validationStatuses,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "assertion.dataHash.mismatch",
          success: false,
        }),
      ]),
    );
    expect(report.provenance[0]?.delivered?.c2pa).toMatchObject({
      manifestPresent: true,
      embedded: true,
      inspectionError: null,
    });
    expect(report.provenance[0]?.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MANIFEST_INVALID",
        }),
      ]),
    );
  });

  it("observes the source active label in a delivered manifest chain", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: c2pa-delivery-chain
provenance:
  - id: generated-image
    source: ${JSON.stringify(signedSourcePath)}
    delivered: ${JSON.stringify(deliveredChainPath)}
    requireManifest: true
    requireEmbedded: true
    requireSourceManifestInDeliveredChain: true
    failOnInvalid: true
`);

    const report = await runAudit(config, {
      baseDirectory: temporaryDirectory,
      outputDirectory: path.join(temporaryDirectory, "chain-audit"),
      mode: "audit",
    });

    expect(report.provenance[0]).toMatchObject({
      passed: true,
      activeLabelPreserved: true,
    });
    expect(report.provenance[0]?.delivered?.c2pa.manifestLabels).toContain(
      report.provenance[0]?.source?.c2pa.activeLabel,
    );
    expect(
      report.provenance[0]?.delivered?.c2pa.manifestAncestryLabels,
    ).toContain(report.provenance[0]?.source?.c2pa.activeLabel);
    expect(report.provenance[0]?.source?.c2pa.validationState).toBe("Valid");
    expect(report.provenance[0]?.delivered?.c2pa.validationState).toBe(
      "Valid",
    );
    expect(
      report.provenance[0]?.source?.c2pa.validationStatuses.some(
        (status) => status.success === false,
      ),
    ).toBe(false);
    expect(
      report.provenance[0]?.delivered?.c2pa.validationStatuses.some(
        (status) => status.success === false,
      ),
    ).toBe(false);
  });

  it("compares expected digital source type URIs exactly", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: exact-source-type
provenance:
  - id: generated-image
    delivered: ${JSON.stringify(signedSourcePath)}
    failOnInvalid: false
    expectedDigitalSourceType: ${digitalSourceType}-decoy
`);

    const report = await runAudit(config, {
      baseDirectory: temporaryDirectory,
      outputDirectory: path.join(temporaryDirectory, "source-type-audit"),
      mode: "audit",
    });

    expect(report.provenance[0]?.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DIGITAL_SOURCE_TYPE_NOT_OBSERVED",
        }),
      ]),
    );
  });

  it("ignores digital source type strings outside direct action fields", async () => {
    const result = await inspectProvenance({
      id: "source-type-decoy",
      target: decoySourcePath,
      baseDirectory: temporaryDirectory,
      evidenceDirectory: path.join(temporaryDirectory, "evidence"),
    });

    expect(result.c2pa.manifestPresent).toBe(true);
    expect(result.c2pa.digitalSourceTypes).toEqual([]);
  });
});
