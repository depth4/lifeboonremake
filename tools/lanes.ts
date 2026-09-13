/**
 * Проверка сети движения без браузера.
 *
 * Смотрит на то, чего на картинке не видно: есть ли полосы, ведущие в никуда,
 * не разошлась ли связь с полосами, которые соединяет, и сколько на каждом
 * перекрёстке мест, где машины мешают друг другу.
 *
 * Запуск: npm run lanes           — все сцены
 *         npm run lanes крест     — только названные
 *         npm run lanes break     — заведомо сломанный случай: выключаем
 *                                   поворот налево. Проверка ОБЯЗАНА упасть,
 *                                   иначе ей нельзя верить (правило 11).
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildTraffic, deadEnds, worstGap } from '../src/world/lanes.ts';
import type { Turn } from '../src/world/lanes.ts';
import { badPairs, buildRules, greenOnGreen, unresolved } from '../src/world/rules.ts';

const args = process.argv.slice(2);
const broken = args.includes('break');
const wanted = args.filter((a) => SCENES[a] !== undefined);
const names = wanted.length > 0 ? wanted : Object.keys(SCENES);

if (broken) console.log('ЗАВЕДОМО СЛОМАННЫЙ СЛУЧАЙ: поворот налево выключен\n');

const head = ['сцена', 'полос', 'связей', 'прямо', 'налево', 'направо', 'разв.', 'помех', 'нераз-', 'светоф.', 'фаз', 'тупиков', 'зазор'];
const width = [12, 7, 8, 7, 8, 9, 7, 7, 8, 9, 5, 9, 7];
console.log(head.map((h, i) => h.padEnd(width[i])).join(''));
console.log('─'.repeat(103));

const failures: string[] = [];

for (const name of names) {
  const roads = SCENES[name];
  if (!roads) continue;
  const world = buildWorld(roads, 'hills');
  const traffic = buildTraffic(world, { noLeft: broken });
  const stuck = deadEnds(world, traffic);
  const gap = worstGap(traffic);

  const rules = buildRules(world, traffic);
  const open = unresolved(traffic, rules);
  const both = badPairs(rules);
  const lobbed = greenOnGreen(traffic, rules);
  const phases = rules.signals.reduce((m, s) => Math.max(m, s.phases.length), 0);

  const count = (turn: Turn): number => traffic.links.filter((l) => l.turn === turn).length;

  console.log([
    name.padEnd(12),
    String(traffic.lanes.length).padEnd(7),
    String(traffic.links.length).padEnd(8),
    String(count('прямо')).padEnd(7),
    String(count('налево')).padEnd(8),
    String(count('направо')).padEnd(9),
    String(count('разворот')).padEnd(7),
    String(traffic.conflicts.length).padEnd(7),
    String(open.length).padEnd(8),
    String(rules.signals.length).padEnd(9),
    String(phases || '—').padEnd(5),
    String(stuck.length).padEnd(9),
    gap.toFixed(3).padEnd(7),
  ].join(''));

  // --- правила ---
  if (open.length > 0) {
    failures.push(
      `${name}: ${open.length} помех никто не разрешил — например связи ` +
      `${open[0].a} и ${open[0].b} поедут вдвоём`,
    );
  }
  for (const p of both) failures.push(`${name}: связи ${p.a} и ${p.b} уступают друг другу — встанут намертво`);
  for (const g of lobbed) failures.push(`${name}: ${g.phase} пускает связи ${g.a} и ${g.b} в лоб`);
  for (const signal of rules.signals) {
    if (signal.phases.length < 2) failures.push(`${name}: у светофора в узле ${signal.node} меньше двух фаз`);
    for (const phase of signal.phases) {
      if (phase.yellow <= 0) failures.push(`${name}: жёлтый нулевой длины в узле ${signal.node}`);
      if (phase.allRed <= 0) failures.push(`${name}: «всем красный» нулевой длины в узле ${signal.node}`);
    }
  }

  // --- что считается поломкой ---
  if (traffic.lanes.length === 0) failures.push(`${name}: ни одной полосы`);
  if (stuck.length > 0) {
    const w = stuck[0];
    failures.push(
      `${name}: ${stuck.length} полос ведут в никуда — например полоса ${w.id} ` +
      `(дорога ${w.road}) упирается в узел ${w.to}, и уехать с неё некуда`,
    );
  }
  if (gap > 0.001) failures.push(`${name}: связь разошлась с полосой на ${gap.toFixed(3)} м`);
  for (const lane of traffic.lanes) {
    if (lane.length <= 0) failures.push(`${name}: полоса ${lane.id} нулевой длины`);
  }
  // на перекрёстке дорог хотя бы одна помеха обязана быть: если их ноль,
  // значит связи не пересекаются, то есть перекрёстка на самом деле нет
  const crossings = world.junctions.filter((j) => j.degree > 2).length;
  if (crossings > 0 && traffic.conflicts.length === 0) {
    failures.push(`${name}: ${crossings} перекрёстков, а помех ноль — связи не пересекаются`);
  }
}

console.log('─'.repeat(103));
if (failures.length > 0) {
  console.log(`\nПОЛОМОК: ${failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ полос в никуда нет, связи держатся за полосы, все помехи разрешены,');
console.log('  светофор не пускает поперечные потоки вместе');
