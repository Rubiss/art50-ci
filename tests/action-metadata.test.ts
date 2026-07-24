import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildAuditArguments,
  parsePrivateOrigins,
  validateActionInputs,
  validateRepositoryPath,
} from "../scripts/action-inputs.mjs";
import {
  inspectGeneratedReports,
  prepareDedicatedOutput,
} from "../scripts/action-filesystem.mjs";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("GitHub Action metadata", () => {
  it("defines one composite action with SHA-pinned nested actions", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "action.yml"),
      "utf8",
    );
    const metadata = parse(source) as {
      runs: {
        using: string;
        steps: Array<{ uses?: string; run?: string }>;
      };
    };

    expect(metadata.runs.using).toBe("composite");
    const nestedActions = metadata.runs.steps
      .map((step) => step.uses)
      .filter((value): value is string => value !== undefined);
    expect(nestedActions).toHaveLength(2);
    expect(nestedActions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^actions\/setup-node@[0-9a-f]{40}$/u),
        expect.stringMatching(/^actions\/upload-artifact@[0-9a-f]{40}$/u),
      ]),
    );
    for (const step of metadata.runs.steps) {
      expect(step.run ?? "").not.toContain("${{ inputs.");
    }
  });

  it("keeps untrusted values as distinct process arguments", () => {
    const arguments_ = buildAuditArguments({
      config: ".art50-ci.yml; echo injected",
      output: "artifacts/report",
      privateOrigins: [
        "https://staging.example",
        "http://127.0.0.1:4173",
      ],
    });

    expect(arguments_).toEqual([
      "audit",
      "--config",
      ".art50-ci.yml; echo injected",
      "--output",
      "artifacts/report",
      "--allow-private-origin",
      "https://staging.example",
      "--allow-private-origin",
      "http://127.0.0.1:4173",
    ]);
  });

  it("normalizes exact private origins without accepting URL tails", () => {
    expect(
      parsePrivateOrigins(
        "https://staging.example/\r\nhttp://127.0.0.1:4173\nhttps://staging.example",
      ),
    ).toEqual(["https://staging.example", "http://127.0.0.1:4173"]);
    expect(() =>
      parsePrivateOrigins("https://staging.example/private"),
    ).toThrow(/exact HTTP\(S\) origins/u);
    expect(() =>
      parsePrivateOrigins("https://user:secret@staging.example"),
    ).toThrow(/exact HTTP\(S\) origins/u);
  });

  it("rejects paths and metadata that could broaden the artifact boundary", () => {
    expect(() =>
      validateRepositoryPath("../../outside", "output", { output: true }),
    ).toThrow(/inside/u);
    expect(() =>
      validateRepositoryPath("/tmp/report", "output", { output: true }),
    ).toThrow(/repository-relative/u);
    expect(() =>
      validateRepositoryPath("artifacts/**", "output", { output: true }),
    ).toThrow(/may contain only/u);
    expect(() =>
      validateRepositoryPath(".", "output", { output: true }),
    ).toThrow(/dedicated report directory/u);
  });

  it("validates the supported runner and bounded action inputs", () => {
    const validated = validateActionInputs({
      RUNNER_OS: "Linux",
      ART50_RUNNER_ENVIRONMENT: "github-hosted",
      ART50_CONFIG: "checks/.art50-ci.yml",
      ART50_OUTPUT: "artifacts/art50",
      ART50_ARTIFACT_NAME: "art50-ci evidence",
      ART50_RETENTION_DAYS: "14",
      ART50_INSTALL_BROWSER: "false",
      ART50_PRIVATE_ORIGINS: "https://staging.example",
    });
    expect(validated.retentionDays).toBe(14);
    expect(validated.installBrowser).toBe(false);

    expect(() =>
      validateActionInputs({
        RUNNER_OS: "Windows",
        ART50_RUNNER_ENVIRONMENT: "github-hosted",
        ART50_CONFIG: ".art50-ci.yml",
        ART50_OUTPUT: "artifacts/art50",
        ART50_ARTIFACT_NAME: "evidence",
        ART50_RETENTION_DAYS: "7",
        ART50_INSTALL_BROWSER: "true",
        ART50_PRIVATE_ORIGINS: "",
      }),
    ).toThrow(/Linux/u);
  });

  it("creates only a new or empty dedicated output directory", () => {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), "art50-ci-action-output-"),
    );
    try {
      const workspace = path.join(temporaryRoot, "workspace");
      mkdirSync(workspace);
      const created = prepareDedicatedOutput(
        workspace,
        "artifacts/new-report",
      );
      expect(created).toBe(
        path.join(workspace, "artifacts", "new-report"),
      );

      const occupied = path.join(workspace, "occupied");
      mkdirSync(occupied);
      writeFileSync(path.join(occupied, "unrelated.html"), "private", "utf8");
      expect(() => prepareDedicatedOutput(workspace, "occupied")).toThrow(
        /new or empty/u,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a missing output leaf beneath an escaping symlink", () => {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), "art50-ci-action-symlink-"),
    );
    try {
      const workspace = path.join(temporaryRoot, "workspace");
      const outside = path.join(temporaryRoot, "outside");
      mkdirSync(workspace);
      mkdirSync(outside);
      symlinkSync(
        outside,
        path.join(workspace, "artifacts"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        prepareDedicatedOutput(workspace, "artifacts/new-report"),
      ).toThrow(/ancestor outside/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("refuses generated report trees containing symbolic links", () => {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), "art50-ci-action-report-"),
    );
    try {
      const output = path.join(temporaryRoot, "output");
      const outside = path.join(temporaryRoot, "outside");
      mkdirSync(output);
      mkdirSync(outside);
      writeFileSync(path.join(output, "report.json"), "{}", "utf8");
      symlinkSync(
        outside,
        path.join(output, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => inspectGeneratedReports(output)).toThrow(/symbolic link/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("hard-codes the verified C2PA binary archive digests", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "scripts", "install-c2pa-action-binary.mjs"),
      "utf8",
    );
    expect(source).toContain(
      "fc645619ae218921b46befa031dea4def2981dc541e91a7860add4634fec5aad",
    );
    expect(source).toContain(
      "07b855f150a267fa0593db355eb39a77f4ffdbe54306e50860678c3ed45d0178",
    );
    expect(source).toContain('const version = "0.6.4"');
  });
});
