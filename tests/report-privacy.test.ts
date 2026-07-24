import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactPathForReport,
  localTargetForReport,
  redactKnownLocalPathsInText,
  relativePathWithin,
} from "../src/report-privacy.js";

describe("portable report paths", () => {
  it("relativizes Windows, UNC, and POSIX descendants", () => {
    expect(
      relativePathWithin(
        "C:\\private-user\\project",
        "C:\\private-user\\project\\assets\\image.png",
      ),
    ).toBe("assets/image.png");
    expect(
      relativePathWithin(
        "\\\\server\\share\\project",
        "\\\\server\\share\\project\\assets\\image.png",
      ),
    ).toBe("assets/image.png");
    expect(
      relativePathWithin(
        "/home/private-user/project",
        "/home/private-user/project/assets/image.png",
      ),
    ).toBe("assets/image.png");
  });

  it("rejects escaped roots, sibling prefixes, and mixed path styles", () => {
    expect(
      relativePathWithin(
        "C:\\private-user\\project",
        "C:\\private-user\\project-other\\secret.png",
      ),
    ).toBeNull();
    expect(
      relativePathWithin(
        "/home/private-user/project",
        "/home/private-user/project-other/secret.png",
      ),
    ).toBeNull();
    expect(
      relativePathWithin(
        "C:\\private-user\\project",
        "/home/private-user/project/image.png",
      ),
    ).toBeNull();
  });

  it("projects native paths and file URLs without retaining host roots", () => {
    expect(
      localTargetForReport(
        "C:\\Users\\PRIVATE\\project\\asset.png",
        "C:\\Users\\PRIVATE\\project",
      ),
    ).toBe("$CONFIG_DIR/asset.png");
    expect(
      localTargetForReport(
        "file:///C:/Users/PRIVATE/project/asset.png",
        "C:\\Users\\PRIVATE\\project",
      ),
    ).toBe("$CONFIG_DIR/asset.png");
    expect(
      localTargetForReport(
        "/home/PRIVATE/outside/asset.png",
        "/home/PRIVATE/project",
      ),
    ).toBe("$LOCAL_FILE");
    expect(
      localTargetForReport(
        "https://user:secret@example.test/a?token=x#fragment",
        "/tmp/project",
      ),
    ).toBe(
      "https://example.test/a?__redacted__#__redacted__",
    );
  });

  it("keeps only artifact paths inside the containing report directory", () => {
    expect(
      artifactPathForReport(
        "C:\\private-user\\reports\\screenshots\\page.png",
        "C:\\private-user\\reports",
      ),
    ).toBe("screenshots/page.png");
    expect(
      artifactPathForReport(
        "/home/private-user/outside/page.png",
        "/home/private-user/reports",
      ),
    ).toBe("$LOCAL_FILE");
  });

  it("redacts known roots at path boundaries without rewriting siblings", () => {
    const root = "C:\\private-user\\project";
    const value =
      "inside C:\\private-user\\project\\secret.txt; " +
      "siblings C:\\private-user\\project-other\\public.txt " +
      "C:\\private-user\\project.secret\\public.txt " +
      "C:\\private-user\\project,secret\\public.txt " +
      "C:\\private-user\\project;secret\\public.txt " +
      "C:\\private-user\\project?secret\\public.txt " +
      "C:\\private-user\\project#secret\\public.txt";

    expect(
      redactKnownLocalPathsInText(value, [
        { absolutePath: root, replacement: "$CONFIG_DIR" },
      ]),
    ).toBe(
      "inside $CONFIG_DIR/secret.txt; " +
        "siblings C:\\private-user\\project-other\\public.txt " +
        "C:\\private-user\\project.secret\\public.txt " +
        "C:\\private-user\\project,secret\\public.txt " +
        "C:\\private-user\\project;secret\\public.txt " +
        "C:\\private-user\\project?secret\\public.txt " +
        "C:\\private-user\\project#secret\\public.txt",
    );
  });

  it("does not treat a filesystem root as a replaceable text prefix", () => {
    expect(
      redactKnownLocalPathsInText(
        "remote https://example.test/path/to/result",
        [{ absolutePath: "/", replacement: "$CONFIG_DIR" }],
      ),
    ).toBe("remote https://example.test/path/to/result");
  });

  it("removes home, temp, and otherwise unknown file URLs from text", () => {
    const homePath = path.join(os.homedir(), "private", "secret.txt");
    const tempPath = path.join(os.tmpdir(), "private", "secret.txt");
    const sanitized = redactKnownLocalPathsInText(
      `home ${homePath}; temp ${tempPath}; ` +
        "file (file:///unknown/private/secret.txt); continue",
      [
        { absolutePath: os.homedir(), replacement: "$LOCAL_FILE" },
        { absolutePath: os.tmpdir(), replacement: "$LOCAL_FILE" },
      ],
    );

    expect(sanitized).not.toContain(os.homedir());
    expect(sanitized).not.toContain(os.tmpdir());
    expect(sanitized).not.toContain("file://");
    expect(sanitized).toContain("$LOCAL_FILE");
    expect(sanitized).toContain(
      "file ($LOCAL_FILE); continue",
    );
  });
});
