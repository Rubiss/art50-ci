import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AuditReport } from "./audit.js";
import type { ProvenanceInspectionResult } from "./provenance.js";
import { redactUrlForReport, redactUrlsInText } from "./redact.js";

export interface PersistedAuditContext {
  baseDirectory: string;
  reportDirectory: string;
}

export interface PersistedEvidenceContext {
  baseDirectory: string;
  documentDirectory: string;
}

export interface KnownLocalPath {
  absolutePath: string;
  replacement: string;
}

type PathImplementation = typeof path.win32;
const diagnosticPathKeys = new Set([
  "explanation",
  "inspectionError",
  "message",
]);

function pathImplementationFor(
  value: string,
): PathImplementation | null {
  if (/^(?:[a-z]:[\\/]|\\\\)/iu.test(value)) {
    return path.win32;
  }
  if (path.posix.isAbsolute(value)) {
    return path.posix;
  }
  return null;
}

function toDocumentPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isWithin(
  implementation: PathImplementation,
  relativePath: string,
): boolean {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${implementation.sep}`) &&
    !implementation.isAbsolute(relativePath)
  );
}

export function relativePathWithin(
  rootDirectory: string,
  candidatePath: string,
): string | null {
  const implementation = pathImplementationFor(rootDirectory);
  if (
    implementation === null ||
    implementation !== pathImplementationFor(candidatePath)
  ) {
    return null;
  }
  const relative = implementation.relative(
    implementation.resolve(rootDirectory),
    implementation.resolve(candidatePath),
  );
  return isWithin(implementation, relative)
    ? toDocumentPath(relative)
    : null;
}

function pathFromFileUrl(parsed: URL): string {
  const decodedPath = decodeURIComponent(parsed.pathname);
  if (/^\/[a-z]:\//iu.test(decodedPath)) {
    return path.win32.normalize(
      decodedPath.slice(1).replaceAll("/", "\\"),
    );
  }
  if (parsed.hostname && parsed.hostname !== "localhost") {
    return path.win32.normalize(
      `\\\\${parsed.hostname}\\${decodedPath
        .replace(/^\/+/u, "")
        .replaceAll("/", "\\")}`,
    );
  }
  return fileURLToPath(parsed);
}

function localPathFromTarget(
  value: string,
  baseDirectory: string,
): string | null {
  const valueImplementation = pathImplementationFor(value);
  if (valueImplementation) {
    return valueImplementation.normalize(value);
  }
  if (/^[a-z]:/iu.test(value)) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      try {
        return pathFromFileUrl(parsed);
      } catch {
        return "";
      }
    }
    return null;
  } catch {
    const baseImplementation = pathImplementationFor(baseDirectory);
    return baseImplementation
      ? baseImplementation.resolve(baseDirectory, value)
      : path.resolve(baseDirectory, value);
  }
}

export function localTargetForReport(
  value: string,
  baseDirectory: string,
): string {
  const localPath = localPathFromTarget(value, baseDirectory);
  if (localPath === null) {
    return redactUrlForReport(value);
  }
  if (!localPath) {
    return "$LOCAL_FILE";
  }
  const relative = relativePathWithin(baseDirectory, localPath);
  if (relative === null) {
    return "$LOCAL_FILE";
  }
  return relative ? `$CONFIG_DIR/${relative}` : "$CONFIG_DIR";
}

export function artifactPathForReport(
  absolutePath: string,
  documentDirectory: string,
): string {
  const relative = relativePathWithin(documentDirectory, absolutePath);
  return relative === null || relative === "" ? "$LOCAL_FILE" : relative;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replacePathLiteral(
  value: string,
  needle: string,
  replacement: string,
): string {
  if (!needle) {
    return value;
  }
  const flags = /^(?:[a-z]:[\\/]|\\\\)/iu.test(needle) ? "giu" : "gu";
  const boundary =
    String.raw`(?=$|[\\/\s"'<>()[\]{}]|[),.;:!?#](?=\s|$))`;
  return value.replace(
    new RegExp(`${escapeRegExp(needle)}${boundary}`, flags),
    () => replacement,
  );
}

function pathVariants(absolutePath: string): string[] {
  const implementation = pathImplementationFor(absolutePath);
  if (!implementation) {
    return [];
  }
  const normalized = implementation.normalize(absolutePath);
  if (implementation.dirname(normalized) === normalized) {
    return [];
  }
  const variants = new Set([
    normalized,
    normalized.replaceAll("\\", "/"),
    normalized.replaceAll("/", "\\"),
  ]);
  const nativeImplementation =
    process.platform === "win32" ? path.win32 : path.posix;
  if (implementation === nativeImplementation) {
    try {
      const fileUrl = pathToFileURL(normalized).href;
      variants.add(fileUrl);
      variants.add(decodeURI(fileUrl));
    } catch {
      // Native path variants still provide deterministic redaction.
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function splitTrailingPunctuation(value: string): [string, string] {
  let candidate = value;
  let trailing = "";
  while (/[),.;\]}]$/u.test(candidate)) {
    trailing = `${candidate.at(-1)}${trailing}`;
    candidate = candidate.slice(0, -1);
  }
  return [candidate, trailing];
}

export function redactKnownLocalPathsInText(
  value: string,
  knownPaths: readonly KnownLocalPath[],
): string {
  let redacted = value;
  const ordered = [...knownPaths].sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  );
  for (const { absolutePath, replacement } of ordered) {
    for (const variant of pathVariants(absolutePath)) {
      redacted = replacePathLiteral(redacted, variant, replacement);
    }
  }
  redacted = redacted.replace(
    /\bfile:\/\/[^\s"'<>]+/giu,
    (matched) => {
      const [, trailing] = splitTrailingPunctuation(matched);
      return `$LOCAL_FILE${trailing}`;
    },
  );
  redacted = redacted.replace(
    /(\$(?:CONFIG_DIR|REPORT_DIR|LOCAL_FILE))\\/gu,
    "$1/",
  );
  return redactUrlsInText(redacted);
}

function redactUnknownAbsolutePathsInText(value: string): string {
  const replacePath = (
    matched: string,
    prefix: string,
  ): string => {
    const candidate = matched.slice(prefix.length);
    const [, trailing] = splitTrailingPunctuation(candidate);
    return `${prefix}$LOCAL_FILE${trailing}`;
  };
  return value
    .replace(
      /(^|[\s("'=[\]{},;])(?:[a-z]:[\\/]|\\\\)[^\s"'`<>\r\n]+/giu,
      replacePath,
    )
    .replace(
      /(^|[\s("'=[\]{},;])\/(?!\/)[^\s"'`<>\r\n]+/gu,
      replacePath,
    );
}

function sanitizePersistedValue<T>(
  value: T,
  knownPaths: readonly KnownLocalPath[],
  key: string | null = null,
): T {
  if (typeof value === "string") {
    const sanitized = redactKnownLocalPathsInText(value, knownPaths);
    return (
      key && diagnosticPathKeys.has(key)
        ? redactUnknownAbsolutePathsInText(sanitized)
        : sanitized
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizePersistedValue(item, knownPaths, key),
    ) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        sanitizePersistedValue(item, knownPaths, entryKey),
      ]),
    ) as T;
  }
  return value;
}

function systemPathRoots(): KnownLocalPath[] {
  return [os.homedir(), os.tmpdir()]
    .filter((value) => pathImplementationFor(value) !== null)
    .map((absolutePath) => ({
      absolutePath,
      replacement: "$LOCAL_FILE",
    }));
}

function knownLocalPath(
  value: string | null,
  baseDirectory: string,
  replacement?: string,
): KnownLocalPath | null {
  if (!value) {
    return null;
  }
  const localPath = localPathFromTarget(value, baseDirectory);
  return localPath
    ? {
        absolutePath: localPath,
        replacement:
          replacement ?? localTargetForReport(value, baseDirectory),
      }
    : null;
}

function knownArtifactPath(
  absolutePath: string,
  documentDirectory: string,
): KnownLocalPath {
  const artifactPath = artifactPathForReport(
    absolutePath,
    documentDirectory,
  );
  return {
    absolutePath,
    replacement:
      artifactPath === "$LOCAL_FILE"
        ? "$LOCAL_FILE"
        : `$REPORT_DIR/${artifactPath}`,
  };
}

function inspectionPaths(
  inspection: ProvenanceInspectionResult | null,
  baseDirectory: string,
  documentDirectory: string,
): KnownLocalPath[] {
  if (!inspection) {
    return [];
  }
  return [
    knownLocalPath(inspection.target, baseDirectory),
    knownLocalPath(inspection.resolvedTarget, baseDirectory),
    knownArtifactPath(inspection.evidencePath, documentDirectory),
  ].filter((entry): entry is KnownLocalPath => entry !== null);
}

function persistedInspection(
  inspection: ProvenanceInspectionResult | null,
  context: PersistedAuditContext,
): ProvenanceInspectionResult | null {
  if (!inspection) {
    return null;
  }
  return {
    ...inspection,
    target: localTargetForReport(inspection.target, context.baseDirectory),
    resolvedTarget: localTargetForReport(
      inspection.resolvedTarget,
      context.baseDirectory,
    ),
    evidencePath: artifactPathForReport(
      inspection.evidencePath,
      context.reportDirectory,
    ),
  };
}

export function persistedAuditReport(
  report: AuditReport,
  context: PersistedAuditContext,
): AuditReport {
  const knownPaths: KnownLocalPath[] = [
    {
      absolutePath: context.baseDirectory,
      replacement: "$CONFIG_DIR",
    },
    {
      absolutePath: context.reportDirectory,
      replacement: "$REPORT_DIR",
    },
    ...(report.configPath
      ? [
          knownLocalPath(
            report.configPath,
            context.baseDirectory,
            localTargetForReport(
              report.configPath,
              context.baseDirectory,
            ),
          ),
        ]
      : []),
    ...report.surfaces.flatMap((surface) =>
      [
        knownLocalPath(surface.target, context.baseDirectory),
        knownLocalPath(surface.resolvedTarget, context.baseDirectory),
        knownLocalPath(surface.finalUrl, context.baseDirectory),
        surface.screenshotPath
          ? knownArtifactPath(
              surface.screenshotPath,
              context.reportDirectory,
            )
          : null,
      ].filter((entry): entry is KnownLocalPath => entry !== null),
    ),
    ...report.provenance.flatMap((result) => [
      ...inspectionPaths(
        result.source,
        context.baseDirectory,
        context.reportDirectory,
      ),
      ...inspectionPaths(
        result.delivered,
        context.baseDirectory,
        context.reportDirectory,
      ),
    ]),
    ...systemPathRoots(),
  ].filter((entry): entry is KnownLocalPath => entry !== null);

  const persisted: AuditReport = {
    ...report,
    configPath: report.configPath
      ? localTargetForReport(report.configPath, context.baseDirectory)
      : null,
    surfaces: report.surfaces.map((surface) => ({
      ...surface,
      target: localTargetForReport(surface.target, context.baseDirectory),
      resolvedTarget: localTargetForReport(
        surface.resolvedTarget,
        context.baseDirectory,
      ),
      finalUrl: surface.finalUrl
        ? localTargetForReport(surface.finalUrl, context.baseDirectory)
        : null,
      screenshotPath: surface.screenshotPath
        ? artifactPathForReport(
            surface.screenshotPath,
            context.reportDirectory,
          )
        : null,
    })),
    provenance: report.provenance.map((result) => ({
      ...result,
      source: persistedInspection(result.source, context),
      delivered: persistedInspection(result.delivered, context),
    })),
  };
  return sanitizePersistedValue(persisted, knownPaths);
}

export function persistedProvenanceEvidence(
  result: ProvenanceInspectionResult,
  context: PersistedEvidenceContext,
): ProvenanceInspectionResult {
  const knownPaths = [
    {
      absolutePath: context.baseDirectory,
      replacement: "$CONFIG_DIR",
    },
    {
      absolutePath: context.documentDirectory,
      replacement: "$REPORT_DIR",
    },
    ...inspectionPaths(
      result,
      context.baseDirectory,
      context.documentDirectory,
    ),
    ...systemPathRoots(),
  ];
  const persisted: ProvenanceInspectionResult = {
    ...result,
    target: localTargetForReport(result.target, context.baseDirectory),
    resolvedTarget: localTargetForReport(
      result.resolvedTarget,
      context.baseDirectory,
    ),
    evidencePath: artifactPathForReport(
      result.evidencePath,
      context.documentDirectory,
    ),
  };
  return sanitizePersistedValue(persisted, knownPaths);
}
