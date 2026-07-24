import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Builder, LocalSigner } from "@contentauth/c2pa-node";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(fixtureDirectory, "..", "..");
const assetDirectory = path.join(fixtureDirectory, "assets");
const certificateDirectory = path.join(
  repositoryDirectory,
  "tests",
  "fixtures",
  "certs",
);
const width = 1200;
const height = 630;

const glyphs = {
  "2": ["11110", "00001", "00001", "01110", "10000", "10000", "11111"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ">": ["10000", "01000", "00100", "00010", "00100", "01000", "10000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return chunk;
}

function setPixel(pixels, x, y, [red, green, blue, alpha = 255]) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 4;
  pixels[offset] = red;
  pixels[offset + 1] = green;
  pixels[offset + 2] = blue;
  pixels[offset + 3] = alpha;
}

function drawRectangle(pixels, x, y, rectangleWidth, rectangleHeight, color) {
  for (let row = y; row < y + rectangleHeight; row += 1) {
    for (let column = x; column < x + rectangleWidth; column += 1) {
      setPixel(pixels, column, row, color);
    }
  }
}

function drawText(pixels, text, x, y, scale, color) {
  let cursor = x;
  for (const character of text) {
    const glyph = glyphs[character];
    if (!glyph) {
      throw new Error(`No fixture-card glyph is defined for "${character}".`);
    }
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") {
          drawRectangle(
            pixels,
            cursor + column * scale,
            y + row * scale,
            scale,
            scale,
            color,
          );
        }
      }
    }
    cursor += 6 * scale;
  }
}

function createFixtureCard() {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const horizontal = x / width;
      const vertical = y / height;
      setPixel(pixels, x, y, [
        Math.round(13 + horizontal * 22),
        Math.round(24 + vertical * 24),
        Math.round(46 + horizontal * 34),
        255,
      ]);
    }
  }

  drawRectangle(pixels, 0, 0, 24, height, [83, 230, 176, 255]);
  drawRectangle(pixels, 84, 82, 1032, 466, [20, 35, 61, 255]);
  drawRectangle(pixels, 84, 82, 1032, 8, [83, 230, 176, 255]);
  drawText(pixels, "C2PA DELIVERY TEST", 128, 142, 8, [238, 247, 255, 255]);
  drawText(pixels, "SOURCE -> CDN", 210, 286, 10, [83, 230, 176, 255]);
  drawText(pixels, "PUBLIC TEST FIXTURE", 132, 446, 5, [159, 181, 213, 255]);
  drawText(pixels, "NOT TRUSTED", 786, 446, 5, [248, 174, 97, 255]);

  const rowLength = width * 4 + 1;
  const scanlines = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    scanlines[rowOffset] = 0;
    pixels.copy(
      scanlines,
      rowOffset + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const [certificate, privateKey] = await Promise.all([
    readFile(path.join(certificateDirectory, "es256.pub")),
    readFile(path.join(certificateDirectory, "es256.pem")),
  ]);
  const signer = LocalSigner.newSigner(certificate, privateKey, "es256");
  const unsignedCard = createFixtureCard();

  const sourceBuilder = Builder.withJson({
    claim_generator_info: [
      { name: "art50-ci public test fixtures", version: "0.3.0" },
    ],
    title: "c2pa-source.png",
    format: "image/png",
    instance_id: "xmp:iid:art50-ci-public-source-v1",
  });
  sourceBuilder.setIntent({
    create:
      "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  });
  const sourceDestination = { buffer: null };
  sourceBuilder.sign(
    signer,
    { buffer: unsignedCard, mimeType: "image/png" },
    sourceDestination,
  );
  if (!sourceDestination.buffer) {
    throw new Error("C2PA source signing produced no bytes.");
  }

  const deliveryBuilder = Builder.withJson({
    claim_generator_info: [
      { name: "art50-ci public test fixtures", version: "0.3.0" },
    ],
    title: "c2pa-delivered.png",
    format: "image/png",
    instance_id: "xmp:iid:art50-ci-public-delivered-v1",
  });
  deliveryBuilder.setIntent("update");
  const deliveryDestination = { buffer: null };
  deliveryBuilder.sign(
    signer,
    { buffer: sourceDestination.buffer, mimeType: "image/png" },
    deliveryDestination,
  );
  if (!deliveryDestination.buffer) {
    throw new Error("C2PA delivery signing produced no bytes.");
  }

  const assets = new Map([
    ["c2pa-source.png", sourceDestination.buffer],
    ["c2pa-delivered.png", deliveryDestination.buffer],
    ["c2pa-delivered-stripped.png", unsignedCard],
  ]);
  await mkdir(assetDirectory, { recursive: true });
  await Promise.all(
    [...assets].map(([name, bytes]) =>
      writeFile(path.join(assetDirectory, name), bytes),
    ),
  );

  const checksums = [...assets]
    .map(
      ([name, bytes]) =>
        `${createHash("sha256").update(bytes).digest("hex")}  assets/${name}`,
    )
    .join("\n");
  await writeFile(
    path.join(fixtureDirectory, "SHA256SUMS.txt"),
    `${checksums}\n`,
    "utf8",
  );
  process.stdout.write(
    `Generated ${assets.size} public test assets in ${assetDirectory}.\n`,
  );
}

await main();
