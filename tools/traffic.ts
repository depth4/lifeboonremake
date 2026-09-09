/**
 * Трафик без экрана: гоняем чужие машины по сети и смотрим, не врут ли они.
 *
 *   npm run traffic            — сцена «решётка»
 *   npm run traffic -- каша    — другая сцена
 *   npm run traffic -- решётка сломать   — выключить объезд, проверка обязана упасть
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld, nearestRoad } from '../src/world/world.ts';
import { along, buildNetwork, moveTraffic, placeTraffic, poseOf, watch } from '../src/city/traffic.ts';
import { moveWalkers, placeWalkers, walkerPose } from '../src/city/walkers.ts';
import { walkLight } from '../src/city/signals.ts';

const scene = process.argv[2] ?? 'решётка';
const mode = process.argv[3] ?? '';
const broken = mode === 'сломать';
const lawless = mode === 'без-правил';
const world = buildWorld(SCENES[scene] ?? SCENES['решётка'], 'plain');
const net = buildNetwork(world);
const movers = placeTraffic(world, net, 18);
const walkers = placeWalkers(world, net, 26);
const DT = 1 / 60;

let offRoad = 0, worstOff = 0, tooFast = 0, fastest = 0, stuck = 0;
const travelled = movers.map(() => 0);
const reasons: Record<string, number> = {};
/** Нарушения ПДД и столкновения — то, ради чего правила и писались. */
let ranRed = 0, closestPair = Infinity, inBoxTogether = 0;
// пешеходы
let offKerb = 0, worstKerb = 0, crossedOnRed = 0, yieldedToWalker = 0, crossings = 0;
const walked = walkers.map(() => 0);
const wasBefore = movers.map(() => true); // ещё не пересекли стоп-линию
let closest = Infinity, turns = 0, moved = 0;
const startShapes = movers.map((m) => m.shape);
const startS = movers.map((m) => m.s);

for (let t = 0; t < 120; t += DT) {
  // «сломать» — выключить соблюдение дистанции: машины въедут друг в друга
  moveWalkers(world, net, walkers, DT, t);
  const crossing = walkers.filter((w) => w.crossing > 0).map((w) => ({ shape: w.shape, s: w.s }));
  moveTraffic(world, net, movers, DT, t, { headway: !broken, rules: !lawless, crossing });
  if (movers.some((m) => m.reason === 'пешеход')) yieldedToWalker++;

  walkers.forEach((w, i) => {
    walked[i] += w.speed * DT;
    const pose = walkerPose(world, w);
    const near = nearestRoad(world, pose.x, pose.z);
    // не переходящий пешеход обязан быть на тротуаре, а не на проезжей части
    // у перекрёстка углы тротуара скруглены и «ближайшая дорога» — уже
    // поперечная: там мерить нечего, там пешеход стоит на углу
    const nearJunction = world.junctions.some((j) => Math.hypot(pose.x - j.x, pose.z - j.z) < 16);
    if (!nearJunction && w.crossing === 0 && near !== null && near.distance < near.halfWidth - 0.3) {
      offKerb++;
      worstKerb = Math.max(worstKerb, near.halfWidth - near.distance);
    }
    if (w.crossing > 0 && w.crossing < 0.02) {
      crossings++;
      const node = net.nodes[w.shape].find((n) => Math.abs(n.s - w.s) < 10);
      const signal = node === undefined ? undefined : net.signals.find((sg) => sg.junction === node.junction);
      const approach = signal?.approaches.find((a) => a.shape === w.shape);
      if (signal !== undefined && approach !== undefined
        && walkLight(signal, approach.group, t).light === 'красный') crossedOnRed++;
    }
  });

  movers.forEach((m, i) => { travelled[i] += m.speed * DT; });

  // проезд на красный ловится в МИГ пересечения стоп-линии: въехал на жёлтый
  // и доехал на красном — это не нарушение, а именно так и надо
  movers.forEach((m, i) => {
    const w = watch(net, m, t);
    const before = w === null ? true : w.stopGap > 0;
    if (wasBefore[i] && !before && w !== null && w.light === 'красный' && m.speed > 1) ranRed++;
    wasBefore[i] = before;
  });

  // столкновения: меряем настоящее расстояние между машинами, а не вдоль
  // дороги — на перекрёстке они на разных дорогах
  /**
   * Столкновение — это НАЛОЖЕНИЕ ГАБАРИТОВ, а не близость центров. Первая
   * версия проверки считала столкновением встречный разъезд по узкой улице:
   * там центры в трёх с половиной метрах, и это совершенно нормально.
   * Считаем расстояние в осях самой машины: вдоль неё 4.4 м, поперёк 1.9.
   */
  for (const j of world.junctions) {
    const box = movers.map((m) => poseOf(world, m))
      .filter((p) => Math.hypot(p.x - j.x, p.z - j.z) < 12);
    for (let i = 0; i < box.length; i++)
      for (let k = i + 1; k < box.length; k++) {
        const dx = box[k].x - box[i].x, dz = box[k].z - box[i].z;
        const fx = Math.cos(box[i].yaw), fz = Math.sin(box[i].yaw);
        const along = Math.abs(dx * fx + dz * fz);
        const across = Math.abs(-dx * fz + dz * fx);
        const overlap = Math.max(along / 4.4, across / 1.95);
        if (overlap < closestPair) closestPair = overlap;
        if (overlap < 1) inBoxTogether++;
      }
  }
  for (const m of movers) {
    reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    const pose = poseOf(world, m);
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.z)) { offRoad++; continue; }
    const near = nearestRoad(world, pose.x, pose.z);
    const off = near === null ? 99 : near.distance - near.halfWidth;
    if (off > 0.1) { offRoad++; worstOff = Math.max(worstOff, off); }
    fastest = Math.max(fastest, m.speed);
    if (m.speed > 17) tooFast++;
  }
  // насколько близко подъезжают друг к другу на одной дороге
  for (let i = 0; i < movers.length; i++)
    for (let j = i + 1; j < movers.length; j++) {
      const a = movers[i], b = movers[j];
      if (a.shape !== b.shape || a.dir !== b.dir) continue;
      closest = Math.min(closest, Math.abs(a.s - b.s));
    }
}

movers.forEach((m, i) => {
  if (m.shape !== startShapes[i]) turns++;
  if (Math.abs(m.s - startS[i]) > 20 || m.shape !== startShapes[i]) moved++;
  // «встал намертво» — это проехать меньше тридцати метров за две минуты,
  // а не стоять в тот миг, когда проверка закончилась: на красном стоят все
  if (travelled[i] < 30) stuck++;
});

/**
 * Правостороннее движение. Машина должна стоять СПРАВА от осевой линии,
 * если смотреть по её ходу. Право по ходу — это cross(вперёд, вверх),
 * а признак «справа» — знак векторного произведения направления движения
 * на вектор от осевой к машине.
 */
let wrongSide = 0;
let sideSample = 0;
for (const m of movers) {
  const axis = along(world, m.shape, m.s);
  const pose = poseOf(world, m);
  const fx = Math.cos(pose.yaw), fz = Math.sin(pose.yaw);
  const dx = pose.x - axis.x, dz = pose.z - axis.z;
  const side = fx * dz - fz * dx; // > 0 — справа по ходу
  sideSample = side;
  if (side <= 0.2) wrongSide++;
}

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(38, '.')} ${value}`);
console.log(`\nТрафик по сцене «${scene}»: ${movers.length} машин, две минуты${broken ? '   [СЛОМАНО: дистанция не держится]' : lawless ? '   [СЛОМАНО: правила выключены]' : ''}\n`);
line('дорог в сети / узлов', `${world.shapes.length} / ${world.junctions.length}`);
line('свернули на другую дорогу', `${turns} из ${movers.length}`);
line('сдвинулись с места', `${moved} из ${movers.length}`);
line('самая быстрая', `${(fastest * 3.6).toFixed(0)} км/ч`);
line('ближе всего подъехали друг к другу', `${closest === Infinity ? '—' : closest.toFixed(1) + ' м'}`);
line('дальше всего вылезли с полотна', `${worstOff.toFixed(2)} м`);
line('проехали в среднем', `${(travelled.reduce((a, b) => a + b, 0) / movers.length).toFixed(0)} м за две минуты`);
const total = Object.values(reasons).reduce((a, b) => a + b, 0);
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
  line(`  чем заняты: ${why}`, `${((n / total) * 100).toFixed(0)}%`);

const checks: [string, boolean, string][] = [
  ['никто не съехал с проезжей части', offRoad === 0, `${offRoad} случаев, худший ${worstOff.toFixed(2)} м`],
  ['никто не гонит быстрее 60 км/ч', tooFast === 0, `${(fastest * 3.6).toFixed(0)} км/ч`],
  ['никто не встал намертво', stuck === 0, `${stuck} проехали меньше 30 м`],
  ['держат дистанцию друг от друга', closest > 4.5, `${closest === Infinity ? '—' : closest.toFixed(1)} м`],
  ['кто-то свернул на перекрёстке', world.junctions.length === 0 || turns > 0, `${turns} поворотов`],
  ['никто не проехал на красный', ranRed === 0, `${ranRed} проездов`],
  ['габариты на перекрёстке не наложились', inBoxTogether === 0,
    `самое тесное сближение — ${closestPair === Infinity ? 'никого рядом' : (closestPair * 100).toFixed(0) + '% от касания'}`],
  ['едут по ПРАВОЙ стороне', wrongSide === 0, `${wrongSide} не по той стороне, смещение ${sideSample.toFixed(2)} м`],
  ['пешеходы не гуляют по проезжей части', offKerb === 0, `${offKerb} случаев, заход ${worstKerb.toFixed(2)} м`],
  ['пешеходы не идут на красный', crossedOnRed === 0, `${crossedOnRed} переходов`],
  ['пешеходы вообще переходят дорогу', crossings > 3, `${crossings} за две минуты`],
  ['пешеходы дошли хоть куда-то', walked.every((d) => d > 20), `самый ленивый ${Math.min(...walked).toFixed(0)} м`],
];
console.log('');
console.log('  ПЕШЕХОДЫ');
line('  прошли в среднем', `${(walked.reduce((a, b) => a + b, 0) / walkers.length).toFixed(0)} м за две минуты`);
line('  переходов дороги за прогон', `${crossings}`);
line('  машины тормозили перед ними', `${((yieldedToWalker / (120 / DT)) * 100).toFixed(1)}% времени`);
console.log('');
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(36, '.')} ${detail}`);
}
console.log(bad === 0 ? '\nТРАФИК В ПОРЯДКЕ\n' : `\nТРАФИК ПРОВАЛЕН: ${bad}\n`);
process.exit(bad > 0 ? 1 : 0);
