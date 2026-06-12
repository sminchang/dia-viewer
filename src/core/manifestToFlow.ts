import { type Edge, type Node } from "@xyflow/react";
import type {
  C4Data,
  C4EdgeData,
  Column,
  DiagramManifest,
  ErdEdgeData,
  TableData,
} from "../manifest";

export const TABLE_WIDTH = 260;
export const HEADER_H = 36;
export const ROW_H = 24;
const C4_WIDTH = 88;

/** Flow step node fixed dimensions (CSS must match). */
export const FLOW_NODE_W = 180;
export const FLOW_NODE_H = 84;

/** Flow phase banner node fixed dimensions (CSS must match). */
export const PHASE_NODE_W = 240;
export const PHASE_NODE_H = 52;

/** Lane colour palette — same hues as EDGE_COLORS so flow and ERD/arch share one visual language. */
export const LANE_COLORS = [
  "#2563EB", // blue
  "#7C3AED", // violet
  "#0D9488", // teal
  "#D97706", // amber
  "#DB2777", // pink
  "#65A30D", // lime
];


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
  if (node.nodeType === "phase") return { width: PHASE_NODE_W, height: PHASE_NODE_H };
  if (node.nodeType === "step") return { width: FLOW_NODE_W, height: FLOW_NODE_H };
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
  // Glyph-as-node (AWS diagram convention): 52px pictogram + one-line label,
  // always. description/technology are manifest data for LLM onboarding and
  // hover tooltips — never rendered as rows (the glyph + name carry the
  // visual identity). Deterministic: fixed CSS row heights, so the assumed
  // size IS the rendered size.
  return { width: C4_WIDTH, height: 4 + 52 + 2 + 18 + 6 };
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
  expandedTables?: Set<string>,
): FlowData {
  // Legacy manifests may nest sub-domain groups under the boundary; the
  // viewer dropped sub-domain support (space expresses relationships,
  // data.role covers characteristics), so node groups collapse to their
  // root group on load.
  const parentOf = new Map((m.groups ?? []).map((g) => [g.id, g.parent]));
  const rootOf = (gid?: string): string | undefined => {
    let cur = gid;
    while (cur && parentOf.get(cur)) cur = parentOf.get(cur)!;
    return cur;
  };

  // Flowchart semantics derived from the step-edge graph (FlowNode renders):
  // in-degree 0 = entry, out-degree 0 = exit (terminator pills); ≥2 outgoing
  // edges of which ≥1 carries a condition = decision (diamond badge).
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const condOut = new Map<string, number>();
  if (m.kind === "flowchart") {
    const phaseIds = new Set(m.nodes.filter((n) => n.nodeType === "phase").map((n) => n.id));
    for (const e of m.edges) {
      if (phaseIds.has(e.source) || phaseIds.has(e.target)) continue;
      outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
      if ((e.data as C4EdgeData | undefined)?.condition)
        condOut.set(e.source, (condOut.get(e.source) ?? 0) + 1);
    }
  }

  // Flow layout is step-flow-first: steps are positioned by the real edge graph.
  // Phase grouping is drawn as boxes around each contiguous run of same-phase
  // steps (App.phaseBoxNodes), so phase nodes themselves aren't rendered.
  const nodes: Node[] = m.nodes
    .filter((n) => n.nodeType !== "phase")
    .map((n) => {
    // keys-only can be lifted per table (clicking its "hidden" row); an
    // expanded table shows all columns plus a collapse row.
    const expanded = keysOnly && n.nodeType === "table" && !!expandedTables?.has(n.id);
    const effKeysOnly = keysOnly && !expanded;
    const size = nodeSize(m, n.id, showComments, effKeysOnly);
    if (expanded) size.height += ROW_H; // trailing collapse row
    // For flow step nodes, embed lane colour so the renderer doesn't need the manifest.
    const extraData: Record<string, unknown> = {};
    if (n.nodeType === "step" && m.kind === "flowchart") {
      const laneId = (n.data as C4Data).lane;
      const lanes = (m.groups ?? []).filter((g) => g.kind === "lane");
      const laneIdx = lanes.findIndex((g) => g.id === laneId);
      const li = laneIdx >= 0 ? laneIdx : 0;
      extraData.laneIdx = li;
      extraData.laneColor = LANE_COLORS[li % LANE_COLORS.length];
      extraData.laneLabel = laneIdx >= 0 ? lanes[laneIdx].label : laneId ?? "";
      extraData.terminal = !inDeg.get(n.id) ? "start" : !outDeg.get(n.id) ? "end" : undefined;
      extraData.decision = (outDeg.get(n.id) ?? 0) >= 2 && (condOut.get(n.id) ?? 0) >= 1;
    }
    return {
      id: n.id,
      type: n.nodeType === "table" ? "table"
          : n.nodeType === "step" ? "flow"
          : "c4",
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      // An expanded table must stay readable: lift it above neighbors it may
      // now cover (and above edges) instead of growing underneath them.
      zIndex: expanded ? 20 : undefined,
      data: {
        ...n.data,
        ...extraData,
        label: n.label,
        nodeType: n.nodeType,
        group: rootOf(n.group),
        showComments,
        keysOnly: effKeysOnly,
        expanded,
      },
    } as Node;
  });

  const edges: Edge[] =
    m.kind === "erd" ? buildErdEdges(m) : m.kind === "flowchart" ? buildFlowEdges(m) : buildC4Edges(m);
  return { nodes, edges };
}

/** FK-relationship colour palette, keyed by referenced parent column (see
 *  buildErdEdges). Six distinct hues — amber, violet, blue up front (the first,
 *  most-referenced keys get these), then lime, mint, pink. Near-duplicate hues
 *  (navy vs blue, amber vs orange) were dropped to cut visual noise. */
export const EDGE_COLORS = [
  "#D97706", // amber
  "#7C3AED", // violet
  "#2563EB", // blue
  "#65A30D", // lime
  "#0D9488", // mint
  "#DB2777", // pink
];

/** Crow's-foot symbol per cardinality token (marker defs in ErdMarkers.tsx). */
const CARD_SYM: Record<string, string> = { "1": "one", "0..1": "zeroone", N: "many", M: "many" };

/** ERD edges: dashed, animated, with curvature offset for multiple edges
 *  between the same table pair. Cardinality is expressed with crow's-foot (IE
 *  notation) end markers instead of a midpoint text label — position-independent
 *  and the de-facto standard for ERD deliverables.
 *  Colour is keyed by the referenced PARENT column (target table + column), so
 *  every FK pointing at the same key shares one hue — far fewer colours than
 *  per-edge cycling, and the shared colour reads as "these all reference here". */
function buildErdEdges(m: DiagramManifest): Edge[] {
  const pairCount = new Map<string, number>();
  const colorIndex = new Map<string, number>();
  return m.edges.map((e, i) => {
    const d = (e.data ?? {}) as ErdEdgeData;
    const parentKey = `${e.target}::${d.targetColumn ?? "*"}`;
    let ci = colorIndex.get(parentKey);
    if (ci === undefined) {
      ci = colorIndex.size % EDGE_COLORS.length;
      colorIndex.set(parentKey, ci);
    }
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

/** Architecture edges leave manifestToFlow PRISTINE — type, ports, path,
 *  markers and label placement are all assigned by routeArchEdges (the
 *  compact router). Only identity + text survive from the manifest. */
function buildC4Edges(m: DiagramManifest): Edge[] {
  return m.edges.map(
    (e, i) =>
      ({
        id: e.id ?? `e${i}`,
        source: e.source,
        target: e.target,
        label: e.label,
        data: { ...e.data },
      }) as Edge,
  );
}

/** ERD edges anchor on table columns (left/right handles only); after layout
 *  or drag, re-pick the side on both ends from the tables' relative x. */
export function updateErdHandles(nodes: Node[], edges: Edge[]): Edge[] {
  const pos = new Map(
    nodes.map((n) => [n.id, n.position.x + (n.width ?? 0) / 2]),
  );
  return edges.map((e) => {
    if (!e.sourceHandle || !e.targetHandle) return e;
    const s = pos.get(e.source);
    const t = pos.get(e.target);
    if (s === undefined || t === undefined) return e;
    const targetRight = t >= s;
    return {
      ...e,
      sourceHandle: e.sourceHandle.replace(/__[lr]$/, targetRight ? "__r" : "__l"),
      targetHandle: e.targetHandle.replace(/__[lr]$/, targetRight ? "__l" : "__r"),
    };
  });
}

/** Column row index for handle vertical placement. */
export function columnIndex(data: TableData, name: string): number {
  return data.columns.findIndex((c: Column) => c.name === name);
}

/** Flow edges: emit minimal {source, target, label} pairs — routeArchEdges does
 *  the rest (Manhattan routing around step boxes, bidirectional A↔B merge into a
 *  single amber double-headed arrow, one-way edges as plain single arrows, and
 *  lane spreading so distinct edges sharing a gutter read as separate rails).
 *  Phase→phase edges aren't drawn: phases are background boxes, so the step
 *  edges carry the flow. */
function buildFlowEdges(m: DiagramManifest): Edge[] {
  const phaseIds = new Set(m.nodes.filter((n) => n.nodeType === "phase").map((n) => n.id));
  return m.edges.flatMap((e, i) => {
    if (phaseIds.has(e.source) && phaseIds.has(e.target)) return [];
    const d = (e.data ?? {}) as C4EdgeData;
    return [{
      id: e.id ?? `fe${i}`,
      source: e.source,
      target: e.target,
      label: d.condition,
      data: { condition: d.condition, path: d.path },
    } as Edge];
  });
}
