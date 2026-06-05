import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

/** Horizontal run at each end, long enough to cover the longest end marker
 *  (zero-or-one: 19px) so symbols always sit on a straight segment. */
const STUB = 24;

/** ERD edge: straight horizontal stub → bezier → straight horizontal stub.
 *
 *  End markers orient to the path tangent *at the endpoint*, but the symbols
 *  are 12–19px long — a plain bezier bends away within that distance and the
 *  straight-drawn crow's foot visibly detaches from the curve. The stubs give
 *  each symbol a straight run to sit on, so line and symbol join seamlessly
 *  (same trick ERwin/dbdiagram use). */
export function ErdEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const sx = sourceX + (sourcePosition === Position.Left ? -STUB : STUB);
  const tx = targetX + (targetPosition === Position.Left ? -STUB : STUB);
  const [curve] = getBezierPath({
    sourceX: sx,
    sourceY,
    sourcePosition,
    targetX: tx,
    targetY,
    targetPosition,
    curvature: (data as { curvature?: number } | undefined)?.curvature ?? 0.25,
  });
  // Splice the bezier (sans its M command) between the two stubs.
  const path = `M ${sourceX},${sourceY} L ${sx},${sourceY} ${curve.slice(curve.indexOf("C"))} L ${targetX},${targetY}`;
  return <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />;
}
