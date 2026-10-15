// How the angry robot flies (2026-10-15 evening): straight runs across the screen at a few hundred points a second,
// turning to a new random heading every second or so and bouncing off the edges of the work area. Pure, so it can be
// tested; bot-window.ts moves the window by it.

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Flight {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds until the next turn. */
  turnIn: number;
}

/** Points per second. */
const SPEED_MIN = 320;
const SPEED_MAX = 620;

/** A new heading and speed, and when to turn again. */
function turn(f: Flight, random: () => number): Flight {
  const angle = random() * Math.PI * 2;
  const speed = SPEED_MIN + random() * (SPEED_MAX - SPEED_MIN);
  return { ...f, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, turnIn: 0.7 + random() * 1.1 };
}

/** Takes off at `at` (the window's top-left), inside the area. */
export function takeOff(at: { x: number; y: number }, size: { width: number; height: number }, area: Area, random: () => number = Math.random): Flight {
  return turn({ ...clampInto({ x: at.x, y: at.y }, size, area), vx: 0, vy: 0, turnIn: 0 }, random);
}

/** Where the window is `dt` seconds later. */
export function fly(f: Flight, dt: number, size: { width: number; height: number }, area: Area, random: () => number = Math.random): Flight {
  let next: Flight = { ...f, x: f.x + f.vx * dt, y: f.y + f.vy * dt, turnIn: f.turnIn - dt };
  const maxX = area.x + Math.max(0, area.width - size.width);
  const maxY = area.y + Math.max(0, area.height - size.height);
  if (next.x < area.x || next.x > maxX) next = { ...next, x: Math.min(maxX, Math.max(area.x, next.x)), vx: -next.vx };
  if (next.y < area.y || next.y > maxY) next = { ...next, y: Math.min(maxY, Math.max(area.y, next.y)), vy: -next.vy };
  return next.turnIn <= 0 ? turn(next, random) : next;
}

function clampInto(p: { x: number; y: number }, size: { width: number; height: number }, area: Area): { x: number; y: number } {
  return {
    x: Math.min(area.x + Math.max(0, area.width - size.width), Math.max(area.x, p.x)),
    y: Math.min(area.y + Math.max(0, area.height - size.height), Math.max(area.y, p.y)),
  };
}
