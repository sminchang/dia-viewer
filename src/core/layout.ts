import type { Edge, Node } from "@xyflow/react";
import type { ManifestKind } from "../manifest";
import { CONCEPT_CARD_W, FLOW_NODE_W, FLOW_NODE_H } from "./manifestToFlow";
import { routeArchEdges } from "./routeEdges";
import { routeFlowEdges } from "./routeFlowEdges";
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
  if (kind === "concept-tree") return conceptForestLayout(nodes, edges);
  if (kind === "flowchart") return flowLayout(nodes, edges, "portrait", labelRoom);
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

/** Hierarchical layered layout (ELK) — ERD (RIGHT, FK trees) and concept-tree
 *  (DOWN, a containment forest read top-to-bottom). */
async function elkLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "RIGHT" | "DOWN" = "RIGHT",
): Promise<Pos> {
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
      "elk.direction": direction,
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

/** Concept-tree layout — a tidy horizontal tree. Depth runs left→right (anchor
 *  at left). Subtrees pack TIGHT: a node's children stack by their own block
 *  heights, so similar siblings (leaves) sit at equal gaps while a child with a
 *  real subtree claims only the room it needs — high levels stay compact instead
 *  of inflating by child count, and space appears exactly where detail is added.
 *  Each parent centres on its children's vertical span (4 equal children →
 *  between the 2nd and 3rd; 3 → level with the 2nd). Separate trees stack
 *  top-to-bottom. A convergence node is placed once under its first parent; the
 *  extra parent keeps only its drawn edge. Pure/synchronous — no layout engine. */
const CONCEPT_COL_GAP = 90;  // horizontal gap between depth layers
const CONCEPT_ROW_GAP = 26;  // vertical gap between sibling leaves
const CONCEPT_TREE_GAP = 70; // extra vertical gap between separate trees
function conceptForestLayout(nodes: Node[], edges: Edge[]): Pos {
  if (nodes.length === 0) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Primary layout-parent = the first edge that targets a node; a later edge
  // into the same node is a convergence link (drawn, but not a second parent).
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  nodes.forEach((n) => children.set(n.id, []));
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    if (parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
    children.get(e.source)!.push(e.target);
  }
  const roots = nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id);

  // Depth (x layer) from the roots, following layout-parent edges.
  const depth = new Map<string, number>();
  const seen = new Set<string>();
  const stack: [string, number][] = roots.map((r) => [r, 0]);
  while (stack.length) {
    const [id, d] = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    depth.set(id, d);
    for (const c of children.get(id)!) stack.push([c, d + 1]);
  }
  nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, 0); });

  // Pass 1 — subtree extent: a TIGHT block = the sum of the children's blocks
  // (a leaf is one node-height slot). Compact — only a real subtree claims real
  // room, so high levels stay close instead of multiplying by child count.
  const extent = new Map<string, number>();
  const computeExtent = (id: string): number => {
    const kids = children.get(id)!;
    const own = (byId.get(id)!.height ?? 60) + CONCEPT_ROW_GAP;
    if (kids.length === 0) { extent.set(id, own); return own; }
    const e = Math.max(own, kids.reduce((a, k) => a + computeExtent(k), 0));
    extent.set(id, e);
    return e;
  };
  roots.forEach(computeExtent);

  // Pass 2 — stack each child's block tight inside the parent's; the parent
  // centres on the span of its children.
  const centerY = new Map<string, number>();
  const place = (id: string, top: number): void => {
    const kids = children.get(id)!;
    const h = byId.get(id)!.height ?? 60;
    if (kids.length === 0) { centerY.set(id, top + h / 2); return; }
    let childTop = top;
    for (const k of kids) { place(k, childTop); childTop += extent.get(k)!; }
    const first = centerY.get(kids[0])!;
    const last = centerY.get(kids[kids.length - 1])!;
    centerY.set(id, (first + last) / 2);
  };
  const colW = CONCEPT_CARD_W + CONCEPT_COL_GAP;
  const out: Pos = {};

  // Root-centred bidirectional spread: split the anchor's top-level branches
  // into a left and a right group (balanced by subtree height) so the tree fans
  // BOTH ways from a central root instead of growing one direction. Left
  // branches mirror (negative depth → x); updateConceptHandles flips their edge
  // sides. Falls back to single-direction for multi-root/trivial.
  const mainRoot = roots.length === 1 ? roots[0] : null;
  const branches = mainRoot ? children.get(mainRoot)! : [];
  if (mainRoot && branches.length >= 2) {
    const sorted = [...branches].sort((a, b) => extent.get(b)! - extent.get(a)!);
    const leftSet = new Set<string>();
    let lh = 0, rh = 0;
    for (const b of sorted) {
      if (lh <= rh) { leftSet.add(b); lh += extent.get(b)!; }
      else { rh += extent.get(b)!; }
    }
    const leftB = branches.filter((b) => leftSet.has(b));   // manifest order, per side
    const rightB = branches.filter((b) => !leftSet.has(b));

    // Lay each side as a stack centred on y=0, then PIN every branch's own root
    // to its slot centre (shift the whole subtree). So the root's links fan from
    // a shared centre — one branch each side lines up dead level with the root,
    // instead of drifting to its lopsided subtree's centre.
    const subtree = (id: string): string[] => {
      const acc = [id];
      for (const c of children.get(id)!) acc.push(...subtree(c));
      return acc;
    };
    const placeSide = (list: string[]): void => {
      const sideH = list.reduce((a, b) => a + extent.get(b)!, 0);
      let top = -sideH / 2;
      for (const b of list) {
        const ext = extent.get(b)!;
        place(b, top);
        const shift = (top + ext / 2) - centerY.get(b)!;   // pin branch root to slot centre
        for (const n of subtree(b)) centerY.set(n, centerY.get(n)! + shift);
        top += ext;
      }
    };
    placeSide(leftB);
    placeSide(rightB);
    // Both sides stack centred on y=0 (each starts at -sideH/2), so the root sits at the shared centre.
    centerY.set(mainRoot, 0);

    const sign = new Map<string, number>([[mainRoot, 0]]);
    const tag = (id: string, s: number): void => { sign.set(id, s); for (const c of children.get(id)!) tag(c, s); };
    leftB.forEach((b) => tag(b, -1));
    rightB.forEach((b) => tag(b, 1));

    for (const n of nodes) {
      const h = n.height ?? 60;
      out[n.id] = { x: (sign.get(n.id) ?? 1) * (depth.get(n.id) ?? 0) * colW, y: (centerY.get(n.id) ?? h / 2) - h / 2 };
    }
    return out;
  }

  let cursor = 0;
  for (const r of roots) {
    place(r, cursor);
    cursor += extent.get(r)! + CONCEPT_TREE_GAP;
  }
  for (const n of nodes) {
    const h = n.height ?? 60;
    out[n.id] = { x: (depth.get(n.id) ?? 0) * colW, y: (centerY.get(n.id) ?? h / 2) - h / 2 };
  }
  return out;
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
// Annotations ON: edge labels live in the gutters, so they get wider ones
// (12px documentation-grade labels — gutters clear the wrapped box + margin).
const GAP_X_ANNO = 136;
const GAP_Y_ANNO = 104;
// Mirror of App.tsx boundary-box geometry (GROUP_PAD + label strip) so
// satellites clear the rendered boundary box.
const BOX_PAD = 20;
const BOX_LABEL_H = 16;
const BAND_GAP = BOX_PAD + BOX_LABEL_H + 21;

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

// ── Flow layout (topology-aware) ───────────────────────────────────────────
//
// Linear segments stay in one column; branch points fan out proportionally
// to sub-tree width; merge points (multiple forward parents) center themselves
// on the mean of their parents' columns.

// Axis-aware spacing: the X axis carries node WIDTH, the Y axis node HEIGHT.
// Each orientation is computed natively (no 90° rotation), so the tight row step
// never lands on the width axis — vertically-stacked steps stay close.
const FLOW_COL_STEP = FLOW_NODE_W + 64;  // 244 — X axis (clears node width)
const FLOW_ROW_STEP = FLOW_NODE_H + 44;  // 128 — Y axis (clears node height; tighter)
// Annotations ON: edge labels sit in the inter-node gutters, so widen the step
// pitch to fit a label. Flowchart labels are documentation-grade (12px,
// WRAP_MAX 104 in FlowRoutedEdge) — gutters clear the wrapped box with margin.
const FLOW_COL_STEP_ANNO = FLOW_NODE_W + 136; // 316 — vertical gutter ≥ wrapped label + margin
const FLOW_ROW_STEP_ANNO = FLOW_NODE_H + 104; // 188 — horizontal gutter for 2-line labels

/** Orientation for the sub-layout inside each phase column.
 *  "landscape": depth → X (sequential), branch → Y (parallel branches stacked vertically).
 *  "portrait":  depth → Y (sequential), branch → X (parallel branches spread horizontally).
 *  "auto":      landscape when the phase has branching (multiple roots or fan-out > 1),
 *               portrait otherwise — keeps linear chains compact. */
function flowLayout(nodes: Node[], edges: Edge[], subOrientation: "portrait" | "landscape" | "auto" = "portrait", labelRoom = false): Pos {
  if (nodes.length === 0) return {};
  const colStep = labelRoom ? FLOW_COL_STEP_ANNO : FLOW_COL_STEP;
  const rowStep = labelRoom ? FLOW_ROW_STEP_ANNO : FLOW_ROW_STEP;

  const nodeIds = new Set(nodes.map((n) => n.id));

  // Full adjacency (all edges) + in-degrees for back-edge detection.
  const allAdj = new Map<string, string[]>();
  const indegAll = new Map<string, number>();
  for (const n of nodes) { allAdj.set(n.id, []); indegAll.set(n.id, 0); }
  for (const e of edges)
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      allAdj.get(e.source)!.push(e.target);
      indegAll.set(e.target, indegAll.get(e.target)! + 1);
    }

  // Back-edge detection by BFS layering (NOT DFS): an edge u→v is a back/cross
  // edge when v sits at an equal-or-earlier BFS level than u. BFS is symmetric
  // for parallel branches that share a loop hub — e.g. two tools that both loop
  // through one synthesize step; DFS visit-order marks inconsistent edges as
  // "back" there and stretches one branch to a much deeper rank.
  const level = new Map<string, number>();
  const bfs: string[] = [];
  for (const n of nodes) if (indegAll.get(n.id) === 0) { level.set(n.id, 0); bfs.push(n.id); }
  if (bfs.length === 0 && nodes.length) { level.set(nodes[0].id, 0); bfs.push(nodes[0].id); } // pure cycle
  for (let h = 0; h < bfs.length; h++) {
    const u = bfs[h];
    for (const v of allAdj.get(u)!)
      if (!level.has(v)) { level.set(v, level.get(u)! + 1); bfs.push(v); }
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0); // unreachable cycle remnants
  const backPairs = new Set<string>();
  for (const n of nodes)
    for (const v of allAdj.get(n.id)!)
      if (level.get(v)! <= level.get(n.id)!) backPairs.add(`${n.id}>${v}`);

  // Forward-only adjacency (back-edges excluded).
  const fwd = new Map<string, string[]>();
  const bwd = new Map<string, string[]>();
  for (const n of nodes) { fwd.set(n.id, []); bwd.set(n.id, []); }
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (backPairs.has(`${e.source}>${e.target}`)) continue;
    fwd.get(e.source)!.push(e.target);
    bwd.get(e.target)!.push(e.source);
  }

  // Resolve "auto": landscape when the phase has multiple roots or any fan-out > 1
  // (parallel branches exist), portrait for a plain linear chain.
  const ori: "portrait" | "landscape" = subOrientation === "auto"
    ? (
        nodes.filter((n) => bwd.get(n.id)!.length === 0).length > 1 ||
        nodes.some((n) => fwd.get(n.id)!.length > 1)
          ? "landscape"
          : "portrait"
      )
    : subOrientation;

  // Kahn topological sort + longest-path depth (Y axis).
  const indeg = new Map(nodes.map((n) => [n.id, bwd.get(n.id)!.length]));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const c of fwd.get(id)!) {
      depth.set(c, Math.max(depth.get(c)!, depth.get(id)! + 1));
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }

  // Column assignment by CONTOUR packing (Reingold–Tilford style), not by
  // subtree-width sums. A width sum reserves the subtree's widest level at
  // EVERY level, so a deep fan (e.g. validate → execute/error far down a
  // chain) pushes shallow siblings apart even though their own depth is
  // empty. Contours pack sibling subtrees by the columns they actually
  // occupy at each depth — shallow siblings tuck in close.
  const col = new Map<string, number>();
  const isMergeId = (id: string) => (bwd.get(id)?.length ?? 0) > 1;
  // Owned-children tree: merge nodes are placed afterward on their parents'
  // mean and excluded from subtree contours. A non-merge node has exactly
  // one forward parent, so its depth is parentDepth + 1 — subtree contour
  // arrays index cleanly by depth offset.
  interface Sub { rel: Map<string, number>; min: number[]; max: number[] }
  const subOf = new Map<string, Sub>();
  for (const id of [...topo].reverse()) {
    if (isMergeId(id)) continue;
    const kids = fwd.get(id)!.filter((k) => subOf.has(k));
    if (kids.length === 0) {
      subOf.set(id, { rel: new Map([[id, 0]]), min: [0], max: [0] });
      continue;
    }
    let acc: Sub | null = null;
    const kidCol: number[] = [];
    for (const k of kids) {
      const s = subOf.get(k)!;
      if (!acc) {
        acc = { rel: new Map(s.rel), min: [...s.min], max: [...s.max] };
        kidCol.push(0);
      } else {
        // minimal shift so this subtree clears the accumulated group's right
        // contour by one column at every depth both occupy
        let shift = -Infinity;
        for (let d = 0; d < Math.min(acc.min.length, s.min.length); d++)
          shift = Math.max(shift, acc.max[d] - s.min[d] + 1);
        if (shift === -Infinity) shift = acc.max[0] - s.min[0] + 1;
        s.rel.forEach((v, nid) => acc!.rel.set(nid, v + shift));
        kidCol.push(shift);
        const depths = Math.max(acc.min.length, s.min.length);
        for (let d = 0; d < depths; d++) {
          const sm = d < s.min.length ? s.min[d] + shift : Infinity;
          const sx = d < s.max.length ? s.max[d] + shift : -Infinity;
          acc.min[d] = Math.min(d < acc.min.length ? acc.min[d] : Infinity, sm);
          acc.max[d] = Math.max(d < acc.max.length ? acc.max[d] : -Infinity, sx);
        }
      }
    }
    // parent centered over its children; children sit one depth deeper
    const center = (kidCol[0] + kidCol[kidCol.length - 1]) / 2;
    const rel = new Map<string, number>([[id, 0]]);
    acc!.rel.forEach((v, nid) => rel.set(nid, v - center));
    subOf.set(id, {
      rel,
      min: [0, ...acc!.min.map((v) => v - center)],
      max: [0, ...acc!.max.map((v) => v - center)],
    });
  }

  // Roots: pack their subtrees side by side with the same contour rule.
  const roots = topo.filter((id) => bwd.get(id)!.length === 0 && subOf.has(id));
  if (roots.length === 0 && topo.length && subOf.has(topo[0])) roots.push(topo[0]);
  {
    let groupMin: number[] = [];
    let groupMax: number[] = [];
    for (const r of roots) {
      const s = subOf.get(r)!;
      let shift = 0;
      if (groupMin.length) {
        shift = -Infinity;
        for (let d = 0; d < Math.min(groupMax.length, s.min.length); d++)
          shift = Math.max(shift, groupMax[d] - s.min[d] + 1);
        if (shift === -Infinity) shift = groupMax[0] - s.min[0] + 1;
      }
      s.rel.forEach((v, nid) => col.set(nid, v + shift));
      const depths = Math.max(groupMin.length, s.min.length);
      for (let d = 0; d < depths; d++) {
        const sm = d < s.min.length ? s.min[d] + shift : Infinity;
        const sx = d < s.max.length ? s.max[d] + shift : -Infinity;
        groupMin[d] = Math.min(d < groupMin.length ? groupMin[d] : Infinity, sm);
        groupMax[d] = Math.max(d < groupMax.length ? groupMax[d] : -Infinity, sx);
      }
    }
  }

  // Merge nodes: mean of their placed parents, then a per-depth sweep nudges
  // them right until everyone at that depth keeps one column of separation
  // (contour packing guarantees this for tree nodes; merges can land close).
  for (const id of topo)
    if (!col.has(id)) {
      const parents = bwd.get(id)!.filter((p) => col.has(p));
      col.set(id, parents.length
        ? parents.reduce((s, p) => s + col.get(p)!, 0) / parents.length
        : 0);
    }
  {
    const byDepth = new Map<number, string[]>();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      byDepth.set(d, [...(byDepth.get(d) ?? []), n.id]);
    }
    byDepth.forEach((ids) => {
      ids.sort((a, b) => col.get(a)! - col.get(b)!);
      for (let i = 1; i < ids.length; i++)
        if (col.get(ids[i])! - col.get(ids[i - 1])! < 1)
          col.set(ids[i], col.get(ids[i - 1])! + 1);
    });
  }

  // Per-level depth pitch: a gutter earns the wide annotation pitch only when
  // a LABELED edge actually crosses it — unlabeled gutters keep the base
  // pitch, so consecutive plain steps stay close even with annotations on.
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const labeledLevel: boolean[] = new Array(maxDepth).fill(false);
  if (labelRoom)
    for (const e of edges) {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target) || !e.label) continue;
      if (backPairs.has(`${e.source}>${e.target}`)) continue;
      const d0 = depth.get(e.source)!;
      const d1 = depth.get(e.target)!;
      for (let d = d0; d < d1; d++) labeledLevel[d] = true;
    }
  const baseDepthStep = ori === "landscape" ? FLOW_COL_STEP : FLOW_ROW_STEP;
  const annoDepthStep = ori === "landscape" ? FLOW_COL_STEP_ANNO : FLOW_ROW_STEP_ANNO;
  const depthPos: number[] = [0];
  for (let d = 0; d < maxDepth; d++)
    depthPos.push(depthPos[d] + (labelRoom && labeledLevel[d] ? annoDepthStep : baseDepthStep));

  // Pixel positions.
  // portrait: depth → Y (sequential top-to-bottom), branch → X.
  // landscape: depth → X (sequential left-to-right), branch → Y (parallel branches stacked vertically).
  const minC = Math.min(...[...col.values()]);
  const pos: Pos = {};
  for (const n of nodes) {
    const colNorm = (col.get(n.id) ?? 0) - minC;
    const dep = depth.get(n.id) ?? 0;
    pos[n.id] = ori === "landscape"
      ? { x: depthPos[dep], y: colNorm * rowStep }
      : { x: colNorm * colStep, y: depthPos[dep] };
  }
  return pos;
}

/** Vertical room above each phase's steps for its box header (drawn in App).
 *  ≥ PHASE_HEADER_H (32) + the box's 8px header-to-step gap. */
const PHASE_HEADER_RESERVE = 48;

const INTER_PHASE_GAP_BASE = 96; // gap between adjacent phase regions
// Label-aware boundary widths (annotations ON): a boundary widens only when a
// LABELED edge crosses it, and only as much as that label needs — a horizontal
// boundary hosts a wrapped label between shelves.
const INTER_PHASE_GAP_BELOW_ANNO = 128; // inter-shelf gap when labels cross it

/** Phase-region flowchart layout. Each phase's steps are sub-laid-out as an
 *  independent flow (its cluster); phase regions are then placed in rank order,
 *  each relative to its primary parent. The parent-relative side — RIGHT or BELOW —
 *  is chosen by which makes the connecting step edges shortest with the fewest
 *  crossings of already-placed step boxes (the architecture-style edge cost). So a
 *  small phase after a WIDE one (e.g. response after a loop) lands below it, aligned
 *  under the step it connects from, giving a short straight edge instead of a long
 *  one across the wide region. A phase that recurs in a loop stays one region (the
 *  skill keeps loops inside a phase). Returns step positions; App draws one box per
 *  phase. */
function flowchartLayout(
  nodes: Node[],
  edges: Edge[],
  labelRoom = false,
  // Canvas orientation: which way the phases grow — landscape → right (wide),
  // portrait → down (tall). Every phase's sub-layout follows it (§3 below).
  orientation: Orientation = "landscape",
): Pos {
  const phaseOfId = new Map<string, string>();
  for (const n of nodes) {
    const p = (n.data as { phase?: string }).phase;
    if (p) phaseOfId.set(n.id, p);
  }
  const order: string[] = [];
  const stepsForPhase = new Map<string, Node[]>();
  for (const n of nodes) {
    const p = phaseOfId.get(n.id) ?? "__nophase";
    if (!stepsForPhase.has(p)) { stepsForPhase.set(p, []); order.push(p); }
    stepsForPhase.get(p)!.push(n);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const stepEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  // Single phase: it IS the whole diagram, so it just follows the canvas
  // orientation like every phase does in the multi-phase path below.
  if (order.length <= 1) return flowLayout(nodes, stepEdges, orientation, labelRoom);

  // 1. Sub-layout BOTH orientations per phase — the placement search picks
  //    per phase by measured cost (a linear chain may still lie sideways when
  //    that keeps the whole diagram compact, and vice versa).
  interface Cluster { rel: Pos; w: number; h: number; }
  const clusterOf = (pid: string, o: "portrait" | "landscape"): Cluster => {
    const steps = stepsForPhase.get(pid)!;
    const intra = stepEdges.filter(
      (e) => phaseOfId.get(e.source) === pid && phaseOfId.get(e.target) === pid,
    );
    const sub = flowLayout(steps, intra, o, labelRoom);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of steps) {
      const p = sub[s.id];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + (s.width ?? FLOW_NODE_W));
      maxY = Math.max(maxY, p.y + (s.height ?? FLOW_NODE_H));
    }
    const rel: Pos = {};
    for (const s of steps) rel[s.id] = { x: sub[s.id].x - minX, y: sub[s.id].y - minY };
    return { rel, w: maxX - minX, h: maxY - minY };
  };
  const clusterVariants = new Map<string, { portrait: Cluster; landscape: Cluster }>();
  for (const pid of order)
    clusterVariants.set(pid, { portrait: clusterOf(pid, "portrait"), landscape: clusterOf(pid, "landscape") });

  // 2. Phase graph from cross-phase step edges → drop only CYCLE-closing
  //    edges (DFS) → rank by LONGEST path. BFS levels are wrong here: a
  //    diamond (A→B, A→C, B→C) puts B and C on one level and silently drops
  //    B→C, so C never sees B as a parent — and lands on top of it.
  const padj = new Map<string, string[]>();
  for (const p of order) padj.set(p, []);
  const pseen = new Set<string>();
  for (const e of stepEdges) {
    const a = phaseOfId.get(e.source), b = phaseOfId.get(e.target);
    if (!a || !b || a === b) continue;
    const k = `${a}>${b}`;
    if (pseen.has(k)) continue;
    pseen.add(k);
    padj.get(a)!.push(b);
  }
  const backE = new Set<string>();
  {
    const state = new Map<string, number>(); // 0 unvisited, 1 in-stack, 2 done
    const dfs = (u: string) => {
      state.set(u, 1);
      for (const v of padj.get(u)!) {
        if (state.get(v) === 1) backE.add(`${u}>${v}`);
        else if (!state.get(v)) dfs(v);
      }
      state.set(u, 2);
    };
    for (const p of order) if (!state.get(p)) dfs(p);
  }
  const fadj = new Map<string, string[]>();
  const findeg = new Map<string, number>();
  for (const p of order) { fadj.set(p, []); findeg.set(p, 0); }
  for (const a of order)
    for (const b of padj.get(a)!)
      if (!backE.has(`${a}>${b}`)) {
        fadj.get(a)!.push(b); findeg.set(b, findeg.get(b)! + 1);
      }
  const rank = new Map(order.map((p) => [p, 0]));
  const rq = order.filter((p) => findeg.get(p) === 0);
  if (rq.length === 0 && order.length) rq.push(order[0]); // pure cycle fallback
  while (rq.length) {
    const a = rq.shift()!;
    for (const b of fadj.get(a)!) {
      rank.set(b, Math.max(rank.get(b)!, rank.get(a)! + 1));
      findeg.set(b, findeg.get(b)! - 1);
      if (findeg.get(b) === 0) rq.push(b);
    }
  }

  // 3. Placement by SHELF PACKING (compact-first) + measured variant search.
  //    Phase regions are packed in rank order along the orientation's main axis
  //    (landscape → rows left-to-right wrapping down; portrait → columns
  //    top-to-bottom wrapping right) toward a target extent, so small phases
  //    pack two-up to fill the whitespace a long phase leaves.
  //
  //    Two targets are tried and the lower measured cost wins: the COMPACT
  //    target (wraps to fill gaps — best when several similar phases exist,
  //    e.g. request+login under a wide token) and INFINITY (one shelf = a
  //    plain flow chain — best when one phase dominates, so wrapping the tiny
  //    final phase to a fresh shelf would orphan it and break the flow). The
  //    hill-climb tries each phase's sub-layout VARIANT for routing. Shelves
  //    are disjoint bands → overlap-free; reading order is the fill order.
  const RES = PHASE_HEADER_RESERVE;
  const ordered = [...order].sort((a, b) => rank.get(a)! - rank.get(b)!);
  const gap = labelRoom ? INTER_PHASE_GAP_BELOW_ANNO : INTER_PHASE_GAP_BASE;
  const horizontal = orientation === "landscape"; // shelves run along X (rows)

  type PV = "portrait" | "landscape";
  const realize = (variant: Map<string, PV>, target: number): Pos => {
    const pos: Pos = {};
    let mainPos = 0, crossBase = 0, shelfThick = 0;
    for (const pid of ordered) {
      const c = clusterVariants.get(pid)![variant.get(pid)!];
      const w = c.w, h = c.h + RES;
      const main = horizontal ? w : h;
      // Wrap to a new shelf only when overflowing AND this phase is big enough
      // to justify its own shelf. A tiny phase (≈1 step) must NOT wrap alone —
      // it would land at the next shelf's START (visually before the bulky
      // phase it follows), so the flow edge into it points backward. Let it
      // overflow the current shelf instead. Threshold is absolute (≈2 steps),
      // not relative to target — a relative one flips on big dominant phases.
      const minShelf = 2.2 * (horizontal ? FLOW_NODE_W : FLOW_NODE_H);
      if (mainPos > 0 && mainPos + main > target && main >= minShelf) {
        crossBase += shelfThick + gap;
        mainPos = 0;
        shelfThick = 0;
      }
      const rx = horizontal ? mainPos : crossBase;
      const ry = horizontal ? crossBase : mainPos;
      for (const id of Object.keys(c.rel))
        pos[id] = { x: rx + c.rel[id].x, y: ry + RES + c.rel[id].y };
      mainPos += main + gap;
      shelfThick = Math.max(shelfThick, horizontal ? h : w);
    }
    return pos;
  };

  // Cross-phase fan-out centering. The in-phase comb (flowLayout centres a
  // parent over its children's span) stops at the phase boundary: a step whose
  // children live in the NEXT phase is a leaf in its own sub-layout, so the
  // fan lands lopsided. Restore it by shifting each child phase as a RIGID
  // block along the cross axis until its entry steps centre under the steps
  // that feed them. Symmetry is prioritised over pack tightness (the block may
  // leave whitespace). Safe because: blocks move on the cross axis only, and
  // same-shelf phases hold disjoint MAIN-axis bands, so a cross shift can never
  // overlap them. Phases on different shelves that share a main band are
  // de-overlapped afterward (the one rare case a shift can collide).
  const nodeW = new Map(nodes.map((n) => [n.id, n.width ?? FLOW_NODE_W]));
  const nodeH = new Map(nodes.map((n) => [n.id, n.height ?? FLOW_NODE_H]));
  const xPhase = new Map<string, { src: Set<string>; dst: Set<string> }>();
  for (const p of order) xPhase.set(p, { src: new Set(), dst: new Set() });
  for (const e of stepEdges) {
    const a = phaseOfId.get(e.source), b = phaseOfId.get(e.target);
    if (!a || !b || a === b) continue;
    xPhase.get(b)!.src.add(e.source);
    xPhase.get(b)!.dst.add(e.target);
  }
  const centerCrossPhase = (input: Pos): Pos => {
    const pos: Pos = {};
    for (const k in input) pos[k] = { x: input[k].x, y: input[k].y };
    const crossDim = (id: string) => (horizontal ? nodeH.get(id)! : nodeW.get(id)!);
    const mainDim = (id: string) => (horizontal ? nodeW.get(id)! : nodeH.get(id)!);
    const crossLo = (id: string) => (horizontal ? pos[id].y : pos[id].x);
    const crossMid = (id: string) => crossLo(id) + crossDim(id) / 2;
    const mainLo = (id: string) => (horizontal ? pos[id].x : pos[id].y);
    // Span midpoint (min..max of centres) — matches the in-phase comb, which
    // centres on the span, not the mean (robust to lopsided fan counts).
    const spanMid = (ids: string[]): number => {
      const cs = ids.map(crossMid);
      return (Math.min(...cs) + Math.max(...cs)) / 2;
    };
    const origMinCross = Math.min(...nodes.map((n) => crossLo(n.id)));
    const moveCross = (pid: string, d: number) => {
      for (const s of stepsForPhase.get(pid)!)
        if (horizontal) pos[s.id].y += d; else pos[s.id].x += d;
    };
    // 1. Shift each child phase so its entry steps centre under their feeders.
    //    Rank order → a phase's parents are already settled when it moves.
    for (const pid of ordered) {
      const x = xPhase.get(pid)!;
      if (!x.dst.size) continue;
      moveCross(pid, spanMid([...x.src]) - spanMid([...x.dst]));
    }
    // 2. De-overlap phases that share a main-axis band (different shelves only;
    //    same-shelf phases are disjoint on main). Sweep in cross order, pushing
    //    each phase clear of every earlier phase it overlaps on the main axis.
    const range = (pid: string) => {
      const ss = stepsForPhase.get(pid)!;
      return {
        m0: Math.min(...ss.map((s) => mainLo(s.id))),
        m1: Math.max(...ss.map((s) => mainLo(s.id) + mainDim(s.id))),
        c0: Math.min(...ss.map((s) => crossLo(s.id))),
        c1: Math.max(...ss.map((s) => crossLo(s.id) + crossDim(s.id))),
      };
    };
    const byCross = [...order].sort((a, b) => range(a).c0 - range(b).c0);
    const done: { m0: number; m1: number; c1: number }[] = [];
    for (const pid of byCross) {
      const r = range(pid);
      let floor = -Infinity;
      for (const d of done)
        if (r.m0 < d.m1 && d.m0 < r.m1) floor = Math.max(floor, d.c1 + gap);
      if (floor > -Infinity && r.c0 < floor) { moveCross(pid, floor - r.c0); r.c0 = floor; }
      done.push({ m0: r.m0, m1: r.m1, c1: range(pid).c1 });
    }
    // 3. Preserve the original cross margin (header reserve, top/left gutter).
    const newMinCross = Math.min(...nodes.map((n) => crossLo(n.id)));
    const back = origMinCross - newMinCross;
    if (back) for (const pid of order) moveCross(pid, back);
    return pos;
  };

  // Compact wrap target: a near-rectangle of the total region area, long along
  // the orientation axis.
  const baseDim = (pid: string, v: PV) => {
    const c = clusterVariants.get(pid)![v];
    return horizontal ? c.w : c.h + RES;
  };
  // Selection score for packed-vs-chain: COMPACT-FIRST per the user's choice,
  // so crossings are EXCLUDED here (they would let the looser chain win on
  // auth, defeating the gap-fill). What distinguishes a good pack (auth: gap
  // filled, flow intact) from a bad one (tag-chat: tiny final phase orphaned
  // to a fresh shelf) is length + bends + half-perimeter — orphaning spikes
  // length, gap-fill shrinks the box.
  const selectScore = (pos: Pos): number => {
    const placed = nodes.filter((n) => pos[n.id]).map((n) => ({ ...n, position: pos[n.id] }));
    const routed = routeFlowEdges(placed as Node[], stepEdges);
    let bends = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of routed) {
      const pts = (e.data as { points?: { x: number; y: number }[] } | undefined)?.points;
      if (pts) bends += Math.max(0, pts.length - 2);
    }
    for (const n of placed) {
      x0 = Math.min(x0, n.position.x); y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + (n.width ?? FLOW_NODE_W));
      y1 = Math.max(y1, n.position.y + (n.height ?? FLOW_NODE_H));
    }
    return routedLength(routed) + 40 * bends + (x1 - x0) + (y1 - y0);
  };
  // EVERY phase's sub-layout follows the canvas orientation — depth along the
  // reading axis, branches perpendicular. A phase never orients against its
  // neighbours: a branching phase reads in the same direction as the linear
  // ones around it (its fan just spreads sideways), instead of turning broad-
  // side to fill space. Consistent direction beats the few crossings a lone
  // perpendicular phase would save. Only the shelf wrap is searched: COMPACT
  // (gaps filled) vs chain, lower measured cost wins.
  const variant = new Map<string, PV>();
  for (const pid of ordered) variant.set(pid, orientation);
  const area = ordered.reduce((a, pid) => {
    const c = clusterVariants.get(pid)![orientation];
    return a + c.w * (c.h + RES);
  }, 0);
  const maxMain = Math.max(0, ...ordered.map((pid) => baseDim(pid, orientation)));
  const packed = centerCrossPhase(realize(variant, Math.max(maxMain, Math.sqrt(area * 1.7))));
  const chained = centerCrossPhase(realize(variant, Infinity));
  return selectScore(packed) <= selectScore(chained) ? packed : chained;
}

/** The flowchart's single layout (no user toggle): phase regions placed by the
 *  edge-cost greedy in flowchartLayout. Both ArchLayout fields hold the same
 *  layout so orientation state is a no-op. */
export function flowLayoutBoth(nodes: Node[], edges: Edge[], labelRoom = false): ArchLayout {
  return {
    landscape: flowchartLayout(nodes, edges, labelRoom, "landscape"),
    portrait: flowchartLayout(nodes, edges, labelRoom, "portrait"),
    natural: "landscape", // flow reading convention; the toggle flips it
    fixed: false,
  };
}
