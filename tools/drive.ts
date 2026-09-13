/**
 * Проверка движения без браузера: гоняем город заданное время и смотрим цифры.
 *
 * Смотрит на то, чего на картинке не поймать глазом за минуту наблюдения:
 * были ли столкновения, проезжал ли кто-то на красный, стоял ли кто-то
 * вечно, доезжают ли машины вообще.
 *
 * Запуск: npm run drive                 — город, 5 минут, 120 машин
 *         npm run drive крест 600 200   — сцена, секунды, сколько машин
 *         npm run drive break           — заведомо сломанный случай:
 *                                         выключаем «уступи дорогу».
 *                                         Проверка ОБЯЗАНА упасть.
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildTraffic } from '../src/world/lanes.ts';
import { buildRules } from '../src/world/rules.ts';
import { STEP, feed, newSim, place, prepare, reseed, step } from '../src/world/drive.ts';
import type { Roads, Sim } from '../src/world/drive.ts';

const args = process.argv.slice(2);
const broken = args.includes('break');
const name = args.find((a) => SCENES[a] !== undefined) ?? 'город';
const numbers = args.filter((a) => /^\d+$/.test(a)).map(Number);
const seconds = numbers[0] ?? 300;
const wanted = numbers[1] ?? 120;

const world = buildWorld(SCENES[name], 'plateau');
const traffic = buildTraffic(world);
const rules = buildRules(world, traffic);
const roads: Roads = prepare(world, traffic, rules);

/**
 * Заведомая поломка: машины перестают проверять, свободно ли впереди, и
 * перестают видеть тех, кто вливается в ту же полосу по соседней дорожке.
 * Тогда на слияниях они обязаны начать встречаться в одной точке. Если
 * проверка этого НЕ заметит — сломана проверка, а не движение (правило 11).
 *
 * Выключается именно это, а не «уступи дорогу»: без уступания машины всё
 * равно не врезаются, потому что видят друг друга физически. Это хорошо
 * для движения, но тогда «уступи» не годится как заведомая поломка.
 */
const blind: Roads = broken ? { ...roads, reckless: true } : roads;

reseed(20260913);
const sim: Sim = newSim(world, traffic);

console.log(`сцена «${name}»: ${traffic.lanes.length} полос, ${traffic.links.length} связей, ` +
  `${rules.signals.length} светофоров, ${sim.crossings.length} переходов`);
if (broken) console.log('ЗАВЕДОМО СЛОМАННЫЙ СЛУЧАЙ: «уступи дорогу» выключено\n');

let redRuns = 0;
let stuckFor = 0;
const steps = Math.round(seconds / STEP);
const started = Date.now();

for (let i = 0; i < steps; i++) {
  feed(blind, sim, wanted);
  step(blind, sim);

  // Проезд на красный считается по МОМЕНТУ ВЪЕЗДА, а не по тому, что машина
  // оказалась на перекрёстке при красном: въехавший на зелёный имеет полное
  // право доехать, для того и существует такт «всем красный».
  for (const car of sim.cars) {
    if (car.ranRed) {
      redRuns++;
      car.ranRed = false;
    }
  }
  if (i % 10 === 0) {
    const moving = sim.cars.filter((c) => c.speed > 0.5).length;
    if (sim.cars.length > 10 && moving === 0) stuckFor += 10 * STEP;
  }
}

const ms = Date.now() - started;
const speeds = sim.cars.map((c) => c.speed);
const mean = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
const standing = sim.cars.filter((c) => c.speed < 0.5).length;

console.log(`\nпрогон ${seconds} с модельного времени за ${ms} мс (${(seconds * 1000 / ms).toFixed(0)}× быстрее реального)`);
console.log(`  машин сейчас          ${sim.cars.length}`);
console.log(`  родилось / уехало     ${sim.born} / ${sim.left}`);
console.log(`  средняя скорость      ${(mean * 3.6).toFixed(1)} км/ч`);
console.log(`  стоят на месте        ${standing} (${((standing / Math.max(1, sim.cars.length)) * 100).toFixed(0)}%)`);
console.log(`  самое долгое ожидание ${sim.worstWait.toFixed(1)} с`);
console.log(`  столкновений          ${sim.crashes}`);
console.log(`  проездов на красный   ${redRuns}`);
console.log(`  сеть стояла целиком   ${stuckFor.toFixed(1)} с`);

// где машины оказались — грубая проверка, что они на дороге, а не в поле
let offRoad = 0;
for (const car of sim.cars) {
  const p = place(roads, car);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) offRoad++;
}

const failures: string[] = [];
if (sim.crashes > 0) failures.push(`${sim.crashes} столкновений — машины оказались в одной точке`);
if (redRuns > 0) failures.push(`${redRuns} проездов на красный`);
if (offRoad > 0) failures.push(`${offRoad} машин потеряли своё место на карте`);
if (sim.left === 0 && seconds > 120) failures.push('ни одна машина не доехала до края мира');
if (stuckFor > 30) failures.push(`сеть стояла целиком ${stuckFor.toFixed(0)} с — взаимная блокировка`);
if (sim.worstWait > seconds * 0.75) failures.push(`кто-то прождал ${sim.worstWait.toFixed(0)} с — это навсегда`);

if (failures.length > 0) {
  console.log('\nПОЛОМОК: ' + failures.length);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✓ столкновений нет, на красный никто не поехал, сеть не заперта');
