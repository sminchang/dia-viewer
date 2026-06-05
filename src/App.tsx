import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DiagramManifest } from "./manifest";
import { manifestToFlow, updateHandles } from "./core/manifestToFlow";
import { routeArchEdges } from "./core/routeEdges";
import { layout } from "./core/layout";
import { exportDiagram } from "./core/exportImage";
import { downloadLayoutFile, isLayoutFile, type Positions } from "./core/storage";
import { TableNode } from "./nodes/TableNode";
import { ErdMarkerDefs } from "./nodes/ErdMarkers";
import { ErdEdge } from "./nodes/ErdEdge";
import { C4Node } from "./nodes/C4Node";
import { GroupNode } from "./nodes/GroupNode";
import { RoutedEdge } from "./nodes/RoutedEdge";

/** Per-axis snap-to-align tolerance, in pixels. Conservative — only nodes whose
 *  centers land within this window of another node's center get auto-aligned. */
const SNAP_PX = 8;

const layoutSubject = (m: DiagramManifest): string =>
  m.title || m.meta?.system || m.meta?.database || "diagram";

const nodeTypes = { table: TableNode, c4: C4Node, group: GroupNode };
const edgeTypes = { erd: ErdEdge, routed: RoutedEdge };
const GROUP_PAD = 20;

const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
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
  const [keysOnly, setKeysOnly] = useState(false);
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
  const wireEdges = useCallback(
    (placed: Node[], built: Edge[]): Edge[] =>
      manifest?.kind === "architecture"
        ? routeArchEdges(placed, built)
        : updateHandles(placed, built),
    [manifest],
  );

  // Recompute layout whenever the manifest or a view toggle changes. A layout
  // sidecar that was loaded before/with this manifest is applied on top of
  // the auto-layout (pendingLayoutRef).
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    const { nodes, edges: built } = manifestToFlow(
      manifest,
      showComments,
      keysOnly,
      showAllLabels, // architecture: descriptions ride with the labels toggle
    );
    layout(manifest.kind, nodes, built).then((auto) => {
      if (cancelled) return;
      const merged = { ...auto, ...(pendingLayoutRef.current ?? {}) };
      const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
      builtEdgesRef.current = built;
      setContentNodes(placed);
      setEdges(wireEdges(placed, built));
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, showComments, keysOnly, showAllLabels, wireEdges]);

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

  const allNodes = useMemo(() => [...groupNodes, ...contentNodes], [groupNodes, contentNodes]);

  // Click-to-focus: clicking a node pins the highlight on it + its directly-
  // connected nodes/edges; everything else dims. Click again (or the pane) to clear.
  const focus = locked;
  const highlight = useMemo(() => {
    if (!focus) return null;
    const nodes = new Set<string>([focus]);
    const edgesOn = new Set<string>();
    for (const e of edges) {
      if (e.source === focus || e.target === focus) {
        if (e.id) edgesOn.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    }
    return { nodes, edgesOn };
  }, [focus, edges]);

  const displayNodes = useMemo(() => {
    if (!highlight) return allNodes;
    return allNodes.map((n) =>
      n.type === "group"
        ? n
        : { ...n, style: { ...n.style, opacity: highlight.nodes.has(n.id) ? 1 : 0.15 } },
    );
  }, [allNodes, highlight]);

  const displayEdges = useMemo(() => {
    const hideLabels = manifest?.kind === "architecture" && !showAllLabels;
    if (!highlight) {
      return hideLabels ? edges.map((e) => ({ ...e, label: "" })) : edges;
    }
    return edges.map((e) => {
      const on = e.id ? highlight.edgesOn.has(e.id) : false;
      // Annotations OFF hides labels regardless of highlight state; with a
      // highlight active, only the highlighted edges keep their labels.
      const label = hideLabels || !on ? "" : e.label;
      return { ...e, label, animated: on ? e.animated : false, style: { ...e.style, opacity: on ? 1 : 0.07 } };
    });
  }, [edges, highlight, manifest, showAllLabels]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setContentNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // After a drag: (1) conservative snap to align centers with any neighbor
  // within SNAP_PX, (2) re-pick handle sides.
  const onNodeDragStop = useCallback(
    (_: unknown, dragged: Node) => {
      const dw = dragged.width ?? 200;
      const dh = dragged.height ?? 100;
      const dcx = dragged.position.x + dw / 2;
      const dcy = dragged.position.y + dh / 2;

      let snappedX: number | null = null;
      let snappedY: number | null = null;
      for (const other of contentNodes) {
        if (other.id === dragged.id || other.type === "group") continue;
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
      setEdges(wireEdges(updated, builtEdgesRef.current));
    },
    [contentNodes, wireEdges],
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === "group") return;
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
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="toolbar">
        <span className="title">dia-viewer</span>
        {manifest && (
          <span className="meta">
            {manifest.title} · {manifest.kind} · {manifest.nodes.length} nodes
          </span>
        )}
        <div className="spacer" />

        {hasComments && (
          <button className={showComments ? "active" : ""} onClick={() => setShowComments((v) => !v)}>
            Annotations
          </button>
        )}

        {manifest?.kind === "erd" && (
          <button className={keysOnly ? "active" : ""} onClick={() => setKeysOnly((v) => !v)}>
            Keys Only
          </button>
        )}

        {manifest?.kind === "architecture" && (
          <button className={showAllLabels ? "active" : ""} onClick={() => setShowAllLabels((v) => !v)}>
            Annotations
          </button>
        )}

        <label className="btn icon-btn" title="Open manifest">
          <UploadIcon />
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
          />
        </label>
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
                  exportDiagram(contentNodes, "png", manifest?.kind ?? "diagram");
                  setDownloadOpen(false);
                }}
              >
                PNG
              </button>
              <button
                onClick={() => {
                  exportDiagram(contentNodes, "svg", manifest?.kind ?? "diagram");
                  setDownloadOpen(false);
                }}
              >
                SVG
              </button>
              <button
                onClick={() => {
                  if (!manifest) return;
                  const positions: Positions = {};
                  contentNodes.forEach((n) => {
                    if (n.type !== "group") {
                      positions[n.id] = { x: n.position.x, y: n.position.y };
                    }
                  });
                  downloadLayoutFile(layoutSubject(manifest), positions);
                  setDownloadOpen(false);
                }}
              >
                Layout JSON
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="canvas">
        {dragOver && <div className="drop-overlay">Drop the manifest file here</div>}
        {!manifest ? (
          <div className="empty">
            <div>Open a manifest file (drag &amp; drop also works).</div>
            <div style={{ fontSize: 12 }}>Renders DiagramManifest JSON files created by skills.</div>
          </div>
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
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
