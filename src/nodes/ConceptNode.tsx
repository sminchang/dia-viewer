import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ConceptAttr } from "../core/manifestToFlow";

/** Concept-tree entity card. The entity name, its definition, and its inline
 *  attribute rows are distinguished by FONT only — no boxes or colour. Terminal
 *  sub-concepts ride inside the card as attribute rows; expandable ones are
 *  separate cards linked by edges (left = incoming, right = outgoing). */
export function ConceptNode({ data }: NodeProps) {
  const d = data as unknown as { label: string; aka?: string[]; definition?: string; uncertain?: boolean; detail?: string; nature?: "abstract" | "concrete"; attrs?: ConceptAttr[]; isRoot?: boolean };
  return (
    <div className={"concept-node" + (d.uncertain ? " uncertain" : "") + (d.nature ? " " + d.nature : "") + ((d.isRoot || d.detail) ? " tree-head" : "")} title={d.detail ? `상세 지도: ${d.detail}` : undefined}>
      {/* Both sides carry a source and a target handle; the layout picks which
          (updateConceptHandles) so a root-centred bidirectional tree draws
          parent→child cleanly whether the child sits to the right or left. */}
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} />
      <div className="concept-entity">{d.label}</div>
      {d.aka?.length ? <div className="concept-entity-aka">{d.aka.join(" · ")}</div> : null}
      {d.definition ? <div className="concept-entity-def">{d.definition}</div> : null}
      {d.attrs?.map((a, i) => (
        <div key={i} className={"concept-attr" + (a.uncertain ? " uncertain" : "")}>
          <span className="concept-attr-name">
            {a.label}
            {a.aka?.length ? ` (${a.aka.join(", ")})` : ""}
          </span>
          {a.definition ? <span className="concept-attr-def"> : {a.definition}</span> : null}
        </div>
      ))}
    </div>
  );
}
