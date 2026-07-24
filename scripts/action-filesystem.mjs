import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve an existing output-path ancestor.");
    }
    current = parent;
  }
  return current;
}

export function resolveContainedConfig(workspace, relativeConfig) {
  const canonicalWorkspace = realpathSync(workspace);
  const canonicalConfig = realpathSync(
    path.resolve(canonicalWorkspace, relativeConfig),
  );
  if (!isInside(canonicalWorkspace, canonicalConfig)) {
    throw new Error("The resolved config path leaves the checked-out repository.");
  }
  return canonicalConfig;
}

export function prepareDedicatedOutput(workspace, relativeOutput) {
  const canonicalWorkspace = realpathSync(workspace);
  const outputPath = path.resolve(canonicalWorkspace, relativeOutput);
  const ancestor = nearestExistingAncestor(outputPath);
  const canonicalAncestor = realpathSync(ancestor);
  if (!isInside(canonicalWorkspace, canonicalAncestor)) {
    throw new Error(
      "The output path has an ancestor outside the checked-out repository.",
    );
  }

  if (existsSync(outputPath)) {
    const outputMetadata = lstatSync(outputPath);
    if (outputMetadata.isSymbolicLink()) {
      throw new Error("The output directory must not be a symbolic link.");
    }
    if (!outputMetadata.isDirectory()) {
      throw new Error("The output path exists and is not a directory.");
    }
    const canonicalOutput = realpathSync(outputPath);
    if (!isInside(canonicalWorkspace, canonicalOutput)) {
      throw new Error(
        "The resolved output directory leaves the checked-out repository.",
      );
    }
    if (readdirSync(canonicalOutput).length !== 0) {
      throw new Error(
        "The output directory must be new or empty so unrelated files cannot be uploaded.",
      );
    }
    return canonicalOutput;
  }

  mkdirSync(outputPath, { recursive: true });
  const canonicalOutput = realpathSync(outputPath);
  if (!isInside(canonicalWorkspace, canonicalOutput)) {
    throw new Error(
      "The created output directory leaves the checked-out repository.",
    );
  }
  return canonicalOutput;
}

export function inspectGeneratedReports(outputDirectory) {
  const pending = [outputDirectory];
  let reportFiles = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          "The generated report tree contains a symbolic link and will not be uploaded.",
        );
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".json") || entry.name.endsWith(".html")) {
          reportFiles += 1;
        }
      } else {
        throw new Error(
          "The generated report tree contains an unsupported filesystem entry.",
        );
      }
    }
  }
  return { reportFiles, safe: reportFiles > 0 };
}
