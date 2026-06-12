import { Handle, Position, type NodeProps } from "@xyflow/react";

/** Phase territory box: full-width dark header + light body.
 *  Handles on all four sides so phase-to-phase edges can connect
 *  to the box boundary in both landscape and portrait orientations. */
export function PhaseBoxNode({ data }: NodeProps) {
  const d = data as { label?: string };
  return (
    <div className="phase-box">
      {/* Left/right handles pinned to header vertical center (26px = PHASE_NODE_H / 2) */}
      <Handle type="source" id="n__l" position={Position.Left}   style={{ top: 26 }} isConnectable={false} />
      <Handle type="target" id="n__l" position={Position.Left}   style={{ top: 26 }} isConnectable={false} />
      <Handle type="source" id="n__r" position={Position.Right}  style={{ top: 26 }} isConnectable={false} />
      <Handle type="target" id="n__r" position={Position.Right}  style={{ top: 26 }} isConnectable={false} />
      {/* Top/bottom handles at horizontal center (portrait orientation) */}
      <Handle type="source" id="n__b" position={Position.Bottom} isConnectable={false} />
      <Handle type="target" id="n__b" position={Position.Bottom} isConnectable={false} />
      <Handle type="source" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="target" id="n__t" position={Position.Top}    isConnectable={false} />
      {d.label && <div className="phase-box-header">{d.label}</div>}
      <div className="phase-box-body" />
    </div>
  );
}
