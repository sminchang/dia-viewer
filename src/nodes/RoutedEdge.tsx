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

/** Fallback label anchor: midpoint of the longest segment. The router
 *  normally supplies data.labelPos — anchors with overlap clusters fanned
 *  out vertically so colliding labels stack instead of piling up. */
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
  const d = data as
    | {
        points?: RoutedPoint[];
        labelPos?: RoutedPoint;
        labelWrap?: boolean;
        labelFull?: boolean;
      }
    | undefined;
  const pts = d?.points;
  const path =
    pts && pts.length >= 2
      ? roundedPath(pts)
      : `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  const anchor = d?.labelPos ?? (pts && pts.length >= 2 ? labelAnchor(pts) : null);
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
      {label && anchor && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${anchor.x}px, ${anchor.y}px)`,
              fontSize: 10,
              fontWeight: 600,
              lineHeight: "13px",
              color: "#64748b",
              // halo instead of a box — boxes stacked up as white patches
              // wherever labels met other lines
              textShadow:
                "0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff, 0 0 4px #fff",
              // long labels wrap to two centered lines (LBL_MAX in routeEdges
              // mirrors this width for collision boxes); clamp keeps extreme
              // labels from growing a third line past the estimated box.
              // labelWrap=false → barely-too-long labels stay on one line
              // instead of orphaning a single character onto line two.
              textAlign: "center",
              ...(d?.labelWrap
                ? ({
                    maxWidth: 84,
                    // balance the lines — width estimates can misjudge mixed
                    // Hangul/Latin labels, and balancing makes a one-character
                    // orphan line impossible at render time
                    textWrap: "balance",
                    // click-highlight (labelFull) lifts the clamp: the whole
                    // text shows while every other label is hidden anyway
                    ...(d?.labelFull
                      ? {}
                      : {
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }),
                  } as React.CSSProperties)
                : { whiteSpace: "nowrap" as const }),
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
