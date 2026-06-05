import type { Edge } from "@xyflow/react";
import type { RoutedPoint } from "./routeEdges";

/** Soft quality metrics over routed architecture edges — shared by the
 *  layout's multi-start selection and scripts/metrics.mts, so the number a
 *  start is picked by IS the number the gates report. */

interface Path {
  s: string;
  pts: RoutedPoint[];
}

const pathsOf = (routed: Edge[]): Path[] =>
  routed.map((e) => ({
    s: e.source,
    pts: (e.data as { points: RoutedPoint[] }).points,
  }));

const segs = (p: Path): [RoutedPoint, RoutedPoint][] => {
  const o: [RoutedPoint, RoutedPoint][] = [];
  for (let i = 0; i + 1 < p.pts.length; i++) o.push([p.pts[i], p.pts[i + 1]]);
  return o;
};

/** Visual bundle crossings: orthogonal segment intersections deduped per
 *  source pair and ~40px cell; same-source path pairs are skipped (one trunk
 *  visually — sharing is by design). */
export function visualCrossings(routed: Edge[]): number {
  const paths = pathsOf(routed);
  const cross = new Set<string>();
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[i].s === paths[j].s) continue; // same trunk shares by design
      for (const [a1, a2] of segs(paths[i]))
        for (const [b1, b2] of segs(paths[j])) {
          const aH = a1.y === a2.y, bH = b1.y === b2.y;
          if (aH === bH) continue;
          const [h1, , v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
          const [hx0, hx1] = aH
            ? [Math.min(a1.x, a2.x), Math.max(a1.x, a2.x)]
            : [Math.min(b1.x, b2.x), Math.max(b1.x, b2.x)];
          const [vy0, vy1] = [Math.min(v1.y, v2.y), Math.max(v1.y, v2.y)];
          if (v1.x > hx0 && v1.x < hx1 && h1.y > vy0 && h1.y < vy1)
            cross.add(
              [paths[i].s, paths[j].s].sort().join("::") +
                "@" + Math.round(v1.x / 40) + "," + Math.round(h1.y / 40),
            );
        }
    }
  return cross.size;
}

/** Total Manhattan length of all routed paths. */
export function routedLength(routed: Edge[]): number {
  return pathsOf(routed).reduce((a, p) => {
    let l = 0;
    for (let i = 0; i + 1 < p.pts.length; i++)
      l += Math.abs(p.pts[i + 1].x - p.pts[i].x) + Math.abs(p.pts[i + 1].y - p.pts[i].y);
    return a + l;
  }, 0);
}
