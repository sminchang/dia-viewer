import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Column, TableData } from "../manifest";

/** ERD table node with per-column connection handles (left + right).
 *  - `showComments` ON: each row gets a right-side comment column, and the
 *    table comment sits right of the title in the header; the table grows
 *    horizontally rather than vertically.
 *  - `keysOnly` ON: only columns with PK/FK/UK/uniqueGroup are rendered, plus
 *    a trailing row flagging how many regular columns are hidden. */
export function TableNode({ data }: NodeProps) {
  const d = data as unknown as TableData & {
    label: string;
    showComments?: boolean;
    keysOnly?: boolean;
    /** keys-only lifted for THIS table via its "hidden" row (click toggles). */
    expanded?: boolean;
  };
  const show = d.showComments;
  const cols = d.keysOnly ? d.columns.filter(isKey) : d.columns;
  const hidden = d.columns.length - cols.length;
  return (
    <div className="table-node">
      <div className="th">
        <span>{d.label}</span>
        {show && d.comment && (
          <span className="table-comment" title={d.comment}>
            {d.comment}
          </span>
        )}
      </div>
      {cols.map((c) => (
        <div key={c.name} className="row">
          <ColumnHandles name={c.name} />
          <span className={c.nullable === false ? "name" : "name null"}>{c.name}</span>
          {badges(c)}
          {show && (
            <div className="col-comment" title={c.comment ?? ""}>
              {c.comment ?? ""}
            </div>
          )}
          <span className="type">{c.type}</span>
        </div>
      ))}
      {d.keysOnly && hidden > 0 && (
        <div className="row omitted">+{hidden} columns hidden</div>
      )}
      {d.expanded && (
        <div className="row omitted">− collapse to keys</div>
      )}
    </div>
  );
}

function isKey(c: Column): boolean {
  return !!(c.pk || c.fk || c.unique || c.uniqueGroup);
}

function badges(c: Column) {
  return (
    <>
      {c.pk && <span className="badge pk">PK</span>}
      {c.fk && <span className="badge fk">FK</span>}
      {c.unique && <span className="badge uk">UK</span>}
      {c.uniqueGroup && <span className="badge uk">UK*</span>}
    </>
  );
}

/** Two handles per side (source + target share an id, differ by type) so an
 *  edge can attach to a column from either direction. Positioned by being a
 *  child of the row — ReactFlow's default left/right handle CSS centers each
 *  vertically within its row. Do NOT set a pixel `top`: it is measured against
 *  the 24px-tall row, not the node, and would push the handle into empty space. */
function ColumnHandles({ name }: { name: string }) {
  return (
    <>
      <Handle type="target" id={`${name}__l`} position={Position.Left} isConnectable={false} />
      <Handle type="source" id={`${name}__l`} position={Position.Left} isConnectable={false} />
      <Handle type="target" id={`${name}__r`} position={Position.Right} isConnectable={false} />
      <Handle type="source" id={`${name}__r`} position={Position.Right} isConnectable={false} />
    </>
  );
}
