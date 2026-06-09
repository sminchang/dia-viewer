import { toPng, toSvg } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import type { DiagramManifest } from "../manifest";

const PADDING = 15;

/** Frame the ReactFlow viewport DOM to the full diagram bounds, returning the
 *  capture target + html-to-image options shared by the image export formats. */
function frame(nodes: Node[]): { viewport: HTMLElement; opts: Record<string, unknown> } | null {
  const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
  if (!viewport) {
    alert("No diagram to export.");
    return null;
  }
  if (nodes.length === 0) {
    alert("No nodes to export.");
    return null;
  }
  const bounds = getNodesBounds(nodes);
  // Cap output dimensions so the canvas stays under browser limits
  // (~16384px after pixelRatio=2 → keep logical width/height ≤ 4096).
  const MAX_DIM = 4096;
  let width = Math.ceil(bounds.width + PADDING * 2);
  let height = Math.ceil(bounds.height + PADDING * 2);
  const fit = Math.min(1, MAX_DIM / Math.max(width, height));
  width = Math.ceil(width * fit);
  height = Math.ceil(height * fit);
  // v12: padding as a bare number is interpreted as a *fraction* of the viewport
  // (parsePadding: `viewport - viewport/(1+n)`). Passing `40` would reserve ~49%
  // of the canvas as padding on each side → tiny content + huge whitespace.
  // Use a "${n}px" string to keep it absolute pixels.
  const { x, y, zoom } = getViewportForBounds(bounds, width, height, 0.05, 4, `${PADDING}px`);
  const opts = {
    backgroundColor: "#ffffff",
    width,
    height,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${x}px, ${y}px) scale(${zoom})`,
    },
    pixelRatio: 2,
    cacheBust: true,
    skipFonts: true, // avoid CORS on @font-face fetches; system fonts render fine
  };
  return { viewport, opts };
}

/** Export the ReactFlow viewport to PNG or SVG at full diagram bounds. */
export async function exportDiagram(
  nodes: Node[],
  format: "png" | "svg",
  filename: string,
): Promise<void> {
  const f = frame(nodes);
  if (!f) return;
  try {
    const dataUrl = format === "png" ? await toPng(f.viewport, f.opts) : await toSvg(f.viewport, f.opts);
    const a = document.createElement("a");
    a.download = `${filename}.${format}`;
    a.href = dataUrl;
    a.click();
  } catch (err) {
    console.error(`${format.toUpperCase()} export failed:`, err);
    alert(`${format.toUpperCase()} export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Export a standalone, offline, INTERACTIVE viewer HTML: fetch the prebuilt
 *  single-file viewer (the whole app inlined, no layout engine) and inject the
 *  current diagram + node positions so it opens exactly as shown — with
 *  highlight, zoom, drag and ERD expand/collapse all working offline. */
export async function exportViewerHtml(
  manifest: DiagramManifest,
  positions: Record<string, { x: number; y: number }>,
  filename: string,
): Promise<void> {
  try {
    // no-store: never reuse a cached copy — a stale template would inject the
    // current diagram into an old viewer build.
    const res = await fetch(`${import.meta.env.BASE_URL}viewer.html`, { cache: "no-store" });
    if (!res.ok) throw new Error(`viewer template missing (${res.status}) — run a full build first`);
    const template = await res.text();
    // Escape "<" in the data so a string value can't prematurely close the
    // tag. The literal closing tag is written "<\/script>" so that THIS source,
    // once inlined into the single-file viewer, doesn't close its own <script>.
    const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
    const inject =
      `<script>window.__DIAGRAM__=${json(manifest)};` +
      `window.__POSITIONS__=${json(positions)};<\/script>`;
    // Inject at the document's real </head> — the LAST one. The viewer bundle
    // inlines this very function, whose source contains the literal "</head>",
    // so a plain replace() would match that code string first and splice the
    // diagram into the middle of the script. The real closing tag is last.
    const at = template.lastIndexOf("</head>");
    if (at === -1) throw new Error("viewer template malformed (no </head>)");
    const html = template.slice(0, at) + inject + template.slice(at);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = `${filename}.html`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Viewer HTML export failed:", err);
    alert(`Viewer HTML export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
