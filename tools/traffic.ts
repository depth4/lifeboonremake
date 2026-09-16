/**
 * Трафик без экрана: гоняем чужие машины по сети и смотрим, не врут ли они.
 *
 *   npm run traffic            — сцена «решётка»
 *   npm run traffic -- каша    — другая сцена
 *   npm run traffic -- решётка сломать   — выключить объезд, проверка обязана упасть
 *   npm run traffic -- решётка шаг-по-часам — походка от часов, обязана упасть
 */

import { дорогиСцены, посёлокСцены } from '../src/scenes.ts';
import { расселить } from '../src/city/житель.ts';
import {
  ЧАС_УТРА, машиныЖителей, пешеходыЖителей, сколькоМашин, сколькоПешеходов,
} from '../src/city/жизнь.ts';
import { buildWorld, nearestRoad } from '../src/world/world.ts';
import { along, bump, buildNetwork, moveTraffic, placeTraffic, poseOf, signalsOf, touching, watch } from '../src/city/traffic.ts';
import { laneAcross, sideOf } from '../src/city/lanes.ts';
import { TOWN_LIMIT, priorityOf } from '../src/city/signs.ts';
import { moveWalkers, placeWalkers, walkerPose } from '../src/city/walkers.ts';
import { lightFor, walkLight } from '../src/city/signals.ts';
import { judge, newWatchdog, tally } from '../src/city/offence.ts';

const scene = process.argv[2] ?? 'решётка';
const mode = process.argv[3] ?? '';
const broken = mode === 'сломать';
const lawless = mode === 'без-правил';
/** Заведомо сломанный вариант: походка считается часами, а не пройденным путём. */
const byClock = mode === 'шаг-по-часам';
const oneLane = mode === 'одна-полоса';
const world = buildWorld(дорогиСцены(scene), 'plain');
const net = buildNetwork(world);

// сколько машин и пешеходов ставить — одна плотность на весь проект,
// она же и у страницы: см. `сколькоМашин` в `жизнь.ts`
const машин = сколькоМашин(net);
const пешком = сколькоПешеходов(net);

/**
 * ОТКУДА БЕРУТСЯ МАШИНЫ. Если у сцены есть посёлок — из его жителей: кто
 * сейчас в пути, тот едет, кто дома или на работе, тот стоит у своего
 * подъезда. Если посёлка нет (рукотворные сцены без домов) — ничьи машины,
 * которые просто ездят и НЕ ПАРКУЮТСЯ: парковаться им не к чему.
 *
 * Это не два правила, а одно: машина стоит, когда её хозяин внутри. Нет
 * хозяина — нет и стоянки.
 */
const посёлок = посёлокСцены(scene);
const ЧАС = ЧАС_УТРА;
const жизнь = посёлок === null ? null : расселить(посёлок);
const movers = жизнь === null
  ? placeTraffic(world, net, машин)
  : машиныЖителей(world, net, жизнь, ЧАС, машин).машины;
const walkers = жизнь === null
  ? placeWalkers(world, net, пешком)
  : пешеходыЖителей(world, net, жизнь, ЧАС, пешком);
const DT = 1 / 60;

let offRoad = 0, worstOff = 0, tooFast = 0, fastest = 0, stuck = 0, worstSpeeding = -99;
/** Кто именно встал: без имени цифра «шесть застряло» ничего не даёт. */
const головы: { голова: boolean; что: string }[] = [];
/**
 * Самый долгий НЕПРЕРЫВНЫЙ простой каждой машины, секунды.
 *
 * «Встал намертво» мерили пройденным путём: меньше тридцати метров за две
 * минуты. На пустой «решётке» это работало, на живом городе начало врать:
 * машина в утренней очереди у перекрёстка честно проезжает двадцать пять
 * метров и попадала в застрявшие. А настоящий тупик — это стоять
 * НЕ ШЕВЕЛЯСЬ: те, кого ловили раньше, стояли все две минуты подряд.
 */
const простой = new Map<number, number>();
const дольшеВсего = new Map<number, number>();
const travelled = movers.map(() => 0);
const reasons: Record<string, number> = {};
/** Нарушения ПДД и столкновения — то, ради чего правила и писались. */
let ranRed = 0, closestPair = Infinity, inBoxTogether = 0;
/**
 * Кто и когда проехал на красный. Без имени и мига цифра «1 проезд» —
 * это цифра, с которой нечего делать: приходится писать второй инструмент,
 * чтобы узнать, кто это был. Тот же приём, что у тесноты ниже.
 */
const красные: string[] = [];
// пешеходы
let offKerb = 0, worstKerb = 0, crossedOnRed = 0, yieldedToWalker = 0, crossings = 0;
/**
 * Походка. Фаза шага ВЫЧИСЛЯЕТСЯ из пройденного пути, и это значит, что путь
 * обязан совпадать с тем, насколько человек на самом деле сдвинулся по земле.
 * Разошлись — ноги живут отдельно от человека: стоит и семенит либо едет
 * не перебирая. Прыжок при переходе на другую улицу — не движение, а смена
 * места, и такие кадры из сравнения выкидываются.
 */
let худшийРазлад = 0, кадровПоходки = 0;
const прежнее = new Map<number, { x: number; z: number; путь: number }>();
let parkedEver = 0, leftEver = 0, maxParked = 0;
const wasParked = movers.map(() => false);
const walked = walkers.map(() => 0);
const wasBefore = movers.map(() => true); // ещё не пересекли стоп-линию
let closest = Infinity, turns = 0, moved = 0;
/**
 * ПОВОРОТНИКИ. Сравнивается не «мигает ли», а «в ту ли сторону»: запоминаем
 * курс в миг, когда машина выбрала маршрут, и последний зажжённый поворотник,
 * а на выезде смотрим, куда она на самом деле повернула.
 *
 * Тут же считается заведомо перепутанный поворотник — та же проверка на
 * зеркальном сигнале. Она обязана его поймать, иначе она ничего не проверяет.
 */
let signalled = 0, agreed = 0, flipped = 0, braked = 0;
/**
 * ПОЛОСЫ И ОБГОНЫ. «Обгон» считается не по намерению, а по факту: машина,
 * которая была позади другой на той же дороге, оказалась впереди неё.
 * Намерение соврать может, порядок в колонне — нет.
 */
let overtakes = 0, betweenLanes = 0, inLane = 0, worstStray = 0;
const laneUse: number[] = [];
const order = new Map<string, number>();
const blinkOf = movers.map(() => 0);
const yawAt = movers.map(() => 0);
const hadRoute = movers.map(() => false);
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
  moveWalkers(world, net, walkers, DT, t, byClock ? { походка: 'по часам' } : {});
  const crossing = walkers.filter((w) => w.crossing > 0).map((w) => ({ shape: w.shape, s: w.s }));
  /**
   * Городской час идёт за минуту: две минуты проверки — это два часа
   * утреннего города, с 7:48 до 9:48. Медленнее нельзя: иначе за прогон
   * не наступает ни один час выхода, и «кто-то уехал» проверять не на чем.
   */
  moveTraffic(world, net, movers, DT, t,
    { headway: !broken, rules: !lawless, lanes: !oneLane, crossing, час: ЧАС + t / 60 });
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
    const было = прежнее.get(i);
    if (было !== undefined) {
      const сдвиг = Math.hypot(pose.x - было.x, pose.z - было.z);
      if (сдвиг < 0.5) {
        худшийРазлад = Math.max(худшийРазлад, Math.abs(сдвиг - (w.путь - было.путь)));
        кадровПоходки++;
      }
    }
    прежнее.set(i, { x: pose.x, z: pose.z, путь: w.путь });
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

  movers.forEach((m, i) => {
    travelled[i] += m.speed * DT;
    // стоящая в кармане не простаивает: она стоит по причине, и причина — хозяин
    if (m.speed < 0.3 && m.park === null) {
      const было = (простой.get(i) ?? 0) + DT;
      простой.set(i, было);
      if (было > (дольшеВсего.get(i) ?? 0)) дольшеВсего.set(i, было);
    } else простой.set(i, 0);
  });

  // кто кого обогнал: следим за порядком в каждой паре на одной дороге
  for (let i = 0; i < movers.length; i++)
    for (let j = i + 1; j < movers.length; j++) {
      const a = movers[i], b = movers[j];
      const key = `${i}-${j}`;
      if (a.shape !== b.shape || a.dir !== b.dir || a.knocked !== null || b.knocked !== null) {
        order.delete(key); continue;
      }
      const now = Math.sign((a.s - b.s) * a.dir);
      const was = order.get(key);
      // обгон — это проехать МИМО, по соседней полосе. Если оба шли по одной
      // линии, значит один просто отстал или встал, и это не обгон
      // первые десять секунд не в счёт: машины рождаются кто где и в это время
      // просто разъезжаются по своим полосам, а это не обгон
      if (t > 10 && was !== undefined && was !== 0 && now !== 0 && was !== now
        && Math.abs(a.across - b.across) > 1.5) overtakes++;
      order.set(key, now);
    }

  // держатся ли машины середины полосы
  for (const m of movers) {
    if (m.knocked !== null || m.route !== null || m.park !== null) continue;
    const side = sideOf(net.lanes, m.shape, m.dir as 1 | -1);
    if (side.length === 0) continue;
    laneUse[m.lane] = (laneUse[m.lane] ?? 0) + 1;
    const stray = Math.min(...side.map((l) => Math.abs(l.across - m.across)));
    if (stray > 0.6) { betweenLanes++; worstStray = Math.max(worstStray, stray); } else inLane++;
  }

  movers.forEach((m, i) => {
    const lights = signalsOf(world, net, m, t);
    if (lights.brake) braked++;
    const has = m.route !== null;
    if (has && !hadRoute[i]) { yawAt[i] = poseOf(world, net, m).yaw; blinkOf[i] = 0; }
    if (has && lights.blink !== 0) blinkOf[i] = lights.blink;
    if (!has && hadRoute[i] && blinkOf[i] !== 0) {
      const now = poseOf(world, net, m).yaw;
      const turn = Math.atan2(Math.sin(now - yawAt[i]), Math.cos(now - yawAt[i]));
      if (Math.abs(turn) > 0.35) {
        signalled++;
        if (Math.sign(turn) === blinkOf[i]) agreed++;
        if (Math.sign(turn) === -blinkOf[i]) flipped++;
      }
    }
    hadRoute[i] = has;
  });

  // проезд на красный ловится в МИГ пересечения стоп-линии: въехал на жёлтый
  // и доехал на красном — это не нарушение, а именно так и надо
  movers.forEach((m, i) => {
    const w = watch(world, net, m, t);
    const before = w === null ? true : w.stopGap > 0;
    if (wasBefore[i] && !before && w !== null && w.light === 'красный' && m.speed > 1) {
      ranRed++;
      if (красные.length < 6) {
        красные.push(`t=${t.toFixed(1)} ${tell(m, i)} ${(m.speed * 3.6).toFixed(0)} км/ч, `
          + `за стоп-линией на ${(-w.stopGap).toFixed(2)} м, занят «${m.reason}»`);
      }
    }
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
    /**
     * «Быстро» меряется от ЗНАКА, а не от общей цифры. Превышение мы
     * моделируем нарочно: по ГИБДД две трети всех нарушений — это
     * 20–40 км/ч сверх знака, и машина, едущая 64 там, где 60, ведёт себя
     * правильно. Неправильно — это 20–40 превратившиеся в сто.
     */
    const overBy = m.speed * 3.6 - net.signs.limit[m.shape];
    if (overBy > worstSpeeding) worstSpeeding = overBy;
    if (overBy > 45) tooFast++;
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
  /**
   * «Встал намертво» — это простоять НЕ ШЕВЕЛЯСЬ дольше минуты. Не «проехать
   * мало»: машина в утренней очереди у перекрёстка честно проезжает двадцать
   * пять метров за две минуты, и мерка по пути звала её застрявшей. Все
   * настоящие тупики, найденные за этот вечер, стояли по две минуты подряд.
   *
   * Припаркованная сюда не входит: она не встала, она СТОИТ, и стоит
   * по причине — её хозяин внутри.
   */
  /**
   * Застрял — это стоит НЕ ШЕВЕЛЯСЬ дольше минуты И ВСЁ ЕЩЁ СТОИТ, когда
   * проверка кончилась. Просто «стоял минуту где-то по ходу» — это пробка:
   * машина, проехавшая триста метров и вставшая в хвост под конец, ничего
   * не нарушила. Настоящий тупик виден тем, что он не рассасывается.
   *
   * Обе половины нужны. По одному только «стоит сейчас» не отличить тупик
   * от красного света; по одному только «стоял когда-то» пробка выглядит
   * тупиком. Мерили сначала пройденным путём — врало на пробках; потом
   * самым долгим простоем — врало на них же.
   */
  const стоялПодряд = простой.get(i) ?? 0;
  if (стоялПодряд > 60 && m.park === null) {
    stuck++;
    /**
     * Показываем ГОЛОВУ затора, а не хвост. «Машина впереди» — это тот, кто
     * стоит ЗА кем-то; причина у него чужая. Интересен тот, у кого причина
     * своя: он и есть начало цепочки, и чинить надо его.
     */
    головы.push({
      голова: m.reason !== 'машина впереди',
      что: `${tell(m, i)} стоит ${стоялПодряд.toFixed(0)} с, проехал ${travelled[i].toFixed(0)} м`,
    });
  }
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
  const lane = laneAcross(net.lanes, road, 1, 0);
  const spot = along(world, road, at);
  const me = {
    x: spot.x - spot.fz * lane, z: spot.z + spot.fx * lane,
    speed: 0, yaw: Math.atan2(spot.fz, spot.fx),
  };
  // подъезжающего сажаем руками: сцена не должна зависеть от везения
  const test = cars[0];
  test.shape = road; test.dir = 1; test.s = lo + 5; test.across = lane; test.lane = 0;
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
  const lane = laneAcross(net.lanes, road, 1, 0);
  const spot = along(world, road, at);
  // жертву ставим руками и держим на месте
  const target = cars[0];
  target.shape = road; target.dir = 1; target.s = at; target.across = lane; target.lane = 0;
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

/**
 * НАРУШЕНИЯ ИГРОКА. Синтетический игрок нарочно едет на красный и нарочно
 * выезжает на встречную; город обязан назвать оба. «Послушный» — тот же
 * игрок, который стоит перед красным и держится своей полосы: ему нельзя
 * записать ничего, иначе счётчик просто ругается на всех подряд.
 */
function offenceScene(naughty: boolean): { red: number; wrong: number; total: number } {
  const cars = placeTraffic(world, net, 0);
  const people = placeWalkers(world, net, 0);
  const dog = newWatchdog();
  // подъезд к перекрёстку со светофором: там есть чему гореть красным
  const signal = net.signals[0];
  const approach = signal.approaches[0];
  const shape = approach.shape, dir = approach.dir;
  const lane = laneAcross(net.lanes, shape, dir as 1 | -1, 0);
  let s = approach.stopS - dir * 30;
  let time = 0;
  // ждём своего красного, стоя на месте, и только потом трогаемся
  while (time < 60 && lightFor(signal, approach, time).light !== 'красный') time += DT;
  const started = time;
  const total = net.length[shape];
  for (; time < started + 8; time += DT) {
    const red = lightFor(signal, approach, time).light === 'красный';
    // послушный останавливается перед линией, нарушитель едет как ехал
    const stop = !naughty && red && (approach.stopS - s) * dir < 3;
    const speed = stop ? 0 : 9;
    // за конец дороги не выезжаем: там `locate` уже про другую улицу
    s = Math.max(2, Math.min(total - 2, s + speed * dir * DT));
    const spot = along(world, shape, s);
    // нарушитель ещё и едет по встречной — с самого начала, вдали от узла,
    // чтобы `locate` не приняла его за машину на поперечной улице
    const across = naughty ? -lane : lane;
    judge(world, net, dog, {
      x: spot.x - spot.fz * across, z: spot.z + spot.fx * across,
      yaw: Math.atan2(spot.fz * dir, spot.fx * dir), speed,
    }, time, people);
  }
  void cars;
  const counts = tally(dog);
  const of = (name: string): number => counts.find((c) => c.what === name)?.count ?? 0;
  return { red: of('проезд на красный'), wrong: of('выезд на встречную полосу'), total: dog.list.length };
}

const naughty = offenceScene(true);
const lawful = offenceScene(false);

/**
 * ГЛАВНАЯ И ВТОРОСТЕПЕННАЯ. Сцена «бритва» — единственная с перекрёстком
 * без светофора, где дороги разной ширины. ПДД 13.9: едущий по второстепенной
 * уступает всем, кто на главной, независимо от направления.
 *
 * Меряем не намерение, а дело: кто сколько времени стоял и уступал.
 */
function priorityScene(): { signs: number; mainWaits: number; sideWaits: number; name: string } {
  const scene = 'бритва';
  const w2 = buildWorld(дорогиСцены(scene), 'plain');
  const n2 = buildNetwork(w2);
  const cars = placeTraffic(w2, n2, 14);
  const junction = w2.junctions.findIndex((_, j) => n2.atJunction[j].length >= 3
    && !n2.signals.some((sg) => sg.junction === j));
  let mainWaits = 0, sideWaits = 0;
  for (let t = 0; t < 120; t += DT) {
    moveTraffic(w2, n2, cars, DT, t, {});
    if (junction < 0) continue;
    for (const m of cars) {
      if (m.route?.junction !== junction || m.reason !== 'уступает') continue;
      if (priorityOf(n2.signs, junction, m.shape) === 'главная') mainWaits++;
      if (priorityOf(n2.signs, junction, m.shape) === 'второстепенная') sideWaits++;
    }
  }
  return { signs: n2.signs.all.filter((g) => g.kind !== '3.24').length, mainWaits, sideWaits, name: scene };
}

const priority = priorityScene();

/** Как разошлись желаемые скорости по потоку: превышает ли кто и насколько. */
const wanted = movers.map((m) => ({ kmh: m.cruise * 3.6, limit: net.signs.limit[m.shape] }));
const over = wanted.filter((x) => x.kmh > x.limit + 0.5).length;
const worstOver = Math.max(0, ...wanted.map((x) => x.kmh - x.limit));

const crash = crashScene(false);
const through = crashScene(true);

const sees = playerScene(false);
const blind = playerScene(true);

/** Самые долгие простои: цифра, по которой видно, близко ли до провала. */
const dольше = (): number[] => [...дольшеВсего.values()];

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(38, '.')} ${value}`);
console.log(`\nТрафик по сцене «${scene}»: ${movers.length} машин, две минуты${broken ? '   [СЛОМАНО: дистанция не держится]' : byClock ? '   [СЛОМАНО: походка по часам]' : lawless ? '   [СЛОМАНО: правила выключены]' : oneLane ? '   [СЛОМАНО: перестроений нет, все в правой полосе]' : ''}\n`);
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
  ['превышают на 20–40, а не втрое', tooFast === 0,
    `самое быстрое ${(fastest * 3.6).toFixed(0)} км/ч, это +${worstSpeeding.toFixed(0)} к знаку`],
  ['никто не встал намертво', stuck === 0,
    `${stuck} стоят не шевелясь дольше минуты и в конце проверки; `
    + `самый долгий простой за прогон ${Math.max(0, ...dольше()).toFixed(0)} с`
    + `${головы.length > 0 ? '\n      ' + головы
      .sort((a, b) => Number(b.голова) - Number(a.голова)).slice(0, 6)
      .map((x) => (x.голова ? 'ГОЛОВА ' : 'хвост  ') + x.что).join('\n      ') : ''}`],
  ['габариты нигде не наложились', closest > 1, `самое тесное ${(closest * 100).toFixed(0)}% от касания`],
  ['кто-то свернул на перекрёстке', world.junctions.length === 0 || turns > 0, `${turns} поворотов`],
  ['никто не проехал на красный', ranRed === 0,
    `${ranRed} проездов${красные.length > 0 ? '\n      ' + красные.join('\n      ') : ''}`],
  ['на перекрёстке не столкнулись', inBoxTogether === 0,
    `самое тесное — ${closestPair === Infinity ? 'никого рядом' : (closestPair * 100).toFixed(0) + '% от касания'}`],
  ['едут по ПРАВОЙ стороне', wrongSide === 0, `${wrongSide} не по той стороне, смещение ${sideSample.toFixed(2)} м`],
  ['пешеходы не гуляют по проезжей части', offKerb === 0, `${offKerb} случаев, заход ${worstKerb.toFixed(2)} м`],
  ['пешеходы не идут на красный', crossedOnRed === 0, `${crossedOnRed} переходов`],
  ['пешеходы вообще переходят дорогу', crossings > 3, `${crossings} за две минуты`],
  /**
   * Парковка существует только там, где есть к чему парковаться. На сцене
   * без домов ничья машина не встаёт вообще — и это не отсутствие проверки,
   * а само правило: у стоянки должна быть причина.
   */
  [жизнь === null ? 'без домов никто не паркуется' : 'кто-то припарковался и уехал',
    жизнь === null ? parkedEver === 0 && leftEver === 0 : parkedEver > 0 && leftEver > 0,
    `${parkedEver} парковок, ${leftEver} выездов`],
  ['пешеходы дошли хоть куда-то', walked.every((d) => d > 20), `самый ленивый ${Math.min(...walked).toFixed(0)} м`],
  ['ноги идут ровно столько, сколько человек прошёл', худшийРазлад < 0.01 && кадровПоходки > 1000,
    `худшее расхождение ${(худшийРазлад * 100).toFixed(2)} см за кадр на ${кадровПоходки} кадрах`],
  ['город видит машину игрока', sees.held > 0, `${(sees.held / 60).toFixed(1)} с держался за неё`],
  ['трафик не проехал сквозь игрока', sees.hit === 0,
    `подъехал на ${sees.approached.toFixed(1)} м, ближе всего ${(sees.closest * 100).toFixed(0)}% от касания`],
  ['вслепую — обязан задеть', blind.hit > 0,
    blind.hit > 0 ? `задел ${(blind.hit / 60).toFixed(1)} с, проверка ловит` : 'НЕ ЗАДЕЛ — проверка ничего не проверяет'],
  ['знак 3.24 ставится там, где 40, и нигде больше',
    net.signs.all.filter((g) => g.kind === '3.24').every((g) => g.value < TOWN_LIMIT),
    `${net.signs.all.filter((g) => g.kind === '3.24').length} знаков ограничения`],
  ['превышают не все, а меньшинство', over > 0 && over <= Math.ceil(movers.length * 0.35),
    `${over} из ${movers.length} едут быстрее знака`],
  ['превышают типично, а не втрое', worstOver <= 40.5,
    `самый лихой на ${worstOver.toFixed(0)} км/ч выше знака`],
  ['знаки приоритета расставлены там, где нет светофора', priority.signs > 0,
    `${priority.signs} знаков на сцене «${priority.name}»`],
  ['второстепенная уступает, а главная нет', priority.sideWaits > 0 && priority.mainWaits === 0,
    `второстепенная ждала ${(priority.sideWaits / 60).toFixed(1)} с, главная ${(priority.mainWaits / 60).toFixed(1)} с`],
  ['машины держатся середины полосы', betweenLanes / Math.max(1, betweenLanes + inLane) < 0.15,
    `${((betweenLanes / Math.max(1, betweenLanes + inLane)) * 100).toFixed(1)}% времени между полос, дальше всего ${worstStray.toFixed(2)} м`],
  ['кто-то кого-то обогнал', overtakes > 0, `${overtakes} обгонов за две минуты`],
  ['левая полоса не пустует', (laneUse[1] ?? 0) > 0,
    laneUse.map((n, i) => `полоса ${i}: ${((n / Math.max(1, laneUse.reduce((a, b) => a + (b ?? 0), 0))) * 100).toFixed(0)}%`).join(', ')],
  ['поворотник показывает ту сторону, куда свернули', signalled > 0 && agreed === signalled,
    `${agreed} из ${signalled} поворотов`],
  ['перепутанный поворотник — обязан провалиться', signalled > 0 && flipped === 0,
    flipped === 0 ? `зеркальный сигнал разошёлся бы во всех ${signalled}` : `${flipped} совпали — проверка слепа`],
  ['стоп-сигналы вообще загораются', braked > 0, `${((braked / (movers.length * 120 / DT)) * 100).toFixed(0)}% времени`],
  ['проезд игрока на красный замечен', naughty.red === 1, `${naughty.red} раз`],
  ['выезд игрока на встречную замечен', naughty.wrong === 1, `${naughty.wrong} раз, а не за каждый кадр`],
  ['послушному игроку не пишут ничего', lawful.total === 0,
    lawful.total === 0 ? 'чисто' : `${lawful.total} на ровном месте — счётчик ругается на всех`],
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
