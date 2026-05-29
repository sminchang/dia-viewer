import { toPng, toSvg } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";

const PADDING = 40;

/** Export the ReactFlow viewport to PNG or SVG at full diagram bounds. */
export async function exportDiagram(
  nodes: Node[],
  format: "png" | "svg",
  filename: string,
): Promise<void> {
  const viewport = document.querySelector(
    ".react-flow__viewport",
  ) as HTMLElement | null;
  if (!viewport) {
    alert("내보낼 다이어그램이 없습니다.");
    return;
  }
  if (nodes.length === 0) {
    alert("노드가 없습니다.");
    return;
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

  try {
    const dataUrl = format === "png" ? await toPng(viewport, opts) : await toSvg(viewport, opts);
    const a = document.createElement("a");
    a.download = `${filename}.${format}`;
    a.href = dataUrl;
    a.click();
  } catch (err) {
    console.error(`${format.toUpperCase()} export failed:`, err);
    alert(`${format.toUpperCase()} 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}
