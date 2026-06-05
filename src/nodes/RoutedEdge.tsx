import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { RoutedPoint } from "../core/routeEdges";

const RADIUS = 8;

/** SVG path through the routed points with rounded corners. */
function roundedPath(pts: RoutedPoint[]): string {
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const n = pts[i + 1];
    const r = Math.min(
      RADIUS,
      Math.hypot(c.x - p.x, c.y - p.y) / 2,
      Math.hypot(n.x - c.x, n.y - c.y) / 2,
    );
    const a = { x: c.x - Math.sign(c.x - p.x) * r, y: c.y - Math.sign(c.y - p.y) * r };
    const b = { x: c.x + Math.sign(n.x - c.x) * r, y: c.y + Math.sign(n.y - c.y) * r };
    d += ` L ${a.x},${a.y} Q ${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last.x},${last.y}`;
}

/** Label anchor: midpoint of the longest segment (most room for text). */
function labelAnchor(pts: RoutedPoint[]): RoutedPoint {
  let best = 0;
  let bi = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    if (len > best) {
      best = len;
      bi = i;
    }
  }
  return {
    x: (pts[bi].x + pts[bi + 1].x) / 2,
    y: (pts[bi].y + pts[bi + 1].y) / 2,
  };
}

/** Architecture edge following a pre-routed Manhattan path (routeEdges.ts).
 *  Falls back to a straight line when no points are present. */
export function RoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerStart,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps) {
  const pts = (data as { points?: RoutedPoint[] } | undefined)?.points;
  const path =
    pts && pts.length >= 2
      ? roundedPath(pts)
      : `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  const anchor = pts && pts.length >= 2 ? labelAnchor(pts) : null;
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
      {label && anchor && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${anchor.x}px, ${anchor.y}px)`,
              fontSize: 11,
              fontWeight: 600,
              color: "#475569",
              background: "rgba(255,255,255,0.85)",
              padding: "1px 4px",
              borderRadius: 3,
              pointerEvents: "none",
              opacity: (style as { opacity?: number } | undefined)?.opacity ?? 1,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
