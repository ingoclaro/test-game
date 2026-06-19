/** Tiny typed wrapper around localStorage for the session we belong to. */

export type Role = "host" | "client";

const ROLE_KEY = "p2p.role";
const SERVER_ID_KEY = "p2p.serverId";

export function saveSession(role: Role, serverId: string): void {
  localStorage.setItem(ROLE_KEY, role);
  localStorage.setItem(SERVER_ID_KEY, serverId);
}

export function loadSession(): { role: Role; serverId: string } | null {
  const role = localStorage.getItem(ROLE_KEY) as Role | null;
  const serverId = localStorage.getItem(SERVER_ID_KEY);
  if ((role === "host" || role === "client") && serverId) {
    return { role, serverId };
  }
  return null;
}

export function clearSession(): void {
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(SERVER_ID_KEY);
}
