import path from "node:path";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const OUTPUT_CHARACTERS = /^[A-Za-z0-9._/-]+$/u;
const ARTIFACT_CHARACTERS = /^[A-Za-z0-9._ -]+$/u;

function requirePlainSingleLine(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not start or end with whitespace.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return value;
}

export function validateRepositoryPath(value, label, options = {}) {
  const candidate = requirePlainSingleLine(value, label);
  if (
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    candidate.includes("\\")
  ) {
    throw new Error(`${label} must be a repository-relative POSIX path.`);
  }

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside the checked-out repository.`);
  }
  if (options.output === true) {
    if (candidate === "." || segments.every((segment) => segment === ".")) {
      throw new Error(`${label} must name a dedicated report directory.`);
    }
    if (!OUTPUT_CHARACTERS.test(candidate)) {
      throw new Error(
        `${label} may contain only letters, numbers, ".", "_", "-", and "/".`,
      );
    }
  }
  return candidate;
}

export function validateArtifactName(value) {
  const candidate = requirePlainSingleLine(value, "artifact-name");
  if (candidate.length > 255 || !ARTIFACT_CHARACTERS.test(candidate)) {
    throw new Error(
      'artifact-name must be at most 255 characters and use only letters, numbers, spaces, ".", "_", and "-".',
    );
  }
  return candidate;
}

export function parseRetentionDays(value) {
  const candidate = requirePlainSingleLine(value, "retention-days");
  if (!/^[0-9]+$/u.test(candidate)) {
    throw new Error("retention-days must be an integer from 1 through 90.");
  }
  const parsed = Number(candidate);
  if (parsed < 1 || parsed > 90) {
    throw new Error("retention-days must be an integer from 1 through 90.");
  }
  return parsed;
}

export function parseBooleanInput(value, label) {
  if (value !== "true" && value !== "false") {
    throw new Error(`${label} must be either "true" or "false".`);
  }
  return value === "true";
}

export function parsePrivateOrigins(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  const origins = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (CONTROL_CHARACTERS.test(line)) {
      throw new Error("private-origins contains a control character.");
    }

    let parsed;
    try {
      parsed = new URL(line);
    } catch {
      throw new Error(`private-origins contains an invalid URL: ${line}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        `private-origins entries must be exact HTTP(S) origins without credentials, paths, queries, or fragments: ${line}`,
      );
    }
    if (!origins.includes(parsed.origin)) {
      origins.push(parsed.origin);
    }
  }
  return origins;
}

export function validateActionInputs(environment) {
  if (environment.RUNNER_OS !== "Linux") {
    throw new Error(
      "art50-ci's composite action currently supports GitHub-hosted Linux runners only.",
    );
  }
  if (environment.ART50_RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error(
      "art50-ci's composite action currently supports GitHub-hosted runners only.",
    );
  }
  const config = validateRepositoryPath(
    environment.ART50_CONFIG ?? "",
    "config",
  );
  const output = validateRepositoryPath(
    environment.ART50_OUTPUT ?? "",
    "output",
    { output: true },
  );
  const artifactName = validateArtifactName(
    environment.ART50_ARTIFACT_NAME ?? "",
  );
  const retentionDays = parseRetentionDays(
    environment.ART50_RETENTION_DAYS ?? "",
  );
  const installBrowser = parseBooleanInput(
    environment.ART50_INSTALL_BROWSER ?? "",
    "install-browser",
  );
  const privateOrigins = parsePrivateOrigins(
    environment.ART50_PRIVATE_ORIGINS ?? "",
  );
  return {
    config,
    output,
    artifactName,
    retentionDays,
    installBrowser,
    privateOrigins,
  };
}

export function buildAuditArguments(inputs) {
  const arguments_ = [
    "audit",
    "--config",
    inputs.config,
    "--output",
    inputs.output,
  ];
  for (const origin of inputs.privateOrigins) {
    arguments_.push("--allow-private-origin", origin);
  }
  return arguments_;
}
