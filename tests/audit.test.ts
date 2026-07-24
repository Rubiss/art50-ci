import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAudit } from "../src/audit.js";
import { parseConfigText } from "../src/config.js";
import { writeReports } from "../src/report.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(testDirectory, "fixtures", "disclosure-pass.html");
const obstructedFixturePath = path.join(
  testDirectory,
  "fixtures",
  "disclosure-obstructed.html",
);
const splitMatchFixturePath = path.join(
  testDirectory,
  "fixtures",
  "disclosure-split-match.html",
);
const outputRoot = path.join(testDirectory, "..", ".test-output");
let outputDirectory: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

beforeAll(async () => {
  await mkdir(outputRoot, { recursive: true });
  outputDirectory = await mkdtemp(path.join(outputRoot, "audit-"));
});

afterAll(async () => {
  const resolvedOutput = path.resolve(outputDirectory);
  if (resolvedOutput.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) {
    await rm(resolvedOutput, { recursive: true, force: true });
  }
});

describe("runAudit", () => {
  it("checks disclosures, records failures, and writes JSON and HTML evidence", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: integration-test
surfaces:
  - id: local-assistant
    kind: chatbot
    target: ${JSON.stringify(fixturePath)}
    firstInteraction:
      selector: "[data-first-interaction]"
      action: focus
    disclosures:
      - id: present-notice
        selector: "[data-ai-disclosure]"
        expectedText: "interacting with an AI system"
      - id: missing-notice
        selector: "[data-missing-disclosure]"
        expectedText: "Synthetic content"
`);

    const report = await runAudit(config, {
      baseDirectory: testDirectory,
      outputDirectory,
      mode: "audit",
    });
    const written = await writeReports(report, outputDirectory, {
      baseDirectory: testDirectory,
    });

    expect(report.passed).toBe(false);
    expect(report.summary.totalChecks).toBe(2);
    expect(report.summary.passedChecks).toBe(1);
    expect(report.summary.failedChecks).toBe(1);
    expect(report.surfaces[0]?.failures[0]?.code).toBe("SELECTOR_NOT_FOUND");
    expect(report.surfaces[0]?.checks[0]).toMatchObject({
      passed: true,
      inViewport: true,
      unobstructed: true,
      accessible: true,
      observationPhase: "initial",
    });
    expect(report.surfaces[0]?.firstInteraction).toMatchObject({
      passed: true,
      visible: true,
      enabled: true,
    });
    expect(report.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.resultMeaning).toMatch(/not a legal compliance/i);
    expect(report.surfaces[0]?.screenshotPath).not.toBeNull();
    expect(report.surfaces[0]?.screenshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.surfaces[0]?.pageContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(report.surfaces[0]?.screenshotPath ?? "")).toBe(true);
    expect(existsSync(written.jsonPath)).toBe(true);
    expect(existsSync(written.htmlPath)).toBe(true);

    const json = JSON.parse(await readFile(written.jsonPath, "utf8")) as {
      project: string;
      configPath: string | null;
      surfaces: Array<{
        target: string;
        resolvedTarget: string;
        finalUrl: string;
      }>;
    };
    const html = await readFile(written.htmlPath, "utf8");
    expect(json.project).toBe("integration-test");
    expect(json.configPath).toBeNull();
    expect(json.surfaces[0]).toMatchObject({
      target: "$CONFIG_DIR/fixtures/disclosure-pass.html",
      resolvedTarget: "$CONFIG_DIR/fixtures/disclosure-pass.html",
      finalUrl: "$CONFIG_DIR/fixtures/disclosure-pass.html",
    });
    expect(html).toContain("integration-test");
    expect(html).toContain("SELECTOR_NOT_FOUND");
    expect(html).toContain("Result boundary");
  });

  it("persists portable reports without local paths or private markers", async () => {
    const privateMarker = "ART50_PRIVATE_REPORT_MARKER";
    const configDirectory = path.join(outputDirectory, privateMarker);
    const reportDirectory = path.join(configDirectory, "reports");
    const localFixture = path.join(configDirectory, "disclosure.html");
    const configPath = path.join(configDirectory, "art50-ci.yml");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(localFixture, await readFile(fixturePath));

    const config = parseConfigText(`
version: 1
project:
  name: portable-report-test
surfaces:
  - id: local-page
    target: disclosure.html
    disclosures:
      - id: notice
        selector: "[data-ai-disclosure]"
        expectedText: "interacting with an AI system"
provenance:
  - id: local-asset
    delivered: disclosure.html
`);
    const report = await runAudit(config, {
      baseDirectory: configDirectory,
      outputDirectory: reportDirectory,
      configPath,
    });
    const surface = report.surfaces[0]!;
    const observation = report.provenance[0]!.delivered!;
    const absoluteValues = {
      configPath: report.configPath,
      resolvedTarget: surface.resolvedTarget,
      screenshotPath: surface.screenshotPath,
      evidencePath: observation.evidencePath,
    };
    surface.failures.push({
      code: "CHECK_FAILED",
      message:
        `Local ${path.join(configDirectory, "secret.txt")}; ` +
        `file URL ${pathToFileURL(localFixture).href}; ` +
        `unknown POSIX /opt/${privateMarker}/secret.txt; ` +
        `unknown Windows D:\\${privateMarker}\\secret.txt; ` +
        `remote https://example.test/result?token=${privateMarker}#${privateMarker}`,
      surfaceId: surface.surfaceId,
    });

    const directEvidenceText = await readFile(observation.evidencePath, "utf8");
    const directEvidence = JSON.parse(directEvidenceText) as {
      target: string;
      resolvedTarget: string;
      evidencePath: string;
    };
    const written = await writeReports(report, reportDirectory);
    const jsonText = await readFile(written.jsonPath, "utf8");
    const html = await readFile(written.htmlPath, "utf8");
    const json = JSON.parse(jsonText) as {
      schemaVersion: number;
      configPath: string;
      surfaces: Array<{
        target: string;
        resolvedTarget: string;
        finalUrl: string;
        screenshotPath: string;
      }>;
      provenance: Array<{
        delivered: {
          target: string;
          resolvedTarget: string;
          evidencePath: string;
        };
      }>;
    };

    expect(absoluteValues.configPath).toContain(privateMarker);
    expect(report.schemaVersion).toBe(2);
    expect(json.schemaVersion).toBe(2);
    expect(absoluteValues.resolvedTarget).toContain(privateMarker);
    expect(absoluteValues.screenshotPath).toContain(privateMarker);
    expect(absoluteValues.evidencePath).toContain(privateMarker);
    expect(report.configPath).toBe(absoluteValues.configPath);
    expect(surface.resolvedTarget).toBe(absoluteValues.resolvedTarget);
    expect(surface.screenshotPath).toBe(absoluteValues.screenshotPath);
    expect(observation.evidencePath).toBe(absoluteValues.evidencePath);
    expect(written.jsonPath).toBe(
      path.join(reportDirectory, `${report.mode}-${report.runId}.json`),
    );
    expect(written.htmlPath).toBe(
      path.join(reportDirectory, `${report.mode}-${report.runId}.html`),
    );

    expect(directEvidence.target).toBe("$CONFIG_DIR/disclosure.html");
    expect(directEvidence.resolvedTarget).toBe(
      "$CONFIG_DIR/disclosure.html",
    );
    expect(directEvidence.evidencePath).toMatch(
      /^local-asset-delivered-.+\.json$/u,
    );
    expect(json.configPath).toBe("$CONFIG_DIR/art50-ci.yml");
    expect(json.surfaces[0]?.target).toBe("$CONFIG_DIR/disclosure.html");
    expect(json.surfaces[0]?.resolvedTarget).toBe(
      "$CONFIG_DIR/disclosure.html",
    );
    expect(json.surfaces[0]?.finalUrl).toBe(
      "$CONFIG_DIR/disclosure.html",
    );
    expect(json.surfaces[0]?.screenshotPath).toMatch(
      /^screenshots\/local-page-.+\.png$/u,
    );
    expect(json.provenance[0]?.delivered.target).toBe(
      "$CONFIG_DIR/disclosure.html",
    );
    expect(json.provenance[0]?.delivered.resolvedTarget).toBe(
      "$CONFIG_DIR/disclosure.html",
    );
    expect(json.provenance[0]?.delivered.evidencePath).toMatch(
      /^provenance\/local-asset-delivered-.+\.json$/u,
    );
    expect(jsonText).toContain(
      "https://example.test/result?__redacted__#__redacted__",
    );
    expect(
      existsSync(
        path.resolve(
          reportDirectory,
          json.surfaces[0]!.screenshotPath,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.resolve(
          reportDirectory,
          json.provenance[0]!.delivered.evidencePath,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.resolve(
          path.dirname(observation.evidencePath),
          directEvidence.evidencePath,
        ),
      ),
    ).toBe(true);
    expect(html).toContain(
      encodeURI(json.surfaces[0]!.screenshotPath),
    );
    for (const persisted of [directEvidenceText, jsonText, html]) {
      expect(persisted).not.toContain(privateMarker);
      expect(persisted).not.toMatch(/\bfile:\/\//iu);
      expect(persisted).not.toContain(configDirectory);
    }
  }, 30_000);

  it("detects a disclosure covered by an overlay", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: obstruction-test
output:
  screenshots: false
surfaces:
  - id: obstructed-assistant
    kind: chatbot
    target: ${JSON.stringify(obstructedFixturePath)}
    disclosures:
      - id: covered-notice
        selector: "[data-ai-disclosure]"
        expectedText: "interacting with an AI system"
        accessibleName: "AI interaction notice"
`);

    const report = await runAudit(config, {
      baseDirectory: testDirectory,
      outputDirectory,
      mode: "audit",
    });

    expect(report.passed).toBe(false);
    expect(report.surfaces[0]?.checks[0]).toMatchObject({
      passed: false,
      inViewport: true,
      unobstructed: false,
      coveredBy: "div.overlay",
      accessible: true,
    });
    expect(report.surfaces[0]?.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OBSTRUCTED",
        }),
      ]),
    );
  });

  it("reports when separate elements satisfy different assertions", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: split-match-test
output:
  screenshots: false
surfaces:
  - id: split-match
    target: ${JSON.stringify(splitMatchFixturePath)}
    disclosures:
      - id: notice
        selector: "[data-ai-disclosure]"
        expectedText: "interacting with an AI system"
`);

    const report = await runAudit(config, {
      baseDirectory: testDirectory,
      outputDirectory,
      mode: "audit",
    });

    expect(report.passed).toBe(false);
    expect(report.summary.totalFailures).toBe(1);
    expect(report.surfaces[0]?.checks[0]?.failures).toEqual([
      expect.objectContaining({
        code: "NO_SINGLE_ELEMENT_MATCHED",
      }),
    ]);
  });

  it("requires CLI trust for every private browser origin and pins allowed traffic", async () => {
    let mainRequests = 0;
    let secondaryRequests = 0;
    const secondaryServer = createServer((_request, response) => {
      secondaryRequests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    });
    const secondaryOrigin = await listen(secondaryServer);
    const secondaryWebSocketOrigin = secondaryOrigin.replace(
      "http://",
      "ws://",
    );
    const mainServer = createServer((_request, response) => {
      mainRequests += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en"><body>
          <p data-ai-disclosure>AI system</p>
          <img src="${secondaryOrigin}/pixel.png" alt="">
          <script>
            new WebSocket("${secondaryWebSocketOrigin}/socket?token=websocket-secret");
          </script>
        </body></html>`);
    });
    const mainOrigin = await listen(mainServer);

    try {
      const config = parseConfigText(`
version: 1
project:
  name: private-network-test
network:
  requestedPrivateOrigins:
    - ${secondaryOrigin}
    - ${secondaryWebSocketOrigin}
output:
  screenshots: false
surfaces:
  - id: private-page
    target: ${JSON.stringify(
      `${mainOrigin}/?signature=private-token#oauth-token`,
    )}
    disclosures:
      - id: notice
        selector: "[data-ai-disclosure]"
        expectedText: "AI system"
`);

      const untrusted = await runAudit(config, {
        baseDirectory: testDirectory,
        outputDirectory,
      });
      expect(untrusted.passed).toBe(false);
      expect(mainRequests).toBe(0);
      expect(untrusted.surfaces[0]?.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "NETWORK_POLICY_BLOCKED" }),
        ]),
      );

      const mainOnly = await runAudit(config, {
        baseDirectory: testDirectory,
        outputDirectory,
        trustedPrivateOrigins: [mainOrigin],
      });
      expect(mainOnly.passed).toBe(false);
      expect(mainRequests).toBe(1);
      expect(secondaryRequests).toBe(0);
      expect(mainOnly.surfaces[0]?.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "NETWORK_POLICY_BLOCKED" }),
        ]),
      );
      expect(JSON.stringify(mainOnly)).not.toContain("websocket-secret");

      const fullyTrusted = await runAudit(config, {
        baseDirectory: testDirectory,
        outputDirectory,
        trustedPrivateOrigins: [
          mainOrigin,
          secondaryOrigin,
          secondaryWebSocketOrigin,
        ],
      });
      expect(fullyTrusted.passed).toBe(true);
      expect(mainRequests).toBe(2);
      expect(secondaryRequests).toBeGreaterThan(0);
      expect(fullyTrusted.surfaces[0]?.target).toBe(
        `${mainOrigin}/?__redacted__#__redacted__`,
      );
      expect(JSON.stringify(fullyTrusted)).not.toContain("private-token");
      expect(JSON.stringify(fullyTrusted)).not.toContain("oauth-token");
    } finally {
      await Promise.all([
        closeServer(mainServer),
        closeServer(secondaryServer),
      ]);
    }
  }, 30_000);

  it("confines file targets to the configuration directory", async () => {
    const config = parseConfigText(`
version: 1
project:
  name: file-boundary-test
output:
  screenshots: false
surfaces:
  - id: outside-file
    target: ${JSON.stringify(path.join(testDirectory, "audit.test.ts"))}
    disclosures:
      - id: notice
        selector: body
        expectedText: "not observed"
`);

    const report = await runAudit(config, {
      baseDirectory: path.join(testDirectory, "fixtures"),
      outputDirectory,
    });

    expect(report.passed).toBe(false);
    expect(report.surfaces[0]?.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NETWORK_POLICY_BLOCKED" }),
      ]),
    );
  });
});
