import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { RoutedPoint } from "../core/routeFlowEdges";

/**
 * Flowchart edge renderer — forked from the architecture RoutedEdge.
 *
 * Flowcharts ship with annotations ON (conditions are part of the document),
 * so labels here are DOCUMENTATION, not reference hints: larger type (12px
 * vs 10px), darker ink, and a wider wrap budget. flowLabelPlacement.ts
 * mirrors these metrics (LBL_MAX, box heights) for its collision boxes —
 * keep them in sync.
 */

const RADIUS = 8;

/** Label typography — flowLabelPlacement.ts mirrors these. */
const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const WRAP_MAX = 104;
const INK = "#475569";

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
 *  normally supplies data.labelPos. */
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

/** Flowchart edge following a pre-routed Manhattan path (routeFlowEdges.ts).
 *  Falls back to a straight line when no points are present. */
export function FlowRoutedEdge({
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
        labels?: string[];
        labelsPos?: ({ x: number; y: number; wrap: boolean } | undefined)[];
      }
    | undefined;
  const pts = d?.points;
  const path =
    pts && pts.length >= 2
      ? roundedPath(pts)
      : `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  const anchor = d?.labelPos ?? (pts && pts.length >= 2 ? labelAnchor(pts) : null);
  const opacity = (style as { opacity?: number } | undefined)?.opacity ?? 1;

  // Merged edge carrying multiple conditions: spread the labels PERPENDICULAR
  // to the line at its midpoint — a vertical edge gets labels side by side, a
  // horizontal edge gets them stacked — so both read as parallel conditions
  // instead of one clamped "A / B" box.
  const multi = d?.labels;
  if (multi && multi.length > 1 && pts && pts.length >= 2) {
    let best = 0, bi = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
      if (len > best) { best = len; bi = i; }
    }
    const a = pts[bi], b = pts[bi + 1];
    const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = multi.length;
    return (
      <>
        <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
        <EdgeLabelRenderer>
          {multi.map((txt, i) => {
            const k = i - (n - 1) / 2; // centred offset index (2 labels → -0.5, +0.5)
            // collision-adjusted position from the router when present;
            // legacy fixed perpendicular spread as fallback
            const p = d?.labelsPos?.[i];
            const x = p ? p.x : mid.x + (vertical ? k * 150 : 0);
            const y = p ? p.y : mid.y + (vertical ? 0 : k * 38);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
                  fontSize: FONT_SIZE,
                  fontWeight: 600,
                  lineHeight: `${LINE_HEIGHT}px`,
                  color: INK,
                  textShadow: "0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff, 0 0 4px #fff",
                  maxWidth: 140,
                  textAlign: "center",
                  pointerEvents: "none",
                  opacity,
                }}
              >
                {txt}
              </div>
            );
          })}
        </EdgeLabelRenderer>
      </>
    );
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
      {label && anchor && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${anchor.x}px, ${anchor.y}px)`,
              fontSize: FONT_SIZE,
              fontWeight: 600,
              lineHeight: `${LINE_HEIGHT}px`,
              color: INK,
              // halo instead of a box — boxes stack up as white patches
              // wherever labels meet other lines
              textShadow:
                "0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff, 0 0 4px #fff",
              textAlign: "center",
              ...(d?.labelWrap
                ? ({
                    maxWidth: WRAP_MAX,
                    textWrap: "balance",
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
