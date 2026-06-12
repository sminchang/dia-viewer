import { Handle, Position, type NodeProps } from "@xyflow/react";

/**
 * Flow step card — 180×84 px (must match FLOW_NODE_W/H in manifestToFlow).
 * Participant identity: colored left border + small lane tag (text only).
 * Action label: main, bold, prominent.
 * Flowchart shape semantics (derived in manifestToFlow):
 *   terminal start/end → pill (the classic terminator).
 */
export function FlowNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    description?: string;
    laneColor?: string;
    laneLabel?: string;
    terminal?: "start" | "end";
    decision?: boolean;
  };
  const color = d.laneColor ?? "#64748b";
  const cls =
    "flow-node" + (d.terminal ? " terminal" : "") + (d.decision ? " decision" : "");

  return (
    <div className={cls} style={{ "--lane-color": color } as React.CSSProperties} title={d.description ?? d.label}>
      <Handle type="target" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="source" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="target" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="source" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="target" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="source" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="target" id="n__b" position={Position.Bottom} isConnectable={false} />
      <Handle type="source" id="n__b" position={Position.Bottom} isConnectable={false} />

      {d.laneLabel && <span className="flow-lane-tag">{d.laneLabel}</span>}
      <div className="flow-action">{d.label}</div>
    </div>
  );
}
