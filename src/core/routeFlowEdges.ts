import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { placeLabels, type LabelItem, type PlacedLabel } from "./flowLabelPlacement";

/**
 * FLOWCHART edge routing — deliberately forked from the architecture router
 * (routeEdges.ts). The two views evolve under different requirements; nothing
 * in this file is imported by the architecture path, so edit freely.
 *
 * Flowchart-specific divergences (vs the architecture router):
 *
 * 1. ALL FOUR side combinations are always evaluated. The architecture router
 *    collapses to a single combo when the endpoints overlap on an axis — but
 *    phase-region layout makes overlapped pairs the COMMON case for
 *    cross-phase edges, and with one combo the crossing comparison never gets
 *    a choice to act on (the "multi-bend + crossing chosen over a clean
 *    1-bend path" failure). Flowchart graphs are small, so the extra A* runs
 *    are cheap; cost + crossing penalty pick the winner.
 * 2. Combos are ordered by the dominant displacement axis, so cost ties
 *    resolve toward the natural flow direction (forward = down/right).
 * 3. SYMMETRIC BRANCH FANS: a 1:N one-way fan routes as a comb — one shared
 *    stem out of the source, every branch bending on ONE split line (the
 *    middle of the gutter), then dropping straight into its target. The
 *    architecture router lets each sibling bend wherever its cheapest path
 *    lies; a flowchart is an abstracted visualization where a decision point
 *    must read symmetrically. Branches the comb cannot reach without hitting
 *    a box fall back to A* (mostly-symmetric beats never-symmetric).
 * 4. Label placement is flow-owned (flowLabelPlacement.ts) — condition labels
 *    are first-class in flowcharts (annotations default ON).
 *
 * Everything else starts as the architecture behavior the flowchart view was
 * QA'd with: Manhattan A* with turn penalty over the layout gutters, obstacle
 * clearance, duplicate same-direction edges merged with split labels,
 * bidirectional pairs merged into one amber double-arrow line, 1:N trunk
 * bundling, and lane spreading.
 */

export interface RoutedPoint {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stroke colors: slate for one-way, amber for merged bidirectional lines. */
const FLOW_FWD = "#94a3b8";
const FLOW_BIDIR = "#d97706";
/** Path color coding (data.path): failure-ish paths read rose, other named
 *  paths get muted hues in name order, unnamed edges stay slate — so a reader
 *  can follow one route end-to-end by color. Loops keep amber (loop semantics
 *  outranks path membership). */
const FLOW_FAIL = "#e11d48";
const PATH_HUES = ["#0d9488", "#6366f1", "#8b5cf6"]; // teal, indigo, violet
const FAILISH = /fail|error|fallback|reject|cancel|예외|실패|오류/i;

/** Clearance kept between a path and any obstacle box — also the distance
 *  from a node border to the first possible bend (bends only happen on the
 *  clearance grid). Lane spreading can shave up to 8px off this. */
const INFLATE = 14;
/** How far OUTSIDE a phase box wall a perimeter segment is pushed when it would
 *  otherwise land on the wall (the routing gutter and the wall coincide at
 *  INFLATE === PHASE_PAD). Keeps inter-phase / back edges off the border line. */
const WALL_GAP = 8;
/** Extra cost per 90° turn — prefers straight runs over zig-zags. */
const TURN_PENALTY = 40;
/** Port inset from a node corner. */
const PORT_INSET = 14;
/** Cost multiplier on grid segments a sibling edge (same source trunk)
 *  already uses — pulls 1:N fans onto a shared trunk that splits at bends.
 *  A TIEBREAKER, not a subsidy: at 0.05 the discount justified real detours
 *  (an edge looping over a sibling's corridor instead of running straight)
 *  and last-moment splits that leave labels no private room. 0.5 keeps
 *  naturally-coinciding stretches bundled but never pays for extra distance. */
const TRUNK_FACTOR = 0.5;
/** Cost multiplier pushing a merged bidirectional line OFF the gutters that
 *  one-way trunks occupy — a both-ends-arrow line must stay visually distinct
 *  from one-way fans (and its start arrowhead must not get buried in one). */
const AVOID_FACTOR = 3;
/** Added per intersection with an already-routed edge when scoring a side
 *  combination. Set ABOVE BEND_WORTH so a crossing is avoided even at the cost
 *  of an extra bend or moderate length — crossing minimisation outranks bends
 *  (graph-drawing convention). Only effective because long "fit" edges route
 *  last (skeleton-then-fit order below), so the crossings they'd make are
 *  already on the board to be counted. */
const CROSS_PENALTY = 240;
/** Extra length (px) a 90° turn is "worth" when CHOOSING a side-combo (on top
 *  of the in-A* TURN_PENALTY). Lets a clean 1-bend route beat a shorter 2-bend
 *  one across a realistic hub-fan length gap, without inflating A* itself. */
const BEND_WORTH = 160;
/** A horizontal segment routed through a phase header band gets nudged up out
 *  of it later (step 3.5); if nodes sit just above the header that lift can
 *  land ON them. So price header-crossing routes here — load-bearing once
 *  CROSS_PENALTY is high enough that an edge would otherwise cross the header
 *  to dodge a line crossing. */
const HEADER_CROSS_WORTH = BEND_WORTH;

const trunkKey = (a: RoutedPoint, b: RoutedPoint): string =>
  a.x < b.x || (a.x === b.x && a.y < b.y)
    ? `${a.x},${a.y}|${b.x},${b.y}`
    : `${b.x},${b.y}|${a.x},${a.y}`;

type Side = "l" | "r" | "t" | "b";

interface PortPlan {
  edge: Edge;
  sSide: Side;
  tSide: Side;
  sPort: RoutedPoint;
  tPort: RoutedPoint;
}

const centerOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const portPoint = (r: Rect, side: Side, along: number): RoutedPoint => {
  switch (side) {
    case "l": return { x: r.x, y: along };
    case "r": return { x: r.x + r.w, y: along };
    case "t": return { x: along, y: r.y };
    case "b": return { x: along, y: r.y + r.h };
  }
};

/** Escape point: one INFLATE step out of the node, where routing starts. */
const escapeOf = (p: RoutedPoint, side: Side): RoutedPoint => {
  switch (side) {
    case "l": return { x: p.x - INFLATE, y: p.y };
    case "r": return { x: p.x + INFLATE, y: p.y };
    case "t": return { x: p.x, y: p.y - INFLATE };
    case "b": return { x: p.x, y: p.y + INFLATE };
  }
};

/** Does the open segment p1→p2 (axis-aligned) pass through rect's interior? */
function segmentBlocked(p1: RoutedPoint, p2: RoutedPoint, r: Rect): boolean {
  const EPS = 1; // traveling exactly on the clearance line is allowed
  const x0 = r.x - INFLATE + EPS;
  const x1 = r.x + r.w + INFLATE - EPS;
  const y0 = r.y - INFLATE + EPS;
  const y1 = r.y + r.h + INFLATE - EPS;
  if (p1.y === p2.y) {
    const [a, b] = p1.x < p2.x ? [p1.x, p2.x] : [p2.x, p1.x];
    return p1.y > y0 && p1.y < y1 && b > x0 && a < x1;
  }
  const [a, b] = p1.y < p2.y ? [p1.y, p2.y] : [p2.y, p1.y];
  return p1.x > x0 && p1.x < x1 && b > y0 && a < y1;
}

/** A* over the sparse coordinate grid with a turn penalty. Returns grid
 *  points start→goal, or null when walled in (caller falls back to an L).
 *
 *  startDir/goalDir (DIRS index) price the bends at the PORT STUBS: the path
 *  arrives at `start` already moving out of the source side, and must leave
 *  `goal` moving into the target side. Without them the first move and the
 *  final approach turn are free — a Z bending right at both ports gets priced
 *  one whole turn cheaper than it looks, and systematically beats the visually
 *  simpler L (the "2 bends where 1 would do" failure). */
function astar(
  xs: number[],
  ys: number[],
  start: RoutedPoint,
  goal: RoutedPoint,
  obstacles: Rect[],
  trunk?: Set<string>,
  avoid?: Set<string>,
  startDir?: number,
  goalDir?: number,
): { pts: RoutedPoint[]; cost: number } | null {
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const si = xi.get(start.x)!;
  const sj = yi.get(start.y)!;
  const gi = xi.get(goal.x)!;
  const gj = yi.get(goal.y)!;

  // state: (i, j, incoming direction 0..3 | 4 at start)
  const W = xs.length;
  const H = ys.length;
  const key = (i: number, j: number, d: number) => (j * W + i) * 5 + d;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  // With trunk reuse active, costs can shrink to TRUNK_FACTOR× — scale the
  // heuristic down to stay admissible against the discounted graph.
  const hScale = trunk && trunk.size > 0 ? TRUNK_FACTOR : 1;
  const heur = (i: number, j: number) =>
    (Math.abs(xs[i] - xs[gi]) + Math.abs(ys[j] - ys[gj])) * hScale;

  // tiny binary heap of [f, g, i, j, d]
  const heap: [number, number, number, number, number][] = [];
  const push = (it: [number, number, number, number, number]) => {
    heap.push(it);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]];
        p = m;
      }
    }
    return top;
  };

  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const sd = startDir ?? 4;
  dist.set(key(si, sj, sd), 0);
  push([heur(si, sj), 0, si, sj, sd]);

  let goalState = -1;
  while (heap.length) {
    const [, g, i, j, d] = pop();
    const k = key(i, j, d);
    if ((dist.get(k) ?? Infinity) < g) continue;
    if (i === gi && j === gj) {
      goalState = k;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      const ni = i + DIRS[nd][0];
      const nj = j + DIRS[nd][1];
      if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
      const p1 = { x: xs[i], y: ys[j] };
      const p2 = { x: xs[ni], y: ys[nj] };
      if (obstacles.some((r) => segmentBlocked(p1, p2, r))) continue;
      const k2 = trunkKey(p1, p2);
      const factor = trunk?.has(k2)
        ? TRUNK_FACTOR
        : avoid?.has(k2)
          ? AVOID_FACTOR
          : 1;
      const step =
        (Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y)) * factor +
        (d !== 4 && d !== nd ? TURN_PENALTY : 0) +
        // landing on the goal against the entry-stub direction is one more
        // visual bend at the target port — price it
        (ni === gi && nj === gj && goalDir !== undefined && nd !== goalDir
          ? TURN_PENALTY
          : 0);
      const nk = key(ni, nj, nd);
      if (g + step < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, g + step);
        prev.set(nk, k);
        push([g + step + heur(ni, nj), g + step, ni, nj, nd]);
      }
    }
  }
  if (goalState < 0) return null;

  const pts: RoutedPoint[] = [];
  for (let k: number | undefined = goalState; k !== undefined; k = prev.get(k)) {
    const cell = Math.floor(k / 5);
    pts.push({ x: xs[cell % W], y: ys[Math.floor(cell / W)] });
  }
  pts.reverse();
  return { pts, cost: dist.get(goalState)! };
}

/** Drop intermediate points on straight runs (and duplicates). */
function simplify(pts: RoutedPoint[]): RoutedPoint[] {
  const out: RoutedPoint[] = [];
  for (const p of pts) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && b.x === p.x && b.y === p.y) continue;
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Fan out segments that share a gutter line so edges read as parallel rails
 *  instead of one merged stroke. Interior segments only; offsets stay well
 *  under INFLATE so spread rails keep clearing the boxes they route around.
 *  Segments of edges with the SAME source are a deliberate trunk — they get
 *  one lane together (never spread apart from each other).
 *
 *  `fixed[pi]` marks a path as frozen (a kept line from an incremental
 *  re-route): it anchors its gutter but is never shifted. Mutable lanes
 *  sharing that gutter step OFF the anchor instead of centering symmetrically,
 *  so a freshly-routed line dodges a frozen one rather than merging onto it. */
function spreadLanes(
  paths: RoutedPoint[][],
  sourceOf: string[],
  fixed?: boolean[],
) {
  interface Seg {
    pts: RoutedPoint[];
    i: number;
    lo: number;
    hi: number;
    src: string;
    pi: number;
    pinned: boolean; // endpoint is a node port — detect it so others dodge, but never move it
  }
  const pass = (axis: "x" | "y") => {
    const cross = axis === "y" ? "x" : "y"; // segment runs along `cross`
    const lines = new Map<number, Seg[]>();
    paths.forEach((pts, pi) => {
      // ALL segments, including the two port stubs: a stub can't move (it would
      // detach from its port) but it still OCCUPIES its gutter, so movable
      // segments of other edges must dodge it instead of stacking onto it.
      for (let i = 0; i + 1 < pts.length; i++) {
        if (pts[i][axis] !== pts[i + 1][axis]) continue;
        const lo = Math.min(pts[i][cross], pts[i + 1][cross]);
        const hi = Math.max(pts[i][cross], pts[i + 1][cross]);
        const k = pts[i][axis];
        const pinned = i === 0 || i === pts.length - 2;
        lines.set(k, [...(lines.get(k) ?? []), { pts, i, lo, hi, src: sourceOf[pi], pi, pinned }]);
      }
    });
    lines.forEach((segs) => {
      if (segs.length < 2) return;
      segs.sort((a, b) => a.lo - b.lo);
      let cluster: Seg[] = [];
      let end = -Infinity;
      const shift = (laneSegs: Seg[], off: number) =>
        laneSegs.forEach((s) => {
          s.pts[s.i][axis] += off;
          s.pts[s.i + 1][axis] += off;
        });
      const flush = () => {
        const bySrc = new Map<string, Seg[]>();
        cluster.forEach((s) => bySrc.set(s.src, [...(bySrc.get(s.src) ?? []), s]));
        if (bySrc.size > 1) {
          const lanes = [...bySrc.values()];
          const step = Math.min(6, 16 / (lanes.length - 1));
          // A lane is anchored if it carries a frozen segment (incremental
          // re-route) OR a port stub (can't move without detaching the port).
          // With an anchor present, mutable lanes step off it (offsets skip 0);
          // with none, every lane centers symmetrically as before.
          const isAnchor = (s: Seg) => (fixed && fixed[s.pi]) || s.pinned;
          const anchored = lanes.some((l) => l.some(isAnchor));
          if (!anchored) {
            lanes.forEach((laneSegs, idx) =>
              shift(laneSegs, (idx - (lanes.length - 1) / 2) * step),
            );
          } else {
            lanes
              .filter((l) => !l.some(isAnchor))
              .forEach((laneSegs, k) => {
                const mag = Math.ceil((k + 1) / 2) * step;
                const off = Math.max(-12, Math.min(12, (k % 2 === 0 ? 1 : -1) * mag));
                shift(laneSegs, off);
              });
          }
        }
        cluster = [];
      };
      segs.forEach((s) => {
        if (s.lo >= end) flush();
        cluster.push(s);
        end = Math.max(end, s.hi);
      });
      flush();
    });
  };
  pass("y");
  pass("x");
}

/** Route all flowchart step edges as Manhattan paths through layout gutters.
 *
 *  `fixedContext` carries the FROZEN lines of an incremental re-route (kept
 *  paths the user didn't touch): their paths anchor lane spreading, and their
 *  port spots are pre-reserved so a re-routed edge neither merges onto a
 *  frozen stroke nor lands its arrowhead on a frozen one. */
export function routeFlowEdges(
  nodes: Node[],
  edges: Edge[],
  fixedContext?: {
    paths: RoutedPoint[][];
    sources: string[];
    ports: { key: string; along: number }[];
    /** FULL-graph degrees for bidir hub selection — subset degrees would
     *  re-pick the merged pair's kept direction and flip the amber line
     *  (label order + hub arrow stacking change) after a drag. */
    deg: Map<string, number>;
    /** Frozen edges' labels — immovable obstacles for label placement. */
    labels: { x: number; y: number; text: string; wrap: boolean }[];
  },
): Edge[] {
  const rectOf = new Map<string, Rect>(
    nodes.map((n) => [
      n.id,
      { x: n.position.x, y: n.position.y, w: n.width ?? 210, h: n.height ?? 100 },
    ]),
  );

  // Derive phase box geometry from the placed nodes so the nudges below always
  // use the current positions (avoids the stale-ref timing problem). PAD/HEADER
  // /GAP MUST match App's phase box constants (PHASE_PAD etc).
  const PHASE_PAD = 14, PHASE_HEADER_H = 32, PHASE_GAP = 8;
  const phaseBounds = (() => {
    const byPhase = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
    nodes.forEach((n) => {
      const phase = (n.data as { phase?: string } | undefined)?.phase;
      if (!phase) return;
      const r = rectOf.get(n.id)!;
      const cur = byPhase.get(phase);
      if (!cur) byPhase.set(phase, { x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h });
      else {
        cur.x0 = Math.min(cur.x0, r.x);
        cur.x1 = Math.max(cur.x1, r.x + r.w);
        cur.y0 = Math.min(cur.y0, r.y);
        cur.y1 = Math.max(cur.y1, r.y + r.h);
      }
    });
    return [...byPhase.values()];
  })();
  // Box walls (L/R/B) and the dark header strip at the top.
  const phaseBoxes = phaseBounds.map(({ x0, x1, y0, y1 }) => ({
    L: x0 - PHASE_PAD,
    R: x1 + PHASE_PAD,
    T: y0 - PHASE_HEADER_H - PHASE_GAP,
    B: y1 + PHASE_PAD,
  }));
  const phaseHeaders: Rect[] = phaseBounds.map(({ x0, x1, y0 }) => ({
    x: x0 - PHASE_PAD,
    y: y0 - PHASE_HEADER_H - PHASE_GAP,
    w: x1 - x0 + PHASE_PAD * 2,
    h: PHASE_HEADER_H,
  }));
  /** Horizontal segments of `pts` inside a header band (same test as the step
   *  3.5 nudge) — each will be lifted out and may land on nodes above the
   *  header, so the combo selector prices them via HEADER_CROSS_WORTH. */
  const countHeaderCrossings = (pts: RoutedPoint[]): number => {
    if (!phaseHeaders.length) return 0;
    let n = 0;
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s], b = pts[s + 1];
      if (a.y !== b.y) continue;
      const xlo = Math.min(a.x, b.x), xhi = Math.max(a.x, b.x);
      if (phaseHeaders.some((h) => a.y > h.y && a.y < h.y + h.h && xlo < h.x + h.w && xhi > h.x))
        n++;
    }
    return n;
  };

  // Collapse duplicate same-direction edges (same source→target) into one line —
  // two arrows between the same pair are one transition reached under multiple
  // conditions. Keep each distinct label separately (data.labels) so the renderer
  // can spread them along the line instead of cramming "A / B" into one clamped box.
  const byPair = new Map<string, { edge: Edge; labels: string[] }>();
  for (const e of edges) {
    const k = `${e.source}::${e.target}`;
    const lab = typeof e.label === "string" ? e.label : undefined;
    const ex = byPair.get(k);
    if (!ex) { byPair.set(k, { edge: { ...e }, labels: lab ? [lab] : [] }); continue; }
    if (lab && !ex.labels.includes(lab)) ex.labels.push(lab);
  }
  edges = [...byPair.values()].map(({ edge, labels }) => {
    if (labels.length <= 1) { edge.label = labels[0]; return edge; }
    return { ...edge, label: labels.join(" / "), data: { ...edge.data, labels } };
  });

  const pairKeys = new Set(edges.map((e) => `${e.source}::${e.target}`));
  const isBidir = (s: string, t: string) => pairKeys.has(`${t}::${s}`);

  // Bidirectional pairs collapse into ONE line with an arrowhead at each end.
  // The kept direction starts at the higher-degree endpoint (the hub), so
  // sibling bidirectional lines share a source and can trunk-bundle — one
  // start arrowhead at the hub, splitting toward each partner.
  const degAll = fixedContext?.deg ?? new Map<string, number>();
  if (!fixedContext?.deg)
    edges.forEach((e) => {
      degAll.set(e.source, (degAll.get(e.source) ?? 0) + 1);
      degAll.set(e.target, (degAll.get(e.target) ?? 0) + 1);
    });
  const reverseLabel = new Map<string, Edge["label"]>();
  const dedup = edges.filter((e) => {
    if (!isBidir(e.source, e.target)) return true;
    const ds = degAll.get(e.source) ?? 0;
    const dt = degAll.get(e.target) ?? 0;
    if (ds !== dt ? ds > dt : e.source < e.target) return true;
    reverseLabel.set(`${e.target}::${e.source}`, e.label);
    return false;
  });

  // ── 1. Plans (sides chosen during routing, not by rule) ─────────────────
  const plans: PortPlan[] = [];
  for (const e of dedup) {
    if (!rectOf.get(e.source) || !rectOf.get(e.target)) continue;
    plans.push({ edge: e, sSide: "r", tSide: "l", sPort: { x: 0, y: 0 }, tPort: { x: 0, y: 0 } });
  }
  const trunkKeyOf = (p: PortPlan) =>
    `${p.edge.source}` + (isBidir(p.edge.source, p.edge.target) ? ":b" : "");

  // ── 2. Routing grid: obstacle envelopes + every candidate port line ─────
  // Side centers and span insets go in for every node, so any port the
  // selector might pick (and its escape) lands on grid coordinates.
  const xsSet = new Set<number>();
  const ysSet = new Set<number>();
  rectOf.forEach((r) => {
    xsSet.add(r.x - INFLATE);
    xsSet.add(r.x + r.w + INFLATE);
    xsSet.add(r.x + r.w / 2);
    xsSet.add(r.x + PORT_INSET);
    xsSet.add(r.x + r.w - PORT_INSET);
    ysSet.add(r.y - INFLATE);
    ysSet.add(r.y + r.h + INFLATE);
    ysSet.add(r.y + r.h / 2);
    ysSet.add(r.y + PORT_INSET);
    ysSet.add(r.y + r.h - PORT_INSET);
  });
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);

  // Port bookkeeping: chosen ports reserve their spot so later arrows (and
  // bidirectional exits) dodge instead of stacking.
  const tTaken = new Map<string, number[]>();
  const freeAlong = (
    key: string,
    want: number,
    lo: number,
    hi: number,
    coords: number[],
  ): number => {
    const taken = tTaken.get(key) ?? [];
    const cands = coords
      .filter((v) => v >= lo && v <= hi)
      .sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
    for (const v of cands) {
      if (!taken.some((t) => Math.abs(t - v) < 12)) return v;
    }
    return cands[0] ?? Math.min(Math.max(want, lo), hi);
  };
  const reserve = (key: string, v: number) =>
    tTaken.set(key, [...(tTaken.get(key) ?? []), v]);
  // Frozen edges' ports claim their spots up front, so freeAlong dodges them.
  fixedContext?.ports.forEach((p) => reserve(p.key, p.along));

  // ── 3. Route — side combination picked by measured path cost ────────────
  // FLOWCHART POLICY: all sixteen port-side combinations are candidates (no
  // single-combo collapse on axis overlap — see file header, divergence 1),
  // with the four "natural" combos ordered first by the dominant displacement
  // axis (divergence 2) so cost ties keep the flow direction. One-way trunks
  // (grouped per source) route first; merged bidirectional lines route last
  // with a penalty on one-way gutters so they stay distinct.
  const trunkGroups = new Map<string, number[]>();
  plans.forEach((p, i) => {
    const k = trunkKeyOf(p);
    trunkGroups.set(k, [...(trunkGroups.get(k) ?? []), i]);
  });

  const paths: RoutedPoint[][] = new Array(plans.length);
  const oneWaySegs = new Set<string>();
  // Sibling bidirectional lines (same hub) share one exit port so their
  // stacked start arrowheads read as a single arrow at the trunk root.
  const bidirPortCache = new Map<string, number>();
  // Same idea for one-way trunks: siblings share one exit port (the trunk
  // root), but it dodges any incoming arrival port already on that side so a
  // departure and an arrival never land on the same spot (ambiguous "which way").
  const owPortCache = new Map<string, number>();
  // intersections of a candidate path with everything routed so far
  const crossesRouted = (pts: RoutedPoint[]): number => {
    let count = 0;
    for (const other of paths) {
      if (!other) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        for (let j = 0; j + 1 < other.length; j++) {
          const [a1, a2, b1, b2] = [pts[i], pts[i + 1], other[j], other[j + 1]];
          const aH = a1.y === a2.y;
          const bH = b1.y === b2.y;
          if (aH === bH) continue;
          const [h1, h2, v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
          const [hx0, hx1] = h1.x < h2.x ? [h1.x, h2.x] : [h2.x, h1.x];
          const [vy0, vy1] = v1.y < v2.y ? [v1.y, v2.y] : [v2.y, v1.y];
          if (v1.x > hx0 && v1.x < hx1 && h1.y > vy0 && h1.y < vy1) count++;
        }
      }
    }
    return count;
  };
  // ── Symmetric branch fan (comb) — flowchart divergence 3 ────────────────
  // Build the comb for a 1:N one-way fan: shared stem from the source's
  // majority-side port, ALL bends on one split line (middle of the gutter
  // between the source border and the nearest fan target), straight drops
  // into each target. Returns the indices it could NOT place (off-side
  // targets, blocked branches) for the regular A* pass — or null when no
  // comb is feasible (fewer than two branches on the majority side, or
  // fewer than two unblocked). Committed comb segments seed `trunk` and
  // `oneWaySegs` so leftover branches hug the stem and bidir lines avoid it.
  const combFan = (idxs: number[], trunk: Set<string>): number[] | null => {
    const src = plans[idxs[0]].edge.source;
    const s = rectOf.get(src)!;

    // Fan side = where most targets lie strictly BEYOND the source border
    // (lateral spread is irrelevant — a branch child two columns to the side
    // but one row down still fans downward). A diagonal target counts for
    // both its sides. Candidate sides are tried in score order (count, then
    // summed overshoot): when the best side's comb is blocked (e.g. a box
    // sits right on the stem), the runner-up side gets its chance before
    // giving up to A*.
    const allSides: Side[] = ["b", "t", "r", "l"];
    const beyond = (t: Rect, side: Side): number =>
      side === "b" ? t.y - (s.y + s.h)
      : side === "t" ? s.y - (t.y + t.h)
      : side === "r" ? t.x - (s.x + s.w)
      : s.x - (t.x + t.w);
    const candidates = allSides
      .map((side) => {
        const arr = idxs.filter((i) => beyond(rectOf.get(plans[i].edge.target)!, side) > 0);
        const score =
          arr.length * 1e6 +
          arr.reduce((a, i) => a + beyond(rectOf.get(plans[i].edge.target)!, side), 0);
        return { side, arr, score };
      })
      .filter((c) => c.arr.length >= 2)
      .sort((a, b) => b.score - a.score);
    for (const { side: fanSide, arr: fan } of candidates) {

    const vert = fanSide === "b" || fanSide === "t"; // stem runs vertically
    const sign = fanSide === "b" || fanSide === "r" ? 1 : -1;

    // Shared stem port at the side center (dodging reserved arrivals).
    const ck = `${src}:${fanSide}`;
    const lo = (vert ? s.x : s.y) + PORT_INSET;
    const hi = (vert ? s.x + s.w : s.y + s.h) - PORT_INSET;
    const along =
      owPortCache.get(ck) ??
      freeAlong(ck, vert ? s.x + s.w / 2 : s.y + s.h / 2, lo, hi, vert ? xs : ys);
    const sPort = portPoint(s, fanSide, along);
    const sEsc = escapeOf(sPort, fanSide);

    // Split line: middle of the gutter between the source border and the
    // NEAREST fan target's near border (never closer than the escape line).
    const sFar = fanSide === "b" ? s.y + s.h : fanSide === "t" ? s.y : fanSide === "r" ? s.x + s.w : s.x;
    let nearGap = Infinity;
    for (const i of fan) {
      const t = rectOf.get(plans[i].edge.target)!;
      const tNear = fanSide === "b" ? t.y : fanSide === "t" ? t.y + t.h : fanSide === "r" ? t.x : t.x + t.w;
      nearGap = Math.min(nearGap, sign * (tNear - sFar));
    }
    const split = sFar + sign * Math.max(INFLATE, nearGap / 2);

    // Per-branch comb path; a branch the comb cannot reach falls back to A*.
    const tSide: Side = fanSide === "b" ? "t" : fanSide === "t" ? "b" : fanSide === "r" ? "l" : "r";
    const rest: number[] = [];
    const ok: { i: number; pts: RoutedPoint[]; tPort: RoutedPoint }[] = [];
    const obstacles = [...rectOf.values()];
    for (const i of fan) {
      const t = rectOf.get(plans[i].edge.target)!;
      const tHoriz = tSide === "t" || tSide === "b"; // entry coordinate runs along x
      const want = tHoriz ? t.x + t.w / 2 : t.y + t.h / 2;
      const tlo = (tHoriz ? t.x : t.y) + PORT_INSET;
      const thi = (tHoriz ? t.x + t.w : t.y + t.h) - PORT_INSET;
      const ta = freeAlong(`${plans[i].edge.target}:${tSide}`, want, tlo, thi, tHoriz ? xs : ys);
      const tPort = portPoint(t, tSide, ta);
      const tEsc = escapeOf(tPort, tSide);
      const a: RoutedPoint = vert ? { x: sPort.x, y: split } : { x: split, y: sPort.y };
      const b: RoutedPoint = vert ? { x: tPort.x, y: split } : { x: split, y: tPort.y };
      const segs: [RoutedPoint, RoutedPoint][] = [[sEsc, a], [a, b], [b, tEsc]];
      const blocked = segs.some(
        ([p, q]) =>
          (p.x !== q.x || p.y !== q.y) &&
          obstacles.some((r) => segmentBlocked(p, q, r)),
      );
      if (blocked) { rest.push(i); continue; }
      ok.push({ i, pts: simplify([sPort, sEsc, a, b, tEsc, tPort]), tPort });
    }
    if (ok.length < 2) continue; // this side's comb is blocked — try the runner-up

    // Commit the comb.
    owPortCache.set(ck, along);
    reserve(ck, along);
    for (const { i, pts, tPort } of ok) {
      const p = plans[i];
      p.sSide = fanSide;
      p.tSide = tSide;
      p.sPort = sPort;
      p.tPort = tPort;
      reserve(
        `${p.edge.target}:${tSide}`,
        tSide === "t" || tSide === "b" ? tPort.x : tPort.y,
      );
      paths[i] = pts;
      for (let k = 0; k + 1 < pts.length; k++) {
        trunk.add(trunkKey(pts[k], pts[k + 1]));
        oneWaySegs.add(trunkKey(pts[k], pts[k + 1]));
      }
    }
    // Off-side targets + blocked branches go to the regular A* pass.
    return [...rest, ...idxs.filter((i) => !fan.includes(i))];
    }
    return null; // no side could form a comb — route everything by A*
  };

  const routeGroup = (idxs: number[], avoid?: Set<string>) => {
    const trunk = new Set<string>();
    // Symmetric comb first for one-way fans; A* handles what it returns.
    let pending = idxs;
    if (!avoid && idxs.length >= 2) {
      pending = combFan(idxs, trunk) ?? idxs;
    }
    const byDist = pending
      .map((i) => {
        const e = plans[i].edge;
        const cs = centerOf(rectOf.get(e.source)!);
        const ct = centerOf(rectOf.get(e.target)!);
        return { i, d: Math.abs(ct.x - cs.x) + Math.abs(ct.y - cs.y) };
      })
      .sort((a, b) => b.d - a.d);
    byDist.forEach(({ i }) => {
      const p = plans[i];
      const e = p.edge;
      const bidir = isBidir(e.source, e.target);
      const s = rectOf.get(e.source)!;
      const t = rectOf.get(e.target)!;
      // EVERY node is an obstacle, the edge's own endpoints included — A*
      // starts/ends on their clearance lines, so excluding them would let a
      // detour-priced path cut straight through its own box and bury the
      // arrowheads under the node.
      const obstacles: Rect[] = [...rectOf.values()];

      const dx = centerOf(t).x - centerOf(s).x;
      const dy = centerOf(t).y - centerOf(s).y;
      const sH: Side = dx >= 0 ? "r" : "l";
      const sV: Side = dy >= 0 ? "b" : "t";
      const tH: Side = dx >= 0 ? "l" : "r";
      const tV: Side = dy >= 0 ? "t" : "b";
      // ALL 16 side combinations are candidates — flowchart graphs are small,
      // so the extra A* runs are affordable, and the dx/dy sign only names the
      // ONE side facing the source per axis. When the direct sides are walled
      // in by neighbours (a cross-phase edge boxed in by its own cluster), the
      // far sides open up a clean perimeter route the near sides can't reach.
      // The four "natural" combos lead so cost TIES still resolve toward the
      // flow direction (selection keeps the first on equal cost); the rest
      // follow as fallbacks that only win when measurably cheaper.
      const natural: [Side, Side][] =
        Math.abs(dy) >= Math.abs(dx)
          ? [[sV, tV], [sH, tH], [sV, tH], [sH, tV]]
          : [[sH, tH], [sV, tV], [sH, tV], [sV, tH]];
      const combos: [Side, Side][] = [...natural];
      const allSides: Side[] = ["l", "r", "t", "b"];
      for (const ss of allSides)
        for (const ts of allSides)
          if (!natural.some(([a, b]) => a === ss && b === ts)) combos.push([ss, ts]);

      const portFor = (
        r: Rect,
        side: Side,
        key: string,
        want: number,
        dodge: boolean,
      ): RoutedPoint => {
        const horiz = side === "t" || side === "b";
        const lo = (horiz ? r.x : r.y) + PORT_INSET;
        const hi = (horiz ? r.x + r.w : r.y + r.h) - PORT_INSET;
        const along = dodge
          ? freeAlong(key, want, lo, hi, horiz ? xs : ys)
          : Math.min(Math.max(want, lo), hi);
        return portPoint(r, side, along);
      };

      let best: {
        cost: number;
        sSide: Side;
        tSide: Side;
        sPort: RoutedPoint;
        tPort: RoutedPoint;
        pts: RoutedPoint[];
      } | null = null;
      for (const [sSide, tSide] of combos) {
        const sHoriz = sSide === "t" || sSide === "b";
        // Normal edges exit at the side center (the shared one-way trunk
        // port). Bidirectional lines share their OWN port per hub side
        // (cached) — first one dodges whatever is already there, siblings
        // reuse it so their start arrowheads stack into a single arrow.
        let sPort: RoutedPoint;
        if (bidir) {
          const ck = `${e.source}:${sSide}`;
          const lo = (sHoriz ? s.x : s.y) + PORT_INSET;
          const hi = (sHoriz ? s.x + s.w : s.y + s.h) - PORT_INSET;
          const along =
            bidirPortCache.get(ck) ??
            freeAlong(ck, sHoriz ? s.x + s.w / 2 : s.y + s.h / 2, lo, hi, sHoriz ? xs : ys);
          sPort = portPoint(s, sSide, along);
        } else {
          // One-way trunk: first sibling picks the side center, dodging any
          // arrival port already reserved there; siblings reuse it (shared
          // trunk root). Mirrors the bidir branch above.
          const ck = `${e.source}:${sSide}`;
          const lo = (sHoriz ? s.x : s.y) + PORT_INSET;
          const hi = (sHoriz ? s.x + s.w : s.y + s.h) - PORT_INSET;
          const along =
            owPortCache.get(ck) ??
            freeAlong(ck, sHoriz ? s.x + s.w / 2 : s.y + s.h / 2, lo, hi, sHoriz ? xs : ys);
          sPort = portPoint(s, sSide, along);
        }
        const tPort = portFor(
          t,
          tSide,
          `${e.target}:${tSide}`,
          tSide === "t" || tSide === "b" ? sPort.x : sPort.y,
          true,
        );
        // DIRS index of the stub directions: exit moves AWAY from the source
        // side; entry moves INTO the target side.
        const exitDir = sSide === "r" ? 0 : sSide === "l" ? 1 : sSide === "b" ? 2 : 3;
        const entryDir = tSide === "l" ? 0 : tSide === "r" ? 1 : tSide === "t" ? 2 : 3;
        const res = astar(
          xs,
          ys,
          escapeOf(sPort, sSide),
          escapeOf(tPort, tSide),
          obstacles,
          trunk,
          avoid,
          exitDir,
          entryDir,
        );
        if (res) {
          const simp = simplify([sPort, ...res.pts, tPort]);
          const cross = crossesRouted(simp);
          const bends = Math.max(0, simp.length - 2);
          const hdrCross = countHeaderCrossings(simp);
          // Crossings are a hard penalty; among equal-crossing combos, a
          // BEND counts for BEND_WORTH px of length, so a 1-bend route beats a
          // shorter 2-bend one unless the length gap is large. Tunable middle
          // ground between pure weighted cost (length wins) and strict
          // lexicographic (bends always win, which shifted bends elsewhere).
          const cost =
            res.cost +
            cross * CROSS_PENALTY +
            bends * BEND_WORTH +
            hdrCross * HEADER_CROSS_WORTH;
          if (!best || cost < best.cost) {
            best = { cost, sSide, tSide, sPort, tPort, pts: res.pts };
          }
        }
      }

      if (best) {
        p.sSide = best.sSide;
        p.tSide = best.tSide;
        p.sPort = best.sPort;
        p.tPort = best.tPort;
        reserve(
          `${e.target}:${best.tSide}`,
          best.tSide === "t" || best.tSide === "b" ? best.tPort.x : best.tPort.y,
        );
        const sAlong =
          best.sSide === "t" || best.sSide === "b" ? best.sPort.x : best.sPort.y;
        reserve(`${e.source}:${best.sSide}`, sAlong);
        if (bidir) bidirPortCache.set(`${e.source}:${best.sSide}`, sAlong);
        else owPortCache.set(`${e.source}:${best.sSide}`, sAlong);
        for (let k = 0; k + 1 < best.pts.length; k++) {
          trunk.add(trunkKey(best.pts[k], best.pts[k + 1]));
          if (!avoid) oneWaySegs.add(trunkKey(best.pts[k], best.pts[k + 1]));
        }
        paths[i] = simplify([best.sPort, ...best.pts, best.tPort]);
      } else {
        // walled in (shouldn't happen in layout gutters): plain L fallback
        const [sSide, tSide] = combos[0];
        const sPort = portFor(s, sSide, "", (sSide === "t" || sSide === "b") ? s.x + s.w / 2 : s.y + s.h / 2, false);
        const tPort = portFor(t, tSide, "", (tSide === "t" || tSide === "b") ? sPort.x : sPort.y, false);
        const sEsc = escapeOf(sPort, sSide);
        const tEsc = escapeOf(tPort, tSide);
        p.sSide = sSide;
        p.tSide = tSide;
        p.sPort = sPort;
        p.tPort = tPort;
        paths[i] = simplify([sPort, sEsc, { x: sEsc.x, y: tEsc.y }, tEsc, tPort]);
      }
    });
  };
  // Skeleton-then-fit: route SHORT one-way groups first (the structural
  // skeleton), LONG ones last. A long back/return edge then routes against a
  // complete skeleton, so crossesRouted sees the crossings it would make and
  // the cost can steer it around them — instead of routing blind (greedy order
  // dependence) because the edges it crosses weren't placed yet.
  const groupSpan = (idxs: number[]) =>
    Math.max(
      ...idxs.map((i) => {
        const e = plans[i].edge;
        const a = centerOf(rectOf.get(e.source)!), b = centerOf(rectOf.get(e.target)!);
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      }),
    );
  [...trunkGroups.entries()]
    .filter(([k]) => !k.endsWith(":b"))
    .sort((a, b) => groupSpan(a[1]) - groupSpan(b[1]))
    .forEach(([, idxs]) => routeGroup(idxs));
  trunkGroups.forEach((idxs, k) => {
    if (k.endsWith(":b")) routeGroup(idxs, oneWaySegs);
  });
  // ── 3.5. Nudge horizontal segments out of phase header bands ─────────────
  // Phase headers are dark and wide; a horizontal segment passing through one
  // becomes invisible. We move only those specific segments to just above the
  // header — vertical segments are thin enough to stay readable. This runs
  // BEFORE spreadLanes so that the lane fan, which separates different-source
  // edges sharing a gutter, gets the final say: nudging stacks segments onto a
  // single y, and spreadLanes must then pull them back apart.
  if (phaseHeaders.length) {
    for (let i = 0; i < paths.length; i++) {
      if (!paths[i]) continue;
      let dirty = false;
      const pts = [...paths[i]];
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s], b = pts[s + 1];
        if (a.y !== b.y) continue; // skip vertical segments
        const xlo = Math.min(a.x, b.x);
        const xhi = Math.max(a.x, b.x);
        const hdr = phaseHeaders.find(
          (h) => a.y > h.y && a.y < h.y + h.h && xlo < h.x + h.w && xhi > h.x,
        );
        if (!hdr) continue;
        const newY = hdr.y - INFLATE;
        pts[s] = { x: a.x, y: newY };
        pts[s + 1] = { x: b.x, y: newY };
        dirty = true;
      }
      if (dirty) paths[i] = simplify(pts);
    }
  }

  // ── 3.6. Push perimeter segments off the phase box walls ─────────────────
  // The routing gutter sits INFLATE from a node; the box wall sits PHASE_PAD
  // (=== INFLATE) from it — so a perimeter segment lands exactly on the border
  // and reads as drawn on it. Shift such a segment OUTWARD (away from the box
  // interior) by WALL_GAP so inter-phase / back edges flow in the margin with a
  // clear gap. Only interior segments move (port stubs stay anchored). Runs
  // before spreadLanes so the lane fan re-separates anything this stacks. The
  // top wall is the header, already cleared upward by step 3.5.
  if (phaseBoxes.length) {
    const TOL = 2;
    for (let i = 0; i < paths.length; i++) {
      if (!paths[i]) continue;
      const pts = [...paths[i]];
      let dirty = false;
      for (let s = 1; s + 2 < pts.length; s++) {
        const a = pts[s], b = pts[s + 1];
        if (a.x === b.x) {
          // vertical segment — check left/right walls it spans
          const ylo = Math.min(a.y, b.y), yhi = Math.max(a.y, b.y);
          for (const bx of phaseBoxes) {
            if (yhi <= bx.T || ylo >= bx.B) continue;
            let nx: number | null = null;
            if (Math.abs(a.x - bx.L) <= TOL) nx = bx.L - WALL_GAP;
            else if (Math.abs(a.x - bx.R) <= TOL) nx = bx.R + WALL_GAP;
            if (nx !== null) {
              pts[s] = { x: nx, y: a.y };
              pts[s + 1] = { x: nx, y: b.y };
              dirty = true;
              break;
            }
          }
        } else if (a.y === b.y) {
          // horizontal segment — check the bottom wall it spans
          const xlo = Math.min(a.x, b.x), xhi = Math.max(a.x, b.x);
          for (const bx of phaseBoxes) {
            if (xhi <= bx.L || xlo >= bx.R) continue;
            if (Math.abs(a.y - bx.B) <= TOL) {
              const ny = bx.B + WALL_GAP;
              pts[s] = { x: a.x, y: ny };
              pts[s + 1] = { x: b.x, y: ny };
              dirty = true;
              break;
            }
          }
        }
      }
      if (dirty) paths[i] = simplify(pts);
    }
  }

  if (fixedContext) {
    spreadLanes(
      [...paths, ...fixedContext.paths],
      [...plans.map(trunkKeyOf), ...fixedContext.sources],
      [...plans.map(() => false), ...fixedContext.paths.map(() => true)],
    );
  } else {
    spreadLanes(paths, plans.map(trunkKeyOf));
  }

  // ── 4. Label placement (annotation layout lives in flowLabelPlacement.ts) ─
  const labelTextOf = (p: PortPlan): string | undefined => {
    const e = p.edge;
    const revLabel = isBidir(e.source, e.target)
      ? reverseLabel.get(`${e.source}::${e.target}`)
      : undefined;
    const l =
      e.label && revLabel && e.label !== revLabel
        ? `${e.label} / ${revLabel}`
        : (e.label ?? revLabel);
    return typeof l === "string" ? l : undefined;
  };
  // Segments shared with same-trunk siblings are no place for a label — two
  // fan labels would land on the same midpoint and read as one.
  const segUse = new Map<string, number>();
  trunkGroups.forEach((idxs) => {
    if (idxs.length < 2) return;
    idxs.forEach((i) => {
      const pts = paths[i];
      for (let s = 0; s + 1 < pts.length; s++) {
        const k = trunkKey(pts[s], pts[s + 1]);
        segUse.set(k, (segUse.get(k) ?? 0) + 1);
      }
    });
  });
  // Multi-condition merged edges contribute one item PER condition, anchored
  // at the legacy perpendicular split (vertical line → side by side,
  // horizontal → stacked) — but through the same collision system as single
  // labels, so a node or another label at the split spot pushes them off.
  const items: LabelItem[] = [];
  const slot: { plan: number; mi?: number }[] = [];
  plans.forEach((p, i) => {
    const multi = (p.edge.data as { labels?: string[] } | undefined)?.labels;
    const pts = paths[i];
    if (multi && multi.length > 1 && pts && pts.length >= 2) {
      let best = 0, bi = 0;
      for (let s = 0; s + 1 < pts.length; s++) {
        const len = Math.abs(pts[s + 1].x - pts[s].x) + Math.abs(pts[s + 1].y - pts[s].y);
        if (len > best) { best = len; bi = s; }
      }
      const a = pts[bi], b = pts[bi + 1];
      const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      multi.forEach((txt, mi) => {
        const k = mi - (multi.length - 1) / 2;
        slot.push({ plan: i, mi });
        items.push({
          i: items.length,
          pathIdx: i,
          text: txt,
          pts,
          fixedAnchor: {
            x: mid.x + (vertical ? k * 150 : 0),
            y: mid.y + (vertical ? 0 : k * 38),
          },
        });
      });
      return;
    }
    const text = labelTextOf(p);
    if (text) {
      slot.push({ plan: i });
      items.push({ i: items.length, pathIdx: i, text, pts });
    }
  });
  const placedLbl = placeLabels(
    items,
    paths,
    [...rectOf.values(), ...phaseHeaders],
    (a, b) => (segUse.get(trunkKey(a, b)) ?? 1) > 1,
    fixedContext?.labels,
  );
  const labels = new Map<number, PlacedLabel>();
  const labelsPosOf = new Map<number, (PlacedLabel | undefined)[]>();
  slot.forEach((s, k) => {
    const p = placedLbl.get(k);
    if (!p) return;
    if (s.mi === undefined) {
      labels.set(s.plan, p);
    } else {
      const arr = labelsPosOf.get(s.plan) ?? [];
      arr[s.mi] = p;
      labelsPosOf.set(s.plan, arr);
    }
  });

  // Deterministic path→hue assignment: fail-ish names → rose, the rest take
  // muted hues in sorted-name order.
  const pathColor = new Map<string, string>();
  {
    const names = [...new Set(
      edges.map((e) => (e.data as { path?: string } | undefined)?.path).filter((v): v is string => !!v),
    )].sort();
    let hue = 0;
    for (const name of names)
      pathColor.set(name, FAILISH.test(name) ? FLOW_FAIL : PATH_HUES[hue++ % PATH_HUES.length]);
  }

  return plans.map((p, i) => {
    const e = p.edge;
    const bidir = isBidir(e.source, e.target);
    const path = (e.data as { path?: string } | undefined)?.path;
    const color = bidir ? FLOW_BIDIR : (path && pathColor.get(path)) || FLOW_FWD;
    return {
      ...e,
      label: labelTextOf(p),
      type: "flowRouted",
      sourceHandle: `n__${p.sSide}`,
      targetHandle: `n__${p.tSide}`,
      style: { ...e.style, stroke: color },
      // Merged bidirectional line: arrowhead on both ends.
      markerStart: bidir
        ? { type: MarkerType.ArrowClosed, color, width: 18, height: 18 }
        : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      zIndex: bidir ? 10 : undefined,
      data: {
        ...e.data,
        points: paths[i],
        labelPos: labels.get(i),
        labelWrap: labels.get(i)?.wrap,
        labelsPos: labelsPosOf.get(i),
      },
    } as Edge;
  });
}

/** Incremental re-route after a manual drag. "Touched" = what the user's
 *  action physically affected: edges incident to the moved node PLUS frozen
 *  edges whose path the node now sits on. Those re-route (from PRISTINE
 *  built edges, so bidirectional merging re-applies); everything else keeps
 *  its frozen path — a custom arrangement must not reshuffle lines the user
 *  didn't touch.
 *
 *  FLOWCHART EXCEPTION — fan integrity: a comb fan is ONE visual structure.
 *  When any branch of a one-way fan goes dirty, the whole fan re-routes
 *  together, so every bend lands back on a single split line (a lone branch
 *  would re-route solo, comb logic needs ≥2, and the symmetry would break). */
export function rerouteFlowForNode(
  nodes: Node[],
  builtEdges: Edge[],
  prevRouted: Edge[],
  movedId: string,
): Edge[] {
  const moved = nodes.find((n) => n.id === movedId);
  const box: Rect | null = moved
    ? {
        x: moved.position.x,
        y: moved.position.y,
        w: moved.width ?? 88,
        h: moved.height ?? 82,
      }
    : null;
  const pathHitsBox = (e: Edge): boolean => {
    if (!box) return false;
    const pts = (e.data as { points?: RoutedPoint[] } | undefined)?.points;
    if (!pts) return false;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segmentBlocked(pts[i], pts[i + 1], box)) return true;
    }
    return false;
  };
  // endpoints of routed pairs that must re-route: incident OR run-over
  const dirty = new Set<string>();
  prevRouted.forEach((e) => {
    if (e.source === movedId || e.target === movedId || pathHitsBox(e)) {
      dirty.add(`${e.source}::${e.target}`);
      dirty.add(`${e.target}::${e.source}`); // pristine reverse of a merged pair
    }
  });
  // Fan integrity: pull every sibling of a dirty one-way fan branch into the
  // re-route so the comb re-forms around the new positions (one split line).
  const hasReverse = (e: Edge) =>
    builtEdges.some((o) => o.source === e.target && o.target === e.source);
  const fanOf = new Map<string, Edge[]>();
  builtEdges.forEach((e) => {
    if (!hasReverse(e)) fanOf.set(e.source, [...(fanOf.get(e.source) ?? []), e]);
  });
  builtEdges.forEach((e) => {
    if (!dirty.has(`${e.source}::${e.target}`) || hasReverse(e)) return;
    const sibs = fanOf.get(e.source) ?? [];
    if (sibs.length >= 2)
      sibs.forEach((s) => dirty.add(`${s.source}::${s.target}`));
  });
  const touches = (e: Edge) => dirty.has(`${e.source}::${e.target}`);
  const keep = prevRouted.filter((e) => !touches(e));
  // Feed the frozen lines into the re-route: their paths anchor lane
  // spreading, and their port spots are pre-reserved — otherwise a re-routed
  // edge converging on the same target rides the frozen stroke and stacks its
  // arrowhead on the frozen one (two edges reading as one line, one arrow).
  const fixedPaths: RoutedPoint[][] = [];
  const fixedSources: string[] = [];
  const fixedPorts: { key: string; along: number }[] = [];
  const fixedLabels: { x: number; y: number; text: string; wrap: boolean }[] = [];
  keep.forEach((e) => {
    const pts = (e.data as { points?: RoutedPoint[] } | undefined)?.points;
    if (!pts || pts.length < 2) return;
    fixedPaths.push(pts);
    fixedSources.push(`${e.source}${e.markerStart ? ":b" : ""}`);
    const dl = e.data as
      | {
          labelPos?: RoutedPoint;
          labelWrap?: boolean;
          labels?: string[];
          labelsPos?: ({ x: number; y: number; wrap: boolean } | undefined)[];
        }
      | undefined;
    if (typeof e.label === "string" && e.label && dl?.labelPos)
      fixedLabels.push({
        x: dl.labelPos.x,
        y: dl.labelPos.y,
        text: e.label,
        wrap: !!dl.labelWrap,
      });
    if (dl?.labels && dl.labelsPos)
      dl.labels.forEach((t, mi) => {
        const p = dl.labelsPos![mi];
        if (p) fixedLabels.push({ x: p.x, y: p.y, text: t, wrap: !!p.wrap });
      });
    const sSide = (e.sourceHandle ?? "").slice(3); // "n__r" → "r"
    const tSide = (e.targetHandle ?? "").slice(3);
    const sp = pts[0];
    const tp = pts[pts.length - 1];
    if (sSide)
      fixedPorts.push({
        key: `${e.source}:${sSide}`,
        along: sSide === "t" || sSide === "b" ? sp.x : sp.y,
      });
    if (tSide)
      fixedPorts.push({
        key: `${e.target}:${tSide}`,
        along: tSide === "t" || tSide === "b" ? tp.x : tp.y,
      });
  });
  // Full-graph degrees (over pair-deduped built edges, matching the full
  // route's count) so the merged bidir pair keeps its hub across re-routes.
  const deg = new Map<string, number>();
  const seenPair = new Set<string>();
  builtEdges.forEach((e) => {
    const k = `${e.source}::${e.target}`;
    if (seenPair.has(k)) return;
    seenPair.add(k);
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  });
  const rerouted = routeFlowEdges(nodes, builtEdges.filter(touches), {
    paths: fixedPaths,
    sources: fixedSources,
    ports: fixedPorts,
    deg,
    labels: fixedLabels,
  });
  return [...keep, ...rerouted];
}
