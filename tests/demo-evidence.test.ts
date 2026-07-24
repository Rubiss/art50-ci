import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAudit, type AuditReport } from "../src/audit.js";
import { parseConfigText } from "../src/config.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureDirectory = path.join(
  repositoryRoot,
  "examples",
  "browser-obstruction-demo",
);
const evidenceDirectory = path.join(repositoryRoot, "examples", "evidence");

async function loadReport(
  name: "broken" | "fixed",
): Promise<{
  html: string;
  json: string;
  report: AuditReport;
  screenshotPath: string;
}> {
  const basename = `browser-obstruction-${name}-v0.3.0`;
  const [json, html] = await Promise.all([
    readFile(path.join(evidenceDirectory, `${basename}.json`), "utf8"),
    readFile(path.join(evidenceDirectory, `${basename}.html`), "utf8"),
  ]);
  const report = JSON.parse(json) as AuditReport;
  const screenshotPath = path.resolve(
    evidenceDirectory,
    report.surfaces[0]?.screenshotPath ?? "",
  );
  return { html, json, report, screenshotPath };
}

describe("published browser obstruction demonstration", () => {
  it("retains the exact v0.3.0 OBSTRUCTED failure and matching screenshot", async () => {
    const { html, json, report, screenshotPath } =
      await loadReport("broken");
    const surface = report.surfaces[0]!;
    const check = surface.checks[0]!;

    expect(report).toMatchObject({
      schemaVersion: 2,
      passed: false,
      tool: { name: "art50-ci", version: "0.3.0" },
      summary: {
        totalSurfaces: 1,
        failedSurfaces: 1,
        totalChecks: 1,
        failedChecks: 1,
        totalFailures: 1,
      },
    });
    expect(surface.failures).toEqual([
      expect.objectContaining({
        code: "OBSTRUCTED",
        actual: "div.cookie-overlay",
      }),
    ]);
    expect(check).toMatchObject({
      disclosureId: "ai-generation-notice",
      actualVisible: true,
      inViewport: true,
      unobstructed: false,
      coveredBy: "div.cookie-overlay",
      accessible: true,
      accessibleName: "AI generation notice",
      passed: false,
    });
    expect(existsSync(screenshotPath)).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(screenshotPath))
        .digest("hex"),
    ).toBe(surface.screenshotSha256);
    expect(html).toContain("OBSTRUCTED");
    expect(html).toContain(encodeURI(surface.screenshotPath!));
    expect(json).not.toContain(repositoryRoot);
    expect(json).not.toMatch(/\bfile:\/\//iu);
  });

  it("retains the same declared check passing after the overlay fix", async () => {
    const { html, json, report, screenshotPath } =
      await loadReport("fixed");
    const surface = report.surfaces[0]!;
    const check = surface.checks[0]!;

    expect(report).toMatchObject({
      schemaVersion: 2,
      passed: true,
      tool: { name: "art50-ci", version: "0.3.0" },
      summary: {
        totalSurfaces: 1,
        passedSurfaces: 1,
        totalChecks: 1,
        passedChecks: 1,
        totalFailures: 0,
      },
    });
    expect(surface.failures).toEqual([]);
    expect(check).toMatchObject({
      disclosureId: "ai-generation-notice",
      actualVisible: true,
      inViewport: true,
      unobstructed: true,
      coveredBy: null,
      accessible: true,
      accessibleName: "AI generation notice",
      passed: true,
    });
    expect(existsSync(screenshotPath)).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(screenshotPath))
        .digest("hex"),
    ).toBe(surface.screenshotSha256);
    expect(html).toContain(">PASS<");
    expect(html).toContain(encodeURI(surface.screenshotPath!));
    expect(json).not.toContain(repositoryRoot);
    expect(json).not.toMatch(/\bfile:\/\//iu);
  });

  it("keeps the technical declaration identical across the broken and fixed configs", async () => {
    const [brokenConfig, fixedConfig, brokenFixture, fixedFixture] =
      await Promise.all([
        readFile(path.join(fixtureDirectory, "broken.yml"), "utf8"),
        readFile(path.join(fixtureDirectory, "fixed.yml"), "utf8"),
        readFile(path.join(fixtureDirectory, "broken.html"), "utf8"),
        readFile(path.join(fixtureDirectory, "fixed.html"), "utf8"),
      ]);
    const broken = parseConfigText(brokenConfig);
    const fixed = parseConfigText(fixedConfig);
    const [committedBroken, committedFixed] = await Promise.all([
      loadReport("broken"),
      loadReport("fixed"),
    ]);

    expect(broken.browser.viewport).toEqual({ width: 640, height: 480 });
    expect(fixed.browser.viewport).toEqual(broken.browser.viewport);
    expect(fixed.surfaces[0]?.disclosures).toEqual(
      broken.surfaces[0]?.disclosures,
    );
    expect(brokenFixture).toContain('class="cookie-overlay"');
    expect(fixedFixture).toContain('class="cookie-overlay"');
    expect(brokenFixture).toContain("min-height: 120px");
    expect(fixedFixture).toContain("min-height: 52px");
    expect(
      createHash("sha256")
        .update(JSON.stringify(broken))
        .digest("hex"),
    ).toBe(committedBroken.report.configSha256);
    expect(
      createHash("sha256")
        .update(JSON.stringify(fixed))
        .digest("hex"),
    ).toBe(committedFixed.report.configSha256);

    const testOutputRoot = path.join(repositoryRoot, ".test-output");
    await mkdir(testOutputRoot, { recursive: true });
    const temporaryOutput = await mkdtemp(
      path.join(testOutputRoot, "demo-evidence-drift-"),
    );
    try {
      const currentBroken = await runAudit(broken, {
        baseDirectory: fixtureDirectory,
        outputDirectory: path.join(temporaryOutput, "broken"),
        mode: "audit",
      });
      const currentFixed = await runAudit(fixed, {
        baseDirectory: fixtureDirectory,
        outputDirectory: path.join(temporaryOutput, "fixed"),
        mode: "audit",
      });

      expect(currentBroken.surfaces[0]).toMatchObject({
        pageContentSha256:
          committedBroken.report.surfaces[0]?.pageContentSha256,
        passed: false,
        failures: [
          expect.objectContaining({
            code: "OBSTRUCTED",
            actual: "div.cookie-overlay",
          }),
        ],
      });
      expect(currentFixed.surfaces[0]).toMatchObject({
        pageContentSha256:
          committedFixed.report.surfaces[0]?.pageContentSha256,
        passed: true,
        failures: [],
      });
    } finally {
      const resolvedTemporaryOutput = path.resolve(temporaryOutput);
      if (
        resolvedTemporaryOutput.startsWith(
          `${path.resolve(testOutputRoot)}${path.sep}`,
        )
      ) {
        await rm(resolvedTemporaryOutput, {
          recursive: true,
          force: true,
        });
      }
    }
  }, 30_000);
});
