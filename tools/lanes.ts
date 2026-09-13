/**
 * Полосы без экрана: разбираем все сцены на полосы и смотрим, не врёт ли разбор.
 *
 *   npm run lanes            — все сцены
 *   npm run lanes -- сломать — считать по-старому, «полоса в сторону одна»:
 *                              проверка ОБЯЗАНА упасть
 *
 * Сломанный вариант тут не выдуманный: это ровно то, как движение считало
 * полосу до 13 сентября. Проверка на нём падает — значит она видит ту самую
 * беду, ради которой писалась.
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { bands } from '../src/world/road.ts';
import { type Lane, buildLanes, laneAcross, laneAt, sideOf } from '../src/city/lanes.ts';

const broken = process.argv[2] === 'сломать';

let roads = 0, lanesTotal = 0;
let notInBand = 0, worstOff = 0, wrongSide = 0, badOrder = 0, missed = 0, doubled = 0;
let widest = 0;
const bySide: Record<number, number> = {};
const examples: string[] = [];

for (const name of Object.keys(SCENES)) {
  const world = buildWorld(SCENES[name], 'plain');
  const lanes = buildLanes(world);

  world.shapes.forEach((shape, si) => {
    roads++;
    const strips = bands(shape.type);
    const travel = strips.filter((b) => b.kind === 'travel');

    for (const dir of [1, -1] as const) {
      const side = sideOf(lanes, si, dir);
      bySide[side.length] = (bySide[side.length] ?? 0) + 1;
      widest = Math.max(widest, side.length);

      // сколько полос этой стороны на асфальте
      const want = shape.type.lanes.filter((l) => l.kind === 'travel' && l.direction === dir).length;
      if (side.length !== want) { missed++; if (examples.length < 4) examples.push(`${name}, дорога ${si}, сторона ${dir}: полос ${side.length}, а на асфальте ${want}`); }

      side.forEach((lane: Lane) => {
        lanesTotal++;

        /**
         * Середина полосы обязана лежать ВНУТРИ полосы движения на асфальте.
         * Это и есть «машина не едет по разметке»: если центр попал
         * в разметку или в разделительную, ехать там нельзя.
         */
        const at = broken ? dir * shape.halfWidth * 0.5 : lane.across;
        const band = travel.find((b) => at >= b.from && at <= b.to);
        if (band === undefined) {
          notInBand++;
          const near = strips.find((b) => at >= b.from && at <= b.to);
          if (examples.length < 4) examples.push(`${name}, дорога ${si}: середина на ${at.toFixed(2)} — это ${near?.kind ?? 'вне полотна'}`);
        } else {
          const off = Math.abs(at - (band.from + band.to) / 2);
          if (off > worstOff) worstOff = off;
          if (off > 0.05) {
            notInBand++;
            if (examples.length < 4) examples.push(`${name}, дорога ${si}: середина на ${at.toFixed(2)}, а полоса по центру ${(((band.from + band.to) / 2)).toFixed(2)} — мимо на ${off.toFixed(2)} м`);
          }
        }

        // правостороннее движение: знак смещения совпадает со стороной
        if (Math.sign(lane.across) !== dir) wrongSide++;
      });

      // нумерация: нулевая — самая правая, то есть дальше всех от осевой
      for (let i = 0; i + 1 < side.length; i++) {
        if (Math.abs(side[i].across) <= Math.abs(side[i + 1].across)) badOrder++;
      }
      // две полосы в одном месте
      for (let i = 0; i < side.length; i++)
        for (let k = i + 1; k < side.length; k++)
          if (Math.abs(side[i].across - side[k].across) < 0.1) doubled++;

      // обратный разбор: по середине полосы находится она же
      side.forEach((lane) => {
        if (laneAt(lanes, si, dir, lane.across) !== lane.index) badOrder++;
        if (Math.abs(laneAcross(lanes, si, dir, lane.index) - lane.across) > 1e-9) badOrder++;
      });
    }
  });
}

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(40, '.')} ${value}`);
console.log(`\nПолосы по всем ${Object.keys(SCENES).length} сценам${broken ? '   [СЛОМАНО: полоса в сторону одна, как было до 13.09]' : ''}\n`);
line('дорог разобрано', String(roads));
line('полос найдено', String(lanesTotal));
line('самая широкая дорога', `${widest} полос в сторону`);
for (const [n, count] of Object.entries(bySide).sort((a, b) => Number(a[0]) - Number(b[0])))
  line(`  сторон с ${n} полосами`, String(count));
line('дальше всего от середины полосы', `${worstOff.toFixed(2)} м`);

const checks: [string, boolean, string][] = [
  ['полос столько же, сколько на асфальте', missed === 0, `${missed} расхождений`],
  ['середина полосы лежит в самой полосе', notInBand === 0, `${notInBand} мимо, худшее ${worstOff.toFixed(2)} м`],
  ['все полосы по своей стороне', wrongSide === 0, `${wrongSide} не по той стороне`],
  ['нумерация от правой к левой', badOrder === 0, `${badOrder} сбоев порядка`],
  ['двух полос в одном месте нет', doubled === 0, `${doubled} совпадений`],
];
console.log('');
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(38, '.')} ${detail}`);
}
if (bad > 0 && examples.length > 0) {
  console.log('\n  где именно:');
  for (const e of examples) console.log(`      ${e}`);
}
console.log(bad === 0 ? '\nПОЛОСЫ В ПОРЯДКЕ\n' : `\nПОЛОСЫ ПРОВАЛЕНЫ: ${bad}\n`);
process.exit(bad > 0 ? 1 : 0);
