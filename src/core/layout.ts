import type { Edge, Node } from "@xyflow/react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import ELK from "elkjs/lib/elk.bundled.js";

export type LayoutMode = "hierarchical" | "central";

type Pos = Record<string, { x: number; y: number }>;

export async function layout(
  mode: LayoutMode,
  nodes: Node[],
  edges: Edge[],
): Promise<Pos> {
  return mode === "central" ? forceLayout(nodes, edges) : elkLayout(nodes, edges);
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

/**
 * Hub-centric radial layout (d3-force) followed by a grid-snap that aligns
 * nodes into columns. Faithful port of xenia-web's forceLayoutPositions — the
 * grid-snap is what makes it readable (without it the sim is an organic blob).
 */
function forceLayout(nodes: Node[], edges: Edge[]): Pos {
  if (nodes.length === 0) return {};

  const degree = new Map<string, number>();
  const heightOf = new Map<string, number>();
  nodes.forEach((n) => {
    degree.set(n.id, 0);
    heightOf.set(n.id, n.height ?? 100);
  });
  edges.forEach((e) => {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  });

  const HUB = 4;
  const LEAF = 0; // only truly unconnected (degree 0) tables go to the outer ring;
                  // any FK pulls a table inward (xenia used 1, which lumped degree 0 and 1)
  const maxW = Math.max(...nodes.map((n) => n.width ?? 260));

  // Tiered radii (xenia-web): hubs near center, leaves on the outer ring.
  const degOf = (id: string) => degree.get(id) ?? 0;
  const hubCount = nodes.filter((n) => degOf(n.id) >= HUB).length;
  const midCount = nodes.filter((n) => degOf(n.id) > LEAF && degOf(n.id) < HUB).length;
  const leafCount = nodes.filter((n) => degOf(n.id) <= LEAF).length;
  const inner = Math.max(hubCount * 60, 200);
  const mid = inner + Math.max(midCount * 50, 300);
  const outer = mid + Math.max(leafCount * 40, 400);

  interface Sim extends SimulationNodeDatum {
    id: string;
    r: number;
  }
  // Seed on a vertical line (x=0, y spread) — matches xenia-web. forceRadial
  // constrains distance only, not angle, so the seed shapes the final X (column)
  // projection. A circular seed scatters nodes into arbitrary columns; this does not.
  const sim: Sim[] = nodes.map((n, i) => ({
    id: n.id,
    x: 0,
    y: i * 200,
    r: Math.max(n.width ?? 260, n.height ?? 100) / 2,
  }));
  const links: SimulationLinkDatum<Sim>[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const s = forceSimulation<Sim>(sim)
    .force(
      "link",
      forceLink<Sim, SimulationLinkDatum<Sim>>(links)
        .id((d) => d.id)
        .distance(350)
        .strength(0.3),
    )
    .force("charge", forceManyBody<Sim>().strength(-800))
    .force(
      "collide",
      forceCollide<Sim>().radius((d) => d.r + 30).strength(0.8),
    )
    .force(
      "radial",
      forceRadial<Sim>(
        (d) => {
          const deg = degree.get(d.id) ?? 0;
          if (deg <= LEAF) return outer;
          if (deg >= HUB) return 0;
          return mid * (1 - (deg - LEAF) / (HUB - LEAF));
        },
        0,
        0,
      ).strength((d) => {
        const deg = degree.get(d.id) ?? 0;
        return deg <= LEAF ? 0.7 : deg >= HUB ? 0.5 : 0.3;
      }),
    )
    .force("cx", forceX<Sim>(0).strength(0.02))
    .force("cy", forceY<Sim>(0).strength(0.02))
    .stop();

  for (let i = 0; i < 300; i++) s.tick();

  // ── Grid-snap: keep the sim's relative placement but align to columns ──
  const cellW = maxW + 140;
  const vertGap = 50;
  const MAX_PER_COL = 8;

  interface Grid {
    id: string;
    simY: number;
    height: number;
    col: number;
  }
  const grid: Grid[] = sim.map((sn) => ({
    id: sn.id,
    simY: sn.y ?? 0,
    height: heightOf.get(sn.id) ?? 100,
    col: Math.round((sn.x ?? 0) / cellW),
  }));
  // Hubs (high degree) keep their column first; others shift to free columns.
  grid.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

  const columns = new Map<number, Grid[]>();
  grid.forEach((node) => {
    let col = node.col;
    const existing = columns.get(col);
    if (existing && existing.length >= MAX_PER_COL) {
      for (let off = 1; off < 30; off++) {
        if (!columns.has(col + off) || (columns.get(col + off)!.length < MAX_PER_COL)) {
          col = col + off;
          break;
        }
        if (!columns.has(col - off) || (columns.get(col - off)!.length < MAX_PER_COL)) {
          col = col - off;
          break;
        }
      }
    }
    node.col = col;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col)!.push(node);
  });

  const pos: Pos = {};
  const colHeight = new Map<number, number>();
  columns.forEach((colNodes, col) => {
    colNodes.sort((a, b) => a.simY - b.simY);
    let curY = 0;
    colNodes.forEach((node) => {
      pos[node.id] = { x: col * cellW, y: curY };
      curY += node.height + vertGap;
    });
    colHeight.set(col, curY);
  });

  // Vertically center each column (columns have different total heights).
  const maxColH = Math.max(...colHeight.values(), 0);
  columns.forEach((colNodes, col) => {
    const offset = (maxColH - (colHeight.get(col) ?? 0)) / 2;
    colNodes.forEach((node) => (pos[node.id].y += offset));
  });

  return pos;
}
