# P2P Test Game

A proof of concept for **peer-to-peer connectivity** in the browser, built to be hosted on **GitHub Pages**. It uses [PeerJS](https://peerjs.com/) (WebRTC) for the P2P data channel, [Bun](https://bun.sh/) as the build tool, and TypeScript throughout.

The "game" is intentionally minimal — a shared chat plus a latency **ping** — so the focus stays on proving the connection works.

## How it works

- **Lobby** → click **Create Server**. Your browser becomes a PeerJS *host* and gets a sharable URL that embeds the server id (`?host=<id>`).
- Open that URL on another device/browser and it **auto-connects** to the host as a *client* — no extra clicks.
- The host is the hub of a star topology and relays chat to every connected peer, so 3+ participants all see each other's messages.
- **Ping** measures the WebRTC data-channel round-trip time.

### Signaling broker

WebRTC needs a signaling server only to *introduce* peers; the media/data flows peer-to-peer afterwards. By default the app uses the **public PeerJS cloud broker** (`0.peerjs.com`), which requires no setup and works for GitHub Pages.

> ⚠️ Some networks/firewalls block `0.peerjs.com`. If `Create Server` fails with `server-error`, the broker is unreachable from your network — test from a network that allows it, or run your own broker (below).

You can override the broker via URL query params (handy for self-hosting or LAN testing):

```
?bhost=localhost&bport=9000&bpath=/myapp&bsecure=0
```

Recognised params: `bhost`, `bport`, `bpath`, `bsecure` (`1`/`0`), `bkey`. These are automatically carried into the sharable link so invitees use the same broker.

### Session persistence (localStorage)

The server id is stored in `localStorage` so a session survives a reload:

- **Client reload** → re-checks connectivity. If the host is gone (`peer-unavailable`/timeout) the stale entry is deleted and you're returned to the lobby.
- **Host reload (creator browser)** → reclaims the *same* server id, so existing share links keep working. If the id can't be reclaimed, it falls back to a fresh server.

### Auto-rejoin

Connected clients automatically rejoin a host that comes back:

- When the host browser **reloads**, it reclaims its id and clients re-establish the connection within a couple of seconds (no user action needed).
- A client **heartbeats** the host, so even a host that vanished without a clean close is detected within a few seconds. The client then retries the same host id for up to ~45s; if the host never returns, the stale entry is removed and the client falls back to the lobby.

## Develop locally

```bash
bun install

# 1) (optional) run a local signaling broker — useful if the public cloud is firewalled
bun run broker         # PeerServer on http://localhost:9000/myapp

# 2) run the dev server
bun run dev            # http://localhost:3000

# When using the local broker, open the app with the broker params:
#   http://localhost:3000/?bhost=localhost&bport=9000&bpath=/myapp&bsecure=0
```

Other scripts:

```bash
bun run build          # production build into ./dist
bun run typecheck      # tsc --noEmit
```

## Deploy to GitHub Pages

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`) using the official Pages actions:

- `actions/checkout@v4`
- `oven-sh/setup-bun@v2`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v3`
- `actions/deploy-pages@v5`

On every push to `main` it builds with Bun and publishes `./dist`. The build uses relative asset paths (`publicPath: "./"`) so it works from the `/test-game/` project subpath.

**One-time setup:** in the repository, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.

The site will be available at `https://<user>.github.io/test-game/`.

## Project layout

```
src/
  index.html      # entry (Bun bundles HTML + TS + CSS)
  main.ts         # UI glue + bootstrap/reconnect logic
  session.ts      # PeerJS host/client session manager
  config.ts       # broker option resolution from URL params
  storage.ts      # localStorage helpers
  styles.css
scripts/broker.ts # local PeerServer for dev/LAN testing
build.ts          # Bun build / dev server
.github/workflows/deploy.yml
```
