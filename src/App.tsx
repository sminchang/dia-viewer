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
import { layout, type LayoutMode } from "./core/layout";
import { exportDiagram } from "./core/exportImage";
import { downloadLayoutFile, isLayoutFile, type Positions } from "./core/storage";
import { TableNode } from "./nodes/TableNode";
import { C4Node } from "./nodes/C4Node";
import { GroupNode } from "./nodes/GroupNode";

/** Per-axis snap-to-align tolerance, in pixels. Conservative — only nodes whose
 *  centers land within this window of another node's center get auto-aligned. */
const SNAP_PX = 8;

const layoutSubject = (m: DiagramManifest): string =>
  m.title || m.meta?.system || m.meta?.database || "diagram";

const nodeTypes = { table: TableNode, c4: C4Node, group: GroupNode };
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
  const [mode, setMode] = useState<LayoutMode>("hierarchical");
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

  // Honor the manifest's preferred layout on load (skills hint via meta.defaultLayout
  // — C1 manifests typically request "central", C2 manifests "hierarchical"). The
  // toolbar toggle remains available for the user to override.
  useEffect(() => {
    const hint = manifest?.meta?.defaultLayout;
    setMode(hint === "central" ? "central" : "hierarchical");
  }, [manifest]);

  // Recompute layout whenever the manifest, layout mode, or comment view
  // changes. A layout sidecar that was loaded before/with this manifest is
  // applied on top of the auto-layout (pendingLayoutRef).
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    const { nodes, edges: built } = manifestToFlow(manifest, showComments, keysOnly);
    layout(mode, nodes, built).then((auto) => {
      if (cancelled) return;
      const merged = { ...auto, ...(pendingLayoutRef.current ?? {}) };
      const placed = nodes.map((n) => ({ ...n, position: merged[n.id] ?? n.position }));
      setContentNodes(placed);
      setEdges(updateHandles(placed, built));
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, mode, showComments, keysOnly]);

  // Group background boxes — architecture boundaries only. ERD domains overlap
  // heavily once tables are placed, so boxes there add clutter rather than clarity.
  // Nested groups (sub-domains with parent) compute their bbox transitively:
  // a node belongs to group G if its `data.group` is G OR is a descendant of G.
  const groupNodes = useMemo<Node[]>(() => {
    if (manifest?.kind !== "architecture" || !manifest.groups) return [];
    const parentOf = new Map(manifest.groups.map((g) => [g.id, g.parent ?? null]));
    // A node g belongs to ancestor a if walking g's parent chain hits a.
    const isDescendant = (gid: string, anc: string): boolean => {
      let cur: string | null | undefined = gid;
      while (cur) {
        if (cur === anc) return true;
        cur = parentOf.get(cur);
      }
      return false;
    };
    // Padding by depth so boundary > sub-domain visually
    const depthOf = (id: string): number => {
      let d = 0;
      let cur: string | null | undefined = parentOf.get(id);
      while (cur) { d++; cur = parentOf.get(cur); }
      return d;
    };
    return manifest.groups.flatMap((g) => {
      const members = contentNodes.filter((n) => {
        const ng = (n.data as { group?: string }).group;
        return ng ? isDescendant(ng, g.id) : false;
      });
      if (members.length === 0) return [];
      const pad = GROUP_PAD - depthOf(g.id) * 8;
      const xs = members.map((m) => m.position.x);
      const ys = members.map((m) => m.position.y);
      const xe = members.map((m) => m.position.x + (m.width ?? 200));
      const ye = members.map((m) => m.position.y + (m.height ?? 100));
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad - 16;
      const width = Math.max(...xe) - x + pad;
      const height = Math.max(...ye) - y + pad;
      const level = depthOf(g.id);
      return [
        {
          id: `grp_${g.id}`,
          type: "group",
          position: { x, y },
          width,
          height,
          selectable: false,
          draggable: false,
          // Outer boundary behind sub-domains: lower z-index for outer.
          zIndex: -10 + level,
          data: { label: g.label, width, height, level },
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
      // 주석 OFF면 highlight 여부와 무관하게 라벨 숨김.
      const label = hideLabels ? "" : e.label;
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
      setEdges((es) => updateHandles(updated, es));
    },
    [contentNodes],
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
        setEdges((es) => {
          // Re-derive handles against the just-updated positions.
          const updated = contentNodes.map((n) =>
            data.positions[n.id]
              ? { ...n, position: data.positions[n.id] }
              : n,
          );
          return updateHandles(updated, es);
        });
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

        <div className="seg">
          <button className={mode === "hierarchical" ? "active" : ""} onClick={() => setMode("hierarchical")}>
            계층
          </button>
          <button className={mode === "central" ? "active" : ""} onClick={() => setMode("central")}>
            중앙
          </button>
        </div>

        {hasComments && (
          <button className={showComments ? "active" : ""} onClick={() => setShowComments((v) => !v)}>
            주석 {showComments ? "ON" : "OFF"}
          </button>
        )}

        {manifest?.kind === "erd" && (
          <button className={keysOnly ? "active" : ""} onClick={() => setKeysOnly((v) => !v)}>
            간략 {keysOnly ? "ON" : "OFF"}
          </button>
        )}

        {manifest?.kind === "architecture" && (
          <button className={showAllLabels ? "active" : ""} onClick={() => setShowAllLabels((v) => !v)}>
            주석 {showAllLabels ? "ON" : "OFF"}
          </button>
        )}

        <label className="btn icon-btn" title="매니페스트 열기">
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
            title="다운로드"
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
        {dragOver && <div className="drop-overlay">매니페스트 파일을 여기에 놓으세요</div>}
        {!manifest ? (
          <div className="empty">
            <div>매니페스트를 열거나 예시를 불러오세요 (드래그앤드롭도 가능).</div>
            <div style={{ fontSize: 12 }}>스킬이 만든 diagram manifest(JSON)를 렌더링합니다.</div>
          </div>
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#e2e8f0" gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
