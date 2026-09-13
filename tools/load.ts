/**
 * Сколько город тянет — и главное, КАК РАСТЁТ.
 *
 * Вопрос «быстро ли» бесполезен: сегодня быстро, завтра жителей вдесятеро.
 * Полезен вопрос о форме роста. Удвоили число машин, время выросло вдвое —
 * это линия, и город масштабируется железом. Выросло вчетверо — это квадрат,
 * и никакое железо не поможет: каждый смотрит на каждого, чинить надо
 * устройство, а не покупать компьютер.
 *
 * Вторым замером — цена жителя, которого НЕ считают, а вычисляют: его имя,
 * работа, квартира и место в городе выводятся из номера и часов. Это ответ
 * на «миллион жителей в браузере»: миллион существует, никто из них не
 * считается, и спросить можно про любого.
 *
 * Запуск: npm run load [сцена]
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork, moveTraffic, placeTraffic } from '../src/city/traffic.ts';
import { moveWalkers, placeWalkers } from '../src/city/walkers.ts';

const scene = process.argv[2] ?? 'решётка';
const world = buildWorld(SCENES[scene] ?? SCENES['решётка'], 'plain');
const net = buildNetwork(world);
const DT = 1 / 60;
/** Бюджет одного кадра при 60 кадрах в секунду, мс. */
const КАДР = 16.7;

console.log(`\nСЦЕНА «${scene}»: дорог ${world.shapes.length}, узлов ${world.junctions.length}\n`);
console.log('ЧАСТЬ 1. Нынешний город: каждый считается по-настоящему\n');
console.log('  просили  встало машин  встало пешеходов   мс/шаг   рост');

let prevMs = 0;
let prevN = 0;
for (const n of [25, 50, 100, 200, 400, 800]) {
  const movers = placeTraffic(world, net, n);
  const walkers = placeWalkers(world, net, n);
  // Сколько ПРОСИЛИ — не то же самое, что сколько ВСТАЛО: на сцену из дюжины
  // улиц тысяча машин не помещается. Меряем по факту, иначе цифра соврёт.
  const встало = movers.length + walkers.length;
  for (let i = 0; i < 20; i++) { // прогрев: первые шаги врут из-за раскрутки
    moveWalkers(world, net, walkers, DT, i * DT);
    moveTraffic(world, net, movers, DT, i * DT);
  }
  const ШАГОВ = 120;
  const started = performance.now();
  for (let i = 0; i < ШАГОВ; i++) {
    moveWalkers(world, net, walkers, DT, i * DT);
    moveTraffic(world, net, movers, DT, i * DT);
  }
  const ms = (performance.now() - started) / ШАГОВ;
  const рост = prevMs > 0 && встало > prevN
    ? `×${(ms / prevMs).toFixed(1)} на ×${(встало / prevN).toFixed(1)}`
    : '—';
  console.log(
    `  ${String(n).padStart(7)}  ${String(movers.length).padStart(11)}  ${String(walkers.length).padStart(16)}` +
    `   ${ms.toFixed(2).padStart(6)}   ${рост}`,
  );
  if (встало > prevN) { prevMs = ms; prevN = встало; }
}
console.log(`\n  бюджет кадра при 60 к/с — ${КАДР} мс. Сколько существ в него влезает, считать`);
console.log('  по последней строке, где число ещё росло.');

console.log('\nЧАСТЬ 2. Житель, которого не считают, а вычисляют\n');

/** Смешиватель: одно и то же число даёт одно и то же всегда и везде. */
function перемешать(x: number): number {
  let h = (x ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const ПРОФЕССИИ = ['водитель', 'врач', 'продавец', 'слесарь', 'учитель', 'охранник', 'повар', 'курьер'];

/** Всё про жителя — из его номера и сида города. Ничего не хранится. */
function житель(город: number, номер: number) {
  const a = перемешать(город ^ номер);
  const b = перемешать(номер * 2654435761);
  const c = перемешать(номер ^ 0x5bf03635);
  return {
    дом: Math.floor(a * 40000), // номер квартиры в городе
    работа: Math.floor(b * 12000), // номер рабочего места
    профессия: ПРОФЕССИИ[Math.floor(c * ПРОФЕССИИ.length)],
    машина: c > 0.62 ? Math.floor(c * 1e6) : 0, // у части жителей её нет
    встаёт: 6 + Math.floor(a * 4), // час подъёма
  };
}

/** Где он сейчас — тоже вычисляется: из распорядка и часов. */
function где(город: number, номер: number, час: number): 'дома' | 'на работе' | 'в пути' {
  const ж = житель(город, номер);
  const выход = ж.встаёт + 1;
  const возврат = выход + 9;
  if (час < выход || час > возврат + 1) return 'дома';
  if (час < выход + 1 || час > возврат) return 'в пути';
  return 'на работе';
}

const ГОРОД = 1234567;
for (const сколько of [10_000, 100_000, 1_000_000]) {
  const started = performance.now();
  let вПути = 0;
  for (let i = 0; i < сколько; i++) if (где(ГОРОД, i, 8) === 'в пути') вПути++;
  const ms = performance.now() - started;
  console.log(
    `  ${сколько.toLocaleString('ru-RU').padStart(9)} жителей: спросили про каждого за ${ms.toFixed(0).padStart(4)} мс` +
    `   (в 8 утра в пути ${((вПути / сколько) * 100).toFixed(0)}%)`,
  );
}

const сВопросом = performance.now();
const он = житель(ГОРОД, 573291);
const ответ = performance.now() - сВопросом;
console.log(`\n  житель №573291: ${он.профессия}, квартира ${он.дом}, работа ${он.работа},`);
console.log(`  машина ${он.машина || 'нет'}, встаёт в ${он.встаёт}. Спросить про него стоит ${ответ.toFixed(3)} мс.`);
console.log('  Он такой же и завтра, и в другом запуске, и у другого игрока: он выведен, а не сохранён.\n');
