/** Куда уходит время сборки. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { nearestRoad } from '../src/world/world.ts';

const scene = process.argv[2] ?? 'каша';
const world = buildWorld(SCENES[scene], 'plateau');
let t = performance.now();
const s = buildSurface(world);
console.log(`сборка целиком: ${(performance.now() - t).toFixed(0)} мс, вершин ${s.stats.vertices}, треуг. ${s.stats.triangles}`);

const n = s.stats.vertices;
t = performance.now();
for (let i = 0; i < n; i++) nearestRoad(world, (i % 200) - 100, ((i * 7) % 200) - 100);
const ms = performance.now() - t;
const segments = world.shapes.reduce((a, sh) => a + sh.stations.length, 0);
console.log(`${n} раз nearestRoad: ${ms.toFixed(0)} мс  (станций всего ${segments})`);
