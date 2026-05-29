import type { NodeProps } from "@xyflow/react";

/** Non-interactive background box around a domain (ERD) or boundary (C4).
 *  `level` 0 = outermost boundary (heavier visual weight),
 *  `level` ≥1 = nested sub-domain (lighter, less intrusive). */
export function GroupNode({ data }: NodeProps) {
  const d = data as { label: string; width: number; height: number; level?: number };
  const cls = (d.level ?? 0) === 0 ? "group-node group-boundary" : "group-node group-domain";
  return (
    <div className={cls} style={{ width: d.width, height: d.height }}>
      <span className="group-label">{d.label}</span>
    </div>
  );
}
