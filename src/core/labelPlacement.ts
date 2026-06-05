import type { RoutedPoint } from "./routeEdges";

/**
 * Edge-label placement for routed architecture edges — the annotation-layout
 * half of the edge pipeline (routeEdges owns the geometric half).
 *
 * Pipeline: anchor each label on the longest segment its edge owns ALONE
 * (trunk-shared segments would stack sibling labels onto one midpoint) →
 * fan out overlap clusters vertically → dodge anything still colliding with
 * nodes, other labels, or foreign edge lines.
 */

export interface LabelItem {
  /** Edge index in the router's plan/paths arrays. */
  i: number;
  text: string;
  pts: RoutedPoint[];
}

export interface PlacedLabel {
  x: number;
  y: number;
  /** Mirrors RoutedEdge's CSS: true → two 13px lines at LBL_MAX width. */
  wrap: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Wrap threshold (px) — mirrors maxWidth in RoutedEdge's label style. */
const LBL_MAX = 84;
/** Node name text overflows the node rect by this much per side (CSS
 *  max-width 116 vs box 88) — labels must clear the envelope, not the box. */
const NAME_OVERFLOW = 14;

/** Hangul ~10px, Latin ~5.5px at the 10px/600 label font. */
const textW = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 10 : 5.5;
  return w;
};

export function placeLabels(
  items: LabelItem[],
  allPaths: RoutedPoint[][],
  nodeRects: Rect[],
  /** True when a segment is shared with same-trunk siblings. */
  segShared: (a: RoutedPoint, b: RoutedPoint) => boolean,
): Map<number, PlacedLabel> {
  interface LB {
    i: number;
    x: number;
    y: number;
    w: number;
    h: number;
    wrap: boolean;
  }

  // ── anchor + wrap decision ────────────────────────────────────────────
  const labels: LB[] = [];
  for (const { i, text, pts } of items) {
    if (pts.length < 2) continue;
    let best = 0;
    let bi = 0;
    for (const privateOnly of [true, false]) {
      for (let s = 0; s + 1 < pts.length; s++) {
        if (privateOnly && segShared(pts[s], pts[s + 1])) continue;
        const len =
          Math.abs(pts[s + 1].x - pts[s].x) + Math.abs(pts[s + 1].y - pts[s].y);
        if (len > best) {
          best = len;
          bi = s;
        }
      }
      if (best > 0) break; // private segment found; no fallback needed
    }
    const tw = textW(text);
    // don't wrap for a one-character orphan second line — keep one slightly
    // wider line instead (≈ one Hangul glyph of tolerance)
    const wrap = tw > LBL_MAX + 11;
    labels.push({
      i,
      x: (pts[bi].x + pts[bi + 1].x) / 2,
      y: (pts[bi].y + pts[bi + 1].y) / 2,
      w: wrap ? LBL_MAX : tw,
      h: wrap ? 28 : 15,
      wrap,
    });
  }

  // ── fan out overlap clusters vertically (tiny union-find) ────────────
  const collide = (a: LB, b: LB) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 8 &&
    Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 4;
  const parent = labels.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let a = 0; a < labels.length; a++)
    for (let b = a + 1; b < labels.length; b++)
      if (collide(labels[a], labels[b])) parent[find(a)] = find(b);
  const clusters = new Map<number, LB[]>();
  labels.forEach((l, i) => {
    const r = find(i);
    clusters.set(r, [...(clusters.get(r) ?? []), l]);
  });
  const pos = new Map<number, PlacedLabel>();
  clusters.forEach((ls) => {
    if (ls.length === 1) {
      pos.set(ls[0].i, { x: ls[0].x, y: ls[0].y, wrap: ls[0].wrap });
      return;
    }
    // stack with per-label heights (wrapped labels are taller)
    const mean = ls.reduce((a, l) => a + l.y, 0) / ls.length;
    ls.sort((a, b) => a.y - b.y || a.x - b.x);
    const total = ls.reduce((a, l) => a + l.h, 0);
    let cursor = mean - total / 2;
    ls.forEach((l) => {
      pos.set(l.i, { x: l.x, y: cursor + l.h / 2, wrap: l.wrap });
      cursor += l.h;
    });
  });

  // ── unified dodge: nodes (3) > labels (2) > foreign lines (1) ─────────
  // Each label tries sliding along its own segment and perpendicular to it;
  // the first violation-free spot wins, otherwise the least-bad one.
  const violations = (self: number, x: number, y: number, w: number, h: number): number => {
    let v = 0;
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
    for (const r of nodeRects) {
      if (
        x1 > r.x - NAME_OVERFLOW && x0 < r.x + r.w + NAME_OVERFLOW &&
        y1 > r.y && y0 < r.y + r.h
      )
        v += 3;
    }
    for (const o of labels) {
      if (o.i === self) continue;
      const p = pos.get(o.i)!;
      if (Math.abs(x - p.x) < (w + o.w) / 2 + 6 && Math.abs(y - p.y) < (h + o.h) / 2 + 4)
        v += 2;
    }
    for (let ei = 0; ei < allPaths.length; ei++) {
      if (ei === self || !allPaths[ei]) continue;
      const pts = allPaths[ei];
      for (let s = 0; s + 1 < pts.length; s++) {
        const [a, b] = [pts[s], pts[s + 1]];
        if (a.y === b.y) {
          const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
          if (a.y > y0 && a.y < y1 && hi > x0 && lo < x1) v += 1;
        } else if (a.x === b.x) {
          const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
          if (a.x > x0 && a.x < x1 && hi > y0 && lo < y1) v += 1;
        }
      }
    }
    return v;
  };
  labels.forEach((l) => {
    const p = pos.get(l.i)!;
    if (violations(l.i, p.x, p.y, l.w, l.h) === 0) return;
    // own-segment axis: slide stays beside the line it annotates
    const pts = allPaths[l.i];
    let horiz = true;
    for (let s = 0; s + 1 < pts.length; s++) {
      const mx = (pts[s].x + pts[s + 1].x) / 2;
      const my = (pts[s].y + pts[s + 1].y) / 2;
      if (Math.abs(mx - l.x) < 1 && Math.abs(my - l.y) < 1) {
        horiz = pts[s].y === pts[s + 1].y;
        break;
      }
    }
    let best = { x: p.x, y: p.y, v: violations(l.i, p.x, p.y, l.w, l.h) };
    // wide radius: real-world labels (merged bidirectional ones especially)
    // are big boxes that need to travel further to find an open pocket
    outer: for (const perp of [0, 13, -13, 24, -24, 36, -36, 48, -48]) {
      for (const along of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100]) {
        const nx = p.x + (horiz ? along : perp);
        const ny = p.y + (horiz ? perp : along);
        const v = violations(l.i, nx, ny, l.w, l.h);
        if (v < best.v) best = { x: nx, y: ny, v };
        if (v === 0) break outer;
      }
    }
    pos.set(l.i, { x: best.x, y: best.y, wrap: l.wrap });
  });

  return pos;
}
