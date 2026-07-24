import { appendFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildAuditArguments,
  parsePrivateOrigins,
  validateRepositoryPath,
} from "./action-inputs.mjs";
import {
  inspectGeneratedReports,
  prepareDedicatedOutput,
  resolveContainedConfig,
} from "./action-filesystem.mjs";

function escapeWorkflowCommand(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function annotateError(message) {
  process.stdout.write(
    `::error title=art50-ci action failed::${escapeWorkflowCommand(message)}\n`,
  );
}

function writeOutputs(exitCode, reportSafe) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error("GITHUB_OUTPUT is unavailable.");
  }
  appendFileSync(
    outputFile,
    `exit-code=${exitCode}\nreport-safe=${reportSafe ? "true" : "false"}\n`,
    "utf8",
  );
}

let exitCode = 2;
let reportSafe = false;

try {
  const actionPath = process.env.GITHUB_ACTION_PATH ?? "";
  const workspace = process.env.GITHUB_WORKSPACE ?? "";
  const config = validateRepositoryPath(
    process.env.ART50_CONFIG ?? "",
    "config",
  );
  const output = validateRepositoryPath(
    process.env.ART50_OUTPUT ?? "",
    "output",
    { output: true },
  );
  const privateOrigins = parsePrivateOrigins(
    process.env.ART50_PRIVATE_ORIGINS ?? "",
  );

  resolveContainedConfig(workspace, config);
  const outputPath = prepareDedicatedOutput(workspace, output);

  const cliPath = path.join(actionPath, "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      ...buildAuditArguments({
        config,
        output,
        privateOrigins,
      }),
    ],
    {
      cwd: workspace,
      env: process.env,
      stdio: "inherit",
      shell: false,
    },
  );
  if (result.error) {
    throw result.error;
  }
  exitCode =
    result.status === 0 || result.status === 1 || result.status === 2
      ? result.status
      : 2;

  const inspection = inspectGeneratedReports(outputPath);
  if (inspection.safe) {
    reportSafe = true;
  } else if (exitCode !== 2) {
    annotateError("The audit returned without creating JSON or HTML evidence.");
    exitCode = 2;
  }
} catch (error) {
  annotateError(error instanceof Error ? error.message : String(error));
  exitCode = 2;
  reportSafe = false;
}

writeOutputs(exitCode, reportSafe);
