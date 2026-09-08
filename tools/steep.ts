/** Самые крутые треугольники по материалам: тротуар не имеет права быть крутым. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { layout } from './fuzz.ts';

const name = process.argv[2] ?? 'крест';
const seeded = name === 'зерно' ? layout(Number(process.argv[3])) : null;
const world = seeded
  ? buildWorld(seeded.roads, seeded.terrain)
  : buildWorld(SCENES[name], process.argv[3] ?? 'hills');
const s = buildSurface(world);
const P = s.positions, I = s.indices;
const worst = new Map<string, { slope: number; at: string }>();

for (const g of s.groups) {
  for (let t = g.start; t < g.start + g.count; t += 3) {
    const p = [I[t], I[t + 1], I[t + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) continue;
    const rise = Math.max(p[0][1], p[1][1], p[2][1]) - Math.min(p[0][1], p[1][1], p[2][1]);
    if (rise < 0.05) continue;
    const slope = Math.hypot(n[0], n[2]) / Math.abs(n[1] || 1e-9);
    const seen = worst.get(g.material);
    if (!seen || slope > seen.slope) {
      worst.set(g.material, { slope, at: `(${p[0][0].toFixed(1)}, ${p[0][2].toFixed(1)}) высоты ${p.map((q) => q[1].toFixed(2)).join(' / ')}` });
    }
  }
}
for (const [m, w] of worst) {
  console.log(`${m.padEnd(9)} самый крутой ${(w.slope * 100).toFixed(0).padStart(6)}%   ${w.at}`);
}
