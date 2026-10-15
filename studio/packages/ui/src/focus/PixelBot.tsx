// A small pixel robot (2026-10-15, S14-J): it pops up above Focus and dances while something needs the person, the
// first shape of a Focus desktop pet. Drawn on a 12×14 grid of 5px squares; the dance is CSS (steps()), two poses
// swapped in turn, so it is cheap and stops dead under prefers-reduced-motion. Later that evening: a light body with a
// dark outline (the dark one was hard to see), and moods — "alert": something needs the person; "calm" (green): only
// finished work to look at; "angry": left waiting too long, it flies about the screen (app/src/bot-window.ts).

export type BotMood = "alert" | "calm" | "angry";

const PX = 5;
type Cell = [x: number, y: number, w?: number, h?: number];

/** Grid rectangles of each part: x, y, width, height in cells. */
const HEAD: Cell[] = [[2, 2, 8, 5]];
const ANTENNA: Cell[] = [[5, 1, 2, 1]];
const BULB: Cell[] = [[5, 0, 2, 1]];
const EYES: Cell[] = [
  [4, 4],
  [7, 4],
];
const MOUTH: Cell[] = [[5, 5, 2, 1]];
/** Angry: a wide-open mouth, and a vein mark on the head. */
const SHOUT: Cell[] = [[4, 5, 4, 1]];
const VEIN: Cell[] = [
  [8, 2],
  [9, 3],
];
const BODY: Cell[] = [[3, 7, 6, 5]];
const CHEST: Cell[] = [[5, 9, 2, 1]];
const ARM_L_UP: Cell[] = [[1, 5, 2, 3]];
const ARM_L_DOWN: Cell[] = [[1, 8, 2, 3]];
const ARM_R_UP: Cell[] = [[9, 5, 2, 3]];
const ARM_R_DOWN: Cell[] = [[9, 8, 2, 3]];
const LEG_L: Cell[] = [[4, 12, 1, 2]];
const LEG_R: Cell[] = [[7, 12, 1, 2]];

function Pixels({ cells, className }: { cells: Cell[]; className: string }) {
  return (
    <g className={className}>
      {cells.map(([x, y, w = 1, h = 1]) => (
        <rect key={`${x},${y}`} x={x * PX} y={y * PX} width={w * PX} height={h * PX} />
      ))}
    </g>
  );
}

/** The robot itself, without the speech bubble. */
export function BotArt({ mood }: { mood: BotMood }) {
  const angry = mood === "angry";
  return (
    <svg className="pixel-bot-art" width={12 * PX + 4} height={14 * PX + 4} viewBox={`-2 -2 ${12 * PX + 4} ${14 * PX + 4}`} shapeRendering="crispEdges" aria-hidden="true">
      <g className="bot-outline">
        <g className="bot-bob">
          <Pixels cells={BULB} className="bot-bulb" />
          <Pixels cells={ANTENNA} className="bot-metal" />
          <Pixels cells={HEAD} className="bot-shell" />
          <Pixels cells={EYES} className="bot-eye" />
          {angry ? (
            <>
              {/* Brows slanting down to the middle. */}
              <polygon className="bot-eye" points={`${3 * PX},${3 * PX} ${5 * PX},${3.5 * PX} ${5 * PX},${4 * PX} ${3 * PX},${3.5 * PX}`} />
              <polygon className="bot-eye" points={`${9 * PX},${3 * PX} ${7 * PX},${3.5 * PX} ${7 * PX},${4 * PX} ${9 * PX},${3.5 * PX}`} />
              <Pixels cells={SHOUT} className="bot-eye" />
              <Pixels cells={VEIN} className="bot-vein" />
            </>
          ) : (
            <Pixels cells={MOUTH} className="bot-eye" />
          )}
          <Pixels cells={BODY} className="bot-shell" />
          <Pixels cells={CHEST} className="bot-bulb" />
          {/* Pose A: left arm up, right arm down; pose B the other way round. */}
          <Pixels cells={ARM_L_UP} className="bot-metal pose-a" />
          <Pixels cells={ARM_R_DOWN} className="bot-metal pose-a" />
          <Pixels cells={ARM_L_DOWN} className="bot-metal pose-b" />
          <Pixels cells={ARM_R_UP} className="bot-metal pose-b" />
        </g>
        <Pixels cells={LEG_L} className="bot-metal leg-l" />
        <Pixels cells={LEG_R} className="bot-metal leg-r" />
      </g>
    </svg>
  );
}

export function PixelBot({ mood = "alert", message, onClick }: { mood?: BotMood; message: string; onClick(): void }) {
  return (
    <button type="button" className={`pixel-bot ${mood}`} onClick={onClick} title={`${message}（点一下去处理）`} aria-label={`${message}，点一下去处理`} data-testid="focus-bot">
      <span className="pixel-bot-say">{message}</span>
      <BotArt mood={mood} />
    </button>
  );
}
