/**
 * Трафик без экрана: гоняем чужие машины по сети и смотрим, не врут ли они.
 *
 *   npm run traffic            — сцена «решётка»
 *   npm run traffic -- каша    — другая сцена
 *   npm run traffic -- решётка сломать   — выключить объезд, проверка обязана упасть
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld, nearestRoad } from '../src/world/world.ts';
import { buildNetwork, moveTraffic, placeTraffic, poseOf } from '../src/car/traffic.ts';

const scene = process.argv[2] ?? 'решётка';
const broken = process.argv[3] === 'сломать';
const world = buildWorld(SCENES[scene] ?? SCENES['решётка'], 'plain');
const net = buildNetwork(world);
const movers = placeTraffic(world, net, 18);
const DT = 1 / 60;

let offRoad = 0, worstOff = 0, tooFast = 0, fastest = 0, stuck = 0;
let closest = Infinity, turns = 0, moved = 0;
const startShapes = movers.map((m) => m.shape);
const startS = movers.map((m) => m.s);

for (let t = 0; t < 120; t += DT) {
  // «сломать» — выключить соблюдение дистанции: машины въедут друг в друга
  moveTraffic(world, net, movers, DT, { headway: !broken });

  for (const m of movers) {
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
  if (m.speed < 0.5) stuck++;
});

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(38, '.')} ${value}`);
console.log(`\nТрафик по сцене «${scene}»: ${movers.length} машин, две минуты${broken ? '   [СЛОМАНО: дистанция не держится]' : ''}\n`);
line('дорог в сети / узлов', `${world.shapes.length} / ${world.junctions.length}`);
line('свернули на другую дорогу', `${turns} из ${movers.length}`);
line('сдвинулись с места', `${moved} из ${movers.length}`);
line('самая быстрая', `${(fastest * 3.6).toFixed(0)} км/ч`);
line('ближе всего подъехали друг к другу', `${closest === Infinity ? '—' : closest.toFixed(1) + ' м'}`);
line('дальше всего вылезли с полотна', `${worstOff.toFixed(2)} м`);

const checks: [string, boolean, string][] = [
  ['никто не съехал с проезжей части', offRoad === 0, `${offRoad} случаев, худший ${worstOff.toFixed(2)} м`],
  ['никто не гонит быстрее 60 км/ч', tooFast === 0, `${(fastest * 3.6).toFixed(0)} км/ч`],
  ['все едут, никто не встал намертво', stuck === 0, `${stuck} стоят`],
  ['держат дистанцию друг от друга', closest > 4.5, `${closest === Infinity ? '—' : closest.toFixed(1)} м`],
  ['кто-то свернул на перекрёстке', world.junctions.length === 0 || turns > 0, `${turns} поворотов`],
];
console.log('');
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(36, '.')} ${detail}`);
}
console.log(bad === 0 ? '\nТРАФИК В ПОРЯДКЕ\n' : `\nТРАФИК ПРОВАЛЕН: ${bad}\n`);
process.exit(bad > 0 ? 1 : 0);
