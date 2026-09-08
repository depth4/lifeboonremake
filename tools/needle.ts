/** Самые вытянутые треугольники: где они и из чего сделаны. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { layout } from './fuzz.ts';

// либо имя сцены, либо `зерно 27` — постройка из обстрела
const scene = process.argv[2] ?? 'бритва';
const seeded = scene === 'зерно' ? layout(Number(process.argv[3])) : null;
const world = seeded
  ? buildWorld(seeded.roads, seeded.terrain)
  : buildWorld(SCENES[scene], process.argv[3] ?? 'plateau');
const s = buildSurface(world);
const P = s.positions, I = s.indices;
const material = new Map<number, string>();
for (const g of s.groups) for (let i = g.start; i < g.start + g.count; i += 3) material.set(i, g.material);

const rows: { aspect: number; at: string; m: string; sides: string }[] = [];
for (let t = 0; t < I.length; t += 3) {
  const p = [I[t], I[t + 1], I[t + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
  const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-12) continue;
  const sides = [Math.hypot(...u), Math.hypot(...v), Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2])];
  const longest = Math.max(...sides);
  const h = len / longest;
  if (h < 1e-12) continue;
  rows.push({
    aspect: longest / h,
    at: p.map((q) => `(${q[0].toFixed(2)},${q[2].toFixed(2)})`).join(' '),
    m: material.get(t) ?? '?',
    sides: sides.map((x) => x.toFixed(4)).join(' / '),
  });
}
rows.sort((a, b) => b.aspect - a.aspect);
for (const r of rows.slice(0, 8)) console.log(`${r.aspect.toFixed(0).padStart(8)}  ${r.m.padEnd(9)} ${r.at}`);
