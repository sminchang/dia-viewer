import type { NodeProps } from "@xyflow/react";

/** Non-interactive background box around a domain (ERD), boundary (C4), or lane (flow).
 *  `level` 0 = outermost boundary (heavier visual weight),
 *  `level` ≥1 = nested sub-domain (lighter, less intrusive).
 *  `isLane` = true → renders as a swimlane column strip for flow diagrams. */
export function GroupNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    width: number;
    height: number;
    level?: number;
    isLane?: boolean;
    laneColor?: { border: string; bg: string; header: string };
  };
  if (d.isLane && d.laneColor) {
    return (
      <div
        className="group-node group-lane"
        style={{
          width: d.width,
          height: d.height,
          borderColor: d.laneColor.border,
          background: d.laneColor.bg,
        }}
      >
        <span
          className="group-label lane-label"
          style={{ background: d.laneColor.header }}
        >
          {d.label}
        </span>
      </div>
    );
  }
  const cls = (d.level ?? 0) === 0 ? "group-node group-boundary" : "group-node group-domain";
  return (
    <div className={cls} style={{ width: d.width, height: d.height }}>
      <span className="group-label">{d.label}</span>
    </div>
  );
}
