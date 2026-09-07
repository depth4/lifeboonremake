/** Где именно поверхность не сшита: координаты и соседи незашитых рёбер. */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';

const scene = process.argv[2] ?? 'вилка';
const world = buildWorld(SCENES[scene], 'plateau');
const surface = buildSurface(world);
const P = surface.positions, I = surface.indices;

const material = new Map<number, string>();
for (const g of surface.groups) {
  for (let i = g.start; i < g.start + g.count; i += 3) material.set(i, g.material);
}
const key = (v: number): string =>
  `${Math.round(P[v * 3] * 1000)},${Math.round(P[v * 3 + 1] * 1000)},${Math.round(P[v * 3 + 2] * 1000)}`;

const edges = new Map<string, { count: number; owners: string[] }>();
for (let t = 0; t < I.length; t += 3) {
  const m = material.get(t) ?? '?';
  const k = [key(I[t]), key(I[t + 1]), key(I[t + 2])];
  for (let e = 0; e < 3; e++) {
    const pair = [k[e], k[(e + 1) % 3]].sort().join('|');
    const rec = edges.get(pair) ?? { count: 0, owners: [] };
    rec.count++;
    rec.owners.push(m);
    edges.set(pair, rec);
  }
}

const BORDER = 120;
const onBorder = (x: number, z: number): boolean =>
  Math.abs(Math.abs(x) - BORDER) < 0.01 || Math.abs(Math.abs(z) - BORDER) < 0.01;

let shown = 0;
for (const [pair, rec] of edges) {
  if (rec.count === 2) continue;
  const ends = pair.split('|').map((s) => s.split(',').map((n) => Number(n) / 1000));
  if (rec.count === 1 && onBorder(ends[0][0], ends[0][2]) && onBorder(ends[1][0], ends[1][2])) continue;
  if (shown++ >= 14) continue;
  const [a, b] = ends;
  console.log(
    `рёбер ${rec.count}  (${a[0].toFixed(2)}, ${a[1].toFixed(2)}, ${a[2].toFixed(2)}) — ` +
    `(${b[0].toFixed(2)}, ${b[1].toFixed(2)}, ${b[2].toFixed(2)})  у: ${rec.owners.join(', ')}`,
  );
}
console.log(`всего незашитых: ${shown}`);
