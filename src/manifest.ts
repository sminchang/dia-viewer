/**
 * Diagram Manifest — the contract between diagram-generating skills
 * (create-erd, create-diagram) and the renderer web app.
 *
 * One manifest = one diagram (one view). Skills produce it from source code;
 * the renderer consumes it. Node positions are NOT part of the manifest —
 * they live in a separate layout sidecar (layout.json) keyed by node id, so
 * regenerating structure (re-running a skill) preserves the user's manual layout.
 */

export type ManifestKind = "erd" | "architecture";

export interface DiagramManifest {
  /** Schema version of this manifest format. */
  version: "1.0";
  kind: ManifestKind;
  title?: string;
  meta?: ManifestMeta;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Visual clusters — ERD domains (flat) or C4 boundaries (may nest). */
  groups?: DiagramGroup[];
}

export interface ManifestMeta {
  /** Provenance string, e.g. "ORM models + latest migration". */
  source?: string;
  /** e.g. "create-erd skill", "create-diagram skill". */
  generatedBy?: string;
  /** ERD: database name. */
  database?: string;
  /** architecture: system-of-interest name. */
  system?: string;
  /** Renderer's initial layout engine; user can switch in the UI. */
  defaultLayout?: "hierarchical" | "central";
  note?: string;
}

export type NodeType =
  | "table" // ERD
  | "person" // C4
  | "softwareSystem" // C4
  | "container" // C4
  | "component"; // C4

export interface DiagramNode {
  /** Stable, unique id. The layout sidecar keys positions on this — keep it
   *  deterministic across regenerations (use the table name / element name). */
  id: string;
  nodeType: NodeType;
  label: string;
  /** Id of the single group this node belongs to (optional). */
  group?: string;
  data: TableData | C4Data;
}

// ── ERD node data ────────────────────────────────────────────────────────

export interface TableData {
  columns: Column[];
  /** DB COMMENT ON the table (toggleable in the viewer). */
  comment?: string;
  /** Free annotation (manual; not a DB comment). */
  note?: string;
}

export interface Column {
  name: string;
  /** As in the DB: "uuid", "varchar(100)", "timestamptz", "integer", ... */
  type: string;
  /** Defaults to true (SQL semantics). Set false for NOT NULL. */
  nullable?: boolean;
  /** Part of the primary key. Multiple pk:true columns = composite PK. */
  pk?: boolean;
  /** Is a foreign-key column (the edge carries the target). */
  fk?: boolean;
  /** Single-column UNIQUE. */
  unique?: boolean;
  /** Composite UNIQUE member. Columns sharing the same value form one
   *  multi-column unique constraint (rendered as "UK*"). */
  uniqueGroup?: string;
  /** Default value/expression, e.g. "NOW()", "0", "'pending'". */
  default?: string;
  /** DB COMMENT ON the column (toggleable in the viewer). */
  comment?: string;
  /** Free annotation (manual; not a DB comment). */
  note?: string;
}

// ── C4 node data ─────────────────────────────────────────────────────────

export interface C4Data {
  /** "FastAPI", "PostgreSQL 16", "React + Vite", ... */
  technology?: string;
  description?: string;
  /** True if outside the system-of-interest boundary. */
  external?: boolean;
}

// ── Edges ──────────────────────────────────────────────────────────────────

export interface DiagramEdge {
  id?: string;
  /** Source node id. ERD: the FK-holding (child) table. */
  source: string;
  /** Target node id. ERD: the referenced (parent) table. */
  target: string;
  /** C4 relationship verb ("calls", "reads from"). Usually empty for ERD. */
  label?: string;
  data?: ErdEdgeData | C4EdgeData;
}

export interface ErdEdgeData {
  /** FK column on the source table (enables column-level edge attachment). */
  sourceColumn?: string;
  /** Referenced column on the target table. */
  targetColumn?: string;
  cardinality?: "1:N" | "0..1:N" | "1:1" | "0..1:0..1" | "N:M";
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" | "SET DEFAULT";
}

export interface C4EdgeData {
  /** "HTTPS/JSON", "gRPC", "SQL", "AMQP", ... */
  technology?: string;
}

// ── Groups ───────────────────────────────────────────────────────────────

export interface DiagramGroup {
  id: string;
  label: string;
  /** Nesting: a C4 container boundary inside a system boundary. Omit for
   *  flat grouping (ERD domains). */
  parent?: string;
  kind?: "domain" | "boundary";
}
