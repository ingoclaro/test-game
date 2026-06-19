import kaplay from "kaplay";
import {
  type Terrain,
  generateHeights,
  buildTerrain,
  surfaceY,
  carveCrater,
} from "./terrain.ts";
import { simulateShot, type ShotResult, type Vec, SIM_DT } from "./physics.ts";
import { mulberry32 } from "./rng.ts";
import { type GameMessage } from "./protocol.ts";

// Fixed virtual resolution shared by both peers, regardless of device size.
const W = 1280;
const H = 720;
const CELL = 4;

const TANK_W = 38;
const TANK_H = 16;
const BARREL_LEN = 28;
const TANK_R = 20;

const GRAVITY = 720;
const WIND_MAX = 150;
const MIN_SPEED = 190;
const MAX_SPEED = 950;
const MAX_DRAG = 360;
const MIN_DRAG = 12;

const CRATER_R = 50;
const DAMAGE_R = 100;
const MAX_DAMAGE = 55;
const DIRECT_BONUS = 25;

const FLIGHT_SPEED = 1.7;
const START_HP = 100;
// Only the launch stub of the trajectory is previewed, so players still have
// to judge gravity and wind themselves.
const PREVIEW_POINTS = 26;

type Phase = "waiting" | "aim" | "flying" | "over";

export interface HudState {
  phase: Phase;
  myTurn: boolean;
  hp: [number, number];
  wind: number;
  winner: number | null; // 0 | 1 | -1 (draw) | null
  myIndex: 0 | 1;
}

export interface StartGameOptions {
  canvas: HTMLCanvasElement;
  myIndex: 0 | 1;
  isHost: boolean;
  send: (msg: GameMessage) => void;
  onHud: (hud: HudState) => void;
}

export interface GameController {
  handleMessage: (msg: GameMessage) => void;
  requestRematch: () => void;
  destroy: () => void;
}

interface Tank {
  index: 0 | 1;
  x: number;
  surfaceY: number;
  hp: number;
  barrel: Vec; // unit aim direction
}

const PLAYER_COLORS: [[number, number, number], [number, number, number]] = [
  [90, 150, 255],
  [255, 96, 96],
];

export function startGame(opts: StartGameOptions): GameController {
  const k = kaplay({
    canvas: opts.canvas,
    width: W,
    height: H,
    stretch: true,
    letterbox: true,
    background: [22, 26, 46],
    global: false,
    touchToMouse: true,
    pixelDensity: Math.min(window.devicePixelRatio || 1, 2),
  });

  let terrain: Terrain | null = null;
  let wind = 0;
  let windRand: () => number = () => 0.5;
  let tanks: Tank[] = [];
  let currentTurn: 0 | 1 = 0;
  let phase: Phase = opts.isHost ? "aim" : "waiting";
  let winner: number | null = null;

  let aiming = false;
  let aimPos: Vec = { x: 0, y: 0 };

  let shot: ShotResult | null = null;
  let flightTime = 0;

  const tankCenter = (t: Tank): Vec => ({ x: t.x, y: t.surfaceY - TANK_H / 2 });
  const barrelPivot = (t: Tank): Vec => ({ x: t.x, y: t.surfaceY - TANK_H });

  function emitHud() {
    opts.onHud({
      phase,
      myTurn: currentTurn === opts.myIndex && phase === "aim",
      hp: [tanks[0]?.hp ?? 0, tanks[1]?.hp ?? 0],
      wind,
      winner,
      myIndex: opts.myIndex,
    });
  }

  function reseatTanks() {
    if (!terrain) return;
    for (const t of tanks) t.surfaceY = surfaceY(terrain, t.x);
  }

  // Wind changes every turn. Both peers derive it from the same seeded PRNG,
  // advancing it in lockstep (once per resolved shot), so they always agree.
  function rollWind(): number {
    return (windRand() * 2 - 1) * WIND_MAX;
  }

  function setupMatch(t: Terrain, windSeed: number) {
    terrain = t;
    windRand = mulberry32(windSeed);
    wind = rollWind();
    tanks = [
      { index: 0, x: W * 0.1, surfaceY: surfaceY(t, W * 0.1), hp: START_HP, barrel: norm({ x: 1, y: -1 }) },
      { index: 1, x: W * 0.9, surfaceY: surfaceY(t, W * 0.9), hp: START_HP, barrel: norm({ x: -1, y: -1 }) },
    ];
    currentTurn = 0;
    winner = null;
    shot = null;
    aiming = false;
    phase = "aim";
    emitHud();
  }

  function newMatchAsHost() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const windSeed = (Math.random() * 0xffffffff) >>> 0;
    const heights = generateHeights(seed, W, H, CELL);
    const t = buildTerrain(heights, W, H, CELL);
    setupMatch(t, windSeed);
    opts.send({ kind: "init", heights, cell: CELL, width: W, height: H, windSeed });
  }

  function fireShot(start: Vec, velocity: Vec, fromNetwork: boolean) {
    if (!terrain || phase !== "aim") return;
    // Point the firing tank's barrel along the shot for a visual cue.
    tanks[currentTurn].barrel = norm(velocity);
    shot = simulateShot(start, velocity, terrain, {
      gravity: GRAVITY,
      wind,
      tanks: tanks.map((t) => ({ ...tankCenter(t), index: t.index })),
      tankRadius: TANK_R,
    });
    flightTime = 0;
    phase = "flying";
    aiming = false;
    if (!fromNetwork) {
      opts.send({ kind: "fire", startX: start.x, startY: start.y, vx: velocity.x, vy: velocity.y });
    }
    emitHud();
  }

  function land() {
    if (!terrain || !shot) return;
    const imp = shot.impact;
    carveCrater(terrain, imp.x, imp.y, CRATER_R);
    reseatTanks();

    for (const t of tanks) {
      const c = tankCenter(t);
      const d = Math.hypot(imp.x - c.x, imp.y - c.y);
      let dmg = d < DAMAGE_R ? MAX_DAMAGE * (1 - d / DAMAGE_R) : 0;
      if (shot.directHit === t.index) dmg += DIRECT_BONUS;
      if (dmg > 0) t.hp = Math.max(0, t.hp - Math.round(dmg));
    }

    shot = null;
    const dead0 = tanks[0].hp <= 0;
    const dead1 = tanks[1].hp <= 0;
    if (dead0 || dead1) {
      winner = dead0 && dead1 ? -1 : dead0 ? 1 : 0;
      phase = "over";
    } else {
      currentTurn = currentTurn === 0 ? 1 : 0;
      wind = rollWind();
      phase = "aim";
    }
    emitHud();
  }

  function canAim(): boolean {
    return phase === "aim" && currentTurn === opts.myIndex && !!terrain;
  }

  function computeShotFromAim(): { start: Vec; velocity: Vec } | null {
    const me = tanks[opts.myIndex];
    const pivot = barrelPivot(me);
    const dx = aimPos.x - pivot.x;
    const dy = aimPos.y - pivot.y;
    const dist = Math.hypot(dx, dy);
    if (dist < MIN_DRAG) return null;
    const dir = { x: dx / dist, y: dy / dist };
    const power = Math.min(dist, MAX_DRAG) / MAX_DRAG;
    const speed = MIN_SPEED + power * (MAX_SPEED - MIN_SPEED);
    const start = { x: pivot.x + dir.x * BARREL_LEN, y: pivot.y + dir.y * BARREL_LEN };
    return { start, velocity: { x: dir.x * speed, y: dir.y * speed } };
  }

  // --- Input (mouse + touch via touchToMouse) ---
  k.onMousePress(() => {
    if (!canAim()) return;
    aiming = true;
    aimPos = vecOf(k.mousePos());
    updateAimBarrel();
  });
  k.onMouseMove((pos) => {
    if (!aiming) return;
    aimPos = vecOf(pos);
    updateAimBarrel();
  });
  k.onMouseRelease(() => {
    if (!aiming) return;
    aiming = false;
    if (!canAim()) return;
    const s = computeShotFromAim();
    if (s) fireShot(s.start, s.velocity, false);
  });

  function updateAimBarrel() {
    if (!canAim()) return;
    const s = computeShotFromAim();
    if (s) tanks[opts.myIndex].barrel = norm(s.velocity);
  }

  // --- Simulation step ---
  k.onUpdate(() => {
    if (phase !== "flying" || !shot) return;
    flightTime += k.dt() * FLIGHT_SPEED;
    const idx = Math.floor(flightTime / SIM_DT);
    if (idx >= shot.points.length - 1) land();
  });

  // --- Rendering ---
  k.onDraw(() => {
    if (!terrain) {
      k.drawText({
        text: "Waiting for host…",
        pos: k.vec2(W / 2, H / 2),
        anchor: "center",
        size: 36,
        color: k.rgb(200, 205, 225),
      });
      return;
    }

    drawTerrain();
    drawAimPreview();
    for (const t of tanks) drawTank(t);
    drawProjectile();
    drawHud();
  });

  function drawTerrain() {
    const t = terrain!;
    const dirt = k.rgb(76, 110, 72);
    for (const r of t.rects) {
      k.drawRect({ pos: k.vec2(r.x, r.y), width: r.w, height: r.h, color: dirt });
    }
  }

  function drawTank(t: Tank) {
    const col = PLAYER_COLORS[t.index];
    const body = k.rgb(col[0], col[1], col[2]);
    // Body + turret.
    k.drawRect({
      pos: k.vec2(t.x - TANK_W / 2, t.surfaceY - TANK_H),
      width: TANK_W,
      height: TANK_H,
      color: body,
      radius: 4,
    });
    k.drawCircle({ pos: k.vec2(t.x, t.surfaceY - TANK_H), radius: 9, color: body });
    // Barrel.
    const pivot = barrelPivot(t);
    k.drawLine({
      p1: k.vec2(pivot.x, pivot.y),
      p2: k.vec2(pivot.x + t.barrel.x * BARREL_LEN, pivot.y + t.barrel.y * BARREL_LEN),
      width: 5,
      color: k.rgb(230, 230, 235),
    });
    // HP bar.
    const bw = 44;
    const hpFrac = t.hp / START_HP;
    const bx = t.x - bw / 2;
    const by = t.surfaceY - TANK_H - 22;
    k.drawRect({ pos: k.vec2(bx, by), width: bw, height: 6, color: k.rgb(60, 60, 70) });
    k.drawRect({
      pos: k.vec2(bx, by),
      width: bw * hpFrac,
      height: 6,
      color: hpFrac > 0.5 ? k.rgb(80, 210, 120) : hpFrac > 0.25 ? k.rgb(230, 200, 80) : k.rgb(230, 90, 90),
    });
  }

  function drawAimPreview() {
    if (!aiming || !canAim()) return;
    const s = computeShotFromAim();
    if (!s) return;
    const preview = simulateShot(s.start, s.velocity, terrain!, {
      gravity: GRAVITY,
      wind,
      tanks: tanks.map((t) => ({ ...tankCenter(t), index: t.index })),
      tankRadius: TANK_R,
    });
    const limit = Math.min(preview.points.length, PREVIEW_POINTS);
    for (let i = 0; i < limit; i += 2) {
      const p = preview.points[i];
      const fade = 0.55 * (1 - i / PREVIEW_POINTS);
      k.drawCircle({ pos: k.vec2(p.x, p.y), radius: 2.5, color: k.rgb(255, 255, 255), opacity: fade });
    }
  }

  function drawProjectile() {
    if (phase !== "flying" || !shot) return;
    const idx = Math.min(Math.floor(flightTime / SIM_DT), shot.points.length - 1);
    const p = shot.points[idx];
    // Short trail.
    for (let i = Math.max(0, idx - 6); i <= idx; i++) {
      const tp = shot.points[i];
      k.drawCircle({ pos: k.vec2(tp.x, tp.y), radius: 3, color: k.rgb(255, 220, 120), opacity: (i - idx + 7) / 9 });
    }
    k.drawCircle({ pos: k.vec2(p.x, p.y), radius: 5, color: k.rgb(255, 240, 180) });
  }

  function drawHud() {
    // Turn / status banner.
    let banner = "";
    let bannerColor = k.rgb(220, 225, 240);
    if (phase === "over") {
      banner = winner === -1 ? "Draw!" : winner === opts.myIndex ? "You win! 🎉" : "You lose";
      bannerColor = winner === opts.myIndex ? k.rgb(120, 230, 150) : k.rgb(240, 120, 120);
    } else if (phase === "flying") {
      banner = "Incoming!";
    } else if (currentTurn === opts.myIndex) {
      banner = "Your turn — drag to aim, release to fire";
      bannerColor = k.rgb(150, 200, 255);
    } else {
      banner = "Opponent's turn…";
    }
    k.drawText({ text: banner, pos: k.vec2(W / 2, 28), anchor: "center", size: 28, color: bannerColor });

    // Wind indicator.
    const dir = wind >= 0 ? "→" : "←";
    const strength = Math.round(Math.abs(wind));
    k.drawText({
      text: `Wind ${dir} ${strength}`,
      pos: k.vec2(W / 2, 64),
      anchor: "center",
      size: 20,
      color: k.rgb(180, 190, 210),
    });

    // "You" marker under your tank.
    const me = tanks[opts.myIndex];
    if (me) {
      k.drawText({
        text: "YOU",
        pos: k.vec2(me.x, me.surfaceY + 8),
        anchor: "center",
        size: 16,
        color: k.rgb(255, 255, 255),
      });
    }
  }

  // Host kicks off the first match immediately.
  if (opts.isHost) newMatchAsHost();
  else emitHud();

  return {
    handleMessage(msg: GameMessage) {
      switch (msg.kind) {
        case "init":
          setupMatch(buildTerrain(msg.heights, msg.width, msg.height, msg.cell), msg.windSeed);
          break;
        case "fire":
          if (phase === "aim") {
            fireShot({ x: msg.startX, y: msg.startY }, { x: msg.vx, y: msg.vy }, true);
          }
          break;
        case "rematch":
          if (opts.isHost) newMatchAsHost();
          break;
      }
    },
    requestRematch() {
      if (phase !== "over") return;
      if (opts.isHost) newMatchAsHost();
      else opts.send({ kind: "rematch" });
    },
    destroy() {
      k.quit();
    },
  };
}

function norm(v: Vec): Vec {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function vecOf(p: { x: number; y: number }): Vec {
  return { x: p.x, y: p.y };
}
