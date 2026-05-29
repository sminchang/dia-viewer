/** Layout sidecar — the user owns the file. No localStorage, no auto-save.
 *  Workflow: drag nodes to taste → download the layout JSON → keep it next to
 *  the manifest → drop both files together next time to restore the layout. */

export type Positions = Record<string, { x: number; y: number }>;

export interface LayoutFile {
  kind: "layout";
  version: "1.0";
  subject: string;
  positions: Positions;
}

export function isLayoutFile(data: unknown): data is LayoutFile {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.kind === "layout" &&
    typeof d.positions === "object" &&
    d.positions !== null
  );
}

export function downloadLayoutFile(subject: string, positions: Positions): void {
  const payload: LayoutFile = {
    kind: "layout",
    version: "1.0",
    subject,
    positions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${subject}.layout.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
