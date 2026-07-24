import { describe, expect, it } from "vitest";
import { parseConfigText } from "../src/config.js";

const validConfig = `
version: 1
project:
  name: test-project
surfaces:
  - id: assistant
    target: ./fixture.html
    disclosures:
      - id: notice
        selector: "[data-ai-disclosure]"
        expectedText: "AI system"
`;

describe("parseConfigText", () => {
  it("parses a typed YAML configuration and supplies defaults", () => {
    const config = parseConfigText(validConfig);

    expect(config.browser.timeoutMs).toBe(15_000);
    expect(config.network).toEqual({
      maxRedirects: 5,
      requestedPrivateOrigins: [],
    });
    expect(config.output.screenshots).toBe(true);
    expect(config.surfaces[0]?.kind).toBe("website");
    expect(config.surfaces[0]?.disclosures[0]?.match).toBe("contains");
  });

  it("rejects duplicate surface identifiers", () => {
    expect(() =>
      parseConfigText(`${validConfig}
  - id: assistant
    target: ./other.html
    disclosures:
      - id: notice
        selector: ".notice"
        expectedText: "AI"
`),
    ).toThrow(/duplicate surface id/i);
  });

  it("rejects invalid regular expressions before browser execution", () => {
    expect(() =>
      parseConfigText(`
version: 1
project:
  name: test-project
surfaces:
  - id: assistant
    target: ./fixture.html
    disclosures:
      - id: notice
        selector: ".notice"
        expectedText: "[unclosed"
        match: regex
`),
    ).toThrow(/invalid regular expression/i);
  });

  it("rejects misspelled fields", () => {
    expect(() =>
      parseConfigText(`
version: 1
project:
  name: test-project
surfaces:
  - id: assistant
    target: ./fixture.html
    disclosurs: []
`),
    ).toThrow(/unrecognized key|disclosures/i);
  });

  it("accepts an asset-only provenance configuration", () => {
    const config = parseConfigText(`
version: 1
project:
  name: asset-pipeline
provenance:
  - id: launch-poster
    source: ./source.png
    delivered: https://cdn.example.com/source.png
`);

    expect(config.surfaces).toEqual([]);
    expect(config.provenance[0]).toMatchObject({
      id: "launch-poster",
      requireManifest: true,
      requireEmbedded: true,
      requireSourceManifestInDeliveredChain: true,
      failOnInvalid: true,
      maxBytes: 50 * 1024 * 1024,
    });
  });

  it("requires at least one browser surface or provenance asset", () => {
    expect(() =>
      parseConfigText(`
version: 1
project:
  name: empty-project
`),
    ).toThrow(/at least one surface or provenance asset/i);
  });

  it("canonicalizes exact requested private origins", () => {
    const config = parseConfigText(`${validConfig}
network:
  maxRedirects: 3
  requestedPrivateOrigins:
    - HTTP://LOCALHOST.:80
`);

    expect(config.network).toEqual({
      maxRedirects: 3,
      requestedPrivateOrigins: ["http://localhost"],
    });
  });

  it("rejects private-origin grants containing a path or credentials", () => {
    expect(() =>
      parseConfigText(`${validConfig}
network:
  requestedPrivateOrigins:
    - https://user:secret@example.com/private
`),
    ).toThrow(/credentials|scheme, hostname/i);
  });

  it("requires a complete URI for expected digital source types", () => {
    expect(() =>
      parseConfigText(`
version: 1
project:
  name: source-type
provenance:
  - id: generated
    delivered: ./generated.png
    expectedDigitalSourceType: trainedAlgorithmicMedia
`),
    ).toThrow(/complete digital source type URI/i);
  });
});
