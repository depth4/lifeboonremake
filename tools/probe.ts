/** Из чего сделана поверхность в конкретных точках: асфальт, тротуар, трава. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';

const world = buildWorld(SCENES[process.argv[2] ?? 'крест'], 'plateau');
const s = buildSurface(world);
const P = s.positions, I = s.indices;
const material: string[] = [];
for (const g of s.groups) for (let i = g.start; i < g.start + g.count; i += 3) material[i / 3] = g.material;

/** Какой треугольник накрывает точку (по проекции сверху). */
const at = (x: number, z: number): string => {
  for (let t = 0; t < I.length; t += 3) {
    const p = [I[t], I[t + 1], I[t + 2]].map((v) => [P[v * 3], P[v * 3 + 2]]);
    const s1 = (p[1][0] - p[0][0]) * (z - p[0][1]) - (p[1][1] - p[0][1]) * (x - p[0][0]);
    const s2 = (p[2][0] - p[1][0]) * (z - p[1][1]) - (p[2][1] - p[1][1]) * (x - p[1][0]);
    const s3 = (p[0][0] - p[2][0]) * (z - p[2][1]) - (p[0][1] - p[2][1]) * (x - p[2][0]);
    const neg = s1 < 0 || s2 < 0 || s3 < 0;
    const pos = s1 > 0 || s2 > 0 || s3 > 0;
    if (!(neg && pos)) return material[t / 3];
  }
  return 'ничего';
};

for (const shape of world.shapes.slice(0, 4)) {
  const st = shape.stations[Math.floor(shape.stations.length / 2)];
  console.log(`дорога полуширина ${shape.halfWidth.toFixed(2)} внешняя ${shape.outerHalf.toFixed(2)} в точке (${st.x.toFixed(0)}, ${st.z.toFixed(0)})`);
  for (const k of [0, 0.9, 1.05, 1.3, 1.6, 1.9, 2.5]) {
    const off = shape.halfWidth * k;
    const x = st.x + st.nx * off, z = st.z + st.nz * off;
    console.log(`   ${(off).toFixed(2).padStart(6)} м от оси: ${at(x, z)}`);
  }
}
