/**
 * Проверка мира без браузера.
 * Запускается в терминале, видеокарта не нужна. Если это перестанет работать —
 * значит мир зашит в картинку, и дверь в мультиплеер закрылась.
 *
 * Запуск: npm run check        — обычная проверка
 *         npm run check break  — заведомо сломанный случай, проверка обязана упасть
 */

import { ROAD_TYPES } from '../src/world/road.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface.ts';
import { DEMO_ROADS } from '../src/demo.ts';

const broken = process.argv.includes('break');

const world = buildWorld(DEMO_ROADS);
const surface = buildSurface(world, { detachRoad: broken });

console.log(`мир: дорог ${world.shapes.length}, тип «${ROAD_TYPES.street2.name}»`);
console.log(`поверхность: вершин ${surface.stats.vertices}, треугольников ${surface.stats.triangles}`);

/** Кто из треугольников какой материал использует — по каждой вершине. */
const road = new Set<number>();
const grass = new Set<number>();
for (const g of surface.groups) {
  const target = g.material === 'grass' ? grass : road;
  for (let i = g.start; i < g.start + g.count; i++) target.add(surface.indices[i]);
}

const shared = [...road].filter((v) => grass.has(v)).length;
console.log(`общих вершин у земли и дороги: ${shared}`);

const failures: string[] = [];
if (shared === 0) failures.push('земля и дорога не имеют ни одной общей вершины — это ДВЕ поверхности, а не одна');

/** Две вершины почти в одной точке — признак шва, вдоль которого поедет щель. */
const seen = new Map<string, number>();
let doubles = 0;
for (let v = 0; v < surface.stats.vertices; v++) {
  const key = [0, 1, 2].map((k) => Math.round(surface.positions[v * 3 + k] * 1000)).join(',');
  const prev = seen.get(key);
  if (prev !== undefined) doubles++;
  else seen.set(key, v);
}
console.log(`вершин-двойников (шов): ${doubles}`);
if (doubles > 0) failures.push(`${doubles} вершин лежат друг на друге — вдоль шва появится щель`);

if (failures.length > 0) {
  console.log('\nПРОВЕРКА УПАЛА:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✓ поверхность одна, швов нет');
