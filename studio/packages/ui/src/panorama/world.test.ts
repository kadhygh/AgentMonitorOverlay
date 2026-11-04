import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toPanorama, type PanoramaInput } from "./datalayer.js";
import { groundW, layoutPanorama, U, WORLD_TYPE, type LngLatZ } from "./layout.js";
import { placeTopics, ringArea, seedOf, topicShape, type TopicFrame } from "./regions.js";
import { LOOKS, lookFrom } from "./themes.js";

// World looks (2026-11-03, the user: a topic is a region of the map, an island or a metro zone). The demo data of the
// preview (plans/userlayer/panorama-snapshot-topics.json, four topics, mining with three projects) is the input.
const snap = JSON.parse(readFileSync(new URL("../../../../plans/userlayer/panorama-snapshot-topics.json", import.meta.url), "utf8")) as Omit<PanoramaInput, "now"> & { takenAt: string };
const data = toPanorama({ ...snap, now: snap.takenAt });
const opts = (world: "terrain" | "metro") => ({ curve: "line" as const, span: true, fold: true, front: 2700, world });

function inside(ring: readonly LngLatZ[], p: readonly number[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1]! !== b[1] > p[1]! && p[0]! < ((b[0] - a[0]) * (p[1]! - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

describe("全景 world: regions", () => {
  // 11-04, the user: a 公告板 hung out over the metro coast. Everything a topic shows must be on its land: every corner
  // of its boards and of the boxes of its ground text, every point of its lanes, sub-lanes, rings and chevrons.
  for (const kind of ["terrain", "metro"] as const)
    it(`keeps all of a topic on its land (${kind})`, () => {
      const L = layoutPanorama(data, opts(kind));
      const TY = WORLD_TYPE;
      const box = (p: LngLatZ, w: number, up: number, down: number): LngLatZ[] => [[p[0], p[1] + up * U, 0], [p[0] + w * U, p[1] + up * U, 0], [p[0] + w * U, p[1] - down * U, 0], [p[0], p[1] - down * U, 0]];
      const out: string[] = [];
      let n = 0;
      for (const w of L.world) {
        const check = (what: string, pts: readonly LngLatZ[]) => {
          for (const p of pts) {
            n++;
            if (!w.coast.some((c) => inside(c, p))) out.push(`${w.topic.title}: ${what} (${(p[0] / U).toFixed(1)}, ${(p[1] / U).toFixed(1)})`);
          }
        };
        check("header", box(w.head, Math.max(groundW(w.topic.title, TY.title), groundW(w.summary, TY.info)), 0, TY.title * 1.18 + 2 + TY.info * 1.2));
        for (const c of w.cards) check(`board ${c.project.title}`, c.rect);
        check("shelf", w.shelf.rect);
        check("shelf label", box(w.shelf.label, groundW("规范 · 文档  99", TY.label), TY.label * 1.2, 0));
        check("公告板", w.board.rect);
        check("公告板 label", box(w.board.label, groundW("公告板 · 3 条", TY.label), TY.label * 1.2, 0));
        check("spine", w.spine.path);
        check("spine label", box(w.spine.label, groundW("主控 · 9 轮", TY.label), TY.label * 1.2, 0));
        for (const r of L.regions.filter((x) => x.lane.topic === w.id)) {
          const t = r.lane.short;
          check(`lane ${t}`, [...r.walked, ...r.ahead.flat(), ...r.pre, ...r.tick, ...r.chevrons.flat(), ...r.goalRing.flat()]);
          check(`lane ${t} name`, box(r.name, groundW(t, TY.lane), TY.lane * 1.2, 0));
          check(`lane ${t} goal word`, box([r.goal.ground[0] - 5 * U, r.goal.ground[1] - 4.8 * U, 0], 10, 0, TY.round * 1.2));
          for (const b of r.branches) check(`lane ${t} sub-lane`, b.path);
          for (const id of Object.keys(r.nodes)) check(`lane ${t} node`, box([r.nodes[id]!.ground[0] - 4 * U, r.nodes[id]!.ground[1] - 2.6 * U, 0], 8, 2.6, TY.round * 1.2));
        }
      }
      expect(n).toBeGreaterThan(300);
      expect(out).toEqual([]);
    });

  it("parses the world looks: front, folding and the fixed footprint on, pillars only when asked", () => {
    expect(lookFrom("terrain")).toEqual(LOOKS.terrain);
    expect(lookFrom("metro")).toMatchObject({ world: "metro", pillars: false, front: true, fold: true, span: true, blocks: false, curve: "line" });
    expect(lookFrom("terrain-pillars")).toMatchObject({ world: "terrain", pillars: true });
    expect(lookFrom("terrain-flow")).toBe(null);
    // The old looks are still there.
    expect(lookFrom("abd-line")?.world).toBe(null);
  });

  it("gives a topic the same shape every time, from its id", () => {
    const frame = (seed: number): TopicFrame => ({
      seed,
      x0: 0,
      groups: [
        { pi: 0, common: false, els: [{ rect: [14, -18, 86, 36], lane: true }, { seg: [131, 0, 380, 0], lane: true }, { seg: [131, 22, 300, 22], lane: true }] },
        { pi: 1, common: true, els: [{ rect: [0, -108, 154, 32] }, { rect: [123, -78, 78, 34] }, { seg: [4, -64, 4, -11] }] },
      ],
      bands: [{ top: -18, bottom: 22, shift: 0, end: 380, lobe: 30 }],
      cards: [{ x: 14, y: -18, w: 86, h: 36 }],
      spineTop: -64,
      headBottom: -44,
      hubX: [110],
    });
    const a = topicShape(frame(seedOf("tp-a")), "terrain");
    const b = topicShape({ ...frame(seedOf("tp-a")) }, "terrain");
    const c = topicShape(frame(seedOf("tp-b")), "terrain");
    expect(JSON.stringify(b.coast)).toBe(JSON.stringify(a.coast));
    expect(JSON.stringify(c.coast)).not.toBe(JSON.stringify(a.coast));
    // One project: one piece of land, no bay.
    expect(a.coast.length).toBe(1);
    expect(a.cuts).toEqual(["none"]);
    expect(ringArea(a.coast[0]!)).toBeGreaterThan(20000);
  });

  it("scatters the topics the same way every time, apart from each other", () => {
    const boxes = [
      { x0: 0, y0: 0, x1: 300, y1: 200 },
      { x0: 0, y0: 0, x1: 500, y1: 400 },
      { x0: 0, y0: 0, x1: 200, y1: 120 },
    ];
    const p = placeTopics(boxes, 7);
    expect(placeTopics(boxes, 7)).toEqual(p);
    const r = boxes.map((b, i) => ({ x0: b.x0 + p[i]![0], y0: b.y0 + p[i]![1], x1: b.x1 + p[i]![0], y1: b.y1 + p[i]![1] }));
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(r[i]!.x1 <= r[j]!.x0 || r[j]!.x1 <= r[i]!.x0 || r[i]!.y1 <= r[j]!.y0 || r[j]!.y1 <= r[i]!.y0).toBe(true);
  });

  for (const kind of ["terrain", "metro"] as const)
    it(`lays the demo out as regions (${kind}): a region per topic, every lane and its nodes on its topic's land`, () => {
      const t0 = performance.now();
      const L = layoutPanorama(data, opts(kind));
      const ms = performance.now() - t0;
      expect(L.world.map((w) => w.topic.title)).toEqual(data.topics.map((t) => t.title));
      expect(L.blocks).toEqual([]);
      expect(L.grid).toEqual([]);
      for (const r of L.regions) {
        const w = L.world.find((x) => x.id === r.lane.topic)!;
        const on = (p: LngLatZ) => w.coast.some((c) => inside(c, p));
        expect(on(r.origin.ground)).toBe(true);
        expect(on(r.goal.ground)).toBe(true);
        for (const id of Object.keys(r.nodes)) expect(on(r.nodes[id]!.ground)).toBe(true);
        // Straight: the trunk along one line; a start tick across it.
        expect(new Set(r.walked.map((p) => p[1].toFixed(9))).size).toBe(1);
        expect(r.tick).toHaveLength(2);
      }
      const mining = L.world.find((w) => w.topic.title === "mining 迭代")!;
      expect(mining.cards.map((c) => c.project.title)).toEqual(["project_mining", "project_mining_server", "project_mining_design"]);
      expect(mining.waits).toBe(2);
      // Every project's status board on the land, the spine's sessions on the spine.
      for (const c of mining.cards) expect(mining.coast.some((r) => inside(r, c.center))).toBe(true);
      expect(mining.spine.nodes.length).toBeGreaterThan(0);
      // Sub-lanes: south of their trunk; the one merged back ends on its round.
      const cave = L.regions.find((r) => r.id === "task-pm-cave-client")!;
      const br = cave.branches[0]!;
      expect(br.merge).toBe("task-pm-cave-client-r4");
      expect(br.path[br.path.length - 1]).toEqual(cave.nodes["task-pm-cave-client-r4"]!.ground);
      expect(Math.min(...br.path.map((p) => p[1]))).toBeLessThan(cave.walked[0]![1]);
      // Metro: the lanes leave their project's station.
      if (kind === "metro") for (const r of L.regions) expect(r.pre.length).toBeGreaterThan(1);
      // Laid out again (a run folded open), the shapes come from the cache.
      const t1 = performance.now();
      const L2 = layoutPanorama(data, { ...opts(kind), open: "all" });
      expect(L2.world.map((w) => w.coast)).toEqual(L.world.map((w) => w.coast));
      console.log(`world ${kind}: ${Math.round(ms)} ms first, ${Math.round(performance.now() - t1)} ms again; ${L.world.map((w) => `${w.topic.title} ${w.coast.length}/${w.zones.length}/${w.borders.length}`).join(", ")}`);
      expect(U).toBe(0.001);
    });
});
