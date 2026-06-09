import type { Edge, Node } from "@xyflow/react";
import type { ManifestKind } from "../manifest";
import { routeArchEdges } from "./routeEdges";
import { routedLength, visualCrossings } from "./routeMetrics";

type Pos = Record<string, { x: number; y: number }>;

/** Compact-layout canvas orientation. The optimizer keeps crossing-count as
 *  the top priority either way; orientation only steers the aspect of the
 *  packing (more columns vs more rows) among equally good arrangements. */
export type Orientation = "landscape" | "portrait";

/** Both orientations of one compact layout plus which one the unbiased
 *  optimum naturally falls into (the sensible default toggle state). When the
 *  optimum is near-square, rotating it barely changes the aspect and just
 *  reshuffles the flow, so both orientations are identical and `fixed` is true
 *  (the viewer disables the toggle). */
export interface ArchLayout {
  landscape: Pos;
  portrait: Pos;
  natural: Orientation;
  fixed: boolean;
}

/** Below this long:short side ratio the layout is treated as square — flipping
 *  orientation isn't worth a distinct view. */
const SQUARE_RATIO = 1.2;

/** Architecture renders with the compact pipeline (crossing-first slot-grid
 *  placement); ERD uses the layered ELK arrangement for its FK trees.
 *  Architecture callers that need both orientations + the natural default use
 *  archLayout; this returns a single Pos (the requested orientation, or the
 *  natural one) so the gates and any single-orientation caller stay simple. */
export async function layout(
  kind: ManifestKind,
  nodes: Node[],
  edges: Edge[],
  labelRoom = false,
  orientation?: Orientation,
): Promise<Pos> {
  if (kind !== "architecture") return elkLayout(nodes, edges);
  const a = compactLayout(nodes, edges, labelRoom);
  return a[orientation ?? a.natural];
}

/** Architecture layout returning both orientations + the natural default, so
 *  the viewer can flip the orientation toggle instantly (one packing pass,
 *  two selections) instead of recomputing the ~multi-start search per flip. */
export function archLayout(nodes: Node[], edges: Edge[], labelRoom = false): ArchLayout {
  return compactLayout(nodes, edges, labelRoom);
}

/** Hierarchical layered layout (ELK) — used by both ERD and architecture. */
async function elkLayout(nodes: Node[], edges: Edge[]): Promise<Pos> {
  // The standalone viewer renders injected positions only — it never lays out,
  // so this early return lets the build drop elkjs (~500KB) entirely.
  if (__STANDALONE__) return {};
  // Dynamic import keeps elkjs (~500KB, ERD-only) out of the layout worker's
  // bundle — the worker calls archLayout, which never touches ELK.
  const ELK = (await import("elkjs/lib/elk.bundled.js")).default;
  const elk = new ELK();
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width ?? 240,
      height: n.height ?? 100,
    })),
    edges: edges.map((e, i) => ({
      id: `le${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };
  const res = await elk.layout(graph);
  const pos: Pos = {};
  res.children?.forEach((c: { id: string; x?: number; y?: number }) => {
    pos[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  });
  return pos;
}

// ── Compact layout ─────────────────────────────────────────────────────────
//
// Crossing-first placement. Internal nodes go onto a slot grid by descending
// degree (hubs claim the center first), then local search — relocations and
// swaps — keeps any change that lowers a measured objective: straight-line
// crossings dominate; edge length, near-square canvas and downward flow act
// as tiebreakers. persons/externals are satellites pinned to the boundary
// side nearest their peers. No sub-domain clustering — space expresses
// relationships, data.role covers characteristics.

const GRID_GAP = 24; // stacking gap between satellites on one side
const GAP_X = 56;    // column gap — doubles as a vertical routing channel
const GAP_Y = 52;    // row gap — the router's horizontal gutters
// Annotations ON: edge labels live in the gutters, so they get wider ones.
const GAP_X_ANNO = 120;
const GAP_Y_ANNO = 96;
// Mirror of App.tsx boundary-box geometry (GROUP_PAD + label strip) so
// satellites clear the rendered boundary box.
const BOX_PAD = 20;
const BOX_LABEL_H = 16;
const BAND_GAP = BOX_PAD + BOX_LABEL_H + 14;

// Objective weights — crossings outweigh everything else (user priority);
// pierce flags a node sitting on another edge's straight line (the router
// would detour around it); area/aspect ask for a dense near-square canvas.
// Multi-start count: candidate orderings tried per layout (manifest order +
// seeded tie-break shuffles, split between the two orientation biases).
// Chosen by measurement — K=8 left an unlucky input order at 18 crossings,
// K=12 reached the observed floor; beyond that, linear cost for diminishing
// returns. Re-sweep on much larger or denser graphs.
const STARTS = 20;
// Target canvas ratio (long:short side) for an explicit landscape/portrait
// orientation — the biased starts aim here so the toggle yields a genuinely
// wide vs tall layout, not two copies of the near-square optimum.
const ASPECT_TARGET = 1.7;
const W_CROSS = 1000;
const W_PIERCE = 800;
const W_LEN = 25;
const W_AREA = 20;
const W_ASPECT = 600;
const W_UPFLOW = 15;

/** Rotate a whole placement 90° clockwise, keeping each node box upright (only
 *  its centre moves, so glyphs/labels never tip over). Arrangement and crossings
 *  are preserved exactly — rotation is crossing-invariant — while the canvas
 *  aspect transposes (wide ↔ tall). Used to derive the non-natural orientation
 *  from the optimum, so both orientations share the SAME minimal crossings. */
function rotateLayout90(pos: Pos, nodes: Node[]): Pos {
  const sz = new Map(nodes.map((n) => [n.id, { w: n.width ?? 88, h: n.height ?? 82 }]));
  const rot = Object.keys(pos).map((id) => {
    const s = sz.get(id)!;
    // 90° CW: centre (cx,cy) → (cy, −cx); the box keeps its size.
    return { id, nx: pos[id].y + s.h / 2, ny: -(pos[id].x + s.w / 2), w: s.w, h: s.h };
  });
  let minX = Infinity, minY = Infinity;
  rot.forEach((r) => {
    minX = Math.min(minX, r.nx - r.w / 2);
    minY = Math.min(minY, r.ny - r.h / 2);
  });
  const out: Pos = {};
  rot.forEach((r) => {
    out[r.id] = { x: r.nx - r.w / 2 - minX, y: r.ny - r.h / 2 - minY };
  });
  return out;
}

function compactLayout(nodes: Node[], edges: Edge[], labelRoom = false): ArchLayout {
  const gapX = labelRoom ? GAP_X_ANNO : GAP_X;
  const gapY = labelRoom ? GAP_Y_ANNO : GAP_Y;
  if (nodes.length === 0) return { landscape: {}, portrait: {}, natural: "landscape", fixed: true };

  const persons: Node[] = [];
  const externals: Node[] = [];
  const internal: Node[] = [];
  nodes.forEach((n) => {
    const d = n.data as { nodeType?: string; external?: boolean };
    if (d.nodeType === "person") persons.push(n);
    else if (d.external) externals.push(n);
    else internal.push(n);
  });

  const internalIds = new Set(internal.map((n) => n.id));
  const dir = edges.filter(
    (e) => internalIds.has(e.source) && internalIds.has(e.target),
  );
  // undirected unique pairs for the crossing/length terms
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  dir.forEach((e) => {
    const k = [e.source, e.target].sort().join("::");
    if (e.source !== e.target && !seen.has(k)) {
      seen.add(k);
      pairs.push([e.source, e.target]);
    }
  });

  // ── Satellites: persons/externals pinned outside the boundary, on the
  // side nearest their peers (an external lands next to its caller instead
  // of in a far-away rail).
  const placeSatellites = (pos: Pos): Pos => {
    if (Object.keys(pos).length === 0) {
      [...persons, ...externals].forEach((n, i) => {
        pos[n.id] = { x: 0, y: i * 160 };
      });
      return pos;
    }
    const nodeOf = new Map(nodes.map((n) => [n.id, n]));
    const xs = nodes.filter((n) => pos[n.id]).map((n) => pos[n.id].x);
    const xe = nodes.filter((n) => pos[n.id]).map((n) => pos[n.id].x + (n.width ?? 210));
    const ys2 = nodes.filter((n) => pos[n.id]).map((n) => pos[n.id].y);
    const ye = nodes.filter((n) => pos[n.id]).map((n) => pos[n.id].y + (n.height ?? 100));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xe);
    const minY = Math.min(...ys2);
    const maxY = Math.max(...ye);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    type SatSide = "l" | "r" | "t" | "b";
    // Does a straight line from peer-centre P out to `side` clear every
    // internal node? If so, a satellite pinned on that side, aligned to P,
    // connects with a single straight stroke instead of detouring around a
    // node that sits in the corridor.
    const internalRects = internal
      .filter((m) => pos[m.id])
      .map((m) => ({ id: m.id, x: pos[m.id].x, y: pos[m.id].y, w: m.width ?? 210, h: m.height ?? 100 }));
    const corridorClear = (pc: { x: number; y: number }, side: SatSide, peerId: string): boolean =>
      internalRects.every((r) => {
        if (r.id === peerId) return true;
        if (side === "r") return !(r.x > pc.x && r.y < pc.y && r.y + r.h > pc.y);
        if (side === "l") return !(r.x + r.w < pc.x && r.y < pc.y && r.y + r.h > pc.y);
        if (side === "b") return !(r.y > pc.y && r.x < pc.x && r.x + r.w > pc.x);
        return !(r.y + r.h < pc.y && r.x < pc.x && r.x + r.w > pc.x);
      });
    const sats = [...persons, ...externals].map((n) => {
      const peers = edges
        .filter((e) => e.source === n.id || e.target === n.id)
        .map((e) => (e.source === n.id ? e.target : e.source))
        .filter((id) => pos[id]);
      if (peers.length === 0) {
        // unconnected: persons default left, externals right
        const side: SatSide = (n.data as { nodeType?: string }).nodeType === "person" ? "l" : "r";
        return { n, side, want: cy };
      }
      const px =
        peers.reduce((a, id) => a + pos[id].x + (nodeOf.get(id)!.width ?? 210) / 2, 0) / peers.length;
      const py =
        peers.reduce((a, id) => a + pos[id].y + (nodeOf.get(id)!.height ?? 100) / 2, 0) / peers.length;
      const dx = (px - cx) / Math.max(maxX - cx, 1);
      const dy = (py - cy) / Math.max(maxY - cy, 1);
      const side: SatSide = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "l" : "r") : (dy < 0 ? "t" : "b");
      // Single-peer satellite: prefer a side whose straight corridor to the
      // peer is unobstructed (default side first), so the lone link stays
      // straight. Multi-peer keeps the peer-mean side (no single clean line).
      if (peers.length === 1) {
        const pc = { x: px, y: py };
        const clear = ([side, "r", "l", "b", "t"] as SatSide[]).find((sd) =>
          corridorClear(pc, sd, peers[0]),
        );
        if (clear) return { n, side: clear, want: clear === "l" || clear === "r" ? py : px };
      }
      return { n, side, want: side === "l" || side === "r" ? py : px };
    });

    (["l", "r", "t", "b"] as SatSide[]).forEach((side) => {
      const list = sats.filter((s) => s.side === side).sort((a, b) => a.want - b.want);
      let floor = -Infinity;
      list.forEach(({ n, want }) => {
        const w = n.width ?? 210;
        const h = n.height ?? 100;
        if (side === "l" || side === "r") {
          const y = Math.max(want - h / 2, floor);
          pos[n.id] = {
            x: side === "l" ? minX - BAND_GAP - w : maxX + BAND_GAP,
            y,
          };
          floor = y + h + GRID_GAP;
        } else {
          const x = Math.max(want - w / 2, floor);
          pos[n.id] = {
            x,
            y: side === "t" ? minY - BAND_GAP - h : maxY + BAND_GAP,
          };
          floor = x + w + GRID_GAP;
        }
      });
    });

    return pos;
  };

  if (internal.length > 0) {
    let slot = new Map<string, { x: number; y: number }>();
    let occ = new Set<string>();
    const keyOf = (x: number, y: number) => `${x},${y}`;
    const place = (id: string, x: number, y: number) => {
      slot.set(id, { x, y });
      occ.add(keyOf(x, y));
    };
    const unplace = (id: string) => {
      const p = slot.get(id)!;
      occ.delete(keyOf(p.x, p.y));
      slot.delete(id);
    };

    const ori = (
      p: { x: number; y: number },
      q: { x: number; y: number },
      r: { x: number; y: number },
    ) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const segDist = (
      p: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number },
    ): number => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const qx = a.x + t * dx;
      const qy = a.y + t * dy;
      return Math.hypot(p.x - qx, p.y - qy);
    };

    // Aspect penalty per mode. "square" targets w==h (used only to detect the
    // natural orientation). "landscape"/"portrait" target a definite ratio
    // (w:h = ASPECT_TARGET:1 and its inverse) so the biased starts actually
    // reshape a square-optimal graph into a wide / tall one — a one-sided "wide
    // is free" penalty left squares unpenalized, collapsing both toggles onto
    // the same near-square layout.
    const LOG_T = Math.log(ASPECT_TARGET);
    const aspectTerm = (w: number, h: number, o: Orientation | "square"): number => {
      const l = Math.log(w / h);
      if (o === "square") return Math.abs(l);
      if (o === "landscape") return Math.abs(l - LOG_T);
      return Math.abs(l + LOG_T);
    };

    const objective = (aspectMode: Orientation | "square"): number => {
      const live = pairs.filter(([s, t]) => slot.has(s) && slot.has(t));
      let cross = 0;
      let pierce = 0;
      let len = 0;
      for (let i = 0; i < live.length; i++) {
        const a = slot.get(live[i][0])!;
        const b = slot.get(live[i][1])!;
        len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
        slot.forEach((p, id) => {
          if (id === live[i][0] || id === live[i][1]) return;
          if (segDist(p, a, b) < 0.4) pierce++;
        });
        for (let j = i + 1; j < live.length; j++) {
          const [s2, t2] = live[j];
          if (s2 === live[i][0] || s2 === live[i][1] || t2 === live[i][0] || t2 === live[i][1]) continue;
          const c = slot.get(s2)!;
          const d = slot.get(t2)!;
          if (ori(a, b, c) !== ori(a, b, d) && ori(c, d, a) !== ori(c, d, b)) cross++;
        }
      }
      let up = 0;
      dir.forEach((e) => {
        const a = slot.get(e.source);
        const b = slot.get(e.target);
        if (a && b && b.y < a.y) up++;
      });
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      slot.forEach((p) => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      return (
        cross * W_CROSS +
        pierce * W_PIERCE +
        len * W_LEN +
        w * h * W_AREA +
        aspectTerm(w, h, aspectMode) * W_ASPECT +
        up * W_UPFLOW
      );
    };

    const candidates = (): { x: number; y: number }[] => {
      if (slot.size === 0) return [{ x: 0, y: 0 }];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      slot.forEach((p) => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      const out: { x: number; y: number }[] = [];
      for (let x = minX - 1; x <= maxX + 1; x++)
        for (let y = minY - 1; y <= maxY + 1; y++)
          if (!occ.has(keyOf(x, y))) out.push({ x, y });
      return out;
    };

    // Greedy seed by descending degree — "place by connection count": the
    // hub lands first (center), every next node takes the free slot that
    // scores best against the partially built graph.
    const deg = new Map<string, number>(internal.map((n) => [n.id, 0]));
    pairs.forEach(([s, t]) => {
      deg.set(s, (deg.get(s) ?? 0) + 1);
      deg.set(t, (deg.get(t) ?? 0) + 1);
    });

    const seedAndSearch = (order: Node[], aspectMode: Orientation | "square"): number => {
      order.forEach((n, i) => {
        if (i === 0) {
          place(n.id, 0, 0);
          return;
        }
        let bestSlot = { x: 0, y: 0 };
        let bestScore = Infinity;
        for (const c of candidates()) {
          place(n.id, c.x, c.y);
          const s = objective(aspectMode);
          unplace(n.id);
          if (s < bestScore) {
            bestScore = s;
            bestSlot = c;
          }
        }
        place(n.id, bestSlot.x, bestSlot.y);
      });

      // Local search: keep any relocation or swap that measurably improves
      // the objective; stop when a full pass changes nothing.
      let cur = objective(aspectMode);
      for (let pass = 0; pass < 8; pass++) {
        let improved = false;
        for (const n of order) {
          const orig = slot.get(n.id)!;
          let bestSlot: { x: number; y: number } | null = null;
          let bestScore = cur;
          for (const c of candidates()) {
            unplace(n.id);
            place(n.id, c.x, c.y);
            const s = objective(aspectMode);
            unplace(n.id);
            place(n.id, orig.x, orig.y);
            if (s < bestScore) {
              bestScore = s;
              bestSlot = c;
            }
          }
          if (bestSlot) {
            unplace(n.id);
            place(n.id, bestSlot.x, bestSlot.y);
            cur = bestScore;
            improved = true;
            continue;
          }
          for (const m of order) {
            if (m.id === n.id) continue;
            const pa = slot.get(n.id)!;
            const pb = slot.get(m.id)!;
            unplace(n.id);
            unplace(m.id);
            place(n.id, pb.x, pb.y);
            place(m.id, pa.x, pa.y);
            const s = objective(aspectMode);
            if (s < cur) {
              cur = s;
              improved = true;
            } else {
              unplace(n.id);
              unplace(m.id);
              place(n.id, pa.x, pa.y);
              place(m.id, pb.x, pb.y);
            }
          }
        }
        if (!improved) break;
      }
      return cur;
    };

    // Multi-start: the greedy seed breaks degree ties by list order and the
    // improve-only search never leaves that basin, so a single start is an
    // input-order lottery (measured 16~31 crossings across shuffles of one
    // real 21-node graph). Re-run from deterministic tie-break permutations;
    // the manifest order runs first, so equal scores never regress.
    const mulberry = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const byDegree = (list: Node[]) =>
      [...list].sort((a, b) => deg.get(b.id)! - deg.get(a.id)!);
    // Each start carries an aspect bias. The manifest order runs under both
    // biases (so the natural ordering is represented in each orientation);
    // the shuffles alternate, splitting the budget evenly between landscape
    // and portrait so the pool always holds good candidates of both shapes.
    const starts: { order: Node[]; mode: Orientation }[] = [
      { order: byDegree(internal), mode: "landscape" },
      { order: byDegree(internal), mode: "portrait" },
    ];
    for (let k = 1; k < STARTS - 1; k++) {
      const rnd = mulberry(k);
      const shuffled = [...internal];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      starts.push({ order: byDegree(shuffled), mode: k % 2 ? "landscape" : "portrait" });
    }
    // Pixel mapping with axis compaction: empty grid rows/columns vanish, so
    // no canvas space is spent on slots nothing occupies.
    const pixelMap = (sm: Map<string, { x: number; y: number }>): Pos => {
      const out: Pos = {};
      const heightOf = new Map(internal.map((n) => [n.id, n.height ?? 100]));
      const colW = Math.max(...internal.map((n) => n.width ?? 210));
      const xsUsed = [...new Set([...sm.values()].map((p) => p.x))].sort((a, b) => a - b);
      const ysUsed = [...new Set([...sm.values()].map((p) => p.y))].sort((a, b) => a - b);
      const xOf = new Map(xsUsed.map((v, i) => [v, i * (colW + gapX)]));
      const rowH = new Map<number, number>();
      sm.forEach((p, id) => {
        rowH.set(p.y, Math.max(rowH.get(p.y) ?? 0, heightOf.get(id)!));
      });
      const yOf = new Map<number, number>();
      let yy = 0;
      ysUsed.forEach((v) => {
        yOf.set(v, yy);
        yy += rowH.get(v)! + gapY;
      });
      sm.forEach((p, id) => {
        out[id] = {
          x: xOf.get(p.x)!,
          y: yOf.get(p.y)! + (rowH.get(p.y)! - heightOf.get(id)!) / 2,
        };
      });
      return out;
    };

    // Router-in-the-loop pool: the slot objective scores straight lines
    // between internal nodes only — satellite edges, port choice and trunk
    // bundling are invisible to it, and the two disagree enough that picking
    // a start by slot score alone keeps the input-order lottery alive
    // (still 13~29 crossings across shuffles with 8 starts). So assemble
    // every start into real positions, route it for real, and measure the
    // visual crossings / length / canvas of each. Identical grids route once.
    interface Cand { pos: Pos; slot: Map<string, { x: number; y: number }>; cross: number; len: number; obj: number; w: number; h: number }
    const pool: Cand[] = [];
    const routedGrids = new Set<string>();
    for (const { order, mode } of starts) {
      slot = new Map();
      occ = new Set();
      const obj = seedAndSearch(order, mode);
      const pts = [...slot.values()];
      const mx = Math.min(...pts.map((p) => p.x));
      const my = Math.min(...pts.map((p) => p.y));
      const sig = [...slot.entries()]
        .map(([id, p]) => `${id}:${p.x - mx},${p.y - my}`)
        .sort()
        .join("|");
      if (routedGrids.has(sig)) continue;
      routedGrids.add(sig);
      const cand = placeSatellites(pixelMap(slot));
      const placed = nodes.map((n) => ({ ...n, position: cand[n.id] }));
      const routed = routeArchEdges(placed, edges);
      let aX = Infinity, bX = -Infinity, aY = Infinity, bY = -Infinity;
      placed.forEach((n) => {
        aX = Math.min(aX, n.position.x); bX = Math.max(bX, n.position.x + (n.width ?? 88));
        aY = Math.min(aY, n.position.y); bY = Math.max(bY, n.position.y + (n.height ?? 82));
      });
      pool.push({
        pos: cand,
        slot: new Map(slot),
        cross: visualCrossings(routed),
        len: routedLength(routed),
        obj,
        w: bX - aX,
        h: bY - aY,
      });
    }

    // Pick the single best layout (fewest crossings, then shortest, then slot
    // score); the OTHER orientation is that exact layout rotated 90°, not a
    // separate re-optimization. Rotation is crossing-invariant, so both
    // orientations share the same minimal crossings and the arrangement stays
    // recognizable when you flip — the canvas just transposes wide ↔ tall (for
    // fitting a full A4 page vs half a page).
    const best = [...pool].sort(
      (a, b) => a.cross - b.cross || a.len - b.len || a.obj - b.obj,
    )[0];

    // Cleanup pass. The slot search optimises a straight-line PROXY (centre-to-
    // centre crossings), which over-counts crossings for some arrangements the
    // real orthogonal router draws just as cleanly — so it strands nodes (a
    // sink dropped to the boundary when it could sit by its caller for the SAME
    // crossings and a shorter route). Re-judge alignment moves with the ACTUAL
    // router: slide a node onto a free slot sharing a row/column with a
    // neighbour, keep it only if crossings don't rise and the routing shortens.
    // This is the manual "drag it into line" automated, bounded by a route
    // budget so the layout stays a few seconds.
    const adj = new Map<string, string[]>();
    pairs.forEach(([s, t]) => {
      adj.set(s, [...(adj.get(s) ?? []), t]);
      adj.set(t, [...(adj.get(t) ?? []), s]);
    });
    const evalSlot = (sm: Map<string, { x: number; y: number }>) => {
      const pos = placeSatellites(pixelMap(sm));
      const placed = nodes.map((n) => ({ ...n, position: pos[n.id] }));
      const routed = routeArchEdges(placed, edges);
      return { cross: visualCrossings(routed), len: routedLength(routed), pos };
    };
    const clean = new Map(best.slot);
    let cur = evalSlot(clean);
    // Nodes furthest from their neighbours' centre first — those are the ones
    // the proxy most likely stranded.
    const stranded = (id: string) => {
      const ns = adj.get(id) ?? [];
      if (!ns.length) return 0;
      const me = clean.get(id)!;
      const cx = ns.reduce((a, k) => a + clean.get(k)!.x, 0) / ns.length;
      const cy = ns.reduce((a, k) => a + clean.get(k)!.y, 0) / ns.length;
      return Math.abs(me.x - cx) + Math.abs(me.y - cy);
    };
    const order2 = [...internal].sort((a, b) => stranded(b.id) - stranded(a.id));
    // Only clean up the compact (OFF) view — the deliverable. The annotations
    // (ON) view trades tightness for wide label gutters, and shifting nodes by
    // crossings/length alone there can push two labels into each other; that
    // view keeps the proxy-optimal arrangement so labels stay placed.
    let budget = labelRoom ? 0 : 28;
    for (const n of order2) {
      if (budget <= 0) break;
      const occupied = new Set(
        [...clean.entries()].filter(([k]) => k !== n.id).map(([, p]) => `${p.x},${p.y}`),
      );
      const ns = (adj.get(n.id) ?? []).map((k) => clean.get(k)!);
      if (!ns.length) continue;
      const cols = new Set(ns.map((p) => p.x));
      const rows = new Set(ns.map((p) => p.y));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      clean.forEach((p) => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      const me = clean.get(n.id)!;
      const cands: { x: number; y: number }[] = [];
      for (let x = minX - 1; x <= maxX + 1; x++)
        for (let y = minY - 1; y <= maxY + 1; y++)
          if ((cols.has(x) || rows.has(y)) && !occupied.has(`${x},${y}`) && !(x === me.x && y === me.y))
            cands.push({ x, y });
      cands.sort(
        (a, b) =>
          Math.abs(a.x - me.x) + Math.abs(a.y - me.y) - (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)),
      );
      let bestE = cur;
      let bestC: { x: number; y: number } | null = null;
      for (const c of cands.slice(0, 5)) {
        if (budget <= 0) break;
        budget--;
        const trial = new Map(clean);
        trial.set(n.id, c);
        const e = evalSlot(trial);
        if (e.cross <= cur.cross && e.len < bestE.len - 1) {
          bestE = e;
          bestC = c;
        }
      }
      if (bestC) {
        clean.set(n.id, bestC);
        cur = bestE;
      }
    }

    // Pick the single best layout (now cleaned); the OTHER orientation is that
    // exact layout rotated 90°, not a separate re-optimization. Rotation is
    // crossing-invariant, so both orientations share the same minimal crossings
    // and the arrangement stays recognizable when you flip — the canvas just
    // transposes wide ↔ tall (for fitting a full A4 page vs half a page).
    const cleanedPos = cur.pos;
    let pX = Infinity, qX = -Infinity, pY = Infinity, qY = -Infinity;
    nodes.forEach((n) => {
      const p = cleanedPos[n.id];
      if (!p) return;
      pX = Math.min(pX, p.x); qX = Math.max(qX, p.x + (n.width ?? 88));
      pY = Math.min(pY, p.y); qY = Math.max(qY, p.y + (n.height ?? 82));
    });
    const w = qX - pX;
    const h = qY - pY;
    const naturalLandscape = w >= h;
    // Near-square: don't offer a second orientation — both are the optimum,
    // and the viewer fixes (disables) the toggle.
    if (Math.max(w, h) / Math.max(1, Math.min(w, h)) < SQUARE_RATIO) {
      return {
        landscape: cleanedPos,
        portrait: cleanedPos,
        natural: naturalLandscape ? "landscape" : "portrait",
        fixed: true,
      };
    }
    const rotated = rotateLayout90(cleanedPos, nodes);
    return {
      landscape: naturalLandscape ? cleanedPos : rotated,
      portrait: naturalLandscape ? rotated : cleanedPos,
      natural: naturalLandscape ? "landscape" : "portrait",
      fixed: false,
    };
  }

  const sat = placeSatellites({});
  return { landscape: sat, portrait: sat, natural: "landscape", fixed: true };
}
