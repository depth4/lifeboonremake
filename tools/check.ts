/**
 * Проверка мира без браузера.
 * Запускается в терминале, видеокарта не нужна. Если это перестанет работать —
 * значит мир зашит в картинку, и дверь в мультиплеер закрылась.
 *
 * Запуск: npm run check        — обычная проверка на трёх рельефах
 *         npm run check break  — заведомо сломанный случай, проверка обязана упасть
 *
 * Проверка смотрит на ОДНУ известную постройку. Чтобы искать поломки,
 * до которых мы сами не додумались, есть `npm run fuzz`.
 */

import type { Surface } from '../src/surface/index.ts';
import { DEMO_ROADS } from '../src/demo.ts';
import { buildWorld } from '../src/world/world.ts';
import { TERRAINS } from '../src/world/terrain.ts';
import { buildSurface } from '../src/surface/index.ts';
import { inspect, problems } from './inspect.ts';

/**
 * Заведомая поломка: выкидываем бордюрные стенки. Тогда проезжая часть и
 * тротуар перестают быть сшиты между собой, и вдоль всей дороги открывается
 * щель. Если осмотр этого НЕ заметит — сломан осмотр, а не мир.
 */
function withoutCurb(surface: Surface): Surface {
  const keep = surface.groups.filter((g) => g.material !== 'curb');
  const indices: number[] = [];
  const groups = keep.map((g) => {
    const start = indices.length;
    for (let i = g.start; i < g.start + g.count; i++) indices.push(surface.indices[i]);
    return { material: g.material, start, count: g.count };
  });
  return {
    positions: surface.positions,
    indices: new Uint32Array(indices),
    groups,
    stats: { vertices: surface.stats.vertices, triangles: indices.length / 3 },
  };
}

const broken = process.argv.includes('break');
const failures: string[] = [];

for (const name of Object.keys(TERRAINS)) {
  const world = buildWorld(DEMO_ROADS, name);
  const surface = broken ? withoutCurb(buildSurface(world)) : buildSurface(world);
  const r = inspect(world, surface);

  console.log(
    `${name.padEnd(9)} вершин ${String(r.vertices).padStart(6)}` +
    `  треугольников ${String(r.triangles).padStart(6)}` +
    `  общих ${String(r.shared).padStart(4)}` +
    `  дырок ${String(r.holes).padStart(4)}` +
    `  изнанкой вверх ${String(r.downFacing).padStart(4)}` +
    `  уклон ${(r.grade * 100).toFixed(1).padStart(5)}%` +
    `  отрыв ${r.lift.toFixed(1).padStart(5)} м`,
  );

  for (const p of problems(r)) failures.push(`${name}: ${p}`);
}

if (failures.length > 0) {
  console.log('\nПРОВЕРКА УПАЛА:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✓ поверхность одна, дырок нет, уклоны в норме');
