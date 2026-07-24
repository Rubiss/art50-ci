import { validateActionInputs } from "./action-inputs.mjs";

function escapeWorkflowCommand(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

try {
  validateActionInputs(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `::error title=Invalid art50-ci action input::${escapeWorkflowCommand(message)}\n`,
  );
  process.exitCode = 1;
}
