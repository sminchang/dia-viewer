import type { RoutedPoint } from "./routeFlowEdges";

/**
 * Edge-label placement for routed FLOWCHART edges — flow-owned copy of the
 * architecture pipeline's labelPlacement.ts. Forked deliberately: condition
 * labels are first-class in flowcharts (annotations default ON), and label
 * policy here must be editable without touching the architecture view.
 *
 * Pipeline: anchor each label on the DESTINATION side (~70%) of the polyline
 * portion its edge owns ALONE (trunk-shared segments hold sibling lines; the
 * head side of a branch is the visually busiest — split bends, sibling fans) →
 * SLIDE an ambiguous label along its own private polyline, tailward-first,
 * until the spot is clean → fan out remaining overlap clusters vertically →
 * dodge anything still colliding with nodes, other labels, or foreign lines.
 *
 * The slide pass is the attribution rule: a label must sit ON its own line,
 * and when the preferred midpoint is ambiguous (another label or a foreign
 * line inside the box) it moves ALONG that line — never off it — so fan
 * labels that cluster at a split walk down their own diverging branches and
 * separate, while staying visually glued to the path they describe.
 */

export interface LabelItem {
  /** Unique key into the result map. */
  i: number;
  /** Index into allPaths of the edge this label belongs to (defaults to i).
   *  Merged multi-condition edges share one path across several items. */
  pathIdx?: number;
  text: string;
  pts: RoutedPoint[];
  /** Pre-set anchor — merged multi-condition labels sit BESIDE the line by
   *  design (perpendicular split). Skips the setback anchor and the slide
   *  pass; collision passes (cluster, dodge) still apply. */
  fixedAnchor?: RoutedPoint;
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

/** Wrap threshold (px) — mirrors WRAP_MAX in FlowRoutedEdge's label style
 *  (12px documentation-grade type; flowcharts ship with annotations ON). */
const LBL_MAX = 104;
/** Anchor setback from the arrival port (px), measured along the edge's
 *  private run — a FIXED distance so labels sit at a uniform offset from
 *  their destination regardless of edge length (a ratio drifts: the longer
 *  the edge, the earlier its label). Runs shorter than twice this anchor at
 *  their middle — still past the split, on the edge's own line. */
const LABEL_FROM_END = 64;
/** Node name text overflows the node rect by this much per side (CSS
 *  max-width 116 vs box 88) — labels must clear the envelope, not the box. */
const NAME_OVERFLOW = 14;

/** Hangul ~12px, Latin ~6.6px at the 12px/600 label font. */
const textW = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 12 : 6.6;
  return w;
};

export function placeLabels(
  items: LabelItem[],
  allPaths: RoutedPoint[][],
  nodeRects: Rect[],
  /** True when a segment is shared with same-trunk siblings. */
  segShared: (a: RoutedPoint, b: RoutedPoint) => boolean,
  /** Labels of FROZEN edges (incremental re-route) — immovable obstacles, so
   *  a re-placed label never lands on a kept one. */
  frozenLabels?: { x: number; y: number; text: string; wrap: boolean }[],
): Map<number, PlacedLabel> {
  const frozen = (frozenLabels ?? []).map((f) => ({
    x: f.x,
    y: f.y,
    w: Math.min(textW(f.text), LBL_MAX),
    h: f.wrap ? 34 : 18,
  }));
  interface LB {
    i: number;
    pathIdx: number;
    fixed: boolean;
    x: number;
    y: number;
    w: number;
    h: number;
    wrap: boolean;
  }

  // ── anchor + wrap decision ────────────────────────────────────────────
  const labels: LB[] = [];
  for (const { i, text, pts, pathIdx, fixedAnchor } of items) {
    if (pts.length < 2) continue;
    const pi = pathIdx ?? i;
    const tw = textW(text);
    // don't wrap for a one-character orphan second line — keep one slightly
    // wider line instead (≈ one Hangul glyph of tolerance)
    const wrap = tw > LBL_MAX + 11;
    const w = wrap ? LBL_MAX : tw;
    const h = wrap ? 34 : 18; // 2 × 16px lines / 1 line + breathing room

    if (fixedAnchor) {
      labels.push({ i, pathIdx: pi, fixed: true, x: fixedAnchor.x, y: fixedAnchor.y, w, h, wrap });
      continue;
    }

    // candidate segments: private first (shared-trunk parts hold sibling
    // lines by construction); all segments as fallback
    let segs: number[] = [];
    for (const privateOnly of [true, false]) {
      segs = [];
      for (let s = 0; s + 1 < pts.length; s++)
        if (!privateOnly || !segShared(pts[s], pts[s + 1])) segs.push(s);
      if (segs.length) break;
    }
    const segLen = (s: number) =>
      Math.abs(pts[s + 1].x - pts[s].x) + Math.abs(pts[s + 1].y - pts[s].y);
    const insetOf = (s: number) => {
      const horiz = pts[s].y === pts[s + 1].y;
      return (horiz ? w : h) / 2 + (s + 2 === pts.length ? 18 : 6);
    };

    // Anchor LABEL_FROM_END px before the arrival along the private run,
    // snapped into a segment that can hold the box — tailward neighbors
    // first, then headward; last resort = longest segment midpoint.
    const total = segs.reduce((a, s) => a + segLen(s), 0);
    const want = Math.max(total / 2, total - LABEL_FROM_END);
    let segIdx = segs[segs.length - 1];
    let tIn = 0;
    let acc = 0;
    for (const s of segs) {
      const len = segLen(s);
      if (want <= acc + len) {
        segIdx = s;
        tIn = want - acc;
        break;
      }
      acc += len;
    }
    const at = segs.indexOf(segIdx);
    const order = [...segs.slice(at), ...segs.slice(0, at).reverse()];
    let ax: number | null = null;
    let ay = 0;
    for (const s of order) {
      const len = segLen(s);
      const inset = insetOf(s);
      if (len < inset * 2) continue;
      // containing segment: clamp the 70% point; tailward neighbor: enter at
      // its head end; headward neighbor: at its tail end (closest to `want`)
      const t =
        s === segIdx
          ? Math.min(Math.max(tIn, inset), len - inset)
          : s > segIdx
            ? inset
            : len - inset;
      const horiz = pts[s].y === pts[s + 1].y;
      const dir = horiz
        ? Math.sign(pts[s + 1].x - pts[s].x)
        : Math.sign(pts[s + 1].y - pts[s].y);
      ax = horiz ? pts[s].x + dir * t : pts[s].x;
      ay = horiz ? pts[s].y : pts[s].y + dir * t;
      break;
    }
    if (ax === null) {
      // no segment fits the box — longest segment midpoint (legacy)
      let best = 0;
      let bi = segs[0] ?? 0;
      for (const s of segs)
        if (segLen(s) > best) {
          best = segLen(s);
          bi = s;
        }
      ax = (pts[bi].x + pts[bi + 1].x) / 2;
      ay = (pts[bi].y + pts[bi + 1].y) / 2;
    }
    labels.push({ i, pathIdx: pi, fixed: false, x: ax, y: ay, w, h, wrap });
  }

  const pos = new Map<number, PlacedLabel>();
  labels.forEach((l) => pos.set(l.i, { x: l.x, y: l.y, wrap: l.wrap }));
  const pathOfKey = new Map(labels.map((l) => [l.i, l.pathIdx]));

  // ── unified ambiguity score: nodes (3) > labels (2) > foreign lines (1) ──
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
    for (const f of frozen) {
      if (Math.abs(x - f.x) < (w + f.w) / 2 + 6 && Math.abs(y - f.y) < (h + f.h) / 2 + 4)
        v += 2;
    }
    for (let ei = 0; ei < allPaths.length; ei++) {
      if (ei === (pathOfKey.get(self) ?? self) || !allPaths[ei]) continue;
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

  // ── slide pass: move an ambiguous label ALONG its own line ──────────────
  // The attribution rule. Candidates are sampled on the edge's private
  // segments (shared-trunk parts excluded — there the box would sit on
  // sibling lines by construction), ordered nearest-anchor-first with a
  // tailward tie-break: a clean midpoint stays put (principle 1), and a fan
  // label clustered at the split walks down its own diverging branch until
  // it separates — never leaving its line, so ownership stays readable.
  // Two rounds let earlier moves unblock later ones.
  for (let round = 0; round < 2; round++) {
    for (const l of labels) {
      if (l.fixed) continue; // multi-condition labels sit beside the line by design
      const cur = pos.get(l.i)!;
      if (violations(l.i, cur.x, cur.y, l.w, l.h) === 0) continue;
      const pts = allPaths[l.pathIdx];
      const cands: { x: number; y: number; d: number; tail: number }[] = [];
      for (const privateOnly of [true, false]) {
        for (let s = 0; s + 1 < pts.length; s++) {
          if (privateOnly && segShared(pts[s], pts[s + 1])) continue;
          const [a, b] = [pts[s], pts[s + 1]];
          const horiz = a.y === b.y;
          const len = Math.abs(horiz ? b.x - a.x : b.y - a.y);
          // keep the box on the segment: inset by half its extent along the
          // axis, plus arrowhead clearance on the path's final stretch
          const inset = (horiz ? l.w : l.h) / 2 + (s + 2 === pts.length ? 18 : 6);
          if (len < inset * 2) continue;
          const dir = horiz ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
          for (let t = inset; t <= len - inset; t += 16) {
            const cx = horiz ? a.x + dir * t : a.x;
            const cy = horiz ? a.y : a.y + dir * t;
            cands.push({
              x: cx,
              y: cy,
              d: Math.abs(cx - l.x) + Math.abs(cy - l.y),
              tail: s * 1e4 + t,
            });
          }
        }
        if (cands.length) break;
      }
      cands.sort((c1, c2) => c1.d - c2.d || c2.tail - c1.tail);
      for (const c of cands) {
        if (violations(l.i, c.x, c.y, l.w, l.h) === 0) {
          pos.set(l.i, { x: c.x, y: c.y, wrap: l.wrap });
          break;
        }
      }
    }
  }

  // ── fan out remaining overlap clusters vertically (tiny union-find) ─────
  // Fallback for labels the slide could not separate (no clean spot on their
  // own line) — stacking trades attribution for legibility.
  const collide = (a: LB, b: LB) => {
    const pa = pos.get(a.i)!;
    const pb = pos.get(b.i)!;
    return (
      Math.abs(pa.x - pb.x) < (a.w + b.w) / 2 + 8 &&
      Math.abs(pa.y - pb.y) < (a.h + b.h) / 2 + 4
    );
  };
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
  clusters.forEach((ls) => {
    if (ls.length === 1) return; // already placed
    // stack with per-label heights (wrapped labels are taller)
    const mean = ls.reduce((a, l) => a + pos.get(l.i)!.y, 0) / ls.length;
    ls.sort((a, b) => pos.get(a.i)!.y - pos.get(b.i)!.y || pos.get(a.i)!.x - pos.get(b.i)!.x);
    const total = ls.reduce((a, l) => a + l.h, 0);
    let cursor = mean - total / 2;
    ls.forEach((l) => {
      pos.set(l.i, { x: pos.get(l.i)!.x, y: cursor + l.h / 2, wrap: l.wrap });
      cursor += l.h;
    });
  });

  // ── unified dodge: last resort for anything still violating ─────────────
  // Each label tries sliding along its own segment and perpendicular to it;
  // the first violation-free spot wins, otherwise the least-bad one.
  labels.forEach((l) => {
    const p = pos.get(l.i)!;
    if (violations(l.i, p.x, p.y, l.w, l.h) === 0) return;
    // own-segment axis: find the segment the label currently sits on so the
    // slide stays beside the line it annotates
    const pts = allPaths[l.pathIdx];
    let horiz = true;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [a, b] = [pts[s], pts[s + 1]];
      if (a.y === b.y && Math.abs(p.y - a.y) < 8) {
        const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
        if (p.x >= lo - 1 && p.x <= hi + 1) { horiz = true; break; }
      } else if (a.x === b.x && Math.abs(p.x - a.x) < 8) {
        const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
        if (p.y >= lo - 1 && p.y <= hi + 1) { horiz = false; break; }
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
