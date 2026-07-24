import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVerifySettings,
  isActionsAssertion,
  Reader,
  settingsToJson,
} from "@contentauth/c2pa-node";
import {
  createNetworkPolicy,
  NetworkPolicyError,
  resolveAndAuthorize,
  type NetworkPolicy,
} from "./network-policy.js";
import { redactUrlForReport, redactUrlsInText } from "./redact.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};

export interface InspectProvenanceOptions {
  id: string;
  target: string;
  baseDirectory: string;
  evidenceDirectory: string;
  maxBytes?: number;
  timeoutMs?: number;
  networkPolicy?: NetworkPolicy;
}

export interface ValidationStatusSummary {
  code: string;
  success: boolean | null;
  explanation: string | null;
}

export interface ProvenanceInspectionResult {
  schemaVersion: 1;
  id: string;
  target: string;
  resolvedTarget: string;
  sourceKind: "file" | "url";
  observedAt: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  evidencePath: string;
  c2pa: {
    manifestPresent: boolean;
    embedded: boolean | null;
    activeLabel: string | null;
    manifestLabels: string[];
    manifestAncestryLabels: string[];
    validationState: string | null;
    validationStatuses: ValidationStatusSummary[];
    digitalSourceTypes: string[];
    inspectionError: string | null;
  };
  resultMeaning: string;
}

interface LoadedAsset {
  buffer: Buffer;
  resolvedTarget: string;
  sourceKind: "file" | "url";
  mimeType: string;
}

function safeIdentifier(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "asset";
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function inferMimeType(
  target: string,
  declaredType: string | null,
  buffer: Buffer,
): string {
  const normalizedDeclaredType = declaredType
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase();
  if (
    normalizedDeclaredType &&
    normalizedDeclaredType !== "application/octet-stream"
  ) {
    return normalizedDeclaredType;
  }

  let pathname = target;
  try {
    pathname = new URL(target).pathname;
  } catch {
    // Local path.
  }
  const extensionType = MIME_BY_EXTENSION[path.extname(pathname).toLowerCase()];
  if (extensionType) {
    return extensionType;
  }
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return "image/tiff";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") {
    return "audio/mpeg";
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    (buffer[1]! & 0xe0) === 0xe0
  ) {
    return "audio/mpeg";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
    if (
      ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(
        brand,
      )
    ) {
      return "image/heif";
    }
    if (brand === "m4a " || brand === "m4b ") {
      return "audio/mp4";
    }
    if (brand === "qt  ") {
      return "video/quicktime";
    }
    return "video/mp4";
  }
  return "application/octet-stream";
}

async function readLocalAsset(
  target: string,
  baseDirectory: string,
  maxBytes: number,
): Promise<LoadedAsset> {
  let filePath: string;
  if (target.startsWith("file:")) {
    filePath = fileURLToPath(new URL(target));
  } else {
    filePath = path.resolve(baseDirectory, target);
  }
  const [allowedRoot, resolvedFilePath] = await Promise.all([
    realpath(baseDirectory),
    realpath(filePath),
  ]);
  const relative = path.relative(allowedRoot, resolvedFilePath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Provenance files must stay inside the configuration directory.",
    );
  }
  const metadata = await stat(resolvedFilePath);
  if (!metadata.isFile()) {
    throw new Error("The provenance target is not a regular file.");
  }
  if (metadata.size > maxBytes) {
    throw new Error(
      `Asset exceeds the ${maxBytes}-byte provenance inspection limit.`,
    );
  }
  const buffer = await readFile(resolvedFilePath);
  return {
    buffer,
    resolvedTarget: resolvedFilePath,
    sourceKind: "file",
    mimeType: inferMimeType(resolvedFilePath, null, buffer),
  };
}

async function readRemoteAsset(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  networkPolicy: NetworkPolicy,
): Promise<LoadedAsset> {
  if (url.username || url.password) {
    throw new Error("Asset URLs containing embedded credentials are not supported.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = new URL(url);
    currentUrl.hash = "";
    let response: IncomingMessage | null = null;
    for (let redirects = 0; ; redirects += 1) {
      const destination = await resolveAndAuthorize(
        currentUrl.toString(),
        "provenance",
        networkPolicy,
      );
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const pinnedLookup: LookupFunction = (
          _hostname,
          options,
          callback,
        ) => {
          if (options.all) {
            callback(null, [destination.selected]);
            return;
          }
          callback(
            null,
            destination.selected.address,
            destination.selected.family,
          );
        };
        const request = (
          destination.url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          destination.url,
          {
            signal: controller.signal,
            lookup: pinnedLookup,
            headers: {
              accept:
                "image/*,audio/*,video/*,application/pdf,application/octet-stream;q=0.5",
              "accept-encoding": "identity",
              "user-agent": "art50-ci provenance inspector",
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end();
      });

      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) {
          throw new Error(`Asset redirect HTTP ${status} had no Location header.`);
        }
        if (redirects >= networkPolicy.maxRedirects) {
          throw new NetworkPolicyError(
            "TOO_MANY_REDIRECTS",
            `Asset request exceeded ${networkPolicy.maxRedirects} redirects.`,
          );
        }
        currentUrl = new URL(location, currentUrl);
        currentUrl.hash = "";
        continue;
      }
      break;
    }

    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(
        `Asset request returned HTTP ${status} ${response.statusMessage ?? ""}.`.trim(),
      );
    }
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy();
      throw new Error(
        `Asset exceeds the ${maxBytes}-byte provenance inspection limit.`,
      );
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of response) {
      const bufferChunk = Buffer.from(value as Buffer);
      bytes += bufferChunk.length;
      if (bytes > maxBytes) {
        response.destroy();
        throw new Error(
          `Asset exceeds the ${maxBytes}-byte provenance inspection limit.`,
        );
      }
      chunks.push(bufferChunk);
    }
    const buffer = Buffer.concat(chunks);
    return {
      buffer,
      resolvedTarget: currentUrl.toString(),
      sourceKind: "url",
      mimeType: inferMimeType(
        currentUrl.toString(),
        Array.isArray(response.headers["content-type"])
          ? response.headers["content-type"][0] ?? null
          : response.headers["content-type"] ?? null,
        buffer,
      ),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || controller.signal.aborted)
    ) {
      throw new Error(`Asset request exceeded the ${timeoutMs} ms timeout.`);
    }
    if (error instanceof NetworkPolicyError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new Error(redactUrlsInText(error.message));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loadAsset(
  target: string,
  baseDirectory: string,
  maxBytes: number,
  timeoutMs: number,
  networkPolicy: NetworkPolicy,
): Promise<LoadedAsset> {
  const looksLikeWindowsPath =
    /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\");
  if (!looksLikeWindowsPath) {
    try {
      const url = new URL(target);
      if (url.protocol === "file:") {
        return readLocalAsset(target, baseDirectory, maxBytes);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
          `Unsupported provenance target protocol "${url.protocol}". Use a local file, HTTP, or HTTPS.`,
        );
      }
      return readRemoteAsset(url, maxBytes, timeoutMs, networkPolicy);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unsupported provenance target protocol")
      ) {
        throw error;
      }
      if (
        error instanceof TypeError &&
        error.message.toLocaleLowerCase().includes("invalid url")
      ) {
        return readLocalAsset(target, baseDirectory, maxBytes);
      }
      throw error;
    }
  }
  return readLocalAsset(target, baseDirectory, maxBytes);
}

function collectDigitalSourceTypes(activeManifest: unknown): string[] {
  const found = new Set<string>();

  if (
    !activeManifest ||
    typeof activeManifest !== "object" ||
    !("assertions" in activeManifest) ||
    !Array.isArray(activeManifest.assertions)
  ) {
    return [];
  }

  for (const assertion of activeManifest.assertions) {
    if (!isActionsAssertion(assertion)) {
      continue;
    }
    for (const action of assertion.data.actions) {
      const digitalSourceType = (
        action as { digitalSourceType?: unknown }
      ).digitalSourceType;
      if (typeof digitalSourceType === "string" && digitalSourceType.length > 0) {
        found.add(digitalSourceType);
      }
    }
  }

  return [...found].sort();
}

export function collectManifestAncestryLabels(store: unknown): string[] {
  if (!store || typeof store !== "object") {
    return [];
  }

  const activeLabel =
    "active_manifest" in store ? store.active_manifest : undefined;
  const manifests = "manifests" in store ? store.manifests : undefined;
  if (
    typeof activeLabel !== "string" ||
    activeLabel.length === 0 ||
    !manifests ||
    typeof manifests !== "object" ||
    Array.isArray(manifests)
  ) {
    return [];
  }

  const manifestByLabel = manifests as Record<string, unknown>;
  const ancestry = new Set<string>();
  const pending = [activeLabel];

  while (pending.length > 0) {
    const label = pending.pop();
    if (
      !label ||
      ancestry.has(label) ||
      !Object.hasOwn(manifestByLabel, label)
    ) {
      continue;
    }

    const manifest = manifestByLabel[label];
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      continue;
    }

    ancestry.add(label);
    const ingredients =
      "ingredients" in manifest ? manifest.ingredients : undefined;
    if (!Array.isArray(ingredients)) {
      continue;
    }

    for (const ingredient of ingredients) {
      if (
        !ingredient ||
        typeof ingredient !== "object" ||
        Array.isArray(ingredient) ||
        !("active_manifest" in ingredient) ||
        typeof ingredient.active_manifest !== "string" ||
        ingredient.active_manifest.length === 0
      ) {
        continue;
      }
      pending.push(ingredient.active_manifest);
    }
  }

  return [...ancestry].sort();
}

export async function inspectProvenance(
  options: InspectProvenanceOptions,
): Promise<ProvenanceInspectionResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive safe integer.");
  }

  const loaded = await loadAsset(
    options.target,
    options.baseDirectory,
    maxBytes,
    timeoutMs,
    options.networkPolicy ??
      createNetworkPolicy({ configuredTargets: [options.target] }),
  );
  const observedAt = new Date().toISOString();
  let manifestPresent = false;
  let embedded: boolean | null = null;
  let activeLabel: string | null = null;
  let manifestLabels: string[] = [];
  let manifestAncestryLabels: string[] = [];
  let validationState: string | null = null;
  let validationStatuses: ValidationStatusSummary[] = [];
  let digitalSourceTypes: string[] = [];
  let inspectionError: string | null = null;

  try {
    const reader = await Reader.fromAsset(
      {
        buffer: loaded.buffer,
        mimeType: loaded.mimeType,
      },
      settingsToJson(
        createVerifySettings({
          verifyAfterReading: true,
          verifyTrust: false,
          verifyTimestampTrust: false,
          ocspFetch: false,
          remoteManifestFetch: false,
        }),
      ),
    );
    if (reader) {
      const store = reader.json();
      manifestPresent = true;
      embedded = reader.isEmbedded();
      activeLabel = reader.activeLabel() ?? null;
      manifestLabels = Object.keys(store.manifests ?? {}).sort();
      manifestAncestryLabels = collectManifestAncestryLabels(store);
      validationState = store.validation_state ?? null;
      const activeValidation = store.validation_results?.activeManifest;
      const categorizedStatuses = [
        ...(activeValidation?.success ?? []).map((status) => ({
          ...status,
          success: true,
        })),
        ...(activeValidation?.informational ?? []).map((status) => ({
          ...status,
          success: null,
        })),
        ...(activeValidation?.failure ?? []).map((status) => ({
          ...status,
          success: false,
        })),
      ];
      const statuses =
        categorizedStatuses.length > 0
          ? categorizedStatuses
          : (store.validation_status ?? []);
      validationStatuses = statuses.map((status) => ({
        code: status.code,
        success: status.success ?? null,
        explanation: status.explanation ?? null,
      }));
      digitalSourceTypes = collectDigitalSourceTypes(reader.getActive());
    }
  } catch (error) {
    inspectionError = redactUrlsInText(
      error instanceof Error ? error.message : String(error),
    );
  }

  const evidenceDirectory = path.resolve(options.evidenceDirectory);
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(
    evidenceDirectory,
    `${safeIdentifier(options.id)}-${observedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`,
  );
  const result: ProvenanceInspectionResult = {
    schemaVersion: 1,
    id: options.id,
    target: redactUrlForReport(options.target),
    resolvedTarget: redactUrlForReport(loaded.resolvedTarget),
    sourceKind: loaded.sourceKind,
    observedAt,
    mimeType: loaded.mimeType,
    bytes: loaded.buffer.length,
    sha256: sha256(loaded.buffer),
    evidencePath,
    c2pa: {
      manifestPresent,
      embedded,
      activeLabel,
      manifestLabels,
      manifestAncestryLabels,
      validationState,
      validationStatuses,
      digitalSourceTypes,
      inspectionError,
    },
    resultMeaning:
      "This is a technical observation of the inspected bytes. Manifest presence, absence, or validation state is not a legal compliance conclusion or an authenticity guarantee.",
  };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
