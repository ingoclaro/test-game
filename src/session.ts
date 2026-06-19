import { Peer, type DataConnection, type PeerOptions } from "peerjs";

/** Messages exchanged over the data channel. */
export type Message =
  | { type: "hello"; name: string }
  | { type: "chat"; name: string; text: string }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "game"; payload: unknown };

export type Role = "host" | "client";

export interface SessionEvents {
  onStatus: (status: string) => void;
  onPeerCountChange: (count: number) => void;
  onMessage: (msg: Message, fromName: string) => void;
  /** Free-form log line for the message panel (joins, leaves, reconnects). */
  onSystem: (text: string) => void;
  /** Payload from a peer's `game` message (artillery game protocol). */
  onGame: (payload: unknown) => void;
  /** Fired when the underlying peer is open and we know our own id. */
  onReady: (selfId: string) => void;
  /** Fired when the session cannot be established (e.g. host unreachable). */
  onFailed: (reason: string) => void;
  /** Client only: fired when auto-reconnect to the host gave up. */
  onReconnectFailed: () => void;
}

const CONNECT_TIMEOUT_MS = 8000;
// Auto-reconnect tuning for a client whose host dropped (e.g. host reloaded).
const RECONNECT_ATTEMPT_TIMEOUT_MS = 3000;
const RECONNECT_INTERVAL_MS = 1000;
const RECONNECT_MAX_MS = 45000;
// Heartbeat so a client notices a host that vanished without a clean close.
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 8000;

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
  private hostId?: string;
  private intentionalClose = false;
  private reconnecting = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt = 0;

  /** Resolves once we have verified connectivity (host open, or client connected). */
  readonly ready: Promise<void>;

  constructor(
    role: Role,
    opts: { hostId?: string; reclaimId?: string; brokerOptions?: PeerOptions; events: SessionEvents },
  ) {
    this.role = role;
    this.name = randomName();
    this.events = opts.events;
    this.hostId = opts.hostId;

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
        // Wait for the incoming connection to open before counting it, so any
        // immediate sends (e.g. the game's init message) aren't dropped.
        this.peer.on("connection", (conn) => {
          if (conn.open) this.registerConnection(conn);
          else conn.on("open", () => this.registerConnection(conn));
        });
      }
    });
  }

  private connectToHost(hostId: string, onOk: () => void, onFail: (reason: string) => void) {
    this.events.onStatus(`Connecting to ${hostId}…`);
    this.attemptConnect(hostId, CONNECT_TIMEOUT_MS)
      .then((conn) => {
        this.registerConnection(conn);
        this.send(conn, { type: "hello", name: this.name });
        this.events.onStatus("Connected to host");
        onOk();
      })
      .catch(() => onFail("Host unreachable"));
  }

  /** Opens a single data connection, resolving once it's open (or rejecting). */
  private attemptConnect(hostId: string, timeoutMs: number): Promise<DataConnection> {
    return new Promise<DataConnection>((resolve, reject) => {
      const conn = this.peer.connect(hostId, { reliable: true });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        conn.close();
        reject(new Error("timeout"));
      }, timeoutMs);

      conn.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(conn);
      });
      conn.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Client-side auto-rejoin: when the host connection drops (e.g. the host
   * browser reloaded and is reclaiming its id), keep retrying the same host id
   * until it comes back, or give up after RECONNECT_MAX_MS.
   */
  private async startReconnect() {
    if (this.reconnecting || this.intentionalClose || !this.hostId) return;
    this.reconnecting = true;
    this.events.onSystem("Lost connection to host — reconnecting…");

    const deadline = Date.now() + RECONNECT_MAX_MS;
    let attempt = 0;
    while (Date.now() < deadline && !this.intentionalClose && !this.peer.destroyed) {
      attempt++;
      this.events.onStatus(`Reconnecting to host… (attempt ${attempt})`);
      try {
        const conn = await this.attemptConnect(this.hostId, RECONNECT_ATTEMPT_TIMEOUT_MS);
        this.registerConnection(conn);
        this.send(conn, { type: "hello", name: this.name });
        this.events.onStatus("Connected to host");
        this.events.onSystem("Reconnected to host.");
        this.reconnecting = false;
        return;
      } catch {
        await delay(RECONNECT_INTERVAL_MS);
      }
    }

    this.reconnecting = false;
    if (!this.intentionalClose) this.events.onReconnectFailed();
  }

  private registerConnection(conn: DataConnection) {
    this.connections.set(conn.peer, conn);
    this.events.onPeerCountChange(this.connections.size);

    conn.on("data", (data) => this.handleData(conn, data as Message));
    conn.on("close", () => {
      this.connections.delete(conn.peer);
      this.events.onPeerCountChange(this.connections.size);
      // A client losing its host tries to rejoin; everything else is just a peer leaving.
      if (this.role === "client" && conn.peer === this.hostId && !this.intentionalClose) {
        this.stopHeartbeat();
        void this.startReconnect();
      } else {
        this.events.onSystem(`Peer ${conn.peer.slice(0, 6)}… left`);
      }
    });

    // Clients heartbeat the host so a silent disappearance is detected.
    if (this.role === "client" && conn.peer === this.hostId) this.startHeartbeat(conn);
  }

  private startHeartbeat(conn: DataConnection) {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.intentionalClose) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        // Host stopped answering — treat the connection as dead and rejoin.
        this.stopHeartbeat();
        this.connections.delete(conn.peer);
        this.events.onPeerCountChange(this.connections.size);
        try {
          conn.close();
        } catch {
          /* already closed */
        }
        void this.startReconnect();
        return;
      }
      try {
        this.send(conn, { type: "ping", t: performance.now() });
      } catch {
        /* connection going away; next tick will handle it */
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
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
        this.lastPongAt = Date.now();
        this.events.onMessage(msg, from.peer);
        break;
      case "game":
        this.events.onGame(msg.payload);
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

  /** Sends a game-protocol payload to all peers. */
  sendGame(payload: unknown) {
    for (const conn of this.connections.values()) this.send(conn, { type: "game", payload });
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
    this.intentionalClose = true;
    this.stopHeartbeat();
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.peer.destroy();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomName(): string {
  const animals = ["Fox", "Owl", "Wolf", "Bear", "Hawk", "Lynx", "Otter", "Raven"];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${animal}-${Math.floor(Math.random() * 1000)}`;
}
