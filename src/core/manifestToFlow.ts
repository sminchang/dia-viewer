import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type {
  Column,
  DiagramManifest,
  ErdEdgeData,
  TableData,
} from "../manifest";

export const TABLE_WIDTH = 260;
export const HEADER_H = 36;
export const ROW_H = 24;
const C4_WIDTH = 210;

/** Per-node measured size — used by layout and group bounding boxes. */
export interface Sized {
  width: number;
  height: number;
}

/** Extra width the table grows by when annotations are toggled on — comments
 *  sit inline (column comments in each row, table comment in the header), so
 *  they only need extra horizontal space for ellipsis-truncated text. */
const COL_COMMENT_W = 60;

function isKeyColumn(c: {
  pk?: boolean;
  fk?: boolean;
  unique?: boolean;
  uniqueGroup?: string;
}): boolean {
  return !!(c.pk || c.fk || c.unique || c.uniqueGroup);
}

export function nodeSize(
  m: DiagramManifest,
  nodeId: string,
  showComments = false,
  keysOnly = false,
): Sized {
  const node = m.nodes.find((n) => n.id === nodeId)!;
  if (node.nodeType === "table") {
    const td = node.data as TableData;
    const visibleCols = keysOnly ? td.columns.filter(isKeyColumn) : td.columns;
    let height = HEADER_H + visibleCols.length * ROW_H;
    // Keys-only: one trailing row flags the hidden regular columns.
    if (keysOnly && visibleCols.length < td.columns.length) height += ROW_H;
    // Comments sit inline (rows + header), so they grow width rather than height.
    const width = TABLE_WIDTH + (showComments ? COL_COMMENT_W : 0);
    return { width, height };
  }
  const desc = (node.data as { description?: string }).description ?? "";
  return { width: C4_WIDTH, height: desc.length > 60 ? 116 : 96 };
}

export interface FlowData {
  nodes: Node[];
  edges: Edge[];
}

/** Convert a manifest into ReactFlow nodes + edges (positions set to 0; the
 *  layout pass fills them in). Column-level handles are wired for ERD edges.
 *  `showComments` and `keysOnly` are baked into node sizes and node data so the
 *  node component renders the right columns/comments and the layout reserves
 *  appropriate space. */
export function manifestToFlow(
  m: DiagramManifest,
  showComments = false,
  keysOnly = false,
): FlowData {
  const nodes: Node[] = m.nodes.map((n) => {
    const size = nodeSize(m, n.id, showComments, keysOnly);
    return {
      id: n.id,
      type: n.nodeType === "table" ? "table" : "c4",
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data: {
        ...n.data,
        label: n.label,
        nodeType: n.nodeType,
        group: n.group,
        showComments,
        keysOnly,
      },
    } as Node;
  });

  const edges: Edge[] = m.kind === "erd" ? buildErdEdges(m) : buildC4Edges(m);
  return { nodes, edges };
}

/** FK-relationship colour palette (xenia-web parity). Each edge cycles through. */
export const EDGE_COLORS = [
  "#063A74", "#059669", "#D97706", "#7C3AED", "#DC2626",
  "#0891B2", "#C026D3", "#2563EB", "#65A30D", "#EA580C",
];

/** Crow's-foot symbol per cardinality token (marker defs in ErdMarkers.tsx). */
const CARD_SYM: Record<string, string> = { "1": "one", "0..1": "zeroone", N: "many", M: "many" };

/** ERD edges: dashed, animated, colour-cycled, with curvature offset for
 *  multiple edges between the same table pair. Cardinality is expressed with
 *  crow's-foot (IE notation) end markers instead of a midpoint text label —
 *  position-independent and the de-facto standard for ERD deliverables. */
function buildErdEdges(m: DiagramManifest): Edge[] {
  const pairCount = new Map<string, number>();
  return m.edges.map((e, i) => {
    const d = (e.data ?? {}) as ErdEdgeData;
    const ci = i % EDGE_COLORS.length;
    const color = EDGE_COLORS[ci];
    const key = [e.source, e.target].sort().join("::");
    const pc = pairCount.get(key) ?? 0;
    pairCount.set(key, pc + 1);
    const offset = pc === 0 ? 0 : (pc % 2 === 0 ? 1 : -1) * Math.ceil(pc / 2) * 0.15;
    // Cardinality reads "parent:child" — parent is the referenced (target)
    // table, child the FK-holding (source) table. An FK edge without explicit
    // cardinality is one-parent-to-many-children by nature.
    const [parentSym, childSym] = (d.cardinality ?? "1:N")
      .split(":")
      .map((t) => CARD_SYM[t] ?? "one");
    return {
      id: e.id ?? `e${i}`,
      source: e.source,
      target: e.target,
      sourceHandle: d.sourceColumn ? `${d.sourceColumn}__r` : undefined,
      targetHandle: d.targetColumn ? `${d.targetColumn}__l` : undefined,
      type: "erd",
      animated: true,
      style: { stroke: color, strokeWidth: 1.8, strokeDasharray: "6 3", opacity: 0.7 },
      markerStart: `erd-${childSym}-s-${ci}`,
      markerEnd: `erd-${parentSym}-e-${ci}`,
      data: { onDelete: d.onDelete, curvature: 0.25 + offset },
    } as Edge;
  });
}

/** Architecture (C4) edges: orthogonal (smoothstep) routing with a relationship
 *  label. Orthogonal reads better than bezier for dense infrastructure graphs.
 *  Parallel edges (same source→target pair) get staggered bend offsets so they
 *  read as separate rails instead of overlapping into one fat line. */
function buildC4Edges(m: DiagramManifest): Edge[] {
  const pairCount = new Map<string, number>();
  return m.edges.map((e, i) => {
    const key = `${e.source}::${e.target}`;
    const idx = pairCount.get(key) ?? 0;
    pairCount.set(key, idx + 1);
    // Alternate sign so parallels fan symmetrically around the natural path.
    const stagger = idx === 0 ? 0 : (idx % 2 === 0 ? 1 : -1) * Math.ceil(idx / 2) * 18;
    return {
      id: e.id ?? `e${i}`,
      source: e.source,
      target: e.target,
      sourceHandle: "n__r",
      targetHandle: "n__l",
      type: "smoothstep",
      pathOptions: { borderRadius: 8, offset: 20 + stagger },
      label: e.label,
      labelStyle: { fontSize: 11, fill: "#475569", fontWeight: 600 },
      labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
      style: { stroke: "#94a3b8", strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 18, height: 18 },
    } as Edge;
  });
}

/** Architecture edges pick from L/R/T/B based on the source→target vector;
 *  ERD column edges stay L/R only. Horizontal is the default — pick T/B only
 *  when the edge is clearly more vertical than horizontal (>1.2× ratio) so
 *  short side-by-side arrows don't go vertical unnecessarily.
 *
 *  Bidirectional pairs (A→B and B→A both exist) are colored amber on BOTH
 *  edges so feedback loops / webhooks / callbacks stand out against the gray
 *  one-directional flow. Both edges are floated above (zIndex 10) so the
 *  amber color isn't hidden under overlapping gray edges. */
const VERTICAL_RATIO = 1.2;
const ARCH_FWD = "#94a3b8";
const ARCH_BIDIR = "#d97706";

export function updateHandles(nodes: Node[], edges: Edge[]): Edge[] {
  const pos = new Map(
    nodes.map((n) => [
      n.id,
      { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 },
    ]),
  );

  // Index forward edges for reverse-edge lookup (architecture only).
  const archEdgeKeys = new Set(
    edges
      .filter((e) => e.type === "smoothstep")
      .map((e) => `${e.source}::${e.target}`),
  );
  const isBidir = (s: string, t: string) => archEdgeKeys.has(`${t}::${s}`);

  return edges.map((e) => {
    if (!e.sourceHandle || !e.targetHandle) return e;
    const s = pos.get(e.source);
    const t = pos.get(e.target);
    if (!s || !t) return e;

    const scx = s.x + s.w / 2;
    const scy = s.y + s.h / 2;
    const tcx = t.x + t.w / 2;
    const tcy = t.y + t.h / 2;
    const dx = tcx - scx;
    const dy = tcy - scy;

    const isArch = e.type === "smoothstep";
    const useVertical = isArch && Math.abs(dy) > Math.abs(dx) * VERTICAL_RATIO;

    let srcSuffix: "l" | "r" | "t" | "b";
    let tgtSuffix: "l" | "r" | "t" | "b";
    if (useVertical) {
      const targetBelow = dy > 0;
      srcSuffix = targetBelow ? "b" : "t";
      tgtSuffix = targetBelow ? "t" : "b";
    } else {
      const targetRight = dx >= 0;
      srcSuffix = targetRight ? "r" : "l";
      tgtSuffix = targetRight ? "l" : "r";
    }

    // ERD edges only carry __l/__r (column handles); arch carries all 4.
    const regex = isArch ? /__[lrtb]$/ : /__[lr]$/;

    let style = e.style;
    let markerEnd = e.markerEnd;
    let zIndex = e.zIndex;
    if (isArch) {
      const bidir = isBidir(e.source, e.target);
      const color = bidir ? ARCH_BIDIR : ARCH_FWD;
      style = { ...style, stroke: color };
      markerEnd =
        markerEnd && typeof markerEnd === "object"
          ? { ...markerEnd, color }
          : markerEnd;
      if (bidir) zIndex = 10;
    }

    return {
      ...e,
      sourceHandle: e.sourceHandle.replace(regex, `__${srcSuffix}`),
      targetHandle: e.targetHandle.replace(regex, `__${tgtSuffix}`),
      style,
      markerEnd,
      zIndex,
    };
  });
}

/** Column row index for handle vertical placement. */
export function columnIndex(data: TableData, name: string): number {
  return data.columns.findIndex((c: Column) => c.name === name);
}
