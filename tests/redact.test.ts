import { describe, expect, it } from "vitest";
import {
  redactUrlForReport,
  redactUrlsInText,
  sanitizeReportValue,
} from "../src/redact.js";

describe("report URL redaction", () => {
  it("removes credentials, query parameters, and fragments", () => {
    expect(
      redactUrlForReport(
        "https://user:secret@example.com/media.png?token=private#fragment",
      ),
    ).toBe(
      "https://example.com/media.png?__redacted__#__redacted__",
    );
  });

  it("redacts URLs embedded in diagnostic text", () => {
    expect(
      redactUrlsInText(
        "Request to https://example.com/a?signature=secret failed.",
      ),
    ).toBe("Request to https://example.com/a?__redacted__ failed.");
  });

  it("redacts WebSocket and file URL secrets", () => {
    expect(
      redactUrlsInText(
        "ws://localhost:9000/socket?token=ws-secret#fragment and file:///C:/preview.html?token=file-secret#fragment",
      ),
    ).toBe(
      "ws://localhost:9000/socket?__redacted__#__redacted__ and file:///C:/preview.html?__redacted__#__redacted__",
    );
  });

  it("leaves local paths unchanged", () => {
    expect(redactUrlForReport("C:\\fixtures\\asset.png")).toBe(
      "C:\\fixtures\\asset.png",
    );
  });

  it("sanitizes nested report values without mutating the source", () => {
    const source = {
      target: "https://example.com/a?token=secret",
      nested: ["See https://example.com/b#oauth-token"],
    };
    const sanitized = sanitizeReportValue(source);

    expect(sanitized).toEqual({
      target: "https://example.com/a?__redacted__",
      nested: ["See https://example.com/b#__redacted__"],
    });
    expect(source.target).toContain("secret");
  });
});
