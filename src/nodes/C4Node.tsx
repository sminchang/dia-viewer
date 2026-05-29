import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { C4Data, NodeType } from "../manifest";

const KIND_LABEL: Record<string, string> = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
};

/** C4 element node (person / system / container / component). */
export function C4Node({ data }: NodeProps) {
  const d = data as unknown as C4Data & { label: string; nodeType: NodeType };
  const cls = `c4-node ${d.nodeType}${d.external ? " external" : ""}`;
  return (
    <div className={cls}>
      {/* All four sides carry source+target so updateHandles can pick the
          closest pair (L/R/T/B) based on the source→target vector. */}
      <Handle type="target" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="source" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="target" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="source" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="target" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="source" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="target" id="n__b" position={Position.Bottom} isConnectable={false} />
      <Handle type="source" id="n__b" position={Position.Bottom} isConnectable={false} />
      <div className="c4-kind">
        {KIND_LABEL[d.nodeType]}
        {d.external ? " · external" : ""}
      </div>
      <div className="c4-label">{d.label}</div>
      {d.technology && <div className="c4-tech">[{d.technology}]</div>}
      {d.description && <div className="c4-desc">{d.description}</div>}
    </div>
  );
}
