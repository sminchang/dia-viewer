import type { Edge, Node } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ManifestKind } from "../manifest";

type Pos = Record<string, { x: number; y: number }>;

/** Architecture renders with the compact pipeline (crossing-first slot-grid
 *  placement); ERD uses the layered ELK arrangement for its FK trees. */
export async function layout(
  kind: ManifestKind,
  nodes: Node[],
  edges: Edge[],
): Promise<Pos> {
  return kind === "architecture"
    ? compactLayout(nodes, edges)
    : elkLayout(nodes, edges);
}

/** Hierarchical layered layout (ELK) — used by both ERD and architecture. */
async function elkLayout(nodes: Node[], edges: Edge[]): Promise<Pos> {
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
// Mirror of App.tsx boundary-box geometry (GROUP_PAD + label strip) so
// satellites clear the rendered boundary box.
const BOX_PAD = 20;
const BOX_LABEL_H = 16;
const BAND_GAP = BOX_PAD + BOX_LABEL_H + 64;

// Objective weights — crossings outweigh everything else (user priority);
// pierce flags a node sitting on another edge's straight line (the router
// would detour around it); area/aspect ask for a dense near-square canvas.
const W_CROSS = 1000;
const W_PIERCE = 800;
const W_LEN = 25;
const W_AREA = 20;
const W_ASPECT = 600;
const W_UPFLOW = 15;

function compactLayout(nodes: Node[], edges: Edge[]): Pos {
  if (nodes.length === 0) return {};

  const persons: Node[] = [];
  const externals: Node[] = [];
  const internal: Node[] = [];
  nodes.forEach((n) => {
    const d = n.data as { nodeType?: string; external?: boolean };
    if (d.nodeType === "person") persons.push(n);
    else if (d.external) externals.push(n);
    else internal.push(n);
  });

  const pos: Pos = {};
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

  if (internal.length > 0) {
    const slot = new Map<string, { x: number; y: number }>();
    const occ = new Set<string>();
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

    const objective = (): number => {
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
        Math.abs(Math.log(w / h)) * W_ASPECT +
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
    const order = [...internal].sort((a, b) => deg.get(b.id)! - deg.get(a.id)!);
    order.forEach((n, i) => {
      if (i === 0) {
        place(n.id, 0, 0);
        return;
      }
      let bestSlot = { x: 0, y: 0 };
      let bestScore = Infinity;
      for (const c of candidates()) {
        place(n.id, c.x, c.y);
        const s = objective();
        unplace(n.id);
        if (s < bestScore) {
          bestScore = s;
          bestSlot = c;
        }
      }
      place(n.id, bestSlot.x, bestSlot.y);
    });

    // Local search: keep any relocation or swap that measurably improves the
    // objective; stop when a full pass changes nothing.
    let cur = objective();
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (const n of order) {
        const orig = slot.get(n.id)!;
        let bestSlot: { x: number; y: number } | null = null;
        let bestScore = cur;
        for (const c of candidates()) {
          unplace(n.id);
          place(n.id, c.x, c.y);
          const s = objective();
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
          const s = objective();
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

    // Pixel mapping with axis compaction: empty grid rows/columns vanish, so
    // no canvas space is spent on slots nothing occupies.
    const heightOf = new Map(internal.map((n) => [n.id, n.height ?? 100]));
    const colW = Math.max(...internal.map((n) => n.width ?? 210));
    const xsUsed = [...new Set([...slot.values()].map((p) => p.x))].sort((a, b) => a - b);
    const ysUsed = [...new Set([...slot.values()].map((p) => p.y))].sort((a, b) => a - b);
    const xOf = new Map(xsUsed.map((v, i) => [v, i * (colW + GAP_X)]));
    const rowH = new Map<number, number>();
    slot.forEach((p, id) => {
      rowH.set(p.y, Math.max(rowH.get(p.y) ?? 0, heightOf.get(id)!));
    });
    const yOf = new Map<number, number>();
    let yy = 0;
    ysUsed.forEach((v) => {
      yOf.set(v, yy);
      yy += rowH.get(v)! + GAP_Y;
    });
    slot.forEach((p, id) => {
      pos[id] = {
        x: xOf.get(p.x)!,
        y: yOf.get(p.y)! + (rowH.get(p.y)! - heightOf.get(id)!) / 2,
      };
    });
  }

  // ── Satellites: persons/externals pinned outside the boundary, on the
  // side nearest their peers (an external lands next to its caller instead
  // of in a far-away rail).
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
}
