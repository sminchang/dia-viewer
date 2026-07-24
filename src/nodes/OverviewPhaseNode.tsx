import { Handle, Position, type NodeProps } from "@xyflow/react";

/** Phase-overview node: one card per phase — the flowchart's onboarding layer
 *  (phase labels alone must tell the story; steps stay in the detail view). */
export function OverviewPhaseNode({ data }: NodeProps) {
  const d = data as { label?: string; count?: number; idx?: number; horiz?: boolean };
  const inPos = d.horiz ? Position.Left : Position.Top;
  const outPos = d.horiz ? Position.Right : Position.Bottom;
  return (
    <div className="ov-phase">
      <Handle type="target" position={inPos} isConnectable={false} />
      <Handle type="source" position={outPos} isConnectable={false} />
      <div className="ov-phase-idx">{(d.idx ?? 0) + 1}</div>
      <div className="ov-phase-label">{d.label}</div>
      <div className="ov-phase-count">{d.count ?? 0} steps</div>
    </div>
  );
}
