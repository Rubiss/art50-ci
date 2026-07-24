import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_VERSION } from "../src/version.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("release version", () => {
  it("keeps package and CLI versions in sync", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { version: string };

    expect(packageJson.version).toBe(TOOL_VERSION);
  });
});
