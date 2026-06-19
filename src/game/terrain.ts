import { mulberry32 } from "./rng.ts";

/**
 * Destructible terrain stored as a per-column heightmap (surface y per column,
 * with y growing downwards, so a smaller value is higher ground).
 *
 * The host generates the terrain and ships the `heights` array to the client
 * (see protocol `init`). Both peers therefore share the exact same array, so
 * even though generation uses Math.sin (which can differ across engines), there
 * is never any divergence — only the host ever generates.
 */
export interface Terrain {
  width: number;
  height: number;
  columnWidth: number;
  heights: number[];
}

/** Generates rolling hills from a seed. Host-only — result is transmitted. */
export function generateTerrain(seed: number, width: number, height: number, columnWidth: number): Terrain {
  const rand = mulberry32(seed);
  const cols = Math.floor(width / columnWidth) + 1;

  // A few sine octaves with random amplitude/phase make smooth, varied hills.
  const base = height * 0.62;
  const octaves = [
    { amp: height * 0.16, freq: 1 + rand() * 1.5, phase: rand() * Math.PI * 2 },
    { amp: height * 0.08, freq: 2.5 + rand() * 2, phase: rand() * Math.PI * 2 },
    { amp: height * 0.04, freq: 5 + rand() * 3, phase: rand() * Math.PI * 2 },
  ];

  const minY = height * 0.28;
  const maxY = height * 0.9;
  const heights: number[] = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const x = i * columnWidth;
    let y = base;
    for (const o of octaves) y += o.amp * Math.sin((x / width) * Math.PI * 2 * o.freq + o.phase);
    heights[i] = Math.max(minY, Math.min(maxY, y));
  }
  return { width, height, columnWidth, heights };
}

/** Rebuilds a Terrain from the transmitted array (client side). */
export function terrainFromHeights(
  heights: number[],
  width: number,
  height: number,
  columnWidth: number,
): Terrain {
  return { width, height, columnWidth, heights: heights.slice() };
}

/** Surface y at world x, linearly interpolated between columns (deterministic). */
export function heightAt(t: Terrain, x: number): number {
  const c = x / t.columnWidth;
  const i = Math.floor(c);
  if (i < 0) return t.heights[0];
  if (i >= t.heights.length - 1) return t.heights[t.heights.length - 1];
  const frac = c - i;
  return t.heights[i] * (1 - frac) + t.heights[i + 1] * frac;
}

/**
 * Carves a circular crater centred at (cx, cy). For each affected column the
 * surface is lowered to the bottom of the blast circle, producing a dish.
 * Uses only +,-,*,/,sqrt so it is identical on both peers.
 */
export function carveCrater(t: Terrain, cx: number, cy: number, radius: number): void {
  const startCol = Math.max(0, Math.floor((cx - radius) / t.columnWidth));
  const endCol = Math.min(t.heights.length - 1, Math.ceil((cx + radius) / t.columnWidth));
  for (let i = startCol; i <= endCol; i++) {
    const colX = i * t.columnWidth;
    const dx = colX - cx;
    const inside = radius * radius - dx * dx;
    if (inside <= 0) continue;
    const dy = Math.sqrt(inside);
    const craterBottom = cy + dy;
    // Only dig where the blast actually reaches below the existing surface.
    if (craterBottom > t.heights[i]) {
      t.heights[i] = Math.min(craterBottom, t.height);
    }
  }
}
