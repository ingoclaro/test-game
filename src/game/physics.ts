import { type Terrain, solidAt } from "./terrain.ts";

export interface Vec {
  x: number;
  y: number;
}

export interface ShotResult {
  points: Vec[];
  impact: Vec;
  /** Index of a tank that took a direct hit, or null for a terrain/air impact. */
  directHit: number | null;
}

export const SIM_DT = 1 / 120;

/**
 * Deterministically simulates a projectile from a start position and velocity.
 *
 * Crucially, the shooter computes `start` and `velocity` (which involve sin/cos)
 * and transmits them; this function then uses only +,-,*,/ and comparisons, so
 * both peers replay the identical trajectory, crater and damage.
 */
export function simulateShot(
  start: Vec,
  velocity: Vec,
  terrain: Terrain,
  opts: { gravity: number; wind: number; tanks: { x: number; y: number; index: number }[]; tankRadius: number },
): ShotResult {
  const points: Vec[] = [];
  let x = start.x;
  let y = start.y;
  let vx = velocity.x;
  let vy = velocity.y;
  const maxSteps = 4000;

  for (let step = 0; step < maxSteps; step++) {
    vx += opts.wind * SIM_DT;
    vy += opts.gravity * SIM_DT;
    x += vx * SIM_DT;
    y += vy * SIM_DT;
    points.push({ x, y });

    // Direct tank hit.
    for (const tank of opts.tanks) {
      const dx = x - tank.x;
      const dy = y - tank.y;
      if (dx * dx + dy * dy <= opts.tankRadius * opts.tankRadius) {
        return { points, impact: { x, y }, directHit: tank.index };
      }
    }

    // Terrain hit.
    if (solidAt(terrain, x, y)) {
      return { points, impact: { x, y }, directHit: null };
    }

    // Left/right walls: bounce off the sides to keep the shell in play.
    if (x < 0) {
      x = 0;
      vx = Math.abs(vx);
    } else if (x > terrain.width) {
      x = terrain.width;
      vx = -Math.abs(vx);
    }

    // Fell below the world without hitting anything.
    if (y > terrain.height) {
      return { points, impact: { x, y }, directHit: null };
    }
  }

  return { points, impact: { x, y }, directHit: null };
}
