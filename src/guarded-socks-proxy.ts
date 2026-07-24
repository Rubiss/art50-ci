import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  normalizeHostname,
  type PinnedDestination,
} from "./network-policy.js";

export interface NetworkViolation {
  destination: string;
  reason: string;
}

export class DestinationPinStore {
  readonly #pins = new Map<string, PinnedDestination>();

  authorize(destination: PinnedDestination): void {
    this.#pins.set(
      this.#key(destination.hostname, destination.port),
      destination,
    );
    this.#pins.set(
      this.#key(destination.selected.address, destination.port),
      destination,
    );
  }

  get(hostname: string, port: number): PinnedDestination | undefined {
    return this.#pins.get(this.#key(hostname, port));
  }

  clear(): void {
    this.#pins.clear();
  }

  #key(hostname: string, port: number): string {
    return `${normalizeHostname(hostname)}:${port}`;
  }
}

export interface GuardedSocksProxy {
  url: string;
  violations(): readonly NetworkViolation[];
  close(): Promise<void>;
}

export interface GuardedSocksProxyOptions {
  handshakeTimeoutMs?: number;
  connectTimeoutMs?: number;
}

function ipv6FromBytes(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
}

export async function startGuardedSocksProxy(
  pins: DestinationPinStore,
  options: GuardedSocksProxyOptions = {},
): Promise<GuardedSocksProxy> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const violations: NetworkViolation[] = [];
  const sockets = new Set<Socket>();
  let activeConnections = 0;
  const maxConnections = 64;

  const server: Server = createServer((client) => {
    sockets.add(client);
    activeConnections += 1;
    client.setTimeout(handshakeTimeoutMs);
    client.on("timeout", () => client.destroy());
    client.on("error", () => undefined);
    let stage:
      | "greeting"
      | "request"
      | "connecting"
      | "connected"
      | "closed" = "greeting";
    let upstream: Socket | null = null;
    client.on("close", () => {
      sockets.delete(client);
      activeConnections -= 1;
      stage = "closed";
      upstream?.destroy();
    });

    if (activeConnections > maxConnections) {
      violations.push({
        destination: "connection",
        reason: "The guarded proxy connection limit was exceeded.",
      });
      client.destroy();
      return;
    }

    let buffered = Buffer.alloc(0);
    const reject = (code: number, destination: string, reason: string): void => {
      if (stage === "closed") {
        return;
      }
      const rejectedStage = stage;
      stage = "closed";
      violations.push({ destination, reason });
      if (!client.destroyed && rejectedStage !== "greeting") {
        client.write(
          Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
        );
      }
      client.end();
    };

    const onClientData = (chunk: Buffer): void => {
      if (stage === "connecting") {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 64 * 1024) {
          client.destroy();
        }
        return;
      }
      if (stage === "connected" || stage === "closed") {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 512) {
        reject(0x01, "handshake", "SOCKS handshake exceeded 512 bytes.");
        return;
      }

      if (stage === "greeting") {
        if (buffered.length < 2) {
          return;
        }
        const methodCount = buffered[1]!;
        if (buffered.length < 2 + methodCount) {
          return;
        }
        const version = buffered[0]!;
        const methods = buffered.subarray(2, 2 + methodCount);
        buffered = buffered.subarray(2 + methodCount);
        if (version === 0x05 && methods.includes(0x00)) {
          client.write(Buffer.from([0x05, 0x00]));
          stage = "request";
        } else {
          client.write(Buffer.from([0x05, 0xff]));
          client.end();
          return;
        }
      }

      if (stage !== "request" || buffered.length < 4) {
        return;
      }
      if (buffered[0] !== 0x05 || buffered[1] !== 0x01) {
        reject(0x07, "request", "Only SOCKS5 CONNECT is supported.");
        return;
      }

      const addressType = buffered[3]!;
      let addressLength: number;
      let addressOffset: number;
      if (addressType === 0x01) {
        addressLength = 4;
        addressOffset = 4;
      } else if (addressType === 0x04) {
        addressLength = 16;
        addressOffset = 4;
      } else if (addressType === 0x03) {
        if (buffered.length < 5) {
          return;
        }
        addressLength = buffered[4]!;
        addressOffset = 5;
      } else {
        reject(0x08, "request", "Unsupported SOCKS address type.");
        return;
      }
      const requestLength = addressOffset + addressLength + 2;
      if (buffered.length < requestLength) {
        return;
      }

      const addressBytes = buffered.subarray(
        addressOffset,
        addressOffset + addressLength,
      );
      const hostname =
        addressType === 0x01
          ? [...addressBytes].join(".")
          : addressType === 0x04
            ? ipv6FromBytes(addressBytes)
            : addressBytes.toString("ascii");
      const port = buffered.readUInt16BE(addressOffset + addressLength);
      const destinationLabel = `${normalizeHostname(hostname)}:${port}`;
      const pin = pins.get(hostname, port);
      if (!pin) {
        reject(
          0x02,
          destinationLabel,
          "Destination had no policy-authorized pinned address.",
        );
        return;
      }

      stage = "connecting";
      buffered = buffered.subarray(requestLength);
      client.pause();
      const connectingUpstream = createConnection({
        host: pin.selected.address,
        port,
        family: pin.selected.family,
        timeout: connectTimeoutMs,
      });
      upstream = connectingUpstream;
      sockets.add(connectingUpstream);
      connectingUpstream.on("timeout", () => {
        reject(
          0x04,
          destinationLabel,
          "Connection to the pinned destination timed out.",
        );
        connectingUpstream.destroy();
      });
      connectingUpstream.on("error", () => {
        if (stage === "connecting") {
          reject(
            0x05,
            destinationLabel,
            "Connection to the pinned destination failed.",
          );
        } else if (stage === "connected") {
          client.destroy();
        }
      });
      connectingUpstream.on("close", () =>
        sockets.delete(connectingUpstream),
      );
      connectingUpstream.on("connect", () => {
        if (stage !== "connecting") {
          connectingUpstream.destroy();
          return;
        }
        stage = "connected";
        const pending = buffered;
        buffered = Buffer.alloc(0);
        client.off("data", onClientData);
        client.setTimeout(0);
        connectingUpstream.setTimeout(0);
        client.write(
          Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
        );
        if (pending.length > 0) {
          connectingUpstream.write(pending);
        }
        client.pipe(connectingUpstream);
        connectingUpstream.pipe(client);
        client.resume();
      });
    };
    client.on("data", onClientData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the guarded browser proxy.");
  }

  return {
    url: `socks5://127.0.0.1:${address.port}`,
    violations: () => [...violations],
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
