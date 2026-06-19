import { mulberry32 } from "./rng.ts";

/**
 * Destructible terrain stored as a 2D solid/empty grid mask (a column-major
 * bitmap). Unlike a heightmap, this supports holes and overhangs: a shell that
 * hits the lower part of a hill clears a circular pocket of cells and leaves the
 * terrain above it intact.
 *
 * The host generates a surface heightmap and ships just that small array (see
 * protocol `init`); both peers then build the identical mask from it and carve
 * craters identically, so the terrain never diverges.
 */
export interface Terrain {
  width: number;
  height: number;
  cell: number;
  cols: number;
  rows: number;
  solid: Uint8Array; // col-major: index = col * rows + row, 1 = solid
  /** Cached render rectangles (one per vertical solid run), rebuilt on carve. */
  rects: { x: number; y: number; w: number; h: number }[];
}

/** Generates a surface heightmap (one y per grid column). Host-only — transmitted. */
export function generateHeights(seed: number, width: number, height: number, cell: number): number[] {
  const rand = mulberry32(seed);
  const cols = Math.floor(width / cell) + 1;

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
    const x = i * cell;
    let y = base;
    for (const o of octaves) y += o.amp * Math.sin((x / width) * Math.PI * 2 * o.freq + o.phase);
    heights[i] = Math.max(minY, Math.min(maxY, y));
  }
  return heights;
}

/** Builds the solid grid mask from a transmitted heightmap (both peers). */
export function buildTerrain(heights: number[], width: number, height: number, cell: number): Terrain {
  const cols = heights.length;
  const rows = Math.floor(height / cell);
  const solid = new Uint8Array(cols * rows);
  for (let col = 0; col < cols; col++) {
    const surfaceRow = Math.max(0, Math.min(rows, Math.round(heights[col] / cell)));
    const colBase = col * rows;
    for (let row = surfaceRow; row < rows; row++) solid[colBase + row] = 1;
  }
  const t: Terrain = { width, height, cell, cols, rows, solid, rects: [] };
  rebuildRects(t);
  return t;
}

/** Is the world point (x, y) inside solid terrain? */
export function solidAt(t: Terrain, x: number, y: number): boolean {
  const col = Math.floor(x / t.cell);
  const row = Math.floor(y / t.cell);
  if (col < 0 || col >= t.cols || row < 0 || row >= t.rows) return false;
  return t.solid[col * t.rows + row] === 1;
}

/** Y of the topmost solid cell in the column at world x (where a tank rests). */
export function surfaceY(t: Terrain, x: number): number {
  const col = Math.max(0, Math.min(t.cols - 1, Math.floor(x / t.cell)));
  const colBase = col * t.rows;
  for (let row = 0; row < t.rows; row++) {
    if (t.solid[colBase + row] === 1) return row * t.cell;
  }
  return t.height;
}

/**
 * Clears a circular pocket of cells, leaving any terrain above it intact.
 * Uses squared distance against cell centres, so it is identical on both peers.
 */
export function carveCrater(t: Terrain, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  const startCol = Math.max(0, Math.floor((cx - radius) / t.cell));
  const endCol = Math.min(t.cols - 1, Math.floor((cx + radius) / t.cell));
  const startRow = Math.max(0, Math.floor((cy - radius) / t.cell));
  const endRow = Math.min(t.rows - 1, Math.floor((cy + radius) / t.cell));
  const half = t.cell / 2;
  for (let col = startCol; col <= endCol; col++) {
    const cellX = col * t.cell + half;
    const dx = cellX - cx;
    const colBase = col * t.rows;
    for (let row = startRow; row <= endRow; row++) {
      const cellY = row * t.cell + half;
      const dy = cellY - cy;
      if (dx * dx + dy * dy <= r2) t.solid[colBase + row] = 0;
    }
  }
  rebuildRects(t);
}

/** Recomputes the cached render rectangles (one per vertical solid run). */
function rebuildRects(t: Terrain): void {
  const rects: Terrain["rects"] = [];
  for (let col = 0; col < t.cols; col++) {
    const colBase = col * t.rows;
    let runStart = -1;
    for (let row = 0; row <= t.rows; row++) {
      const filled = row < t.rows && t.solid[colBase + row] === 1;
      if (filled && runStart === -1) {
        runStart = row;
      } else if (!filled && runStart !== -1) {
        rects.push({
          x: col * t.cell,
          y: runStart * t.cell,
          w: t.cell + 1,
          h: (row - runStart) * t.cell,
        });
        runStart = -1;
      }
    }
  }
  t.rects = rects;
}
