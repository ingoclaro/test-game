# P2P Test Game

A proof of concept for **peer-to-peer connectivity** in the browser, built to be hosted on **GitHub Pages**. It uses [PeerJS](https://peerjs.com/) (WebRTC) for the P2P data channel, [Bun](https://bun.sh/) as the build tool, [KAPLAY](https://kaplayjs.com/) for the 2D game, and TypeScript throughout.

On top of the connection it ships a small **2-player artillery duel**: each player has a tank on opposite sides of randomly generated, destructible terrain, and they take turns lobbing physics-driven shells at each other.

## The game

- Two players, one tank each, on opposite sides of randomly generated terrain.
- **Drag from your tank to aim, release to fire** — works with mouse and with touch on phones. A dotted preview shows the trajectory.
- Shells follow gravity + wind; terrain is **destructible** (each hit carves a crater); splash/direct hits damage tanks. First to destroy the other wins, then **Rematch**.
- Turn-based **lockstep over P2P**: the host generates the terrain and sends the heightmap; the shooter sends only the start position + velocity, and both peers run an identical integer/float-only simulation, so terrain, craters, and damage stay perfectly in sync. (Verified: both peers produce byte-identical terrain before and after destruction.)

## How it works

- **Lobby** → click **Create Server**. Your browser becomes a PeerJS *host* and gets a sharable URL that embeds the server id (`?host=<id>`).
- Open that URL on another device/browser and it **auto-connects** to the host as a *client* — no extra clicks. The artillery game starts automatically once two players are connected (host = left tank, client = right tank).
- Before the game starts, the data channel also carries a small chat + latency **ping** used to validate connectivity.

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

# Starts BOTH the dev server (:3000) and a local signaling broker (:9000).
# A local broker is handy because the public cloud broker is firewalled on
# some networks. The command prints a ready-to-use URL with the broker params:
#   http://localhost:3000/?bhost=localhost&bport=9000&bpath=/myapp&bsecure=0
bun run dev
```

Other scripts:

```bash
bun run broker         # run just the local broker (PeerServer on :9000)
bun run build          # production build into ./dist
bun run typecheck      # tsc --noEmit
```

> Opening plain `http://localhost:3000` uses the public cloud broker (same as production). Use the printed `?bhost=…` URL to use the local broker instead.

## Deploy to GitHub Pages

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`) using the official Pages actions:

- `actions/checkout@v4`
- `oven-sh/setup-bun@v2`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v3`
- `actions/deploy-pages@v5`

On every push to `main` it builds with Bun and publishes `./dist`. The build uses relative asset paths (`publicPath: "./"`) so it works from the `/test-game/` project subpath.

> **Required one-time setup (repo owner):** go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. This can't be automated — the workflow's `GITHUB_TOKEN` isn't allowed to create a Pages site, so the first deploy fails at "Setup Pages" until this is done. After enabling it, re-run the workflow (Actions → failed run → **Re-run jobs**) or push again.

The site will be available at `https://<user>.github.io/test-game/`.

## Project layout

```
src/
  index.html      # entry (Bun bundles HTML + TS + CSS)
  main.ts         # UI glue + bootstrap/reconnect logic + game wiring
  session.ts      # PeerJS host/client session manager (chat, ping, game channel)
  config.ts       # broker option resolution from URL params
  storage.ts      # localStorage helpers
  styles.css
  game/
    game.ts       # KAPLAY game: render, input (mouse+touch), turns, networking
    terrain.ts    # destructible heightmap: generate, query, carve craters
    physics.ts    # deterministic projectile simulation
    rng.ts        # mulberry32 seeded PRNG
    protocol.ts   # game message types (init / fire / rematch)
scripts/broker.ts # local PeerServer for dev/LAN testing
build.ts          # Bun build / dev server
.github/workflows/deploy.yml
```
