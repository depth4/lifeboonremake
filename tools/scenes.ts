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
import { DEFAULT_VARIANT, VARIANTS, buildSurface, pokeThrough } from '../src/surface/index.ts';
import { inspect, problems } from './inspect.ts';

const args = process.argv.slice(2);
const variant = args.find((a) => VARIANTS[a.toUpperCase()] !== undefined)?.toUpperCase() ?? DEFAULT_VARIANT;
const wanted = args.filter((a) => SCENES[a] !== undefined);
const names = wanted.length > 0 ? wanted : Object.keys(SCENES);
const terrains = Object.keys(TERRAINS);

console.log(`вариант ${VARIANTS[variant].label}\n`);

const head = ['сцена', 'рельеф', 'дорог', 'узлов', 'треуг.', 'дырок', 'изнанка', 'плоских', 'игла', 'торчит', 'уклон', 'мс'];
console.log(head.map((h, i) => h.padEnd([11, 9, 6, 6, 8, 7, 8, 8, 6, 8, 7, 6][i])).join(''));
console.log('─'.repeat(87));

const failures: string[] = [];
let worstTime = 0;
let worstPoke = 0;

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
      const surface = buildSurface(world, variant);
      const ms = performance.now() - started;
      worstTime = Math.max(worstTime, ms);
      const r = inspect(world, surface);
      const poke = variant === 'B' ? pokeThrough(world) : { worst: 0, share: 0 };
      worstPoke = Math.max(worstPoke, poke.worst);
      line = [
        name.padEnd(11),
        TERRAINS[terrain].label.padEnd(9),
        String(world.shapes.length).padEnd(6),
        String(world.junctions.length).padEnd(6),
        String(r.triangles).padEnd(8),
        String(r.holes).padEnd(7),
        String(r.downFacing).padEnd(8),
        String(r.flat).padEnd(8),
        r.worstAspect.toFixed(0).padEnd(6),
        (poke.worst > 0 ? `${poke.worst.toFixed(2)}м` : '—').padEnd(8),
        `${(r.grade * 100).toFixed(1)}%`.padEnd(7),
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

console.log('─'.repeat(87));
console.log(`самая долгая сборка: ${worstTime.toFixed(0)} мс`);
if (worstPoke > 0) console.log(`земля торчит сквозь асфальт: до ${worstPoke.toFixed(2)} м`);
if (failures.length > 0) {
  console.log(`\nПОЛОМОК: ${failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ все сцены целы');
