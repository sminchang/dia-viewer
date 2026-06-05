import { Fragment } from "react";
import { ViewportPortal } from "@xyflow/react";
import { EDGE_COLORS } from "../core/manifestToFlow";

/** Crow's-foot (IE notation) end-marker defs for ERD edges.
 *
 *  Symbols are drawn with +x pointing toward the node they attach to, so one
 *  geometry serves both ends: markerEnd uses orient="auto" (path direction at
 *  the end already faces the node) and markerStart uses
 *  orient="auto-start-reverse" (flips the start direction to face the node).
 *
 *  Rendered through ViewportPortal so the defs live inside
 *  .react-flow__viewport — the element html-to-image captures — which keeps
 *  the symbols visible in PNG/SVG exports. SVG markers cannot inherit the
 *  referencing path's stroke, so one marker is emitted per symbol × end ×
 *  palette colour (ids match buildErdEdges: `erd-{sym}-{s|e}-{colorIdx}`).
 */
export function ErdMarkerDefs() {
  return (
    <ViewportPortal>
      <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden>
        <defs>
          {EDGE_COLORS.map((color, i) => (
            <Fragment key={color}>
              {(["s", "e"] as const).map((end) => {
                const orient = end === "s" ? "auto-start-reverse" : "auto";
                const common = {
                  markerUnits: "userSpaceOnUse",
                  markerHeight: 14,
                  refY: 7,
                  orient,
                } as const;
                const stroke = { fill: "none", stroke: color, strokeWidth: 1.8, strokeLinecap: "round" } as const;
                return (
                  <Fragment key={end}>
                    {/* many (N/M): three prongs fanning into the node edge */}
                    <marker id={`erd-many-${end}-${i}`} {...common} markerWidth={13} refX={12}>
                      <path d="M 0 7 L 12 1.5 M 0 7 L 12 7 M 0 7 L 12 12.5" {...stroke} />
                    </marker>
                    {/* one (1): perpendicular bar just before the node edge */}
                    <marker id={`erd-one-${end}-${i}`} {...common} markerWidth={13} refX={12}>
                      <path d="M 5 2 L 5 12" {...stroke} />
                    </marker>
                    {/* zero-or-one (0..1): circle + bar */}
                    <marker id={`erd-zeroone-${end}-${i}`} {...common} markerWidth={19} refX={18}>
                      <circle cx={5.5} cy={7} r={3.5} {...stroke} fill="#fff" />
                      <path d="M 12.5 2 L 12.5 12" {...stroke} />
                    </marker>
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </defs>
      </svg>
    </ViewportPortal>
  );
}
