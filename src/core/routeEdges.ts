import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { placeLabels, type LabelItem } from "./labelPlacement";

/**
 * Orthogonal obstacle-avoiding edge routing for the compact layout.
 *
 * The compact layout guarantees gutters between rows/blocks; this router uses
 * them as streets: every edge becomes a Manhattan path that never crosses a
 * node box. Exit/entry sides are not fixed by rule: for diagonal pairs all
 * four side combinations (including mixed L-shapes — one end horizontal, the
 * other vertical, bending once where a same-axis Z bends twice) are routed
 * and the cheapest measured path wins; pairs overlapping on an axis keep the
 * single sensible combination.
 */

export interface RoutedPoint {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stroke colors: slate for one-way, amber for merged bidirectional lines. */
const ARCH_FWD = "#94a3b8";
const ARCH_BIDIR = "#d97706";

/** Clearance kept between a path and any obstacle box — also the distance
 *  from a node border to the first possible bend (bends only happen on the
 *  clearance grid). Lane spreading can shave up to 8px off this. */
const INFLATE = 14;
/** Extra cost per 90° turn — prefers straight runs over zig-zags. */
const TURN_PENALTY = 40;
/** Port inset from a node corner. */
const PORT_INSET = 14;
/** Cost multiplier on grid segments a sibling edge (same source trunk)
 *  already uses — pulls 1:N fans onto a shared trunk that splits at bends. */
const TRUNK_FACTOR = 0.05;
/** Cost multiplier pushing a merged bidirectional line OFF the gutters that
 *  one-way trunks occupy — a both-ends-arrow line must stay visually distinct
 *  from one-way fans (and its start arrowhead must not get buried in one). */
const AVOID_FACTOR = 3;
/** Added per intersection with an already-routed edge when scoring a side
 *  combination — a shorter L that buys new crossings is not a better L. */
const CROSS_PENALTY = 120;

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
 *  points start→goal, or null when walled in (caller falls back to an L). */
function astar(
  xs: number[],
  ys: number[],
  start: RoutedPoint,
  goal: RoutedPoint,
  obstacles: Rect[],
  trunk?: Set<string>,
  avoid?: Set<string>,
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
  dist.set(key(si, sj, 4), 0);
  push([heur(si, sj), 0, si, sj, 4]);

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
        (d !== 4 && d !== nd ? TURN_PENALTY : 0);
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
 *  one lane together (never spread apart from each other). */
function spreadLanes(paths: RoutedPoint[][], sourceOf: string[]) {
  interface Seg {
    pts: RoutedPoint[];
    i: number;
    lo: number;
    hi: number;
    src: string;
  }
  const pass = (axis: "x" | "y") => {
    const cross = axis === "y" ? "x" : "y"; // segment runs along `cross`
    const lines = new Map<number, Seg[]>();
    paths.forEach((pts, pi) => {
      for (let i = 1; i + 2 < pts.length; i++) {
        if (pts[i][axis] !== pts[i + 1][axis]) continue;
        const lo = Math.min(pts[i][cross], pts[i + 1][cross]);
        const hi = Math.max(pts[i][cross], pts[i + 1][cross]);
        const k = pts[i][axis];
        lines.set(k, [...(lines.get(k) ?? []), { pts, i, lo, hi, src: sourceOf[pi] }]);
      }
    });
    lines.forEach((segs) => {
      if (segs.length < 2) return;
      segs.sort((a, b) => a.lo - b.lo);
      let cluster: Seg[] = [];
      let end = -Infinity;
      const flush = () => {
        const bySrc = new Map<string, Seg[]>();
        cluster.forEach((s) => bySrc.set(s.src, [...(bySrc.get(s.src) ?? []), s]));
        if (bySrc.size > 1) {
          const lanes = [...bySrc.values()];
          const step = Math.min(6, 16 / (lanes.length - 1));
          lanes.forEach((laneSegs, idx) => {
            const off = (idx - (lanes.length - 1) / 2) * step;
            laneSegs.forEach((s) => {
              s.pts[s.i][axis] += off;
              s.pts[s.i + 1][axis] += off;
            });
          });
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

/** Route all architecture edges as Manhattan paths through layout gutters. */
export function routeArchEdges(nodes: Node[], edges: Edge[]): Edge[] {
  const rectOf = new Map<string, Rect>(
    nodes.map((n) => [
      n.id,
      { x: n.position.x, y: n.position.y, w: n.width ?? 210, h: n.height ?? 100 },
    ]),
  );

  const archKeys = new Set(edges.map((e) => `${e.source}::${e.target}`));
  const isBidir = (s: string, t: string) => archKeys.has(`${t}::${s}`);

  // Bidirectional pairs collapse into ONE line with an arrowhead at each end.
  // The kept direction starts at the higher-degree endpoint (the hub), so
  // sibling bidirectional lines share a source and can trunk-bundle — one
  // start arrowhead at the hub, splitting toward each partner.
  const degAll = new Map<string, number>();
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

  // ── 3. Route — side combination picked by measured path cost ────────────
  // An L-connection (one end horizontal, the other vertical) bends once
  // where a same-axis Z bends twice; which combination wins depends on the
  // surroundings, so for diagonal pairs all four combinations are routed and
  // the cheapest real path (length + turns + trunk reuse) is kept. Pairs
  // overlapping on an axis keep the single sensible combination. One-way
  // trunks (grouped per source) route first; merged bidirectional lines
  // route last with a penalty on one-way gutters so they stay distinct.
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
  const routeGroup = (idxs: number[], avoid?: Set<string>) => {
    const trunk = new Set<string>();
    const byDist = idxs
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
      const yOv = Math.min(s.y + s.h, t.y + t.h) - Math.max(s.y, t.y);
      const xOv = Math.min(s.x + s.w, t.x + t.w) - Math.max(s.x, t.x);
      const sH: Side = dx >= 0 ? "r" : "l";
      const sV: Side = dy >= 0 ? "b" : "t";
      const tH: Side = dx >= 0 ? "l" : "r";
      const tV: Side = dy >= 0 ? "t" : "b";
      const combos: [Side, Side][] =
        yOv > 8 ? [[sH, tH]] : xOv > 8 ? [[sV, tV]] : [[sV, tV], [sH, tH], [sV, tH], [sH, tV]];

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
          sPort = portFor(
            s,
            sSide,
            `${e.source}:${sSide}`,
            sHoriz ? s.x + s.w / 2 : s.y + s.h / 2,
            false,
          );
        }
        const tPort = portFor(
          t,
          tSide,
          `${e.target}:${tSide}`,
          tSide === "t" || tSide === "b" ? sPort.x : sPort.y,
          true,
        );
        const res = astar(
          xs,
          ys,
          escapeOf(sPort, sSide),
          escapeOf(tPort, tSide),
          obstacles,
          trunk,
          avoid,
        );
        if (res) {
          const cost =
            res.cost +
            crossesRouted(simplify([sPort, ...res.pts, tPort])) * CROSS_PENALTY;
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
        for (let k = 0; k + 1 < best.pts.length; k++) {
          trunk.add(trunkKey(best.pts[k], best.pts[k + 1]));
          if (!avoid) oneWaySegs.add(trunkKey(best.pts[k], best.pts[k + 1]));
        }
        paths[i] = simplify([best.sPort, ...best.pts, best.tPort]);
      } else {
        // walled in (shouldn't happen in compact gutters): plain L fallback
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
  trunkGroups.forEach((idxs, k) => {
    if (!k.endsWith(":b")) routeGroup(idxs);
  });
  trunkGroups.forEach((idxs, k) => {
    if (k.endsWith(":b")) routeGroup(idxs, oneWaySegs);
  });
  spreadLanes(paths, plans.map(trunkKeyOf));

  // ── 4. Label placement (annotation layout lives in labelPlacement.ts) ───
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
  const items: LabelItem[] = [];
  plans.forEach((p, i) => {
    const text = labelTextOf(p);
    if (text) items.push({ i, text, pts: paths[i] });
  });
  const labels = placeLabels(
    items,
    paths,
    [...rectOf.values()],
    (a, b) => (segUse.get(trunkKey(a, b)) ?? 1) > 1,
  );

  return plans.map((p, i) => {
    const e = p.edge;
    const bidir = isBidir(e.source, e.target);
    const color = bidir ? ARCH_BIDIR : ARCH_FWD;
    return {
      ...e,
      label: labelTextOf(p),
      type: "routed",
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
      },
    } as Edge;
  });
}

/** Incremental re-route after a manual drag. "Touched" = what the user's
 *  action physically affected: edges incident to the moved node PLUS frozen
 *  edges whose path the node now sits on. Those re-route (from PRISTINE
 *  built edges, so bidirectional merging re-applies); everything else keeps
 *  its frozen path — a custom arrangement must not reshuffle lines the user
 *  didn't touch. */
export function rerouteForNode(
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
  const touches = (e: Edge) => dirty.has(`${e.source}::${e.target}`);
  const keep = prevRouted.filter((e) => !touches(e));
  const rerouted = routeArchEdges(nodes, builtEdges.filter(touches));
  return [...keep, ...rerouted];
}
