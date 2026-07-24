import path from "node:path";
import { pathToFileURL } from "node:url";

const supportedProtocols = new Set(["http:", "https:", "file:"]);

export function resolveTarget(target: string, baseDirectory: string): string {
  // Windows drive-letter paths are valid inputs to URL(), where "C:" is
  // interpreted as a protocol. Resolve filesystem paths before parsing URLs.
  if (path.isAbsolute(target)) {
    return pathToFileURL(target).toString();
  }

  try {
    const parsed = new URL(target);
    if (!supportedProtocols.has(parsed.protocol)) {
      throw new Error(
        `Unsupported target protocol "${parsed.protocol}". Use http, https, or file.`,
      );
    }
    return parsed.toString();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unsupported target protocol")
    ) {
      throw error;
    }
  }

  return pathToFileURL(path.resolve(baseDirectory, target)).toString();
}

export function targetsMatch(
  left: string,
  right: string,
  baseDirectory: string,
): boolean {
  return resolveTarget(left, baseDirectory) === resolveTarget(right, baseDirectory);
}
