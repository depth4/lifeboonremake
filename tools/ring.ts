/** Что за кольца областей проходят рядом с точкой. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { plan } from '../src/surface/carve.ts';

const world = buildWorld(SCENES[process.argv[2] ?? 'каша'], 'plateau');
const near = { x: Number(process.argv[3] ?? -17.3), z: Number(process.argv[4] ?? -56.2) };
const regions = plan(world) as unknown as Record<string, { x: number; z: number }[][]>;

for (const [name, region] of Object.entries(regions)) {
  region.forEach((ring, i) => {
    let close = Infinity;
    for (const p of ring) close = Math.min(close, Math.hypot(p.x - near.x, p.z - near.z));
    if (close > 4) return;
    let area = 0;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      area += a.x * b.z - b.x * a.z;
    }
    let minEdge = Infinity, maxEdge = 0;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      minEdge = Math.min(minEdge, d);
      maxEdge = Math.max(maxEdge, d);
    }
    console.log(
      `${name} кольцо ${i}: точек ${ring.length}, площадь ${(area / 2).toFixed(3)} м², ` +
      `рёбра ${minEdge.toFixed(3)}…${maxEdge.toFixed(2)} м, ближайшая точка ${close.toFixed(2)} м`,
    );
    if (ring.length <= 8) console.log('   ' + ring.map((p) => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' '));
  });
}
