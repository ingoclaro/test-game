/**
 * Local PeerJS signaling broker for development / LAN testing.
 *
 * The public cloud broker (0.peerjs.com) is firewalled on some networks, so this
 * lets you run your own. Point the app at it with the broker query params, e.g.:
 *
 *   http://localhost:3000/?bhost=localhost&bport=9000&bpath=/myapp&bsecure=0
 *
 * Override host/port/path via env vars: BROKER_PORT, BROKER_PATH.
 */
import { PeerServer } from "peer";

const port = Number(process.env.BROKER_PORT ?? 9000);
const path = process.env.BROKER_PATH ?? "/myapp";

const server = PeerServer({ port, path });

server.on("connection", (client) => console.log("peer connected:", client.getId()));
server.on("disconnect", (client) => console.log("peer disconnected:", client.getId()));

console.log(`PeerServer broker running at http://localhost:${port}${path}`);
console.log(`Point the app at it with: ?bhost=localhost&bport=${port}&bpath=${path}&bsecure=0`);
