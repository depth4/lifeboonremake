/**
 * Проверка мира без браузера.
 * Запускается в терминале, видеокарта не нужна. Если это перестанет работать —
 * значит мир зашит в картинку, и дверь в мультиплеер закрылась.
 *
 * Запуск: npm run check        — обычная проверка
 *         npm run check break  — заведомо сломанный случай, проверка обязана упасть
 */

import { DEMO_ROADS } from '../src/demo.ts';
import { MAX_GRADE, buildWorld } from '../src/world/world.ts';
import { TERRAINS, WORLD_HALF } from '../src/world/terrain.ts';
import { buildSurface } from '../src/surface.ts';

const broken = process.argv.includes('break');
const failures: string[] = [];

const mm = (v: number): number => Math.round(v * 1000);
const onBorder = (x: number, z: number): boolean =>
  Math.abs(Math.abs(x) - WORLD_HALF) < 0.001 || Math.abs(Math.abs(z) - WORLD_HALF) < 0.001;

for (const name of Object.keys(TERRAINS)) {
  const world = buildWorld(DEMO_ROADS, name);
  const surface = buildSurface(world, { detachRoad: broken });
  const pos = surface.positions;
  const idx = surface.indices;

  // --- 1. Земля и дорога должны делить вершины: это одна поверхность, а не две
  const road = new Set<number>();
  const grass = new Set<number>();
  for (const g of surface.groups) {
    const target = g.material === 'grass' ? grass : road;
    for (let i = g.start; i < g.start + g.count; i++) target.add(idx[i]);
  }
  const shared = [...road].filter((v) => grass.has(v)).length;

  // --- 2. Швов быть не должно: каждое внутреннее ребро принадлежит ровно
  // двум треугольникам. Считаем по ПОЛОЖЕНИЮ, а не по номеру вершины —
  // тогда две вершины в одной точке (честный излом бордюра) проверке не мешают,
  // а настоящая щель по-прежнему видна.
  const edges = new Map<string, number>();
  const keyOf = (v: number): string => `${mm(pos[v * 3])},${mm(pos[v * 3 + 1])},${mm(pos[v * 3 + 2])}`;

  for (let t = 0; t < idx.length; t += 3) {
    const k = [keyOf(idx[t]), keyOf(idx[t + 1]), keyOf(idx[t + 2])];
    for (let e = 0; e < 3; e++) {
      const pair = [k[e], k[(e + 1) % 3]].sort().join('|');
      edges.set(pair, (edges.get(pair) ?? 0) + 1);
    }
  }

  let cracks = 0;
  for (const [pair, count] of edges) {
    if (count === 2) continue;
    const [a] = pair.split('|');
    const [ax, , az] = a.split(',').map((v) => Number(v) / 1000);
    const [b] = pair.split('|').slice(1);
    const [bx, , bz] = b.split(',').map((v) => Number(v) / 1000);
    if (count === 1 && onBorder(ax, az) && onBorder(bx, bz)) continue; // край мира — это нормально
    cracks++;
  }

  const grade = (world.grade * 100).toFixed(1);
  console.log(
    `${name.padEnd(9)} вершин ${String(surface.stats.vertices).padStart(6)}` +
    `  треугольников ${String(surface.stats.triangles).padStart(6)}` +
    `  общих вершин ${String(shared).padStart(4)}` +
    `  щелей ${String(cracks).padStart(4)}` +
    `  уклон ${grade.padStart(5)}%`,
  );

  if (shared === 0) failures.push(`${name}: земля и дорога не имеют общих вершин — это ДВЕ поверхности, а не одна`);
  if (cracks > 0) failures.push(`${name}: ${cracks} рёбер не сшиты — по ним пойдёт щель`);
  if (name !== 'mountain' && world.grade > MAX_GRADE + 0.001) {
    failures.push(`${name}: дорога круче предела — ${grade}% при допустимых ${(MAX_GRADE * 100).toFixed(0)}%`);
  }
}

if (failures.length > 0) {
  console.log('\nПРОВЕРКА УПАЛА:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✓ поверхность одна, щелей нет, уклоны в норме');
