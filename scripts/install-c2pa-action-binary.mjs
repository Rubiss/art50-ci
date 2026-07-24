import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import unzipper from "unzipper";

const version = "0.6.4";
const releaseTag = encodeURIComponent(`@contentauth/c2pa-node@${version}`);
const binaries = {
  x64: {
    target: "x86_64-unknown-linux-gnu",
    sha256: "fc645619ae218921b46befa031dea4def2981dc541e91a7860add4634fec5aad",
  },
  arm64: {
    target: "aarch64-unknown-linux-gnu",
    sha256: "07b855f150a267fa0593db355eb39a77f4ffdbe54306e50860678c3ed45d0178",
  },
};

function fail(message) {
  throw new Error(`Pinned C2PA binary installation failed: ${message}`);
}

const binary = binaries[os.arch()];
if (!binary || os.platform() !== "linux") {
  fail(`unsupported platform ${os.platform()}/${os.arch()}`);
}

const fileName = `c2pa-node_${binary.target}-v${version}.zip`;
const url =
  `https://github.com/contentauth/c2pa-js/releases/download/${releaseTag}/` +
  fileName;
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  fail(`download returned HTTP ${response.status}`);
}
if (!response.url.startsWith("https://")) {
  fail("download was redirected away from HTTPS");
}
const declaredLength = Number(response.headers.get("content-length") ?? "0");
if (declaredLength > 100 * 1024 * 1024) {
  fail("download exceeded the 100 MiB archive limit");
}

const archive = Buffer.from(await response.arrayBuffer());
if (archive.byteLength === 0 || archive.byteLength > 100 * 1024 * 1024) {
  fail("downloaded archive was empty or exceeded 100 MiB");
}
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== binary.sha256) {
  fail(`SHA-256 mismatch (received ${digest})`);
}

const openedArchive = await unzipper.Open.buffer(archive);
const files = openedArchive.files.filter((entry) => entry.type === "File");
if (files.length !== 1) {
  fail(`archive contained ${files.length} files instead of one`);
}
const nativeEntry = files[0];
if (!nativeEntry || path.posix.basename(nativeEntry.path) !== "index.node") {
  fail("archive did not contain exactly one index.node binary");
}
const nativeBinary = await nativeEntry.buffer();
if (nativeBinary.byteLength === 0 || nativeBinary.byteLength > 100 * 1024 * 1024) {
  fail("extracted binary was empty or exceeded 100 MiB");
}

const actionPath = process.env.GITHUB_ACTION_PATH;
if (!actionPath) {
  fail("GITHUB_ACTION_PATH is unavailable");
}
const destinationDirectory = path.join(
  actionPath,
  "node_modules",
  "@contentauth",
  "c2pa-node",
  "dist",
);
await mkdir(destinationDirectory, { recursive: true });
await writeFile(path.join(destinationDirectory, "index.node"), nativeBinary, {
  mode: 0o644,
});
process.stdout.write(
  `Installed ${fileName} after verifying SHA-256 ${binary.sha256}.\n`,
);
