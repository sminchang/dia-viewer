/**
 * Quality gates for the architecture layout + router. Run after touching
 * layout.ts / routeEdges.ts / manifestToFlow.ts:
 *
 *   npm run metrics                       # bundled fixture, annotations ON
 *   npm run metrics -- path/to.arch.json  # any manifest
 *
 * Hard gates (non-zero exit on failure):
 *   - geometry: boundary semantics (persons/externals outside), node overlaps
 *   - piercing: no edge segment through ANY node box (own endpoints included)
 *   - labels:   no label on a node (name-text envelope included), no
 *               label-label overlap
 * Soft metrics (reported, not gated): visual bundle crossings, edge length,
 * canvas size/aspect, label-on-foreign-line count.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { manifestToFlow } from "../src/core/manifestToFlow";
import { routeArchEdges, type RoutedPoint } from "../src/core/routeEdges";
import { routedLength, visualCrossings } from "../src/core/routeMetrics";
import { layout } from "../src/core/layout";
import type { DiagramManifest } from "../src/manifest";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, "fixtures/sample.arch.json");
const annotations = process.argv[3] !== "off"; // gates target the ON view

const m: DiagramManifest = JSON.parse(readFileSync(file, "utf8"));
if (m.kind !== "architecture") {
  console.error("metrics gate covers architecture manifests only");
  process.exit(2);
}

const { nodes, edges } = manifestToFlow(m);
const pos = await layout("architecture", nodes, edges, annotations);
const placed = nodes.map((n) => ({ ...n, position: pos[n.id] }));
const routed = routeArchEdges(placed, edges);

interface Rect { x: number; y: number; w: number; h: number }
const rects = new Map<string, Rect>(
  placed.map((n) => [n.id, { x: n.position.x, y: n.position.y, w: n.width ?? 88, h: n.height ?? 82 }]),
);
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

let fail = 0;
const hard = (cond: boolean, msg: string) => {
  if (cond) return;
  console.error(`GATE FAIL: ${msg}`);
  fail++;
};

// ── geometry: boundary semantics + node overlaps ───────────────────────────
const roots = (m.groups ?? []).filter((g) => !g.parent);
for (const g of roots) {
  const mem = placed.filter((n) => (n.data as { group?: string }).group === g.id);
  if (!mem.length) continue;
  const x = Math.min(...mem.map((n) => n.position.x)) - 20;
  const y = Math.min(...mem.map((n) => n.position.y)) - 36;
  const box: Rect = {
    x,
    y,
    w: Math.max(...mem.map((n) => n.position.x + (n.width ?? 88))) - x + 20,
    h: Math.max(...mem.map((n) => n.position.y + (n.height ?? 82))) - y + 20,
  };
  placed.forEach((n) => {
    if ((n.data as { group?: string }).group) return;
    hard(!overlap(rects.get(n.id)!, box), `${n.id} (ungrouped) inside boundary box`);
  });
}
const ids = placed.map((n) => n.id);
for (let a = 0; a < ids.length; a++)
  for (let b = a + 1; b < ids.length; b++)
    hard(!overlap(rects.get(ids[a])!, rects.get(ids[b])!), `node overlap ${ids[a]} × ${ids[b]}`);

// ── piercing: segments vs every node box (own endpoints included) ──────────
const paths = routed.map((e) => ({
  s: e.source,
  t: e.target,
  pts: (e.data as { points: RoutedPoint[] }).points,
}));
const segHits = (a: RoutedPoint, b: RoutedPoint, r: Rect, padX = 0): boolean => {
  const E = 0.5;
  const x0 = r.x - padX + E, x1 = r.x + r.w + padX - E, y0 = r.y + E, y1 = r.y + r.h - E;
  if (a.y === b.y) {
    const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
    return a.y > y0 && a.y < y1 && hi > x0 && lo < x1;
  }
  if (a.x === b.x) {
    const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return a.x > x0 && a.x < x1 && hi > y0 && lo < y1;
  }
  return false;
};
let pierce = 0;
paths.forEach((p) => {
  for (let i = 0; i + 1 < p.pts.length; i++)
    rects.forEach((r) => {
      if (segHits(p.pts[i], p.pts[i + 1], r)) pierce++;
    });
});
hard(pierce === 0, `${pierce} edge segment(s) pierce a node box`);

// ── labels: on-node (name-text envelope ±14), label-label, on-foreign-line ─
const tw = (s: string) => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 10 : 5.5;
  return w;
};
interface LBox { x: number; y: number; w: number; h: number; idx: number }
const lbs: LBox[] = [];
routed.forEach((e, idx) => {
  if (!e.label) return;
  const d = e.data as { labelPos?: RoutedPoint; labelWrap?: boolean };
  if (!d.labelPos) return;
  const w0 = tw(e.label as string);
  lbs.push({
    x: d.labelPos.x,
    y: d.labelPos.y,
    w: d.labelWrap ? 84 : w0,
    h: d.labelWrap ? 28 : 15,
    idx,
  });
});
let onNode = 0, onLabel = 0, onLine = 0;
lbs.forEach((l) =>
  rects.forEach((r) => {
    if (
      l.x + l.w / 2 > r.x - 14 && l.x - l.w / 2 < r.x + r.w + 14 &&
      l.y + l.h / 2 > r.y && l.y - l.h / 2 < r.y + r.h
    )
      onNode++;
  }),
);
for (let a = 0; a < lbs.length; a++)
  for (let b = a + 1; b < lbs.length; b++)
    if (
      Math.abs(lbs[a].x - lbs[b].x) < (lbs[a].w + lbs[b].w) / 2 &&
      Math.abs(lbs[a].y - lbs[b].y) < (lbs[a].h + lbs[b].h) / 2
    )
      onLabel++;
paths.forEach((p, idx) => {
  for (let i = 0; i + 1 < p.pts.length; i++)
    lbs.forEach((l) => {
      if (l.idx === idx) return;
      if (segHits(p.pts[i], p.pts[i + 1], { x: l.x - l.w / 2, y: l.y - l.h / 2, w: l.w, h: l.h }))
        onLine++;
    });
});
// labels are hidden in the OFF view — gate them only when they render
if (annotations) {
  hard(onNode === 0, `${onNode} label(s) on a node`);
  hard(onLabel === 0, `${onLabel} label pair(s) overlapping`);
}

// ── soft metrics (shared with the layout's multi-start selection) ──────────
const crossings = visualCrossings(routed);
const len = routedLength(routed);
const xs = placed.map((n) => n.position.x);
const xe = placed.map((n) => n.position.x + (n.width ?? 88));
const ys = placed.map((n) => n.position.y);
const ye = placed.map((n) => n.position.y + (n.height ?? 82));
const W = Math.max(...xe) - Math.min(...xs);
const H = Math.max(...ye) - Math.min(...ys);

console.log(`manifest: ${file}  (annotations ${annotations ? "ON" : "OFF"})`);
console.log(`hard gates: geometry/piercing/labels → ${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
console.log(`soft: visual crossings=${crossings}  label-on-line=${onLine}  length=${Math.round(len)}  canvas=${Math.round(W)}x${Math.round(H)} (${(W / H).toFixed(2)})`);
process.exit(fail === 0 ? 0 : 1);
