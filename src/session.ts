import { Peer, type DataConnection, type PeerOptions } from "peerjs";

/** Messages exchanged over the data channel. */
export type Message =
  | { type: "hello"; name: string }
  | { type: "chat"; name: string; text: string }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

export type Role = "host" | "client";

export interface SessionEvents {
  onStatus: (status: string) => void;
  onPeerCountChange: (count: number) => void;
  onMessage: (msg: Message, fromName: string) => void;
  /** Fired when the underlying peer is open and we know our own id. */
  onReady: (selfId: string) => void;
  /** Fired when the session cannot be established (e.g. host unreachable). */
  onFailed: (reason: string) => void;
}

const CONNECT_TIMEOUT_MS = 8000;

/**
 * Manages a PeerJS session in either `host` or `client` mode.
 *
 * Topology is a star: the host is the hub and relays chat messages to every
 * connected peer, so a PoC with >2 participants still sees all traffic.
 */
export class Session {
  readonly role: Role;
  readonly name: string;
  private peer: Peer;
  private connections = new Map<string, DataConnection>();
  private events: SessionEvents;

  /** Resolves once we have verified connectivity (host open, or client connected). */
  readonly ready: Promise<void>;

  constructor(
    role: Role,
    opts: { hostId?: string; reclaimId?: string; brokerOptions?: PeerOptions; events: SessionEvents },
  ) {
    this.role = role;
    this.name = randomName();
    this.events = opts.events;

    // A host may try to reclaim a previously-used id (creator browser reload).
    // brokerOptions lets callers point at a self-hosted PeerServer.
    const broker = opts.brokerOptions;
    this.peer = opts.reclaimId
      ? new Peer(opts.reclaimId, broker)
      : broker
        ? new Peer(broker)
        : new Peer();

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        this.events.onFailed(reason);
        reject(new Error(reason));
      };

      this.peer.on("open", (id) => {
        this.events.onReady(id);
        if (role === "host") {
          this.events.onStatus("Hosting — waiting for peers");
          if (!settled) {
            settled = true;
            resolve();
          }
        } else {
          this.connectToHost(opts.hostId!, () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          }, fail);
        }
      });

      this.peer.on("error", (err) => {
        // `unavailable-id` means the reclaim failed — surface it to the caller.
        fail(err.type ?? String(err));
      });

      if (role === "host") {
        this.peer.on("connection", (conn) => this.registerConnection(conn));
      }
    });
  }

  private connectToHost(hostId: string, onOk: () => void, onFail: (reason: string) => void) {
    this.events.onStatus(`Connecting to ${hostId}…`);
    const conn = this.peer.connect(hostId, { reliable: true });

    const timer = setTimeout(() => {
      onFail("Host unreachable (timeout)");
      conn.close();
    }, CONNECT_TIMEOUT_MS);

    conn.on("open", () => {
      clearTimeout(timer);
      this.registerConnection(conn);
      this.send(conn, { type: "hello", name: this.name });
      this.events.onStatus("Connected to host");
      onOk();
    });

    conn.on("error", () => {
      clearTimeout(timer);
      onFail("Connection error");
    });
  }

  private registerConnection(conn: DataConnection) {
    this.connections.set(conn.peer, conn);
    this.events.onPeerCountChange(this.connections.size);

    conn.on("data", (data) => this.handleData(conn, data as Message));
    conn.on("close", () => {
      this.connections.delete(conn.peer);
      this.events.onPeerCountChange(this.connections.size);
      this.events.onStatus(`Peer ${conn.peer.slice(0, 6)}… left`);
    });
  }

  private handleData(from: DataConnection, msg: Message) {
    switch (msg.type) {
      case "hello":
        this.events.onMessage(msg, msg.name);
        break;
      case "chat":
        this.events.onMessage(msg, msg.name);
        // Host relays chat to all other peers (star topology).
        if (this.role === "host") this.relay(msg, from.peer);
        break;
      case "ping":
        this.send(from, { type: "pong", t: msg.t });
        break;
      case "pong":
        this.events.onMessage(msg, from.peer);
        break;
    }
  }

  private relay(msg: Message, exceptPeerId: string) {
    for (const [peerId, conn] of this.connections) {
      if (peerId !== exceptPeerId) this.send(conn, msg);
    }
  }

  private send(conn: DataConnection, msg: Message) {
    conn.send(msg);
  }

  /** Broadcasts a chat message to all peers and echoes it locally. */
  sendChat(text: string) {
    const msg: Message = { type: "chat", name: this.name, text };
    for (const conn of this.connections.values()) this.send(conn, msg);
    this.events.onMessage(msg, this.name);
  }

  /** Sends a ping to the first peer and resolves with the round-trip time (ms). */
  ping(): Promise<number> {
    const conn = this.connections.values().next().value as DataConnection | undefined;
    if (!conn) return Promise.reject(new Error("No peers connected"));

    return new Promise<number>((resolve, reject) => {
      const t = performance.now();
      const timer = setTimeout(() => {
        conn.off("data", onData);
        reject(new Error("Ping timed out"));
      }, CONNECT_TIMEOUT_MS);

      const onData = (data: unknown) => {
        const msg = data as Message;
        if (msg.type === "pong" && msg.t === t) {
          clearTimeout(timer);
          conn.off("data", onData);
          resolve(performance.now() - t);
        }
      };
      conn.on("data", onData);
      this.send(conn, { type: "ping", t });
    });
  }

  get peerCount(): number {
    return this.connections.size;
  }

  get selfId(): string {
    return this.peer.id;
  }

  destroy() {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.peer.destroy();
  }
}

function randomName(): string {
  const animals = ["Fox", "Owl", "Wolf", "Bear", "Hawk", "Lynx", "Otter", "Raven"];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${animal}-${Math.floor(Math.random() * 1000)}`;
}
