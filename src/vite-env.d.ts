/// <reference types="vite/client" />

// Build-time constant (vite `define`). True only in the standalone single-file
// build, which renders an injected diagram with no layout engine — so the
// layout worker and elkjs get dead-code-eliminated out of that bundle.
declare const __STANDALONE__: boolean;

interface Window {
  /** Injected by the exported standalone HTML: the diagram to auto-load. */
  __DIAGRAM__?: import("./manifest").DiagramManifest;
  /** Injected node positions (the exact view at export time). */
  __POSITIONS__?: Record<string, { x: number; y: number }>;
}
