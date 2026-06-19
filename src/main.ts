import { Session, type Message } from "./session.ts";
import { saveSession, loadSession, clearSession } from "./storage.ts";
import { resolveBrokerOptions, brokerParamString } from "./config.ts";
import { startGame, type GameController, type HudState } from "./game/game.ts";
import { type GameMessage } from "./game/protocol.ts";

// --- DOM helpers ----------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const lobby = $("lobby");
const sessionEl = $("session");
const createBtn = $<HTMLButtonElement>("create-server");
const lobbyStatus = $("lobby-status");
const roleBadge = $("role-badge");
const connStatus = $("conn-status");
const shareBlock = $("share-block");
const shareUrlInput = $<HTMLInputElement>("share-url");
const copyBtn = $<HTMLButtonElement>("copy-url");
const serverIdEl = $("server-id");
const peerCountEl = $("peer-count");
const pingBtn = $<HTMLButtonElement>("ping-btn");
const pingResult = $("ping-result");
const pingRow = $("ping-row");
const messagesEl = $("messages");
const chatForm = $<HTMLFormElement>("chat-form");
const chatInput = $<HTMLInputElement>("chat-input");
const chatSend = $<HTMLButtonElement>("chat-send");
const leaveBtn = $<HTMLButtonElement>("leave");

const gameSection = $("game");
const gameCanvas = $<HTMLCanvasElement>("game-canvas");
const turnIndicator = $("turn-indicator");
const hpYouEl = $("hp-you");
const hpFoeEl = $("hp-foe");
const windIndicator = $("wind-indicator");
const rematchBtn = $<HTMLButtonElement>("rematch");

let session: Session | null = null;
let gameController: GameController | null = null;
let gameStarted = false;
const gameBuffer: unknown[] = [];

// --- UI rendering ---------------------------------------------------------
function logSystem(text: string) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function logChat(who: string, text: string) {
  const div = document.createElement("div");
  div.className = "msg";
  const whoEl = document.createElement("span");
  whoEl.className = "who";
  whoEl.textContent = who + ":";
  div.appendChild(whoEl);
  div.appendChild(document.createTextNode(text));
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showSession(role: "host" | "client") {
  lobby.classList.add("hidden");
  sessionEl.classList.remove("hidden");
  roleBadge.textContent = role === "host" ? "HOST" : "CLIENT";
  roleBadge.classList.toggle("client", role === "client");
  shareBlock.classList.toggle("hidden", role !== "host");
}

function showLobby() {
  sessionEl.classList.add("hidden");
  lobby.classList.remove("hidden");
}

function enableChat(enabled: boolean) {
  chatInput.disabled = !enabled;
  chatSend.disabled = !enabled;
  pingBtn.disabled = !enabled;
}

function buildShareUrl(serverId: string): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(`host=${encodeURIComponent(serverId)}`);
  // Carry broker overrides so invitees use the same (reachable) signaling server.
  const broker = brokerParamString();
  if (broker) {
    for (const [k, v] of new URLSearchParams(broker)) params.set(k, v);
  }
  url.search = `?${params.toString()}`;
  url.hash = "";
  return url.toString();
}

// --- Session wiring -------------------------------------------------------
function wireSession(role: "host" | "client", opts: { hostId?: string; reclaimId?: string }) {
  showSession(role);
  connStatus.textContent = "Starting…";

  session = new Session(role, {
    ...opts,
    brokerOptions: resolveBrokerOptions(),
    events: {
      onStatus: (s) => (connStatus.textContent = s),
      onReady: (selfId) => {
        if (role === "host") {
          serverIdEl.textContent = selfId;
          shareUrlInput.value = buildShareUrl(selfId);
          saveSession("host", selfId);
        }
      },
      onPeerCountChange: (count) => {
        peerCountEl.textContent = String(count);
        enableChat(count > 0);
        if (count > 0 && !gameStarted) startGameSession(role);
      },
      onMessage: (msg: Message, fromName) => {
        if (msg.type === "chat") logChat(fromName, msg.text);
        else if (msg.type === "hello") logSystem(`${fromName} joined`);
      },
      onSystem: (text) => logSystem(text),
      onGame: (payload) => {
        if (gameController) gameController.handleMessage(payload as GameMessage);
        else gameBuffer.push(payload);
      },
      onFailed: (reason) => {
        connStatus.textContent = `Failed: ${reason}`;
      },
      onReconnectFailed: () => {
        // Host never came back within the retry window — treat as a dead server.
        logSystem("Host did not come back. Removing stale entry.");
        clearSession();
        cleanUrl();
        teardownToLobby();
      },
    },
  });

  if (role === "client") {
    serverIdEl.textContent = opts.hostId ?? "—";
  }

  session.ready
    .then(() => {
      if (role === "client") {
        // Connectivity confirmed — remember which server we belong to.
        saveSession("client", opts.hostId!);
      }
      logSystem(role === "host" ? "Server ready. Share the link to invite peers." : "Connected!");
    })
    .catch((err) => {
      logSystem(`Could not establish session: ${err.message}`);
      if (role === "client") {
        // "delete the entry if it's not working" — stale/dead server.
        clearSession();
        cleanUrl();
        logSystem("Removed stale server entry. Returning to lobby.");
        teardownToLobby();
      } else if (opts.reclaimId) {
        // Reclaiming the old id failed (likely taken). Start a fresh server.
        logSystem("Could not reclaim previous id — creating a fresh server.");
        session?.destroy();
        session = null;
        clearSession();
        wireSession("host", {});
      }
    });
}

function teardownToLobby() {
  teardownGame();
  session?.destroy();
  session = null;
  enableChat(false);
  peerCountEl.textContent = "0";
  showLobby();
}

// --- Game session ---------------------------------------------------------
function startGameSession(role: "host" | "client") {
  if (gameStarted || !session) return;
  gameStarted = true;

  // Focus the UI on the game: hide the chat/ping/share clutter.
  for (const el of [messagesEl, chatForm, pingRow, shareBlock]) el.classList.add("hidden");
  gameSection.classList.remove("hidden");

  const myIndex: 0 | 1 = role === "host" ? 0 : 1;
  gameController = startGame({
    canvas: gameCanvas,
    myIndex,
    isHost: role === "host",
    send: (msg) => session?.sendGame(msg),
    onHud: renderHud,
  });

  // Replay any game messages that arrived before the controller existed.
  while (gameBuffer.length > 0) {
    gameController.handleMessage(gameBuffer.shift() as GameMessage);
  }
}

function teardownGame() {
  gameController?.destroy();
  gameController = null;
  gameStarted = false;
  gameBuffer.length = 0;
  gameSection.classList.add("hidden");
}

function renderHud(hud: HudState) {
  hpYouEl.textContent = String(hud.hp[hud.myIndex]);
  hpFoeEl.textContent = String(hud.hp[hud.myIndex === 0 ? 1 : 0]);
  const dir = hud.wind >= 0 ? "→" : "←";
  windIndicator.innerHTML = `Wind ${dir}&nbsp;${Math.round(Math.abs(hud.wind))}`;

  if (hud.phase === "waiting") {
    turnIndicator.textContent = "Waiting…";
  } else if (hud.phase === "over") {
    turnIndicator.textContent =
      hud.winner === -1 ? "Draw" : hud.winner === hud.myIndex ? "You win!" : "You lose";
  } else if (hud.phase === "flying") {
    turnIndicator.textContent = "Incoming!";
  } else {
    turnIndicator.textContent = hud.myTurn ? "Your turn" : "Opponent's turn";
  }
  turnIndicator.classList.toggle("client", hud.myTurn);

  rematchBtn.classList.toggle("hidden", hud.phase !== "over");
}

rematchBtn.addEventListener("click", () => gameController?.requestRematch());

function cleanUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  window.history.replaceState({}, "", url.toString());
}

// --- Event handlers -------------------------------------------------------
createBtn.addEventListener("click", () => {
  lobbyStatus.textContent = "Creating server…";
  wireSession("host", {});
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !session) return;
  session.sendChat(text);
  chatInput.value = "";
});

pingBtn.addEventListener("click", async () => {
  if (!session) return;
  pingResult.textContent = "Pinging…";
  try {
    const rtt = await session.ping();
    pingResult.textContent = `Round-trip: ${rtt.toFixed(1)} ms`;
  } catch (err) {
    pingResult.textContent = (err as Error).message;
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  } catch {
    shareUrlInput.select();
  }
});

leaveBtn.addEventListener("click", () => {
  clearSession();
  cleanUrl();
  teardownToLobby();
});

// --- Bootstrap ------------------------------------------------------------
function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const hostFromUrl = params.get("host");

  // 1. A shared link always wins: join the referenced server as a client.
  if (hostFromUrl) {
    wireSession("client", { hostId: hostFromUrl });
    return;
  }

  // 2. Otherwise try to restore a previous session from localStorage.
  const saved = loadSession();
  if (saved) {
    if (saved.role === "host") {
      // Creator browser reload: reclaim the same server id so existing
      // share links keep working.
      logSystem("Restoring your server…");
      wireSession("host", { reclaimId: saved.serverId });
    } else {
      // Client reload: re-check connectivity; the .catch in wireSession
      // clears the entry if the server is gone.
      logSystem("Reconnecting to your server…");
      wireSession("client", { hostId: saved.serverId });
    }
    return;
  }

  // 3. Nothing to restore — show the lobby.
  showLobby();
}

// Close connections promptly when the page goes away (e.g. a host reloading),
// so connected clients detect the drop fast and can auto-rejoin.
window.addEventListener("pagehide", () => session?.destroy());

bootstrap();
