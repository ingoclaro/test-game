import type { PeerOptions } from "peerjs";

/**
 * Resolves PeerJS broker (signaling server) options.
 *
 * Default: the public PeerJS cloud broker (no options needed). Some networks
 * firewall `0.peerjs.com`, so the broker can be overridden via URL query params
 * — handy for pointing at a self-hosted PeerServer:
 *
 *   ?bhost=localhost&bport=9000&bpath=/myapp&bsecure=0
 *
 * Recognised params: bhost, bport, bpath, bsecure (1/0), bkey.
 */
export function resolveBrokerOptions(search = window.location.search): PeerOptions | undefined {
  const params = new URLSearchParams(search);
  const host = params.get("bhost");
  if (!host) return undefined;

  const options: PeerOptions = { host };
  const port = params.get("bport");
  if (port) options.port = Number(port);
  const path = params.get("bpath");
  if (path) options.path = path;
  const secure = params.get("bsecure");
  if (secure !== null) options.secure = secure === "1" || secure === "true";
  const key = params.get("bkey");
  if (key) options.key = key;

  return options;
}

/** Returns the subset of broker params that must be carried into share links. */
export function brokerParamString(search = window.location.search): string {
  const params = new URLSearchParams(search);
  const carry = new URLSearchParams();
  for (const k of ["bhost", "bport", "bpath", "bsecure", "bkey"]) {
    const v = params.get(k);
    if (v !== null) carry.set(k, v);
  }
  return carry.toString();
}
