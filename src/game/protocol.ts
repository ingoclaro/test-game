/**
 * Messages exchanged for the artillery game, carried inside Session's generic
 * `game` envelope. Only minimal, already-computed values cross the wire so both
 * peers stay deterministically in sync.
 */
export type GameMessage =
  | {
      // Host → client: the shared terrain and match settings.
      kind: "init";
      heights: number[];
      cell: number;
      width: number;
      height: number;
      windSeed: number;
    }
  | {
      // Active player → peer: a fired shot, as start position + velocity.
      kind: "fire";
      startX: number;
      startY: number;
      vx: number;
      vy: number;
    }
  // Client → host: request a fresh match. Host replies with a new `init`.
  | { kind: "rematch" };
