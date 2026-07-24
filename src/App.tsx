import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DiagramManifest } from "./manifest";
import { manifestToFlow, updateErdHandles, updateConceptHandles } from "./core/manifestToFlow";
import { routeArchEdges, rerouteForNode } from "./core/routeEdges";
import { routeFlowEdges, rerouteFlowForNode } from "./core/routeFlowEdges";
import { layout, flowLayoutBoth, type ArchLayout, type Orientation } from "./core/layout";
import { exportDiagram, exportViewerHtml } from "./core/exportImage";
import { downloadLayoutFile, isLayoutFile, type Positions } from "./core/storage";
import { TableNode } from "./nodes/TableNode";
import { ErdMarkerDefs } from "./nodes/ErdMarkers";
import { ErdEdge } from "./nodes/ErdEdge";
import { C4Node } from "./nodes/C4Node";
import { ConceptNode } from "./nodes/ConceptNode";
import { FlowNode } from "./nodes/FlowNode";
import { PhaseBoxNode } from "./nodes/PhaseBoxNode";
import { OverviewPhaseNode } from "./nodes/OverviewPhaseNode";
import { GroupNode } from "./nodes/GroupNode";
import { RoutedEdge } from "./nodes/RoutedEdge";
import { FlowRoutedEdge } from "./nodes/FlowRoutedEdge";

/** Per-axis snap-to-align tolerance, in pixels. Conservative — only nodes whose
 *  centers land within this window of another node's center get auto-aligned. */
const SNAP_PX = 8;

const layoutSubject = (m: DiagramManifest): string =>
  m.title || m.meta?.system || m.meta?.database || "diagram";

/** Snapshot the current node positions (derived boxes excluded). */
const collectPositions = (nodes: Node[]): Positions => {
  const positions: Positions = {};
  nodes.forEach((n) => {
    if (n.type !== "group" && n.type !== "flowPhaseBox")
      positions[n.id] = { x: n.position.x, y: n.position.y };
  });
  return positions;
};

const nodeTypes = { table: TableNode, c4: C4Node, concept: ConceptNode, flow: FlowNode, flowPhaseBox: PhaseBoxNode, ovPhase: OverviewPhaseNode, group: GroupNode };
const edgeTypes = { erd: ErdEdge, routed: RoutedEdge, flowRouted: FlowRoutedEdge };
const GROUP_PAD = 20;

const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const ResetIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export function App() {
  const [manifest, setManifest] = useState<DiagramManifest | null>(null);
  const [contentNodes, setContentNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [showComments, setShowComments] = useState(false);
  // ERD opens in keys-only mode — full column lists are opt-in noise.
  const [keysOnly, setKeysOnly] = useState(true);
  // Tables whose keys-only is lifted (clicking their "hidden" row toggles).
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  // Bumped by the toolbar reset button — forces a fresh auto-layout pass
  // even when every other dependency already sits at its default.
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [locked, setLocked] = useState<string | null>(null); // click-pinned highlight
  const [dragOver, setDragOver] = useState(false);
  // dragEnter/Leave fire on child element boundaries; count them so the overlay
  // doesn't flicker as the cursor crosses inner elements.
  const dragCount = useRef(0);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadRef = useRef<HTMLDivElement>(null);
  // Most recently loaded layout sidecar (applied if/when a matching manifest
  // is present). Cleared when the user loads a new manifest.
  const pendingLayoutRef = useRef<Positions | null>(null);
  // Pristine edges as built from the manifest. Re-wiring (drag, sidecar)
  // must start from these — routeArchEdges merges bidirectional pairs, so
  // feeding it its own output would lose the reverse direction.
  const builtEdgesRef = useRef<Edge[]>([]);
  // Architecture diagrams pack many edges into a small canvas — labels add
  // noise that buries the structure. Default to hidden; show on click-highlight
  // (or all-at-once via toolbar toggle). ERD labels (cardinality) stay visible.
  const [showAllLabels, setShowAllLabels] = useState(false);
  // Architecture canvas orientation. Both orientations are computed in one
  // packing pass and cached (archLayoutRef) so flipping the toggle re-routes
  // from the cache instead of re-running the multi-start search. A freshly
  // loaded manifest defaults to its natural orientation.
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  // Flowchart phase-overview mode: render only phase nodes + phase edges — the
  // onboarding layer (phase labels alone tell the story). Reset per load.
  const [overview, setOverview] = useState(false);
  const archLayoutRef = useRef<ArchLayout | null>(null);
  // ReactFlow instance for post-layout refits. The fitView PROP only fires on
  // mount — before the layout effect has positioned anything — so wide diagrams
  // rendered clipped until a manual fit. Refit after every layout apply.
  const rfInstRef = useRef<{ fitView: (opts?: { padding?: number }) => unknown } | null>(null);
  const refit = useCallback(() => {
    // First load: the layout effect runs before ReactFlow's onInit delivers the
    // instance, and the store commits positions a frame later — so retry over a
    // few frames (fitView is idempotent) instead of firing once into the void.
    let frame = 0;
    const attempt = () => {
      frame++;
      const inst = rfInstRef.current;
      if (inst) {
        inst.fitView({ padding: 0.08 });
        if (frame < 4) requestAnimationFrame(attempt); // re-fit after store commit
      } else if (frame < 30) {
        requestAnimationFrame(attempt); // instance not ready yet
      }
    };
    requestAnimationFrame(attempt);
  }, []);
  // What the cached archLayout was computed for. Reusable (orientation flips
  // skip the search) unless the manifest or the annotations gutter width
  // changed — those are the only inputs the packing depends on.
  const archCacheRef = useRef<{ m: DiagramManifest; labels: boolean } | null>(null);
  // Flow layout cache — reused on orientation flips (layout is sync/cheap but
  // we still avoid recomputing so prevManifestRef can detect fresh vs flip).
  const flowLayoutRef = useRef<ArchLayout | null>(null);
  const flowCacheRef = useRef<DiagramManifest | null>(null);
  const flowLabelsRef = useRef<boolean | null>(null);
  // True while the synchronous multi-start search is running — drives a
  // spinner overlay so a multi-second freeze doesn't read as a hang.
  const [computing, setComputing] = useState(false);
  // True when the optimum is near-square: the two orientations are identical,
  // so the orientation toggle is disabled (flipping would do nothing).
  const [orientationFixed, setOrientationFixed] = useState(false);
  // The optimum's natural orientation from the latest compute (for the reset
  // button to restore). prevManifestRef lets the compute tell a fresh manifest
  // (→ snap to natural) apart from a re-layout of the same one (→ keep the
  // user's chosen orientation, e.g. across an annotations toggle).
  const naturalRef = useRef<Orientation>("landscape");
  const prevManifestRef = useRef<DiagramManifest | null>(null);
  // The architecture search runs in a Web Worker so it never freezes the main
  // thread (spinner keeps animating; rapid toggles cancel the previous run by
  // terminating the worker).
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => workerRef.current?.terminate(), []);

  // Standalone single-file viewer: auto-load the diagram + positions injected
  // into the exported HTML, so it opens straight to the diagram (no drop).
  useEffect(() => {
    if (__STANDALONE__ && window.__DIAGRAM__) {
      pendingLayoutRef.current = window.__POSITIONS__ ?? null;
      setManifest(window.__DIAGRAM__);
    }
  }, []);

  // Annotations default: flowchart condition labels are core to the flow → ON;
  // architecture annotations are dense secondary detail → OFF. Re-applied per load.
  useEffect(() => {
    if (manifest) setShowAllLabels(manifest.kind === "flowchart");
  }, [manifest]);

  // Close download dropdown on outside click.
  useEffect(() => {
    if (!downloadOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      // DOM Node is shadowed by ReactFlow's Node import; use Element guard instead.
      if (
        downloadRef.current &&
        e.target instanceof Element &&
        !downloadRef.current.contains(e.target)
      ) {
        setDownloadOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [downloadOpen]);

  // Whether this manifest carries any DB comments (to show/hide the toggle).
  const hasComments = useMemo(
    () =>
      manifest?.kind === "erd" &&
      manifest.nodes.some((n) => {
        const d = n.data as { comment?: string; columns?: { comment?: string }[] };
        return d.comment || d.columns?.some((c) => c.comment);
      }),
    [manifest],
  );

  // Architecture renders with the compact pipeline (crossing-first placement
  // + Manhattan routing); ERD uses the layered ELK arrangement.
  // ERD anchors edges on table columns. Architecture and flowchart each own
  // their router (routeEdges.ts vs routeFlowEdges.ts) — same Manhattan
  // foundations, but independent policies that must evolve separately.
  const wireEdges = useCallback(
    (placed: Node[], built: Edge[]): Edge[] =>
      manifest?.kind === "erd"
        ? updateErdHandles(placed, built)
        : manifest?.kind === "flowchart"
          ? routeFlowEdges(placed, built)
          : manifest?.kind === "concept-tree"
            ? updateConceptHandles(placed, built) // pick edge sides for the bidirectional spread
            : routeArchEdges(placed, built),
    [manifest],
  );

  // Lay out and render whenever the manifest, a view toggle, or the orientation
  // changes. Architecture runs the whole pipeline under the spinner — the
  // multi-start search (skipped when only the orientation flipped: the cache
  // serves both), routing, then ReactFlow render — so no segment of the
  // multi-second freeze reads as a hang. A loaded sidecar applies on top of the
  // auto-layout (pendingLayoutRef).
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    let rafA = 0;
    let rafB = 0;
    let rafC = 0;
    const { nodes, edges: built } = manifestToFlow(manifest, showComments, keysOnly, expandedTables);
    builtEdgesRef.current = built;

    // Standalone viewer: positions were injected at export time (pendingLayoutRef);
    // render them directly. No layout engine runs, so the worker + elkjs below
    // are dead-code-eliminated out of this build.
    if (__STANDALONE__) {
      const merged = pendingLayoutRef.current ?? {};
      const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
      setContentNodes(placed);
      setEdges(wireEdges(placed, built));
      return () => {
        cancelled = true;
      };
    }

    if (manifest.kind === "flowchart") {
      archLayoutRef.current = null;
      archCacheRef.current = null;
      // Compute both orientations once per manifest; reuse on orientation flip.
      // Annotations widen the inter-node gutters (labelRoom), so recompute when
      // the toggle changes too — not just per manifest.
      if (
        flowCacheRef.current !== manifest ||
        flowLabelsRef.current !== showAllLabels ||
        !flowLayoutRef.current
      ) {
        const both = flowLayoutBoth(nodes, built, showAllLabels);
        flowLayoutRef.current = both;
        flowCacheRef.current = manifest;
        flowLabelsRef.current = showAllLabels;
        naturalRef.current = both.natural;
        setOrientationFixed(both.fixed);
      }
      let orient = orientation;
      if (prevManifestRef.current !== manifest) {
        prevManifestRef.current = manifest;
        orient = naturalRef.current;
        setOrientation(naturalRef.current);
      }
      const auto = flowLayoutRef.current[orient];
      const merged = { ...auto, ...(pendingLayoutRef.current ?? {}) };
      const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
      setContentNodes(placed);
      setEdges(wireEdges(placed, built));
      refit();
      return () => { cancelled = true; };
    }

    if (manifest.kind !== "architecture") {
      archLayoutRef.current = null;
      archCacheRef.current = null;
      flowLayoutRef.current = null;
      flowCacheRef.current = null;
      layout(manifest.kind, nodes, built).then((auto) => {
        if (cancelled) return;
        const merged = { ...auto, ...(pendingLayoutRef.current ?? {}) };
        const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
        setContentNodes(placed);
        setEdges(wireEdges(placed, built));
        refit();
      });
      return () => {
        cancelled = true;
      };
    }

    const cacheValid =
      !!archLayoutRef.current &&
      archCacheRef.current?.m === manifest &&
      archCacheRef.current?.labels === showAllLabels;

    // Position the cached layout for the current orientation and route it.
    // Routing + ReactFlow render is the only main-thread work left (~hundreds
    // of ms), and the spinner covers it; the multi-second search ran in the
    // worker. Clears the spinner one frame after apply so ReactFlow has painted.
    const applyFromCache = () => {
      if (cancelled || !archLayoutRef.current) return;
      let orient = orientation;
      // A freshly loaded manifest snaps to its natural orientation; a re-layout
      // of the same one keeps the current choice (reset restores natural
      // explicitly via resetView).
      if (prevManifestRef.current !== manifest) {
        prevManifestRef.current = manifest;
        orient = naturalRef.current;
        setOrientation(naturalRef.current);
      }
      const auto = archLayoutRef.current[orient];
      const merged = { ...auto, ...(pendingLayoutRef.current ?? {}) };
      const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
      setContentNodes(placed);
      setEdges(wireEdges(placed, built));
      rafC = requestAnimationFrame(() => {
        if (!cancelled) setComputing(false);
        rfInstRef.current?.fitView({ padding: 0.08 });
      });
    };

    setComputing(true);
    if (cacheValid) {
      // Orientation flip / reset: no search, just re-route from the cache.
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(applyFromCache);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(rafA);
        cancelAnimationFrame(rafB);
        cancelAnimationFrame(rafC);
      };
    }

    // Run the search off the main thread; terminate any in-flight run first so
    // a rapid sequence of toggles cancels the stale work instead of queueing.
    workerRef.current?.terminate();
    const w = new Worker(new URL("./core/layoutWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<ArchLayout>) => {
      if (cancelled) return;
      archLayoutRef.current = e.data;
      archCacheRef.current = { m: manifest, labels: showAllLabels };
      naturalRef.current = e.data.natural;
      setOrientationFixed(e.data.fixed);
      applyFromCache();
      w.terminate();
      if (workerRef.current === w) workerRef.current = null;
    };
    w.postMessage({ nodes, edges: built, labelRoom: showAllLabels });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafC);
      w.terminate();
      if (workerRef.current === w) workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, showComments, keysOnly, showAllLabels, layoutEpoch, orientation, wireEdges]);

  // Per-table expand/collapse (keys-only lift) must NOT re-run auto-layout —
  // it would wipe the user's manual drags. Rebuild the nodes with the new
  // sizes and keep every current position; the table simply grows/shrinks in
  // place (ERD column handles re-measure from the DOM automatically).
  const expandedRef = useRef(expandedTables);
  useEffect(() => {
    if (expandedRef.current === expandedTables) return; // initial render
    expandedRef.current = expandedTables;
    if (!manifest || manifest.kind !== "erd") return;
    setContentNodes((prev) => {
      if (!prev.length) return prev;
      const { nodes } = manifestToFlow(manifest, showComments, keysOnly, expandedTables);
      const posOf = new Map(prev.map((n) => [n.id, n.position]));
      return nodes.map((n) => ({ ...n, position: posOf.get(n.id) ?? n.position }));
    });
  }, [expandedTables, manifest, showComments, keysOnly]);

  // Group background boxes — architecture boundaries only. ERD domains overlap
  // heavily once tables are placed, so boxes there add clutter rather than clarity.
  // Node groups are flattened to their root on load (manifestToFlow), so only
  // root groups (boundaries) collect members here; legacy sub-domain entries
  // match nothing and draw no box.
  const groupNodes = useMemo<Node[]>(() => {
    if (manifest?.kind !== "architecture" || !manifest.groups) return [];
    return manifest.groups.flatMap((g) => {
      const members = contentNodes.filter(
        (n) => (n.data as { group?: string }).group === g.id,
      );
      if (members.length === 0) return [];
      const pad = GROUP_PAD;
      const xs = members.map((m) => m.position.x);
      const ys = members.map((m) => m.position.y);
      const xe = members.map((m) => m.position.x + (m.width ?? 200));
      const ye = members.map((m) => m.position.y + (m.height ?? 100));
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad - 16;
      const width = Math.max(...xe) - x + pad;
      const height = Math.max(...ye) - y + pad;
      return [
        {
          id: `grp_${g.id}`,
          type: "group",
          position: { x, y },
          width,
          height,
          selectable: false,
          draggable: false,
          zIndex: -10,
          data: { label: g.label, width, height, level: 0 },
        } as Node,
      ];
    });
  }, [manifest, contentNodes]);

  // Phase grouping boxes — flowchart only. Steps are positioned by the real
  // edge graph (step-flow), so a phase that recurs in a loop (e.g. reasoning,
  // entered before AND after a tool round) lands in two places. Draw one box
  // per CONTIGUOUS run of same-phase steps: two same-phase steps share a box
  // only when no other-phase node sits between them (inside their joint bounds).
  // A recurring phase therefore gets multiple boxes, each a clean rectangle.
  const PHASE_PAD = 14; // routeFlowEdges' phaseBoxes PAD must match
  const PHASE_HEADER_H = 32; // matches .phase-box-header height in CSS
  const phaseBoxNodes = useMemo<Node[]>(() => {
    if (manifest?.kind !== "flowchart") return [];
    const phases = manifest.nodes.filter((n) => n.nodeType === "phase");
    const cx = (n: Node) => n.position.x + (n.width ?? 180) / 2;
    const cy = (n: Node) => n.position.y + (n.height ?? 84) / 2;
    const boxes: Node[] = [];
    for (const phase of phases) {
      // Satellites (terminal annex states) live outside the phase skeleton:
      // never box members, and never "blockers" that fragment a phase's box.
      const isSatN = (n: Node) => !!(n.data as { satellite?: boolean }).satellite;
      const steps = contentNodes.filter(
        (n) => !isSatN(n) && (n.data as { phase?: string }).phase === phase.id,
      );
      if (steps.length === 0) continue;
      const others = contentNodes.filter(
        (n) => !isSatN(n) && (n.data as { phase?: string }).phase !== phase.id,
      );
      // Union-find: connect same-phase steps with no foreign node between them.
      const parent = steps.map((_, i) => i);
      const find = (i: number): number => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
      };
      for (let i = 0; i < steps.length; i++) {
        for (let j = i + 1; j < steps.length; j++) {
          const a = steps[i], b = steps[j];
          const bx1 = Math.min(a.position.x, b.position.x);
          const by1 = Math.min(a.position.y, b.position.y);
          const bx2 = Math.max(a.position.x + (a.width ?? 180), b.position.x + (b.width ?? 180));
          const by2 = Math.max(a.position.y + (a.height ?? 84), b.position.y + (b.height ?? 84));
          const blocked = others.some((o) => {
            const ox = cx(o), oy = cy(o);
            return ox > bx1 && ox < bx2 && oy > by1 && oy < by2;
          });
          if (!blocked) parent[find(i)] = find(j);
        }
      }
      const groups = new Map<number, Node[]>();
      steps.forEach((s, i) => {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(s);
      });
      let gi = 0;
      for (const grp of groups.values()) {
        const minX = Math.min(...grp.map((m) => m.position.x));
        const minY = Math.min(...grp.map((m) => m.position.y));
        const maxX = Math.max(...grp.map((m) => m.position.x + (m.width ?? 180)));
        const maxY = Math.max(...grp.map((m) => m.position.y + (m.height ?? 84)));
        boxes.push({
          id: `phaseBox_${phase.id}_${gi++}`,
          type: "flowPhaseBox",
          position: { x: minX - PHASE_PAD, y: minY - PHASE_HEADER_H - 8 },
          width: maxX - minX + PHASE_PAD * 2,
          height: maxY - minY + PHASE_HEADER_H + 8 + PHASE_PAD,
          selectable: false,
          // Draggable as a unit by its header (CSS makes only the header grab —
          // body stays inert so step clicks pass through). onNodesChange moves
          // the member steps by the drag delta; the box re-derives under them.
          draggable: true,
          zIndex: -5,
          data: { label: phase.label },
        } as Node);
      }
    }
    return boxes;
  }, [manifest, contentNodes]);

  // Latest derived phase boxes — onNodesChange reads them to compute drag deltas
  // (boxes recompute from member positions each render, so aren't in contentNodes).
  const phaseBoxNodesRef = useRef<Node[]>([]);
  phaseBoxNodesRef.current = phaseBoxNodes;

  const allNodes = useMemo(
    () => [...groupNodes, ...phaseBoxNodes, ...contentNodes],
    [groupNodes, phaseBoxNodes, contentNodes],
  );

  // Click-to-focus: everything else dims. Click again (or the pane) to clear.
  // Concept-tree: highlight the ancestor PATH from the clicked node up to the
  // root, so the derivation chain (where this concept comes from) is visible.
  // Other kinds: highlight the node + its directly-connected neighbours.
  const focus = locked;
  const highlight = useMemo(() => {
    if (!focus) return null;
    const nodes = new Set<string>([focus]);
    const edgesOn = new Set<string>();
    if (manifest?.kind === "concept-tree") {
      let cur: string | undefined = focus;
      const seen = new Set<string>([focus]);
      while (cur) {
        // Tree edge is parent → child, so the one edge into `cur` is its parent.
        const parentEdge = edges.find((e) => e.target === cur);
        if (!parentEdge || seen.has(parentEdge.source)) break;
        if (parentEdge.id) edgesOn.add(parentEdge.id);
        nodes.add(parentEdge.source);
        seen.add(parentEdge.source);
        cur = parentEdge.source;
      }
    } else {
      for (const e of edges) {
        if (e.source === focus || e.target === focus) {
          if (e.id) edgesOn.add(e.id);
          nodes.add(e.source);
          nodes.add(e.target);
        }
      }
    }
    return { nodes, edgesOn };
  }, [focus, edges, manifest]);

  const displayNodes = useMemo(() => {
    if (!highlight) return allNodes;
    return allNodes.map((n) =>
      n.type === "group" || n.type === "flowPhaseBox" || n.type === "flowPhase"
        ? n
        : { ...n, style: { ...n.style, opacity: highlight.nodes.has(n.id) ? 1 : 0.15 } },
    );
  }, [allNodes, highlight]);

  const displayEdges = useMemo(() => {
    // Annotations toggle hides edge labels for both architecture and flowchart.
    // `data.labels` (merged multi-condition edges) renders independently of the
    // `label` prop, so it must be stripped too when labels are hidden.
    const hideLabels =
      (manifest?.kind === "architecture" || manifest?.kind === "flowchart") && !showAllLabels;
    if (!highlight) {
      return hideLabels
        ? edges.map((e) => ({ ...e, label: "", data: { ...e.data, labels: undefined } }))
        : edges;
    }
    return edges.map((e) => {
      const on = e.id ? highlight.edgesOn.has(e.id) : false;
      // Annotations OFF hides labels regardless of highlight state; with a
      // highlight active, only the highlighted edges keep their labels —
      // UNCLAMPED (labelFull): focus is the moment to read the whole text,
      // and every other label is hidden so there is nothing to collide with.
      const labelsHidden = hideLabels || !on;
      return {
        ...e,
        label: labelsHidden ? "" : e.label,
        data: labelsHidden
          ? { ...e.data, labels: undefined }
          : { ...e.data, labelFull: true },
        animated: on ? e.animated : false,
        style: { ...e.style, opacity: on ? 1 : 0.07 },
      };
    });
  }, [edges, highlight, manifest, showAllLabels]);

  // Phase-overview graph: phase nodes + phase→phase edges straight from the
  // manifest (manifestToFlow strips them for the detail view). Laid out in
  // declaration order along the canvas orientation — the phase list IS the
  // narrative, so no search is needed.
  const overviewGraph = useMemo(() => {
    if (!manifest || manifest.kind !== "flowchart") return null;
    const phases = manifest.nodes.filter((n) => n.nodeType === "phase");
    if (!phases.length) return null;
    const phaseIds = new Set(phases.map((p) => p.id));
    const counts = new Map<string, number>();
    for (const n of manifest.nodes) {
      const ph = (n.data as { phase?: string } | undefined)?.phase;
      if (n.nodeType === "step" && ph) counts.set(ph, (counts.get(ph) ?? 0) + 1);
    }
    const horiz = orientation === "landscape";
    const ovNodes: Node[] = phases.map((p, i) => ({
      id: `ov_${p.id}`,
      type: "ovPhase",
      position: horiz ? { x: i * 320, y: 0 } : { x: 0, y: i * 180 },
      width: 250,
      height: 110,
      data: { label: p.label, count: counts.get(p.id) ?? 0, idx: i, horiz },
    }));
    const ovEdges: Edge[] = (manifest.edges ?? [])
      .filter((e) => phaseIds.has(e.source) && phaseIds.has(e.target))
      .map((e, i) => ({
        id: `ove_${i}`,
        source: `ov_${e.source}`,
        target: `ov_${e.target}`,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#64748b" },
        style: { stroke: "#64748b", strokeWidth: 1.6 },
      }));
    return { nodes: ovNodes, edges: ovEdges };
  }, [manifest, orientation]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Phase-box drag: move the whole phase (all its steps) by the drag delta.
    // The box is derived from member positions, so we shift the members and let
    // the box recompute under them.
    const boxDrag = changes.find(
      (c): c is NodeChange & { id: string; position: { x: number; y: number } } =>
        c.type === "position" &&
        typeof (c as { id?: string }).id === "string" &&
        (c as { id: string }).id.startsWith("phaseBox_") &&
        !!(c as { position?: unknown }).position,
    );
    if (boxDrag) {
      const phaseId = boxDrag.id.replace(/^phaseBox_/, "").replace(/_\d+$/, "");
      const box = phaseBoxNodesRef.current.find((b) => b.id === boxDrag.id);
      if (box) {
        const dx = boxDrag.position.x - box.position.x;
        const dy = boxDrag.position.y - box.position.y;
        if (dx || dy) {
          setContentNodes((nds) =>
            nds.map((n) =>
              (n.data as { phase?: string }).phase === phaseId
                ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
                : n,
            ),
          );
        }
      }
      return;
    }
    setContentNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // After a drag: (1) conservative snap to align centers with any neighbor
  // within SNAP_PX, (2) re-pick handle sides.
  const onNodeDragStop = useCallback(
    (_: unknown, dragged: Node) => {
      // Phase-box drag already moved every member step live (onNodesChange);
      // just re-route edges against the new positions — no per-node snap.
      if (dragged.type === "flowPhaseBox") {
        setEdges(routeFlowEdges(contentNodes, builtEdgesRef.current));
        return;
      }
      const dw = dragged.width ?? 200;
      const dh = dragged.height ?? 100;
      const dcx = dragged.position.x + dw / 2;
      const dcy = dragged.position.y + dh / 2;

      let snappedX: number | null = null;
      let snappedY: number | null = null;
      for (const other of contentNodes) {
        if (other.id === dragged.id || other.type === "group" || other.type === "flowPhaseBox" || other.type === "flowPhase") continue;
        const ocx = other.position.x + (other.width ?? 200) / 2;
        const ocy = other.position.y + (other.height ?? 100) / 2;
        if (snappedX === null && Math.abs(dcx - ocx) < SNAP_PX) {
          snappedX = ocx - dw / 2;
        }
        if (snappedY === null && Math.abs(dcy - ocy) < SNAP_PX) {
          snappedY = ocy - dh / 2;
        }
        if (snappedX !== null && snappedY !== null) break;
      }

      const updated = contentNodes.map((n) =>
        n.id === dragged.id
          ? {
              ...n,
              position: {
                x: snappedX ?? dragged.position.x,
                y: snappedY ?? dragged.position.y,
              },
            }
          : n,
      );
      setContentNodes(updated);
      // Manual drag = custom arranging: re-route ONLY the moved node's edges;
      // unrelated lines keep their frozen paths (full re-route would shuffle
      // them — the global grid shifts with every node move).
      setEdges((es) =>
        manifest?.kind === "erd"
          ? updateErdHandles(updated, builtEdgesRef.current)
          : manifest?.kind === "flowchart"
            ? rerouteFlowForNode(updated, builtEdgesRef.current, es, dragged.id)
            : manifest?.kind === "concept-tree"
              ? updateConceptHandles(updated, builtEdgesRef.current) // re-pick sides if dragged across the root
              : rerouteForNode(updated, builtEdgesRef.current, es, dragged.id),
      );
    },
    [contentNodes, manifest],
  );

  // Toolbar reset: back to the exact state of a fresh manifest load — auto
  // layout (manual drags and any loaded sidecar discarded), default toggles,
  // no highlight, no per-table expansion.
  const resetView = useCallback(() => {
    pendingLayoutRef.current = null;
    setLocked(null);
    setExpandedTables(new Set());
    setShowComments(false);
    setKeysOnly(true);
    setShowAllLabels(manifest?.kind === "flowchart"); // flowchart annotations default ON
    setOverview(false);
    setOrientation(naturalRef.current); // back to the optimum's orientation
    // The layout effect reuses the cache when the manifest/annotations are
    // unchanged, so this re-applies (discarding manual drags) without re-running
    // the search unless annotations actually turned off.
    setLayoutEpoch((e) => e + 1);
  }, [manifest]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type === "group" || node.type === "flowPhase") return;
    // Clicking a table's "+N hidden" / "collapse" row toggles THAT table's
    // keys-only state instead of the highlight lock.
    if (
      node.type === "table" &&
      event.target instanceof Element &&
      event.target.closest(".omitted")
    ) {
      setExpandedTables((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      return;
    }
    setLocked((l) => (l === node.id ? null : node.id));
  }, []);
  const onPaneClick = useCallback(() => setLocked(null), []);

  const loadFile = (file: File) => {
    file.text().then((t) => {
      let data: unknown;
      try {
        data = JSON.parse(t);
      } catch {
        alert("Invalid JSON");
        return;
      }
      if (isLayoutFile(data)) {
        // Layout sidecar: cache it and apply on top of the current nodes.
        pendingLayoutRef.current = data.positions;
        setContentNodes((nds) =>
          nds.map((n) =>
            data.positions[n.id]
              ? { ...n, position: data.positions[n.id] }
              : n,
          ),
        );
        {
          // Re-derive handles/routes against the just-updated positions,
          // always from the pristine manifest edges.
          const updated = contentNodes.map((n) =>
            data.positions[n.id]
              ? { ...n, position: data.positions[n.id] }
              : n,
          );
          setEdges(wireEdges(updated, builtEdgesRef.current));
        }
        return;
      }
      // Otherwise treat as a manifest. A fresh manifest invalidates any
      // previously-loaded layout (positions only make sense per-manifest).
      pendingLayoutRef.current = null;
      setLocked(null);
      setExpandedTables(new Set());
      setOverview(false);
      setManifest(data as DiagramManifest);
    });
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCount.current += 1;
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCount.current -= 1;
    if (dragCount.current <= 0) {
      dragCount.current = 0;
      setDragOver(false);
    }
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCount.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  };

  return (
    <div
      className="app"
      {...(__STANDALONE__
        ? {} // exported viewer has no layout engine — disable file drop entirely
        : { onDragEnter, onDragLeave, onDragOver, onDrop })}
    >
      <div className="toolbar">
        {!__STANDALONE__ && <span className="title">dia-viewer</span>}
        {manifest && (
          <span className="meta">
            {manifest.title} · {manifest.kind} · {manifest.nodes.length} nodes
          </span>
        )}
        <div className="spacer" />

        {!__STANDALONE__ && hasComments && (
          <button className={showComments ? "active" : ""} onClick={() => setShowComments((v) => !v)}>
            Annotations
          </button>
        )}

        {!__STANDALONE__ && manifest?.kind === "erd" && (
          <button className={keysOnly ? "active" : ""} onClick={() => setKeysOnly((v) => !v)}>
            Keys Only
          </button>
        )}

        {!__STANDALONE__ && (manifest?.kind === "architecture" || manifest?.kind === "flowchart") && (
          <button className={showAllLabels ? "active" : ""} onClick={() => setShowAllLabels((v) => !v)}>
            Annotations
          </button>
        )}

        {manifest?.kind === "flowchart" && overviewGraph && (
          <button
            className={overview ? "active" : ""}
            title="Phase-level overview — the onboarding storyline"
            onClick={() => setOverview((v) => !v)}
          >
            Overview
          </button>
        )}


        {!__STANDALONE__ && (manifest?.kind === "architecture" || manifest?.kind === "flowchart") && (
          <div
            className="seg"
            title={
              orientationFixed
                ? "Layout is near-square — rotating wouldn't change the fit"
                : "Canvas orientation"
            }
          >
            <button
              className={orientation === "landscape" ? "active" : ""}
              disabled={orientationFixed}
              onClick={() => setOrientation("landscape")}
            >
              Landscape
            </button>
            <button
              className={orientation === "portrait" ? "active" : ""}
              disabled={orientationFixed}
              onClick={() => setOrientation("portrait")}
            >
              Portrait
            </button>
          </div>
        )}

        {!__STANDALONE__ && manifest?.kind !== "concept-tree" && (
          <button
            className="icon-btn"
            disabled={!manifest}
            title="Reset to initial layout"
            onClick={resetView}
          >
            <ResetIcon />
          </button>
        )}
        {!__STANDALONE__ && (
          <label className="btn icon-btn" title="Open manifest">
            <UploadIcon />
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
            />
          </label>
        )}
        {__STANDALONE__ ? (
          <button
            className="icon-btn"
            disabled={!manifest}
            title="Download PNG"
            onClick={() => exportDiagram(allNodes, "png", manifest?.kind ?? "diagram")}
          >
            <DownloadIcon />
          </button>
        ) : (
        <div className="dropdown" ref={downloadRef}>
          <button
            className="icon-btn"
            disabled={!manifest}
            title="Download"
            onClick={() => setDownloadOpen((v) => !v)}
          >
            <DownloadIcon />
          </button>
          {downloadOpen && (
            <div className="dropdown-menu">
              <button
                onClick={() => {
                  // allNodes: the boundary box (+ its label riding 12px above
                  // the border) must count toward the export bounds too
                  exportDiagram(allNodes, "png", manifest?.kind ?? "diagram");
                  setDownloadOpen(false);
                }}
              >
                PNG
              </button>
              <button
                onClick={() => {
                  exportDiagram(allNodes, "svg", manifest?.kind ?? "diagram");
                  setDownloadOpen(false);
                }}
              >
                SVG
              </button>
              <button
                onClick={() => {
                  if (!manifest) return;
                  exportViewerHtml(manifest, collectPositions(contentNodes), manifest.kind ?? "diagram");
                  setDownloadOpen(false);
                }}
              >
                HTML
              </button>
              <button
                onClick={() => {
                  if (!manifest) return;
                  downloadLayoutFile(layoutSubject(manifest), collectPositions(contentNodes));
                  setDownloadOpen(false);
                }}
              >
                Layout JSON
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      <div className="canvas">
        {dragOver && <div className="drop-overlay">Drop the manifest file here</div>}
        {computing && (
          <div className="computing-overlay">
            <div className="spinner" />
            <div>Optimizing layout…</div>
          </div>
        )}
        {!manifest ? (
          <div className="empty">
            <div>Open a manifest file (drag &amp; drop also works).</div>
            <div style={{ fontSize: 12 }}>Renders DiagramManifest JSON files created by skills.</div>
          </div>
        ) : (
          <ReactFlow
            key={overview && overviewGraph ? "overview" : "detail"}
            nodes={overview && overviewGraph ? overviewGraph.nodes : displayNodes}
            edges={overview && overviewGraph ? overviewGraph.edges : displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(inst) => { rfInstRef.current = inst; }}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodesDraggable={manifest.kind !== "concept-tree" && !overview}
            fitView
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            {manifest.kind === "erd" && <ErdMarkerDefs />}
            <Background color="#e2e8f0" gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
