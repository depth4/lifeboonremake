/**
 * Обстрел сложными случаями: каждая сцена на каждом рельефе.
 *
 * Смотреть на одну красивую сцену бессмысленно — ломается на некрасивых.
 * Здесь цифры, а не картинки: цифры видно все сразу и они не врут.
 *
 * Запуск: npm run scenes            — все сцены на всех рельефах
 *         npm run scenes крест      — только названные сцены
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { TERRAINS } from '../src/world/terrain.ts';
import { buildSurface } from '../src/surface/index.ts';
import { inspect, problems } from './inspect.ts';

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length > 0 ? wanted : Object.keys(SCENES);
const terrains = Object.keys(TERRAINS);

const head = ['сцена', 'рельеф', 'дорог', 'узлов', 'треуг.', 'дырок', 'изнанка', 'плоских', 'игла', 'уклон', 'отрыв', 'мс'];
console.log(head.map((h, i) => h.padEnd([11, 9, 6, 6, 8, 6, 8, 8, 6, 7, 7, 6][i])).join(''));
console.log('─'.repeat(80));

const failures: string[] = [];
let worstTime = 0;

for (const name of names) {
  const roads = SCENES[name];
  if (!roads) {
    console.log(`нет сцены «${name}»`);
    continue;
  }
  for (const terrain of terrains) {
    const started = performance.now();
    let line: string;
    try {
      const world = buildWorld(roads, terrain);
      const surface = buildSurface(world);
      const ms = performance.now() - started;
      worstTime = Math.max(worstTime, ms);
      const r = inspect(world, surface);
      line = [
        name.padEnd(11),
        TERRAINS[terrain].label.padEnd(9),
        String(world.shapes.length).padEnd(6),
        String(world.junctions.length).padEnd(6),
        String(r.triangles).padEnd(8),
        String(r.holes).padEnd(6),
        String(r.downFacing).padEnd(8),
        String(r.flat).padEnd(8),
        r.worstAspect.toFixed(0).padEnd(6),
        `${(r.grade * 100).toFixed(1)}%`.padEnd(7),
        `${r.lift.toFixed(1)}м`.padEnd(7),
        ms.toFixed(0).padEnd(6),
      ].join('');
      for (const p of problems(r)) failures.push(`${name}/${terrain}: ${p}`);
    } catch (error) {
      line = `${name.padEnd(11)}${TERRAINS[terrain].label.padEnd(9)}ПАДЕНИЕ: ${String(error instanceof Error ? error.message : error).slice(0, 60)}`;
      failures.push(`${name}/${terrain}: падение — ${String(error instanceof Error ? error.message : error).slice(0, 70)}`);
    }
    console.log(line);
  }
}

console.log('─'.repeat(80));
console.log(`самая долгая сборка: ${worstTime.toFixed(0)} мс`);
if (failures.length > 0) {
  console.log(`\nПОЛОМОК: ${failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ все сцены целы');
