import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Browser,
  Cube,
  Database,
  Desktop,
  DeviceMobileCamera,
  FolderOpen,
  Globe,
  Package,
  PuzzlePiece,
  Robot,
  TerminalWindow,
  Tray,
  User,
  type Icon,
} from "@phosphor-icons/react";
import type { C4Data, NodeType } from "../manifest";

const KIND_LABEL: Record<string, string> = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
};

/** Conventional pictogram per role — Phosphor Icons (MIT), duotone weight:
 *  professionally drawn glyphs that stay rich at large sizes. */
const ROLE_ICON: Record<string, Icon> = {
  webapp: Browser,
  mobileapp: DeviceMobileCamera,
  desktopapp: Desktop,
  cli: TerminalWindow,
  database: Database,
  queue: Tray,
  filestore: FolderOpen,
  automation: Robot,
  module: Package,
};

const TYPE_ICON: Record<string, Icon> = {
  person: User,
  container: Cube,
  component: PuzzlePiece,
  softwareSystem: Globe,
};

/** C4 element node, AWS-diagram style: the pictogram IS the node — a large
 *  duotone glyph with the name underneath. Tech/description rows appear only
 *  with annotations on (manifestToFlow strips them otherwise). */
export function C4Node({ data }: NodeProps) {
  const d = data as unknown as C4Data & { label: string; nodeType: NodeType };
  const role = d.nodeType === "person" ? undefined : d.role;
  const IconGlyph = (role && ROLE_ICON[role]) || TYPE_ICON[d.nodeType] || Cube;
  const cls =
    `c4-node ${d.nodeType}` +
    (d.external ? " external" : "") +
    (role && ROLE_ICON[role] ? ` role-${role}` : "");
  const kind =
    (d.external ? "External" : KIND_LABEL[d.nodeType]) +
    (role ? ` · ${role}` : "") +
    (d.technology ? ` — ${d.technology}` : "") +
    (d.description ? `\n${d.description}` : "");
  return (
    <div className={cls} title={kind}>
      {/* All four sides carry source+target so the router can pick any pair. */}
      <Handle type="target" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="source" id="n__l" position={Position.Left}   isConnectable={false} />
      <Handle type="target" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="source" id="n__r" position={Position.Right}  isConnectable={false} />
      <Handle type="target" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="source" id="n__t" position={Position.Top}    isConnectable={false} />
      <Handle type="target" id="n__b" position={Position.Bottom} isConnectable={false} />
      <Handle type="source" id="n__b" position={Position.Bottom} isConnectable={false} />

      <div className="c4-glyph">
        <IconGlyph size={44} weight="duotone" />
      </div>
      <div className="c4-label" title={d.label}>{d.label}</div>
    </div>
  );
}
