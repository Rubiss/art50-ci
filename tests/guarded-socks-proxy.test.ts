import { once } from "node:events";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { describe, expect, it } from "vitest";
import {
  DestinationPinStore,
  startGuardedSocksProxy,
} from "../src/guarded-socks-proxy.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port.");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readExactly(
  socket: Socket,
  length: number,
  timeoutMs = 2_000,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after reading ${bytes} of ${length} bytes.`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= length) {
        cleanup();
        resolve(Buffer.concat(chunks, bytes).subarray(0, length));
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Socket closed after reading ${bytes} of ${length} bytes.`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function openTunnel(proxyUrl: string, destinationPort: number) {
  const parsedProxy = new URL(proxyUrl);
  const client = createConnection({
    host: parsedProxy.hostname,
    port: Number(parsedProxy.port),
  });
  await once(client, "connect");

  client.write(Buffer.from([0x05, 0x01, 0x00]));
  expect(await readExactly(client, 2)).toEqual(Buffer.from([0x05, 0x00]));

  client.write(
    Buffer.from([
      0x05,
      0x01,
      0x00,
      0x01,
      127,
      0,
      0,
      1,
      (destinationPort >> 8) & 0xff,
      destinationPort & 0xff,
    ]),
  );
  expect((await readExactly(client, 10)).subarray(0, 2)).toEqual(
    Buffer.from([0x05, 0x00]),
  );
  return client;
}

describe("guarded SOCKS proxy", () => {
  it("streams more than 64 KiB after connect and clears connect-only timeouts", async () => {
    const echoServer = createServer((socket) => socket.pipe(socket));
    const destinationPort = await listen(echoServer);
    const pins = new DestinationPinStore();
    const destinationUrl = new URL(
      `http://127.0.0.1:${destinationPort}/`,
    );
    pins.authorize({
      url: destinationUrl,
      origin: destinationUrl.origin,
      hostname: destinationUrl.hostname,
      port: destinationPort,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      selected: { address: "127.0.0.1", family: 4 },
      privateAccess: true,
    });
    const proxy = await startGuardedSocksProxy(pins, {
      handshakeTimeoutMs: 250,
      connectTimeoutMs: 250,
    });
    let client: Socket | null = null;

    try {
      client = await openTunnel(proxy.url, destinationPort);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const payload = Buffer.alloc(128 * 1024, 0x5a);
      client.write(payload);
      expect(await readExactly(client, payload.length)).toEqual(payload);
      expect(client.destroyed).toBe(false);
      expect(proxy.violations()).toEqual([]);
    } finally {
      client?.destroy();
      await proxy.close();
      await closeServer(echoServer);
    }
  });
});
