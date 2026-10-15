// A small pixel robot (2026-10-15, S14-J): it pops up above Focus and dances while something needs the person, the
// first shape of a Focus desktop pet. Drawn on a 12×14 grid of 5px squares; the dance is CSS (steps()), two poses
// swapped in turn, so it is cheap and stops dead under prefers-reduced-motion. `mood` is how it would grow later
// (idle, sleeping, celebrating…); only "alert" is used now.

export type BotMood = "alert";

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

export function PixelBot({ mood = "alert", message, onClick }: { mood?: BotMood; message: string; onClick(): void }) {
  return (
    <button type="button" className={`pixel-bot ${mood}`} onClick={onClick} title={`${message}（点一下去处理）`} aria-label={`${message}，点一下去处理`} data-testid="focus-bot">
      <span className="pixel-bot-say">{message}</span>
      <svg className="pixel-bot-art" width={12 * PX} height={14 * PX} viewBox={`0 0 ${12 * PX} ${14 * PX}`} shapeRendering="crispEdges" aria-hidden="true">
        <g className="bot-bob">
          <Pixels cells={BULB} className="bot-bulb" />
          <Pixels cells={ANTENNA} className="bot-metal" />
          <Pixels cells={HEAD} className="bot-shell" />
          <Pixels cells={EYES} className="bot-eye" />
          <Pixels cells={MOUTH} className="bot-eye" />
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
      </svg>
    </button>
  );
}
