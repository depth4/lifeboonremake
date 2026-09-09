/**
 * Трафик без экрана: гоняем чужие машины по сети и смотрим, не врут ли они.
 *
 *   npm run traffic            — сцена «решётка»
 *   npm run traffic -- каша    — другая сцена
 *   npm run traffic -- решётка сломать   — выключить объезд, проверка обязана упасть
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld, nearestRoad } from '../src/world/world.ts';
import { along, bump, buildNetwork, moveTraffic, placeTraffic, poseOf, touching, watch } from '../src/city/traffic.ts';
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
let parkedEver = 0, leftEver = 0, maxParked = 0;
const wasParked = movers.map(() => false);
const walked = walkers.map(() => 0);
const wasBefore = movers.map(() => true); // ещё не пересекли стоп-линию
let closest = Infinity, turns = 0, moved = 0;
/**
 * Кто именно и когда сошёлся ближе всех. Без этого «самое тесное 89%» —
 * цифра, с которой нечего делать: приходится писать второй инструмент,
 * чтобы узнать, кто это был.
 */
let tightest = { at: 0, who: '' };
const tell = (m: (typeof movers)[number], i: number): string => {
  const p = poseOf(world, net, m);
  return `#${i} дорога ${m.shape} dir ${m.dir} s ${m.s.toFixed(1)} вбок ${m.across.toFixed(1)} `
    + `${(m.speed * 3.6).toFixed(0)} км/ч «${m.reason}» `
    + `${m.route === null ? 'едет прямо' : `узел ${m.route.junction}→дорога ${m.route.shape}`} `
    + `xz ${p.x.toFixed(1)},${p.z.toFixed(1)}`;
};
const startShapes = movers.map((m) => m.shape);
const startS = movers.map((m) => m.s);

for (let t = 0; t < 120; t += DT) {
  // «сломать» — выключить соблюдение дистанции: машины въедут друг в друга
  moveWalkers(world, net, walkers, DT, t);
  const crossing = walkers.filter((w) => w.crossing > 0).map((w) => ({ shape: w.shape, s: w.s }));
  moveTraffic(world, net, movers, DT, t, { headway: !broken, rules: !lawless, crossing });
  if (movers.some((m) => m.reason === 'пешеход')) yieldedToWalker++;
  movers.forEach((m, i) => {
    const parked = m.park?.phase === 'стоит';
    if (parked && !wasParked[i]) parkedEver++;
    if (!parked && wasParked[i]) leftEver++;
    wasParked[i] = parked;
  });
  maxParked = Math.max(maxParked, movers.filter((m) => m.park?.phase === 'стоит').length);

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
    const w = watch(world, net, m, t);
    const before = w === null ? true : w.stopGap > 0;
    if (wasBefore[i] && !before && w !== null && w.light === 'красный' && m.speed > 1) ranRed++;
    wasBefore[i] = before;
  });

  // столкновения: меряем настоящее расстояние между машинами, а не вдоль
  // дороги — на перекрёстке они на разных дорогах
  /**
   * Столкновение — это НАЛОЖЕНИЕ ГАБАРИТОВ, а не близость центров: встречный
   * разъезд по узкой улице держит центры в трёх с половиной метрах, и это
   * совершенно нормально. Меру берём ту же, по которой решает сам город
   * (`touching`): пока определений было два, город считал, что проехал,
   * а проверка — что задел, и спорить с этим было нечем.
   */
  for (const j of world.junctions) {
    const box = movers.map((m) => poseOf(world, net, m))
      .filter((p) => Math.hypot(p.x - j.x, p.z - j.z) < 12);
    for (let i = 0; i < box.length; i++)
      for (let k = i + 1; k < box.length; k++) {
        const overlap = touching(box[i], box[k]);
        if (overlap < closestPair) closestPair = overlap;
        if (overlap < 1) inBoxTogether++;
      }
  }
  for (const m of movers) {
    reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    const pose = poseOf(world, net, m);
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.z)) { offRoad++; continue; }
    const near = nearestRoad(world, pose.x, pose.z);
    const off = near === null ? 99 : near.distance - near.halfWidth;
    if (off > 0.1) { offRoad++; worstOff = Math.max(worstOff, off); }
    fastest = Math.max(fastest, m.speed);
    if (m.speed > 17) tooFast++;
  }
  /**
   * Теснота меряется ГАБАРИТАМИ по всем парам сразу: вдоль дороги её больше
   * не видно, потому что у машины появилось боковое смещение — стоящая
   * в кармане и едущая мимо имеют один и тот же метр, но не сталкиваются.
   */
  {
    const P = movers.map((m) => poseOf(world, net, m));
    for (let i = 0; i < P.length; i++)
      for (let j = i + 1; j < P.length; j++) {
        if (Math.abs(P[j].x - P[i].x) > 9 || Math.abs(P[j].z - P[i].z) > 9) continue;
        const near = touching(P[i], P[j]);
        if (near < closest) {
          closest = near;
          tightest = { at: t, who: `${tell(movers[i], i)}\n      против ${tell(movers[j], j)}` };
        }
      }
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
  if (m.route !== null) continue; // внутри перекрёстка машина не на полосе
  const axis = along(world, m.shape, m.s);
  const pose = poseOf(world, net, m);
  const fx = Math.cos(pose.yaw), fz = Math.sin(pose.yaw);
  const dx = pose.x - axis.x, dz = pose.z - axis.z;
  const side = fx * dz - fz * dx; // > 0 — справа по ходу
  sideSample = side;
  if (side <= 0.2) {
    wrongSide++;
    if (wrongSide === 1) {
      console.log(`  ! не по той стороне: дорога ${m.shape}, dir ${m.dir}, across ${m.across.toFixed(2)}, `
        + `паркуется ${m.park === null ? 'нет' : m.park.phase}, сторона ${side.toFixed(2)}`);
    }
  }
}

/**
 * Отдельная сцена: машина игрока СТОИТ посреди полосы, к ней сзади подъезжает
 * чужая. Город обязан её видеть — иначе трафик проедет сквозь игрока.
 *
 * Сцена гоняется дважды: как есть и «вслепую» (игрока не передали). Слепой
 * прогон обязан задеть машину — иначе проверка ничего не проверяет.
 */
function playerScene(blind: boolean): { held: number; hit: number; closest: number; approached: number } {
  const cars = placeTraffic(world, net, 18, 7);
  // самый длинный кусок дороги без перекрёстков: там никто никуда не свернёт
  let road = 0, lo = 0, hi = 0;
  world.shapes.forEach((_, si) => {
    const marks = [0, ...net.nodes[si].map((n) => n.s), net.length[si]].sort((a, b) => a - b);
    for (let i = 0; i + 1 < marks.length; i++)
      if (marks[i + 1] - marks[i] > hi - lo) { road = si; lo = marks[i]; hi = marks[i + 1]; }
  });
  const at = lo + (hi - lo) * 0.75;
  const lane = world.shapes[road].halfWidth * 0.5;
  const spot = along(world, road, at);
  const me = {
    x: spot.x - spot.fz * lane, z: spot.z + spot.fx * lane,
    speed: 0, yaw: Math.atan2(spot.fz, spot.fx),
  };
  // подъезжающего сажаем руками: сцена не должна зависеть от везения
  const test = cars[0];
  test.shape = road; test.dir = 1; test.s = lo + 5; test.across = lane;
  test.speed = 11; test.park = null; test.route = null; test.cruise = 14;

  let held = 0, hit = 0, closest = Infinity, approached = Infinity;
  for (let t = 0; t < 25; t += DT) {
    moveTraffic(world, net, cars, DT, t, { player: blind ? null : me });
    if (test.reason === 'игрок') held++;
    const pose = poseOf(world, net, test);
    // то же наложение габаритов, что и между чужими машинами
    const overlap = touching(pose, me);
    closest = Math.min(closest, overlap);
    approached = Math.min(approached, (at - test.s) - 4.4);
    if (overlap < 1) hit++;
  }
  return { held, hit, closest, approached };
}

/**
 * УДАР. Машина игрока въезжает в стоящую чужую. Проверяются законы,
 * а не ощущения: импульс вдоль нормали удара обязан сохраниться, энергия —
 * не вырасти, кузова — разойтись.
 *
 * «Насквозь» — заведомо сломанный вариант: удар не считается вовсе.
 * Он обязан провалить проверку, иначе она ничего не проверяет.
 */
function crashScene(through: boolean): {
  before: number; after: number; keep: number; energy: number;
  apart: number; knocked: boolean; back: boolean; hisSpeed: number;
} {
  // в сцене ровно одна чужая машина: удар — это про двоих, третий тут лишний
  const cars = placeTraffic(world, net, 1, 7);
  let road = 0, lo = 0, hi = 0;
  world.shapes.forEach((_, si) => {
    const marks = [0, ...net.nodes[si].map((n) => n.s), net.length[si]].sort((a, b) => a - b);
    for (let i = 0; i + 1 < marks.length; i++)
      if (marks[i + 1] - marks[i] > hi - lo) { road = si; lo = marks[i]; hi = marks[i + 1]; }
  });
  const at = lo + (hi - lo) * 0.75;
  const lane = world.shapes[road].halfWidth * 0.5;
  const spot = along(world, road, at);
  // жертву ставим руками и держим на месте
  const target = cars[0];
  target.shape = road; target.dir = 1; target.s = at; target.across = lane;
  target.speed = 0; target.park = null; target.route = null; target.cruise = 0;

  const MASS = 1556.3, SPIN = MASS * 1.265 * 1.245;
  const yaw = Math.atan2(spot.fz, spot.fx);
  const me = {
    x: spot.x - spot.fz * lane - Math.cos(yaw) * 20, z: spot.z + spot.fx * lane - Math.sin(yaw) * 20,
    yaw, vx: Math.cos(yaw) * 12, vz: Math.sin(yaw) * 12, yawRate: 0, mass: MASS, inertia: SPIN,
  };
  const along1 = (vx: number, vz: number, nx: number, nz: number): number => vx * nx + vz * nz;

  let before = 0, after = 0, energy = 0, keep = 0, apart = 0, knocked = false, back = false;
  let hisSpeed = 0, hit = -1;
  for (let t = 0; t < 12; t += DT) {
    if (hit < 0) {
      const v0 = { vx: Math.cos(target.yaw) * target.speed, vz: Math.sin(target.yaw) * target.speed };
      const e0 = 0.5 * MASS * (me.vx ** 2 + me.vz ** 2) + 0.5 * 1500 * (v0.vx ** 2 + v0.vz ** 2);
      const blow = through ? null : bump(world, net, cars, me);
      if (blow !== null) {
        hit = t;
        // импульс сохраняется ВДОЛЬ НОРМАЛИ УДАРА, а не вдоль курса игрока
        const { nx, nz } = blow;
        before = MASS * along1(me.vx, me.vz, nx, nz) + 1500 * along1(v0.vx, v0.vz, nx, nz);
        me.vx += blow.dvx; me.vz += blow.dvz; me.yawRate += blow.dSpin;
        me.x += blow.pushX; me.z += blow.pushZ;
        const k = target.knocked;
        after = MASS * along1(me.vx, me.vz, nx, nz) + (k ? 1500 * along1(k.vx, k.vz, nx, nz) : 0);
        energy = (0.5 * MASS * (me.vx ** 2 + me.vz ** 2)
          + (k ? 0.5 * 1500 * (k.vx ** 2 + k.vz ** 2) : 0)) / e0;
        keep = Math.abs(after - before) / Math.max(1e-6, Math.abs(before));
        knocked = k !== null;
        hisSpeed = k ? Math.hypot(k.vx, k.vz) : 0;
      }
    }
    me.x += me.vx * DT; me.z += me.vz * DT; me.yaw += me.yawRate * DT;
    moveTraffic(world, net, cars, DT, t, { player: { x: me.x, z: me.z, speed: Math.hypot(me.vx, me.vz), yaw: me.yaw } });
    // расходятся ли — смотрим ровно секунду после удара, дальше игрок просто уезжает
    if (hit >= 0 && t < hit + 1) apart = Math.max(apart, touching(me, poseOf(world, net, target)));
    if (hit >= 0 && target.knocked === null) back = true;
  }
  return { before, after, keep, energy, apart, knocked, back, hisSpeed };
}

const crash = crashScene(false);
const through = crashScene(true);

const sees = playerScene(false);
const blind = playerScene(true);

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(38, '.')} ${value}`);
console.log(`\nТрафик по сцене «${scene}»: ${movers.length} машин, две минуты${broken ? '   [СЛОМАНО: дистанция не держится]' : lawless ? '   [СЛОМАНО: правила выключены]' : ''}\n`);
line('дорог в сети / узлов', `${world.shapes.length} / ${world.junctions.length}`);
line('свернули на другую дорогу', `${turns} из ${movers.length}`);
line('сдвинулись с места', `${moved} из ${movers.length}`);
line('самая быстрая', `${(fastest * 3.6).toFixed(0)} км/ч`);
line('ближе всего подъехали друг к другу', `${closest === Infinity ? '—' : (closest * 100).toFixed(0) + '% от касания'}`);
line('дальше всего вылезли с полотна', `${worstOff.toFixed(2)} м`);
line('проехали в среднем', `${(travelled.reduce((a, b) => a + b, 0) / movers.length).toFixed(0)} м за две минуты`);
const total = Object.values(reasons).reduce((a, b) => a + b, 0);
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
  line(`  чем заняты: ${why}`, `${((n / total) * 100).toFixed(0)}%`);

const checks: [string, boolean, string][] = [
  ['никто не съехал с проезжей части', offRoad === 0, `${offRoad} случаев, худший ${worstOff.toFixed(2)} м`],
  ['никто не гонит быстрее 60 км/ч', tooFast === 0, `${(fastest * 3.6).toFixed(0)} км/ч`],
  ['никто не встал намертво', stuck === 0, `${stuck} проехали меньше 30 м`],
  ['габариты нигде не наложились', closest > 1, `самое тесное ${(closest * 100).toFixed(0)}% от касания`],
  ['кто-то свернул на перекрёстке', world.junctions.length === 0 || turns > 0, `${turns} поворотов`],
  ['никто не проехал на красный', ranRed === 0, `${ranRed} проездов`],
  ['на перекрёстке не столкнулись', inBoxTogether === 0,
    `самое тесное — ${closestPair === Infinity ? 'никого рядом' : (closestPair * 100).toFixed(0) + '% от касания'}`],
  ['едут по ПРАВОЙ стороне', wrongSide === 0, `${wrongSide} не по той стороне, смещение ${sideSample.toFixed(2)} м`],
  ['пешеходы не гуляют по проезжей части', offKerb === 0, `${offKerb} случаев, заход ${worstKerb.toFixed(2)} м`],
  ['пешеходы не идут на красный', crossedOnRed === 0, `${crossedOnRed} переходов`],
  ['пешеходы вообще переходят дорогу', crossings > 3, `${crossings} за две минуты`],
  ['кто-то припарковался и уехал', parkedEver > 0 && leftEver > 0, `${parkedEver} парковок, ${leftEver} выездов`],
  ['пешеходы дошли хоть куда-то', walked.every((d) => d > 20), `самый ленивый ${Math.min(...walked).toFixed(0)} м`],
  ['город видит машину игрока', sees.held > 0, `${(sees.held / 60).toFixed(1)} с держался за неё`],
  ['трафик не проехал сквозь игрока', sees.hit === 0,
    `подъехал на ${sees.approached.toFixed(1)} м, ближе всего ${(sees.closest * 100).toFixed(0)}% от касания`],
  ['вслепую — обязан задеть', blind.hit > 0,
    blind.hit > 0 ? `задел ${(blind.hit / 60).toFixed(1)} с, проверка ловит` : 'НЕ ЗАДЕЛ — проверка ничего не проверяет'],
  ['удар случился, а не проезд насквозь', crash.knocked, crash.knocked ? 'чужую сбило с полосы' : 'проехал сквозь'],
  ['импульс удара сохранился', crash.knocked && crash.keep < 0.01,
    `${crash.before.toFixed(0)} → ${crash.after.toFixed(0)} кг·м/с, разошлось на ${(crash.keep * 100).toFixed(2)}%`],
  ['удар не добавил энергии', crash.energy <= 1.001, `${(crash.energy * 100).toFixed(0)}% от той, что была`],
  ['кузова разошлись, а не слиплись', crash.apart > 1, `разъехались до ${(crash.apart * 100).toFixed(0)}% от касания`],
  ['сбитая вернулась в поток', crash.back, crash.back ? 'постояла и поехала' : 'осталась лежать'],
  ['насквозь — обязан провалиться', !through.knocked,
    through.knocked ? 'СБИЛО и без удара — проверка ничего не проверяет' : 'без удара проехал насквозь, проверка ловит'],
];
console.log('');
line('карманов у бордюра', `${net.bays.length}`);
line('парковались за прогон', `${parkedEver} раз, уезжали ${leftEver}`);
line('стояли одновременно, самое большее', `${maxParked} из ${movers.length}`);
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
if (closest <= 1) {
  console.log(`\n  кто именно, на ${tightest.at.toFixed(1)} с:\n      ${tightest.who}`);
}
console.log(bad === 0 ? '\nТРАФИК В ПОРЯДКЕ\n' : `\nТРАФИК ПРОВАЛЕН: ${bad}\n`);
process.exit(bad > 0 ? 1 : 0);
