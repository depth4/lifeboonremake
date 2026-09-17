/**
 * Трафик: чужие машины, которые едут по дорожной сети сами и по правилам.
 *
 * Второй уровень подробности из docs/how-cars-work.md §12: не четыре пятна
 * контакта, а точка на полосе. Про экран не знает.
 *
 * ГЛАВНОЕ УСТРОЙСТВО. Любая причина сбросить скорость — это одно и то же:
 * **точка впереди и скорость, с которой её надо пройти**. Машина впереди,
 * красный свет, помеха справа, занятый перекрёсток, крутой поворот дороги —
 * всё сводится к списку таких точек, а модель следования превращает список
 * в одно ускорение. Ни одного «если светофор — то...» в самом движении нет.
 *
 * Модель следования — Intelligent Driver Model, стандарт микроскопической
 * транспортной симуляции (SUMO и прочие). Она по построению не допускает
 * столкновения и имеет пять понятных параметров вместо подобранных чисел.
 */

import type { World } from '../world/world.ts';
import { type Signal, buildSignals, junctionReach, lightFor, stopLine } from './signals.ts';
import { type Lanes, buildLanes, laneAcross, laneAt, laneCount } from './lanes.ts';
import { type Маршрут, дальше } from './путь.ts';
import { type Signs, buildSigns, priorityOf } from './signs.ts';

const G = 9.80665;
/** С какой боковой перегрузкой ездит обычный водитель. */
const COMFORT = 0.28;
/** Быстрее этого по городу никто не едет, м/с. */
export const CRUISE = 16;

// ── параметры модели следования (IDM)
/** Максимальное ускорение, м/с². */
const ACCEL = 1.8;
/** Комфортное торможение, м/с². */
const BRAKE = 2.6;
/** Зазор в стоящей пробке, м. */
export const GAP0 = 3.2;
/** Желаемый временной интервал до передней машины, с. */
export const HEADWAY = 1.3;
/** Длина машины, м: зазор считается от бампера, а не от середины. */
export const LENGTH = 4.4;

/** Сколько метров за серединой узла считается «перекрёсток пройден». */
const CLEAR = 12;
/** За сколько секунд ожидания на перекрёстке водитель перестаёт уступать. */
const PATIENCE = 6;
/**
 * Запас времени, с которым водитель соглашается пересечь чужой путь, с.
 * Дорожная инженерия (HCM) даёт критический промежуток 4.5 с для поворота
 * налево — но в него входит и само время пересечения. Своё время машина
 * считает отдельно, поэтому здесь остаётся только запас.
 */
const CRITICAL = 2.2;
/** Половина длины машины: ею она занимает точку конфликта. */
const HALF = LENGTH / 2;
/** Половина ширины машины. */
const WIDE = 0.975;
/**
 * Ближе этого два пути через перекрёсток считаются пересекающимися, м.
 * Это НЕ на глаз: столкновение — наложение габаритов 4.4 × 1.95 м, и центры
 * при нём расходятся самое большее на sqrt(4.4² + 1.95²) ≈ 4.8. Путь, который
 * проходит дальше, задеть не может.
 */
const RUB = 4.8;

/**
 * С какого расстояния машина считается ДОЕХАВШЕЙ до своего кармана.
 *
 * Одно число на два решения: с него же начинается съезд вбок и по нему же
 * засчитывается «встал». Пока их было два — 3 метра на съезд и 4.5 на «встал»,
 * — получалась щель: модель следования оставляет машину в 3.2 м от точки,
 * то есть она уже не съезжает вбок, но ещё не встала. Такая замирала прямо
 * в полосе навсегда, а за ней вставал весь выезд с перекрёстка, и город
 * запирало на девяносто секунд. Щель между двумя числами об одном и том же —
 * это не баг, который ловят проверкой, это баг, который убирают.
 */
const ДОЕХАЛ = 4.5;

export interface Mover {
  shape: number;
  s: number;
  dir: number;
  speed: number;
  yaw: number;
  colour: number;
  /**
   * Кто этот водитель по торопливости: 0 — самый смирный, 1 — самый лихой.
   * Это ЕГО место в потоке, а не скорость: скорость получается из него
   * и из ограничения на дороге. Личная черта, не меняется.
   */
  haste: number;
  /**
   * Скорость, которую он считает своей на нынешней дороге, м/с. Не отдельная
   * правда, а следствие: пересчитывается из `haste` и знака каждый раз,
   * когда машина попадает на другую дорогу.
   */
  cruise: number;
  /**
   * Сколько метров вправо от осевой линии. Это НАСТОЯЩЕЕ положение кузова
   * поперёк дороги: при перестроении оно плавно переползает с полосы
   * на полосу, у припаркованной стоит в кармане.
   */
  across: number;
  /**
   * Номер полосы, на которую машина едет: 0 — самая правая по ходу.
   * Не то же, что `across`: `across` — где кузов сейчас, `lane` — куда он
   * стремится. Пока они не совпали, машина перестраивается.
   */
  lane: number;
  /**
   * Хозяин: номер жителя, которому принадлежит машина, или −1 — ничья.
   *
   * Это и есть ответ на «машины на парковке не должны быть декоративными».
   * Декоративность — не свойство машины, а следствие того, что у стоянки
   * нет причины. У хозяина причина есть: он дома или на работе. НИЧЬЯ МАШИНА
   * НЕ ПАРКУЕТСЯ ВООБЩЕ — ей негде взять причину, и «стоит просто так»
   * записать негде.
   */
  хозяин: number;
  /**
   * До какого часа суток хозяин будет внутри, когда доедет. `null` — ехать
   * ему некуда, значит и вставать незачем.
   */
  доЧаса: number | null;
  /**
   * Куда едет. `null` — не едет никуда конкретно (ничья машина на голой
   * сцене): такая выбирает повороты наугад и не паркуется вовсе.
   *
   * Пока маршрута не было, «приехал» сказать было нельзя — приезжать
   * некуда, — и машина парковалась где придётся, простаивая до чужого часа.
   */
  маршрут: Маршрут | null;
  /**
   * Место в кармане. `доЧаса` — час суток, когда хозяин выйдет; до него
   * машина стоит. Раньше здесь был обратный отсчёт `8 + случайно × 25`
   * секунд, то есть стоянка без причины.
   */
  park: { bay: number; phase: 'въезжает' | 'стоит' | 'выезжает'; доЧаса: number } | null;
  /**
   * Куда поедем через ближайший перекрёсток. Решение принимается НА ПОДЪЕЗДЕ,
   * а не в точке въезда: пока путь неизвестен, нельзя сказать, пересекается
   * ли он с чужим, и остаётся только запрещать перекрёсток целиком.
   *
   * Пока маршрут есть, `s` продолжает расти за конец дороги — это и значит
   * «машина внутри перекрёстка». Отдельного состояния «внутри» нет, и потому
   * «машина одновременно на дороге и в перекрёстке» невыразимо.
   */
  route: Route | null;
  /** Сколько секунд стоим и уступаем. Против вечного взаимного «после вас». */
  wait: number;
  /**
   * Сбитая машина. Пока это есть, она НЕ участник движения, а тело: катится,
   * тормозит о дорогу и стоит. Полосой её больше не ведёт ничто — правила
   * к телу неприменимы, и это не особый случай в правилах, а другое
   * состояние: «сбит» и «едет по полосе» одновременно невыразимы.
   *
   * Пока она катится, её место на полосе (shape, s, across) не хранится,
   * а КАЖДЫЙ ШАГ вычисляется из настоящего положения тела. Иначе у неё
   * было бы два положения сразу, и они разошлись бы.
   */
  knocked: Knocked | null;
  /** Что сейчас держит: для приборки и проверок. */
  reason: string;
  /**
   * Ускорение, с которым едет прямо сейчас, м/с². Не второе состояние,
   * а опубликованный итог шага — из него берутся стоп-сигналы, и из него же
   * видно в приборке, кто тормозит.
   */
  accel: number;
  /**
   * Своё зерно случайности. Общий Math.random() делал каждый прогон другим,
   * и проверка переставала быть повторяемой: одна и та же поломка то ловилась,
   * то нет. Теперь выбор поворота зависит только от машины и её пути.
   */
  seed: number;
}

/** Сбитое тело: где оно, куда летит и сколько уже стоит. */
export interface Knocked {
  x: number; z: number; yaw: number;
  vx: number; vz: number;
  /** Вращение вокруг вертикали, рад/с. */
  spin: number;
  /** Сколько секунд стоит почти неподвижно: через это водитель приходит в себя. */
  still: number;
}

/**
 * Путь через перекрёсток: с какой дороги на какую и в какую сторону.
 * Сама кривая не хранится, а считается из этих трёх чисел — хранимая
 * разошлась бы с дорогой, если та изменится.
 */
export interface Route {
  readonly junction: number;
  readonly shape: number;
  readonly s: number;
  readonly dir: number;
  /** На какую полосу выезжаем: 0 — самая правая по ходу. */
  readonly lane: number;
}

/** Кто-то на дороге: этого хватает, чтобы спросить про светофор впереди. */
export interface OnRoad { readonly shape: number; readonly s: number; readonly dir: number }

interface Link { shape: number; s: number }
/** Конец дороги: в какой узел упирается и какой веткой светофора является. */
interface End { junction: number; signal: number; approach: number }

/** Карман у бордюра: где машина может встать. */
export interface Bay {
  readonly shape: number;
  readonly s: number;
  /** Сколько метров вправо от осевой при движении по возрастанию s. */
  readonly across: number;
  /** Кто занял: индекс машины или −1. */
  taken: number;
}

export interface Network {
  readonly length: number[];
  readonly atJunction: Link[][];
  readonly nodes: { s: number; junction: number }[][];
  readonly signals: Signal[];
  /** По дороге: конец при s=0 и конец при s=длина. */
  readonly ends: (End | null)[][];
  /** Карманы у бордюра по всему городу. */
  readonly bays: Bay[];
  /** Полосы: где именно по каждой дороге можно ехать. */
  readonly lanes: Lanes;
  /** Знаки: ограничения скорости и приоритет дорог. */
  readonly signs: Signs;
  /** Насколько каждый перекрёсток простирается от своей середины, м. */
  readonly reach: readonly number[];
}

export function buildNetwork(world: World): Network {
  const length = world.shapes.map((sh) => sh.stations.at(-1)?.s ?? 0);
  const atJunction: Link[][] = world.junctions.map(() => []);
  const nodes: { s: number; junction: number }[][] = world.shapes.map(() => []);

  world.junctions.forEach((j, ji) => {
    world.shapes.forEach((shape, si) => {
      let best = Infinity, bestS = 0;
      for (const st of shape.stations) {
        const d = Math.hypot(st.x - j.x, st.z - j.z);
        if (d < best) { best = d; bestS = st.s; }
      }
      if (best < 6) {
        atJunction[ji].push({ shape: si, s: bestS });
        nodes[si].push({ s: bestS, junction: ji });
      }
    });
  });
  for (const list of nodes) list.sort((a, b) => a.s - b.s);

  /**
   * Размер каждого перекрёстка: по самой широкой из сходящихся дорог.
   * От него, а не от своей ширины, отсчитываются все стоп-линии.
   */
  const reach = world.junctions.map((_, ji) => junctionReach(world, atJunction[ji]));
  const signals = buildSignals(world, reach);
  const ends: (End | null)[][] = world.shapes.map(() => [null, null]);
  world.shapes.forEach((shape, si) => {
    const total = length[si];
    for (const [slot, atS] of [[0, 0], [1, total]] as const) {
      const node = nodes[si].find((n) => Math.abs(n.s - atS) < 8);
      if (node === undefined) continue;
      let signal = -1, approach = -1;
      signals.forEach((sig, sgi) => {
        if (sig.junction !== node.junction) return;
        const ai = sig.approaches.findIndex((a) => a.shape === si && Math.abs(a.s - atS) < 1);
        if (ai >= 0) { signal = sgi; approach = ai; }
      });
      ends[si][slot] = { junction: node.junction, signal, approach };
    }
  });

  /**
   * Карманы у бордюра. Только на широких улицах: на однополосной карман
   * пришёлся бы ровно на полосу движения. У перекрёстков карманов нет —
   * там переходы и обзор.
   */
  const bays: Bay[] = [];
  const lanes = buildLanes(world);
  world.shapes.forEach((shape, si) => {
    if (shape.halfWidth < 6) return;
    const total = length[si];
    const edge = shape.outerHalf + 4;
    /**
     * Шаг карманов — длина кузова плюс место на манёвр. Было 6.5 м, то есть
     * между двумя занятыми карманами оставалось два метра: въехать боком туда
     * физически нельзя, и машина, выбравшая такой карман, вставала посреди
     * полосы навсегда, а за ней вся улица. Девять метров — это 4.4 кузова
     * и 4.6 на заезд.
     */
    for (let at = edge; at < total - edge; at += 9) {
      if (nodes[si].some((n) => Math.abs(n.s - at) < shape.outerHalf + 6)) continue;
      /**
       * Карман — это ПРАВАЯ ПОЛОСА, а не полоска у бордюра. Отдельного места
       * для стоянки на наших улицах нет: полосы движения занимают полотно
       * целиком. Так и в жизни — стоящая машина перегораживает правую полосу,
       * и её объезжают. Прежнее «полуширина минус 1.4» попадало внутрь той же
       * полосы, только мимо её середины, и машины налезали друг на друга.
       */
      for (const dir of [1, -1] as const) {
        const side = lanes[si].forward.length > 0 || lanes[si].backward.length > 0
          ? (dir > 0 ? lanes[si].forward : lanes[si].backward) : [];
        if (side.length === 0) continue;
        bays.push({ shape: si, s: at, across: side[0].across, taken: -1 });
      }
    }
  });

  const signalled = new Set(signals.map((sg) => sg.junction));
  const signs = buildSigns(world, atJunction, signalled,
    (si) => Math.max(lanes[si].forward.length, lanes[si].backward.length));

  return { length, atJunction, nodes, signals, ends, bays, lanes, signs, reach };
}

/** Где дорога в этом месте и куда она смотрит. */
export function along(world: World, shape: number, s: number): { x: number; z: number; fx: number; fz: number } {
  const st = world.shapes[shape].stations;
  const total = st.at(-1)?.s ?? 0;
  const t = Math.max(0, Math.min(total, s));
  /**
   * Нужный отрезок ищется ДЕЛЕНИЕМ ПОПОЛАМ, а не перебором с начала.
   *
   * Станции идут через ровные два метра, и на двухсотметровой улице их сотня.
   * Перебор с начала стоил в среднем полсотни шагов НА КАЖДЫЙ ВЫЗОВ, а зовут
   * эту функцию все: каждый пешеход по пять раз за кадр, каждая машина, каждая
   * поза, каждая проверка. Замерено: на проверке жителей это было больше
   * половины всего времени.
   *
   * Отрезок выбирается ТОТ ЖЕ САМЫЙ — это не приближение, а тот же ответ,
   * найденный быстрее: ищем наименьшее i, у которого конец отрезка уже
   * дальше t, и не выходим за предпоследнюю станцию.
   */
  let низ = 0, верх = st.length - 2;
  while (низ < верх) {
    const середина = (низ + верх) >> 1;
    if (st[середина + 1].s >= t) верх = середина; else низ = середина + 1;
  }
  const i = низ;
  const a = st[i], b = st[i + 1];
  const k = (t - a.s) / Math.max(1e-6, b.s - a.s);
  const dx = b.x - a.x, dz = b.z - a.z;

  /**
   * Направление берётся из НОРМАЛЕЙ СТАНЦИЙ и плавно перетекает между ними,
   * а не из хорды отрезка.
   *
   * Хорда даёт направление СТУПЕНЬКОЙ: на середине дороги оно одно, а через
   * два метра, за станцией, другое. Сама осевая от этого не страдает — она
   * и есть ломаная. Страдает всё, что от неё СМЕЩЕНО: тротуар, полосы,
   * карман у бордюра. На повороте точка в пяти метрах от оси прыгала вбок
   * на полметра при каждой станции — замерено на «каше», 47.5 см за кадр.
   * То есть пешеход дёргался, а машина в левой полосе виляла.
   *
   * Нормаль станции — та же, которой режется полотно в `surface/`. Значит
   * тротуар пешехода и тротуар на картинке считаются одним и тем же, и
   * разойтись им негде.
   */
  const nx = a.nx + (b.nx - a.nx) * k;
  const nz = a.nz + (b.nz - a.nz) * k;
  const len = Math.hypot(nx, nz);
  if (len < 1e-6) {
    const chord = Math.hypot(dx, dz) || 1;
    return { x: a.x + dx * k, z: a.z + dz * k, fx: dx / chord, fz: dz / chord };
  }
  // «вперёд» — перпендикуляр к нормали; из двух берём тот, что смотрит по ходу s
  let fx = nz / len, fz = -nx / len;
  if (fx * dx + fz * dz < 0) { fx = -fx; fz = -fz; }
  return { x: a.x + dx * k, z: a.z + dz * k, fx, fz };
}

/**
 * На какой дороге и на каком её метре оказалась произвольная точка мира.
 *
 * Считает город, а не дорога: дорога про городскую жизнь ничего не знает
 * и знать не должна. Нужно это ровно для одного — чтобы трафик видел машину
 * игрока и вёл себя так, будто она тоже участник движения.
 */
export function locate(world: World, x: number, z: number):
{ shape: number; s: number; across: number; fx: number; fz: number } | null {
  let best: { shape: number; s: number; across: number; fx: number; fz: number } | null = null;
  let bestDist = Infinity;
  world.shapes.forEach((shape, si) => {
    const st = shape.stations;
    for (let i = 0; i + 1 < st.length; i++) {
      const dx = st[i + 1].x - st[i].x, dz = st[i + 1].z - st[i].z;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-9) continue;
      let t = ((x - st[i].x) * dx + (z - st[i].z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = st[i].x + dx * t, pz = st[i].z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d >= bestDist) continue;
      const len = Math.sqrt(len2);
      const fx = dx / len, fz = dz / len;
      bestDist = d;
      best = {
        shape: si,
        s: st[i].s + t * (st[i + 1].s - st[i].s),
        // право по ходу возрастания s — это (−fz, fx)
        across: -(x - px) * fz + (z - pz) * fx,
        fx, fz,
      };
    }
  });
  return bestDist > 40 ? null : best;
}

/**
 * СТОИТ — значит не участник движения, а препятствие.
 *
 * Одно определение на весь проект, и это не удобство. За один вечер четыре
 * разных места независимо перепутали «стоит» и «едет», и каждое давало свой
 * тупик: очередь не объезжала припаркованную, выезжающий уступал стоящему,
 * разворот ждал припаркованную у обочины, а въезд на перекрёсток считал
 * припаркованную за ним затором — и не пускал туда никого НИКОГДА.
 *
 * Пока определение одно, «в одном месте она участник, в другом препятствие»
 * записать негде.
 */
export const стоит = (m: Mover): boolean =>
  m.park?.phase === 'стоит' || m.knocked !== null;

/** Насколько круто дорога заворачивает здесь: радиус в метрах. */
function radius(world: World, shape: number, s: number): number {
  const back = along(world, shape, s - 5), fwd = along(world, shape, s + 5);
  const turn = Math.atan2(fwd.fz, fwd.fx) - Math.atan2(back.fz, back.fx);
  const wrapped = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  return wrapped < 1e-4 ? 1e5 : 10 / wrapped;
}

export const COLOURS = [0x9fa5ab, 0x2b3a4a, 0x7d2b2b, 0xd8d3c6, 0x35513f, 0x1c1e22, 0x8a7b4f];

export function placeTraffic(world: World, net: Network, count: number, seed = 1): Mover[] {
  let rnd = (seed * 16807) % 2147483647;
  const next = (): number => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };

  for (const b of net.bays) b.taken = -1; // карманы освобождаются вместе с трафиком
  const movers: Mover[] = [];
  for (let attempt = 0; attempt < count * 40 && movers.length < count; attempt++) {
    const shape = Math.floor(next() * world.shapes.length) % world.shapes.length;
    const total = net.length[shape];
    if (total < 30) continue;
    const dir = next() < 0.5 ? 1 : -1;
    const s = 10 + next() * (total - 20);
    if (movers.some((o) => o.shape === shape && o.dir === dir && Math.abs(o.s - s) < 16)) continue;
    // не ставим машину на подъезде к перекрёстку: она родится на ходу перед
    // стоп-линией и проедет на красный, ещё не сделав ни одного решения
    if (net.nodes[shape].some((n) => Math.abs(n.s - s) < 26)) continue;
    const spot = along(world, shape, s);
    movers.push({
      shape, s, dir, speed: 8 + next() * 5, wait: 0, reason: 'едет', accel: 0,
      seed: Math.floor(next() * 2147483647),
      lane: 0,
      across: 0,   // ставится ниже, когда полоса выбрана
      // ничья машина: ехать ей есть куда, а вставать негде и незачем
      хозяин: -1, доЧаса: null, маршрут: null,
      park: null,
      route: null,
      knocked: null,
      haste: next(),
      cruise: CRUISE,
      yaw: Math.atan2(spot.fz * dir, spot.fx * dir),
      colour: COLOURS[Math.floor(next() * COLOURS.length) % COLOURS.length],
    });
    // полоса выбирается из тех, что есть у этой дороги в эту сторону,
    // и кузов сразу ставится в её середину
    const last = movers[movers.length - 1];
    const count = laneCount(net.lanes, shape, dir as 1 | -1);
    last.lane = count <= 1 ? 0 : Math.floor(next() * count) % count;
    last.across = laneAcross(net.lanes, shape, dir as 1 | -1, last.lane);
    retune(net, last);
  }
  return movers;
}

/** Свой генератор: одна и та же машина в одном и том же месте решит одинаково. */
function roll(m: Mover): number {
  // Лемер: множитель подобран так, чтобы произведение оставалось в пределах
  // целых, которые число с плавающей точкой хранит ТОЧНО. Прежний множитель
  // 1103515245 переполнял их, последовательность вырождалась, и парковаться
  // не хотел никто: «случайное» число просто перестало меняться.
  m.seed = (m.seed * 16807) % 2147483647;
  return m.seed / 2147483647;
}

/** Середина полосы, на которую эта машина едет. */
function laneMid(net: Network, m: Mover): number {
  return laneAcross(net.lanes, m.shape, m.dir as 1 | -1, m.lane);
}

/** Середина своей полосы на этом метре дороги, и куда она смотрит. */
function lanePoint(world: World, net: Network, shape: number, s: number, dir: number, lane: number):
{ x: number; z: number; fx: number; fz: number } {
  const spot = along(world, shape, s);
  const off = laneAcross(net.lanes, shape, dir as 1 | -1, lane);
  return { x: spot.x - spot.fz * off, z: spot.z + spot.fx * off, fx: spot.fx * dir, fz: spot.fz * dir };
}

/** Метр, на котором дорога кончается и начинается перекрёсток. */
function mouthAt(net: Network, junction: number, shape: number, s: number, dir: number): number {
  void shape;
  return stopLine(net.reach[junction], s, dir);
}

/** Свой въезд в перекрёсток: метр, за которым машина уже внутри. */
function myMouth(world: World, net: Network, m: Mover): number {
  void world;
  const slot = m.dir > 0 ? 1 : 0;
  const end = net.ends[m.shape][slot];
  if (end === null) return m.dir > 0 ? net.length[m.shape] : 0;
  return mouthAt(net, end.junction, m.shape, m.dir > 0 ? net.length[m.shape] : 0, m.dir);
}

/** Сколько метров пути через перекрёсток уже позади. Меньше нуля — ещё не въехал. */
function inside(world: World, net: Network, m: Mover): number {
  return (m.s - myMouth(world, net, m)) * m.dir;
}

/** Ломаная пути через перекрёсток: точки и метраж до каждой из них. */
export interface Path {
  readonly pts: readonly { x: number; z: number }[];
  readonly mark: readonly number[];
  readonly len: number;
  /** Курс на въезде и насколько круто поворачиваем: + направо, − налево. */
  readonly inYaw: number;
  readonly turn: number;
  /**
   * Круг, в который путь помещается целиком: середина и радиус.
   *
   * Нужен не для геометрии, а для скорости: два пути, чьи круги не задевают
   * друг друга, не могут сойтись ближе опасного расстояния, и перебирать
   * их точки попарно незачем. Замерено профилировщиком: на попарном переборе
   * путей город тратил больше половины всего времени.
   */
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
}

/** На сколько кусков режется кривая перекрёстка. Шаг выходит около полутора метров. */
const STEPS = 12;

/**
 * Путь через перекрёсток: кривая от своей стоп-линии до стоп-линии дороги,
 * на которую выезжаем. Она КАСАЕТСЯ своей полосы на въезде и своей полосы
 * на выезде — поэтому машина не срезает угол и не выползает на встречную,
 * а едет так, как ездят настоящие.
 *
 * Одно представление на всё: по нему машина едет, и им же считаются
 * пересечения с чужими путями. Второй геометрии перекрёстка в городе нет,
 * и «поехал не там, где считались конфликты» невыразимо.
 */
export function crossPath(
  world: World, net: Network, shape: number, dir: number, lane: number, r: Route,
): Path {
  const a = lanePoint(world, net, shape, mouthAt(net, r.junction, shape, dir > 0 ? net.length[shape] : 0, dir), dir, lane);
  const b = lanePoint(world, net, r.shape, mouthAt(net, r.junction, r.shape, r.s, -r.dir), r.dir, r.lane);
  // точка схода касательных: где продолжение въезда встречает продолжение выезда
  const det = a.fx * b.fz - a.fz * b.fx;
  let cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
  if (Math.abs(det) > 1e-4) {
    const t = ((b.x - a.x) * b.fz - (b.z - a.z) * b.fx) / det;
    /**
     * Точку схода касательных держим В ПРЕДЕЛАХ САМОГО УЗЛА. При пологом
     * угле встречи она уезжает далеко, кривая раздувается и выходит за
     * асфальт: машина поворачивает по газону. Дальше размера перекрёстка
     * ей быть негде — там уже не перекрёсток.
     */
    const far = net.reach[r.junction] * 1.6;
    if (t > 0 && t < far) { cx = a.x + a.fx * t; cz = a.z + a.fz * t; }
  }
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, z: u * u * a.z + 2 * u * t * cz + t * t * b.z });
  }
  /**
   * Метки вдоль пути и круг вокруг него считаются ОДНИМ проходом. Функция
   * горячая — её зовут на каждую машину с маршрутом каждый шаг, — и лишний
   * проход по тринадцати точкам с `Math.hypot` тут виден в профиле.
   */
  const mark = [0];
  let minX = pts[0].x, maxX = pts[0].x, minZ = pts[0].z, maxZ = pts[0].z;
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
    mark.push(mark[i] + Math.sqrt(dx * dx + dz * dz));
    const q = pts[i + 1];
    if (q.x < minX) minX = q.x; else if (q.x > maxX) maxX = q.x;
    if (q.z < minZ) minZ = q.z; else if (q.z > maxZ) maxZ = q.z;
  }
  const inYaw = Math.atan2(a.fz, a.fx);
  const outYaw = Math.atan2(b.fz, b.fx);
  const полуX = (maxX - minX) / 2, полуZ = (maxZ - minZ) / 2;
  return {
    pts, mark, len: mark[mark.length - 1], inYaw, turn: wrap(outYaw - inYaw),
    cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
    r: Math.sqrt(полуX * полуX + полуZ * полуZ),
  };
}

/**
 * Куда сворачивает этот маршрут: + направо, − налево. Считается по курсам
 * дорог, а не по кривой, — поэтому его можно спросить ДО того, как кривая
 * построена, и выбрать по нему полосу выезда.
 */
function turnOf(world: World, net: Network, shape: number, dir: number, r: Route): number {
  const inS = mouthAt(net, r.junction, shape, dir > 0 ? net.length[shape] : 0, dir);
  const a = along(world, shape, inS);
  const b = along(world, r.shape, mouthAt(net, r.junction, r.shape, r.s, -r.dir));
  return wrap(Math.atan2(b.fz * r.dir, b.fx * r.dir) - Math.atan2(a.fz * dir, a.fx * dir));
}

/**
 * На какую полосу выезжать. ПДД 8.6: поворот направо выполняется так, чтобы
 * машина оказалась как можно ближе к правому краю. Налево — наоборот, в левую
 * из доступных: оттуда и поворачивают. Прямо — со своей же по счёту.
 */
function exitLane(world: World, net: Network, m: Mover, r: Route, changing: boolean): number {
  const count = laneCount(net.lanes, r.shape, r.dir as 1 | -1);
  if (count <= 1 || !changing) return 0;
  const turn = turnOf(world, net, m.shape, m.dir, r);
  if (turn > 0.35) return 0;                       // направо — в правую
  if (turn < -0.35) return count - 1;              // налево — в левую
  return Math.min(m.lane, count - 1);              // прямо — со своей же
}

/** Разница углов в пределах ±180°. */
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Где машина на пути через перекрёсток, проехав столько метров. */
function alongPath(path: Path, at: number): { x: number; z: number; yaw: number } {
  const d = Math.max(0, Math.min(path.len, at));
  let i = 0;
  while (i + 2 < path.pts.length && path.mark[i + 1] < d) i++;
  const span = Math.max(1e-6, path.mark[i + 1] - path.mark[i]);
  const k = (d - path.mark[i]) / span;
  const p = path.pts[i], q = path.pts[i + 1];
  return { x: p.x + (q.x - p.x) * k, z: p.z + (q.z - p.z) * k, yaw: Math.atan2(q.z - p.z, q.x - p.x) };
}

/** Кузов на плоскости: середина и куда смотрит. */
export interface Box { readonly x: number; readonly z: number; readonly yaw: number }

/**
 * Насколько два кузова далеки от касания: меньше единицы — уже наложились,
 * единица — впритирку, два — вдвое дальше, чем нужно.
 *
 * ОДНО определение столкновения на весь проект: им пользуется и город,
 * решая, можно ли ехать, и проверка, решая, столкнулись ли. Пока определений
 * было два, они и расходились: город считал, что проехал, а проверка — что
 * задел, и оба были по-своему правы.
 *
 * Считается честно, по осям обоих кузовов: прямоугольники не пересекаются
 * тогда и только тогда, когда их тени не пересекаются хотя бы на одной
 * из четырёх осей.
 */
export function touching(a: Box, b: Box): number {
  return contact(a, b).apart;
}

/**
 * Полное касание: насколько далеко до него, по какой оси кузова разошлись
 * бы легче всего и на сколько они перекрылись. Ось наименьшего перекрытия —
 * это и есть нормаль удара: по ней их и растаскивать, по ней и толкать.
 */
export function contact(a: Box, b: Box): { apart: number; nx: number; nz: number; depth: number } {
  const af = { x: Math.cos(a.yaw), z: Math.sin(a.yaw) };
  const bf = { x: Math.cos(b.yaw), z: Math.sin(b.yaw) };
  const dx = b.x - a.x, dz = b.z - a.z;
  // прямоугольники НЕ пересекаются, если развела хоть одна ось, — значит
  // «далеко от касания» это самая РАЗВОДЯЩАЯ ось, а не самая тесная
  let apart = 0, nx = 1, nz = 0, depth = 0;
  for (const u of [af, { x: -af.z, z: af.x }, bf, { x: -bf.z, z: bf.x }]) {
    const reach = (f: { x: number; z: number }): number =>
      Math.abs(u.x * f.x + u.z * f.z) * HALF + Math.abs(-u.x * f.z + u.z * f.x) * WIDE;
    const span = reach(af) + reach(bf);
    const gap = dx * u.x + dz * u.z;
    const k = Math.abs(gap) / span;
    if (k > apart) {
      apart = k;
      depth = span - Math.abs(gap);
      // нормаль смотрит ОТ a К b: по ней b выталкивают наружу
      const sign = gap >= 0 ? 1 : -1;
      nx = u.x * sign; nz = u.z * sign;
    }
  }
  return { apart, nx, nz, depth };
}

/**
 * С какого метра пути чужой кузов начинает мешать, и на каком метре он стоит.
 *
 * «Мешает» меряется ТЕМ ЖЕ наложением габаритов, которым меряется
 * столкновение: 4.4 м вдоль машины и 1.95 поперёк. Простое расстояние
 * до точки тут не годится — машина поперёк пути и машина вдоль него
 * загораживают совсем разное, а расстояние у них одинаковое.
 */
function blockAt(path: Path, body: Box): { at: number; centre: number } {
  let at = Infinity, centre = 0, near = Infinity;
  for (let i = 0; i < path.pts.length; i++) {
    const p = path.pts[i];
    const q = path.pts[Math.min(i + 1, path.pts.length - 1)];
    const r = path.pts[Math.max(i - 1, 0)];
    const straight = Math.hypot(body.x - p.x, body.z - p.z);
    if (straight < near) { near = straight; centre = path.mark[i]; }
    // мой кузов, поставленный на этот метр пути, против его кузова
    const me = { x: p.x, z: p.z, yaw: Math.atan2(q.z - r.z, q.x - r.x) };
    if (touching(me, body) < 1.15 && path.mark[i] < at) at = path.mark[i];
  }
  return { at, centre };
}

/**
 * Самое тесное место двух путей: метр по каждому и просвет между ними.
 * Меряется сближение, а не пересечение: два пути, расходящиеся в полуметре,
 * геометрически не пересекаются, но машины по ним столкнутся.
 */
function nearest(a: Path, b: Path): { at: number; foe: number; gap: number } {
  /**
   * Берётся ПЕРВОЕ опасное место по ходу, а не самое тесное. Раньше бралось
   * самое тесное — и это врало там, где два пути не пересекаются в точке,
   * а сходятся на длинном куске: на многополосном узле «самое тесное»
   * оказывается в конце схождения, машины считают, что встретятся позже,
   * чем встречаются, и въезжают друг в друга по дороге туда.
   */
  /**
   * ОТСЕЧКА ПО КРУГАМ. Если круги двух путей не задевают друг друга даже
   * с запасом в опасное расстояние, ни одна пара точек ближе него не будет.
   * Оба, кто спрашивает, сравнивают просвет только с этим порогом — значит
   * ответ «дальше порога» для них тот же самый, и перебирать 169 пар
   * незачем. Замерено: попарный перебор занимал 52% всего времени города.
   */
  const между = Math.hypot(a.cx - b.cx, a.cz - b.cz);
  if (между > a.r + b.r + RUB) return { at: 0, foe: 0, gap: Infinity };

  /**
   * Внутри считается КВАДРАТ расстояния, а корень берётся один раз в конце.
   * `Math.hypot` защищён от переполнения и оттого медленный, а нам нужно
   * сравнение, которому корень не нужен.
   */
  let first: { at: number; foe: number; gap: number } | null = null;
  let best = { at: 0, foe: 0, gap: Infinity };
  const ОПАСНО = RUB * RUB;
  for (let i = 0; i < a.pts.length; i++) {
    const ax = a.pts[i].x, az = a.pts[i].z, at = a.mark[i];
    if (first !== null && at >= first.at) continue;   // ищем ПЕРВОЕ по ходу
    for (let k = 0; k < b.pts.length; k++) {
      const dx = ax - b.pts[k].x, dz = az - b.pts[k].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best.gap) best = { at, foe: b.mark[k], gap: d2 };
      if (d2 < ОПАСНО && (first === null || at < first.at)) {
        first = { at, foe: b.mark[k], gap: d2 };
      }
    }
  }
  const итог = first ?? best;
  return { at: итог.at, foe: итог.foe, gap: Math.sqrt(итог.gap) };
}

/**
 * Какую скорость этот водитель считает своей там, где на знаке столько-то.
 *
 * Числа не подобраны, а взяты из того, как ездят на самом деле:
 *  — ограничения ставят по 85-му процентилю, то есть ПО ПОСТРОЕНИЮ около 15%
 *    потока едет быстрее знака, и это норма, а не эпидемия;
 *  — из тех, кто превышает, подавляющее большинство превышает ТИПИЧНО:
 *    по ГИБДД за 2024 год 66,7% всех постановлений — превышение на 20–40 км/ч.
 *
 * Поэтому лихач у нас едет 80–100 там, где знак 60, а не 200. Отдельного
 * «этот водитель нарушитель» в правилах нет: нарушитель — это хвост
 * распределения, и он получается сам.
 */
function desiredSpeed(haste: number, limitKmh: number): number {
  const kmh = haste < 0.85
    ? limitKmh * (0.8 + (0.2 * haste) / 0.85)          // 80–100% от знака
    : limitKmh + 20 + (20 * (haste - 0.85)) / 0.15;    // +20…+40 сверх знака
  return kmh / 3.6;
}

/** Пересчитать желаемую скорость под дорогу, на которой машина оказалась. */
export function retune(net: Network, m: Mover): void {
  m.cruise = desiredSpeed(m.haste, net.signs.limit[m.shape]);
}

/** Сколько метров впереди смотрят, решая, не пора ли перестроиться. */
const SCAN = 55;
/** Насколько медленнее должен ехать лидер, чтобы его захотелось обогнать, м/с. */
const SLOWER = 2.5;

/**
 * Кто едет передо мной на этой линии и как быстро. null — свободно.
 * `line` — смещение поперёк дороги, а не номер полосы: так же можно
 * спросить и про соседнюю полосу, и про ту, где машина сейчас между полос.
 */
function aheadOn(movers: readonly Mover[], m: Mover, line: number, reach: number):
{ gap: number; speed: number; parked: boolean } | null {
  let best: { gap: number; speed: number; parked: boolean } | null = null;
  for (const o of movers) {
    if (o === m || o.shape !== m.shape) continue;
    if (o.knocked === null && o.dir !== m.dir) continue;
    if (Math.abs(o.across - line) > 2.2) continue;
    const gap = (o.s - m.s) * m.dir - LENGTH;
    /**
     * Отрицательный зазор — это УЖЕ НАЛОЖЕНИЕ КУЗОВОВ, а не «позади меня».
     *
     * Раньше такой случай просто пропускался: `gap < 0 → continue`. То есть
     * машина переставала видеть того, в кого уже въехала, и спокойно ехала
     * дальше сквозь него. Наложение от этого не рассасывалось, а росло.
     * Теперь зазор поджимается к нулю: въехал — тормози в пол, пока не
     * разъедетесь. Дальше −LENGTH это уже сосед позади, он не наш.
     */
    if (gap < -LENGTH || gap > reach) continue;
    const видимый = Math.max(0, gap);
    if (best === null || видимый < best.gap)
      best = { gap: видимый, speed: o.speed, parked: стоит(o) };
  }
  return best;
}

/**
 * Можно ли перестроиться на эту линию. Два условия, оба из MOBIL:
 * впереди хватает места, и тому, кто сзади, не придётся бить по тормозам.
 */
function laneSafe(movers: readonly Mover[], m: Mover, line: number): boolean {
  for (const o of movers) {
    if (o === m || o.shape !== m.shape) continue;
    if (o.knocked === null && o.dir !== m.dir) continue;
    if (Math.abs(o.across - line) > 2.2) continue;
    const gap = (o.s - m.s) * m.dir;
    if (gap >= 0 && gap < LENGTH + GAP0 + m.speed * 0.6) return false;      // впереди тесно
    if (gap < 0 && -gap < сзадиНадо(o)) return false;
  }
  return true;
}

/**
 * Кто стоит бок о бок со мной так, что ехать в его сторону нельзя.
 *
 * Возвращается СПИСОК, а не ближайший. С одним ответом получалось вот что:
 * машина между двумя соседями отходила «прочь от ближайшего» — то есть
 * прямо в того, второго, которого никто не спросил. Наложение кузовов
 * на 96% от касания ловилось именно так.
 */
function sideBlockers(movers: readonly Mover[], m: Mover): number[] {
  const из: number[] = [];
  for (const o of movers) {
    if (o === m || o.shape !== m.shape) continue;
    if (o.knocked === null && o.dir !== m.dir) continue;
    /**
     * Бок о бок — это про КУЗОВА, а не про дистанцию следования.
     *
     * Раньше здесь стояло `LENGTH + GAP0` — 7.6 метра, то есть машина
     * в семи метрах впереди считалась «стоящей рядом», хотя между кузовами
     * два с половиной метра чистого асфальта. Из-за этого получался клин:
     * машина между припаркованной справа и соседом слева-сзади не могла
     * шагнуть вбок НИКУДА — любой шаг считался «в сторону кого-то», — и
     * стояла до конца проверки вместе со всей очередью за собой.
     */
    if (Math.abs(o.s - m.s) > LENGTH + 1) continue;  // кузова разъехались — не мешает
    if (Math.abs(o.across - m.across) > 3.6) continue; // дальше полосы — не мешает
    из.push(o.across);
  }
  return из;
}

/**
 * На какую полосу машине надо. Считается каждый шаг из обстановки и нигде
 * не хранится: «поехал влево, а почему — забыл» невыразимо.
 *
 * Причины по убыванию силы, ровно как в ПДД и в модели перестроения MOBIL:
 *  8.5  — поворачивать надо из крайней полосы: направо из правой, налево из левой;
 *  препятствие — стоящая машина в моей полосе, её надо объехать;
 *  обгон — впереди заметно медленнее, а слева свободно;
 *  9.4  — держись правее, когда ничего не держит.
 */
function wantLane(world: World, net: Network, movers: readonly Mover[], m: Mover): number {
  const count = laneCount(net.lanes, m.shape, m.dir as 1 | -1);
  if (count <= 1) return 0;
  const left = count - 1;
  const line = (i: number): number => laneAcross(net.lanes, m.shape, m.dir as 1 | -1, i);
  /**
   * Есть ли такая полоса и свободна ли она.
   *
   * «Своя считается свободной всегда» — верно, но СВОЯ ЭТО ТА, ГДЕ КУЗОВ,
   * а не та, куда собрался. Пока машина между полосами, целевая ей ещё
   * не своя, и спрашивать про неё надо каждый шаг.
   *
   * Без этого получалось вот что: машина решила перестроиться, когда сзади
   * было чисто, поехала вбок — и перестала перепроверять. Сзади подъезжал
   * сосед, а она считала полосу своей и продолжала вползать. Поймано 17.09
   * наложением кузовов на 88% от касания на сцене «город» (до этого запас
   * был 114% — беда лежала рядом и ждала любой перестановки в городе).
   */
  const вСвоей = Math.abs(m.across - line(m.lane)) < 1.0;
  const свободна = (to: number): boolean =>
    to >= 0 && to <= left
    && ((to === m.lane && вСвоей) || laneSafe(movers, m, line(to)));
  const mine = aheadOn(movers, m, line(m.lane), SCAN);

  /**
   * КУДА ХОЧЕТСЯ. Здесь только желания, и ни одно из них не спрашивает,
   * свободна ли полоса: это решает последняя строка, одна на всех.
   */
  const хочет = ((): number => {
    /**
     * ПРЕПЯТСТВИЕ РАЗБИРАЕТСЯ ПЕРВЫМ — раньше запрета перестраиваться в очереди.
     *
     * Стоящего надо объезжать, ждать его бессмысленно: он не поедет. А запрет
     * «в очереди на месте не перестраиваются» касается ОЧЕРЕДИ — потока,
     * который сам вот-вот тронется. Пока эти два правила стояли в обратном
     * порядке, получался тупик: машина останавливалась перед припаркованной,
     * а остановившись, переставала иметь право её объехать. Ловилось на живом
     * городе — очередь из шести машин стояла за одной стоящей всю проверку.
     *
     * Здесь и только здесь спрашивается про свободу заранее: из двух сторон
     * объезда надо выбрать ту, куда можно.
     */
    if (mine !== null && mine.parked && mine.gap < 40) {
      for (const to of [m.lane + 1, m.lane - 1]) if (свободна(to)) return to;
      return m.lane;
    }

    /**
     * В очереди на месте не перестраиваются. Не запрет ради запрета: пока
     * машина еле ползёт, соседи вокруг неё двигаются быстрее, чем она успевает
     * переехать вбок, и проверка «там свободно» устаревает прямо посреди
     * манёвра. Живые водители в пробке тоже стоят в своей полосе.
     */
    if (m.speed < 2) return m.lane;

    // 8.5: поворот выполняется из крайней полосы, и решение принимается заранее
    const ahead = nextJunction(world, net, m);
    if (m.route !== null && ahead !== null && ahead.stopGap < 70) {
      const turn = turnOf(world, net, m.shape, m.dir, m.route);
      if (turn > 0.35) return 0;
      if (turn < -0.35) return left;
    }

    // обгон: впереди заметно медленнее меня, а слева есть куда
    if (mine !== null && mine.speed < m.cruise - SLOWER && m.lane < left) {
      const to = m.lane + 1;
      const there = aheadOn(movers, m, line(to), SCAN);
      if (there === null || there.speed > mine.speed + 1) return to;
    }

    // 9.4: держись правее. Возвращаемся, только если справа не хуже
    if (m.lane > 0) {
      const to = m.lane - 1;
      const there = aheadOn(movers, m, line(to), SCAN);
      if (there === null || there.speed >= Math.min(m.cruise, m.speed) - 0.5) return to;
    }
    return m.lane;
  })();

  /**
   * ЕДИНСТВЕННАЯ ДВЕРЬ. Перестроиться можно ТОЛЬКО в свободную полосу, и
   * проверка стоит здесь одна на все желания сразу.
   *
   * Раньше каждое правило спрашивало про свободу само — и одно не спросило:
   * «поворот выполняется из крайней полосы» уводило машину в крайнюю,
   * не глядя, кто там. Найдено наложением кузовов на 99% от касания: машина
   * переползала в полосу тому, кто ехал в четырёх метрах позади неё. Пока
   * дверей три, четвёртая когда-нибудь опять окажется без замка.
   */
  if (свободна(хочет)) return хочет;
  /**
   * В полосу, куда переезжал, стало нельзя. Значит назад — в ту, где кузов.
   * Остаться «в целевой» было бы враньём: машина стоит между полосами,
   * а считает, что уже перестроилась.
   */
  return вСвоей ? m.lane : laneAt(net.lanes, m.shape, m.dir as 1 | -1, m.across);
}

/** Куда машина смотрит и где стоит: правостороннее движение. */
export function poseOf(world: World, net: Network, m: Mover): { x: number; z: number; yaw: number } {
  if (m.knocked !== null) return { x: m.knocked.x, z: m.knocked.z, yaw: m.knocked.yaw };
  if (m.route !== null) {
    const at = inside(world, net, m);
    if (at > 0) return alongPath(crossPath(world, net, m.shape, m.dir, m.lane, m.route), at);
  }
  const spot = along(world, m.shape, m.s);
  const fx = spot.fx * m.dir, fz = spot.fz * m.dir;
  // across задан в осях дороги; право по ходу — это cross(вперёд, вверх)
  return {
    x: spot.x - spot.fz * m.across,
    z: spot.z + spot.fx * m.across,
    yaw: Math.atan2(fz, fx),
  };
}

/**
 * Куда машина стремится вбок: середина своей полосы или карман.
 *
 * К бордюру она начинает прижиматься только рядом с карманом. Если начать
 * раньше, машина едет по обочине весь квартал и задевает тех, кто уже стоит.
 */
function wantAcross(world: World, net: Network, m: Mover): number {
  const lane = laneMid(net, m);
  if (m.park === null || m.park.phase === 'выезжает') return lane;
  const bay = net.bays[m.park.bay];
  const gap = (bay.s - m.s) * m.dir;
  /**
   * Вбок машина уходит, только КОГДА ДОЕХАЛА до своего кармана. Раньше
   * она начинала за восемь метров — то есть напротив ЧУЖОГО, занятого
   * кармана, — и упиралась в стоящего боком, не доехав до своего.
   */
  return gap > ДОЕХАЛ ? lane : bay.across;
}

/**
 * Сколько места надо тому, кто сзади.
 *
 * У ЕДУЩЕГО — чтобы не пришлось бить по тормозам. У СТОЯЩЕГО тормозить
 * нечем: ему нужно только не быть задетым. Одно правило на всех, кто
 * спрашивает про место сзади, и это не удобство. Пока полный запас
 * требовался и для стоящего, получался тупик, причём дважды в разных
 * местах: машина не могла уйти из-под припаркованной, а выезжающий
 * из кармана ждал просвета в очереди, которую сам же и создал —
 * наполовину выехав в полосу и встав.
 */
const сзадиНадо = (o: Mover): number => (o.speed > 0.5
  ? LENGTH + GAP0 + o.speed * HEADWAY * 0.7
  : LENGTH + 0.8);

/**
 * Кто держит выезд из кармана: те, кто рядом и сзади в целевой полосе.
 *
 * Отдаётся наружу списком, а не «да/нет», потому что проверке нужно знать
 * не только «не уехал», но и КТО не пустил. Если держат только стоящие
 * машины — это не уступка потоку, а тупик: стоящей не уступают. Ровно
 * таким тупиком ряд припаркованных машин запирал сам себя, пока выезд
 * шёл по своей же полосе.
 *
 * Правило одно на обоих: машина решает по нему же, по чему её проверяют.
 */
export function ктоДержитВыезд(
  net: Network, movers: readonly Mover[], m: Mover,
): Mover[] {
  const lane = laneMid(net, m);
  return movers.filter((o) => {
    if (o === m || o.shape !== m.shape || o.dir !== m.dir) return false;
    if (Math.abs(o.across - lane) >= 2.4) return false;
    const сзади = (m.s - o.s) * m.dir;
    // впереди: не выехать в того, кто стоит прямо перед носом
    if (сзади < 0) return -сзади < LENGTH + GAP0;
    // сзади: подъезжающему нужен запас, стоящему — только не быть задетым
    return сзади < сзадиНадо(o);
  });
}

/** Свободна ли полоса рядом и сзади — чтобы выехать из кармана. */
function laneClear(world: World, net: Network, movers: readonly Mover[], m: Mover): boolean {
  return ктоДержитВыезд(net, movers, m).length === 0;
}

/** Точка впереди, которую надо пройти с такой скоростью. */
interface Hold { gap: number; speed: number; why: string }

/**
 * Модель следования: из списка точек впереди — одно ускорение.
 * Свободный член разгоняет к желаемой скорости, каждая точка тормозит тем
 * сильнее, чем ближе она и чем медленнее её надо пройти. Берётся самая
 * строгая — поэтому «красный», «машина впереди» и «крутой поворот»
 * не спорят между собой и не требуют ни одного особого случая.
 */
function follow(v: number, want: number, holds: readonly Hold[]): { accel: number; why: string } {
  const free = 1 - (v / Math.max(0.5, want)) ** 4;
  let worst = 0, why = 'едет';
  for (const h of holds) {
    const gap = Math.max(0.3, h.gap);
    const closing = v - h.speed;
    const desired = GAP0 + Math.max(0, v * HEADWAY + (v * closing) / (2 * Math.sqrt(ACCEL * BRAKE)));
    const term = (desired / gap) ** 2;
    if (term > worst) { worst = term; why = h.why; }
  }
  return { accel: ACCEL * (free - worst), why: worst > Math.max(0, free) ? why : 'едет' };
}

/**
 * За сколько секунд машина покроет столько метров, если поедет как обычно.
 * Стоящей нельзя мерить время как «путь делить на скорость»: скорость ноль,
 * любое время выходит бесконечным, и стоящий не трогается никогда.
 */
function timeToCover(d: number, v: number): number {
  if (d <= 0) return 0;
  return (-v + Math.sqrt(v * v + 2 * ACCEL * d)) / ACCEL;
}

/**
 * Сколько метров до перекрёстка впереди и что это за перекрёсток.
 * Стоп-линия берётся ОДНОЙ формулой, светофор там или нет: раньше у
 * нерегулируемого была своя константа, и край перекрёстка мерился двумя
 * способами — то есть когда-нибудь разошёлся бы.
 */
export function nextJunction(world: World, net: Network, m: OnRoad):
{ end: End; stopGap: number; centreGap: number } | null {
  const slot = m.dir > 0 ? 1 : 0;
  const end = net.ends[m.shape][slot];
  if (end === null) return null;
  const atS = slot === 1 ? net.length[m.shape] : 0;
  const stopS = stopLine(net.reach[end.junction], atS, m.dir);
  return { end, stopGap: (stopS - m.s) * m.dir, centreGap: (atS - m.s) * m.dir };
}

/**
 * Что машина видит перед собой на перекрёстке: для проверок и приборки.
 *
 * Принимает не Mover, а «кто-то на дороге»: тем же правилом смотрит на свой
 * светофор и чужая машина, и машина игрока. Второй копии правила «когда
 * это проезд на красный» в проекте нет и быть не должно.
 */
export function watch(world: World, net: Network, m: OnRoad, time: number): {
  junction: number; stopGap: number; centreGap: number; light: string;
} | null {
  const ahead = nextJunction(world, net, m);
  if (ahead === null) return null;
  const signal = ahead.end.signal >= 0 ? net.signals[ahead.end.signal] : null;
  const light = signal === null ? 'нерегулируемый'
    : lightFor(signal, signal.approaches[ahead.end.approach], time).light;
  return { junction: ahead.end.junction, stopGap: ahead.stopGap, centreGap: ahead.centreGap, light };
}

/** Сколько раз в секунду мигает поворотник: как в жизни, полтора. */
const BLINK = 1.5;

/**
 * Что машина показывает другим: поворотник и стоп-сигнал.
 *
 * Ничего из этого не хранится. Поворотник берётся из ТОГО ЖЕ маршрута,
 * по которому машина поедет, — поэтому «мигает налево, а свернула направо»
 * невыразимо, а не отлавливается. Стоп-сигнал — из ускорения, с которым
 * она едет прямо сейчас.
 *
 * ПДД 8.1: показывать заранее и прекратить сразу после манёвра. Маршрут
 * появляется за 45 метров до узла и пропадает на выезде — ровно это.
 */
export function signalsOf(world: World, net: Network, m: Mover, time: number):
{ blink: -1 | 0 | 1; brake: boolean } {
  const brake = m.accel < -0.4 && m.speed > 0.1;
  if (m.route === null || m.knocked !== null) return { blink: 0, brake };
  const path = crossPath(world, net, m.shape, m.dir, m.lane, m.route);
  // прямо — не мигаем: поворотник на «еду прямо» это не сигнал, а шум
  if (Math.abs(path.turn) < 0.35) return { blink: 0, brake };
  const on = Math.floor(time * BLINK * 2) % 2 === 0;
  return { blink: on ? (path.turn > 0 ? 1 : -1) : 0, brake };
}

/** Масса чужой машины, кг: обычный седан. */
const CAR_MASS = 1500;
/** Её момент инерции вокруг вертикали, кг·м². */
const CAR_SPIN = CAR_MASS * 1.2 * 1.2;
/**
 * Упругость удара кузова о кузов. Почти вся энергия уходит в мятое железо,
 * поэтому машины не отскакивают друг от друга, как бильярдные шары.
 */
const BOUNCE = 0.12;
/** С каким замедлением скользит сбитая машина: колёса поперёк, м/с². */
const SLIDE = 0.8 * G;

/**
 * Шаг сбитой машины: она просто катится и тормозит о дорогу. Место на полосе
 * при этом ВЫЧИСЛЯЕТСЯ из положения тела, а не хранится — иначе у неё было бы
 * два положения сразу. Остановилась и постояла — водитель пришёл в себя,
 * и она снова участник движения.
 */
function rollKnocked(
  world: World, net: Network, m: Mover, dt: number,
  переехал: (o: Mover, был: number) => void,
): void {
  const k = m.knocked as Knocked;
  const v = Math.hypot(k.vx, k.vz);
  if (v > 1e-6) {
    const drop = Math.min(v, SLIDE * dt) / v;
    k.vx -= k.vx * drop; k.vz -= k.vz * drop;
  }
  k.spin -= k.spin * Math.min(1, dt / 0.35);
  k.x += k.vx * dt; k.z += k.vz * dt; k.yaw += k.spin * dt;

  const at = locate(world, k.x, k.z);
  if (at !== null) {
    const был = m.shape;
    m.shape = at.shape;
    переехал(m, был);
    m.s = Math.max(0, Math.min(net.length[at.shape], at.s));
    m.across = at.across;
  }
  m.yaw = k.yaw;
  m.speed = Math.hypot(k.vx, k.vz);
  m.reason = 'сбит';
  m.accel = -SLIDE;

  k.still = m.speed < 0.4 ? k.still + dt : 0;
  if (k.still > 1.5) {
    // пришёл в себя: снова едет по своей полосе, в ту сторону, куда смотрит
    const axis = along(world, m.shape, m.s);
    m.dir = Math.cos(k.yaw) * axis.fx + Math.sin(k.yaw) * axis.fz >= 0 ? 1 : -1;
    // встаёт в ту полосу, к которой ближе всего оказался кузов
    m.lane = laneAt(net.lanes, m.shape, m.dir as 1 | -1, m.across);
    m.across = laneMid(net, m);
    m.route = null;
    m.park = null;
    m.speed = 0;
    m.knocked = null;
  }
}

/** Кто во что въехал: что от удара досталось машине игрока. */
export interface Hit {
  /** Прибавка к её скорости, м/с. */
  dvx: number; dvz: number;
  /** Прибавка к скорости вращения, рад/с. */
  dSpin: number;
  /** На сколько её выталкивает из перекрытия, м. */
  pushX: number; pushZ: number;
  /** Нормаль удара: вдоль неё летит импульс, по ней же он и сохраняется. */
  nx: number; nz: number;
  /** Сила удара: с какой скоростью кузова сходились, м/с. */
  force: number;
}

/**
 * УДАР машины игрока о чужую. Одно правило сохранения импульса, никаких
 * «если сзади — то», «если вбок — то»: направление берётся из той самой
 * оси, по которой кузова перекрылись меньше всего.
 *
 * Чужая машина от удара перестаёт быть участником движения и становится
 * телом. Машине игрока удар возвращается наружу: считать её движение —
 * дело машины, а не города.
 */
export function bump(
  world: World, net: Network, movers: Mover[],
  you: {
    x: number; z: number; yaw: number; vx: number; vz: number;
    yawRate: number; mass: number; inertia: number;
  },
): Hit | null {
  let worst: Hit | null = null;
  for (const m of movers) {
    const pose = poseOf(world, net, m);
    const hit = contact(you, pose);
    if (hit.apart >= 1) continue;

    // скорость чужой машины: по полосе или уже как тела
    const his = m.knocked !== null
      ? { vx: m.knocked.vx, vz: m.knocked.vz, spin: m.knocked.spin }
      : { vx: Math.cos(pose.yaw) * m.speed, vz: Math.sin(pose.yaw) * m.speed, spin: 0 };

    // точка касания — между серединами; плечи от неё до каждой середины
    const cx = (you.x + pose.x) / 2, cz = (you.z + pose.z) / 2;
    const rax = cx - you.x, raz = cz - you.z;
    const rbx = cx - pose.x, rbz = cz - pose.z;
    const n = { x: hit.nx, z: hit.nz };
    const vax = you.vx - you.yawRate * raz, vaz = you.vz + you.yawRate * rax;
    const vbx = his.vx - his.spin * rbz, vbz = his.vz + his.spin * rbx;
    const closing = (vax - vbx) * n.x + (vaz - vbz) * n.z;
    if (closing <= 0) continue;                       // уже расходятся

    const crossA = rax * n.z - raz * n.x;
    const crossB = rbx * n.z - rbz * n.x;
    const denom = 1 / you.mass + 1 / CAR_MASS
      + (crossA * crossA) / you.inertia + (crossB * crossB) / CAR_SPIN;
    const j = ((1 + BOUNCE) * closing) / denom;

    if (m.knocked === null) {
      m.knocked = { x: pose.x, z: pose.z, yaw: pose.yaw, vx: his.vx, vz: his.vz, spin: 0, still: 0 };
      m.route = null;
      if (m.park !== null) { net.bays[m.park.bay].taken = -1; m.park = null; }
    }
    const k = m.knocked;
    k.vx += (j * n.x) / CAR_MASS;
    k.vz += (j * n.z) / CAR_MASS;
    k.spin += (j * crossB) / CAR_SPIN;
    // растащить: перекрытие делится обратно пропорционально массам
    const share = (1 / CAR_MASS) / (1 / you.mass + 1 / CAR_MASS);
    k.x += n.x * hit.depth * share;
    k.z += n.z * hit.depth * share;

    const mine: Hit = {
      dvx: (-j * n.x) / you.mass, dvz: (-j * n.z) / you.mass,
      dSpin: (-j * crossA) / you.inertia,
      pushX: -n.x * hit.depth * (1 - share), pushZ: -n.z * hit.depth * (1 - share),
      nx: n.x, nz: n.z,
      force: closing,
    };
    if (worst === null || mine.force > worst.force) worst = mine;
  }
  return worst;
}

/** Пешеход, которого машина обязана пропустить. Знать о нём больше не нужно. */
export interface OnCrossing { shape: number; s: number }

export function moveTraffic(
  world: World, net: Network, movers: Mover[], dt: number, time: number,
  options: {
    headway?: boolean; rules?: boolean; crossing?: readonly OnCrossing[];
    /** Выключить перестроения: все едут в правой полосе, как было до 13.09. */
    lanes?: boolean;
    /** Машина игрока: город обязан её видеть, иначе он едет сквозь неё. */
    player?: { x: number; z: number; speed: number; yaw: number } | null;
    /**
     * Час суток. По нему припаркованная машина понимает, вышел ли хозяин.
     * Без него город живёт вне времени, и стоянка снова становится
     * случайным отсчётом.
     */
    час?: number;
    /**
     * `выезд: 'по своей полосе'` — выезжать из кармана вперёд по той же
     * полосе, как было до 15.09. Заведомо сломанный вариант: ряд стоящих
     * машин запирает сам себя, и город с утра не выезжает.
     */
    выезд?: 'по своей полосе';
  } = {},
): void {
  const headway = options.headway ?? true;
  const rules = options.rules ?? true;
  const changing = options.lanes ?? true;

  /**
   * КТО НА КАКОЙ ДОРОГЕ. Считается один раз за шаг, из самого списка машин.
   *
   * Зачем. Почти каждый вопрос машины к городу начинается со слов «а кто
   * на МОЕЙ дороге» — кто впереди, свободна ли соседняя полоса, кто стоит
   * бок о бок, есть ли затор за перекрёстком. Раньше каждый такой вопрос
   * перебирал ВСЕХ и тут же выбрасывал 99% первой же строкой `o.shape !==
   * m.shape`. От этого цена шага росла быстрее, чем число машин: на
   * «большом городе» удвоение с 400 до 800 стоило втрое дороже, а не вдвое.
   *
   * Почему это не второй источник правды. Список не хранится между шагами
   * и никем не правится: он собирается заново в начале каждого шага из
   * `movers`. Разойтись с истиной ему негде — он и есть та же истина,
   * разложенная по полкам.
   *
   * Почему ответ не меняется. Внутри каждой полки машины идут в том же
   * порядке, что и в общем списке, — один проход слева направо. А все, кого
   * полка не содержит, и так отсеивались первой строкой. Значит и «первый
   * из равных» остаётся тем же.
   */
  const наДороге: Mover[][] = net.length.map(() => []);
  for (const o of movers) наДороге[o.shape].push(o);

  /**
   * Машина сменила дорогу — значит сменила и полку.
   *
   * Это единственное место, где полки правятся, и зовут его ровно два
   * присваивания `m.shape` на весь город: выезд с перекрёстка и сбитая
   * машина, которую занесло на соседнюю улицу. Больше `m.shape` не меняет
   * никто, поэтому разъехаться полке с истиной негде.
   */
  const переехал = (o: Mover, был: number): void => {
    if (был === o.shape) return;
    const полка = наДороге[был];
    const i = полка.indexOf(o);
    if (i >= 0) полка.splice(i, 1);
    наДороге[o.shape].push(o);
  };

  /**
   * ПРЕДПРОХОД. Всё, что зависит от других машин, считается ДО того, как
   * кто-либо тронулся: занятость перекрёстков, свет каждому и очередь на
   * въезд. Иначе решение зависело бы от места в списке — а это тот самый
   * «а если сначала вон тот», который потом ловят месяцами.
   */
  const targets = movers.map((m) => nextJunction(world, net, m));

  /**
   * Машина игрока превращается в такого же участника: где она на дороге,
   * в какую сторону смотрит и с какой скоростью едет. Дальше она держит
   * тех, кто за ней, и занимает перекрёсток наравне со всеми.
   */
  const you = options.player == null ? null : (() => {
    const at = locate(world, options.player.x, options.player.z);
    if (at === null) return null;
    const p = options.player;
    const facing = Math.cos(p.yaw) * at.fx + Math.sin(p.yaw) * at.fz;
    const dir = facing >= 0 ? 1 : -1;
    return { shape: at.shape, s: at.s, across: at.across, dir, speed: Math.abs(p.speed), x: p.x, z: p.z, yaw: p.yaw };
  })();

  /** Стоит ли машина на своём светофоре. */
  const onRed = movers.map((m, i) => {
    const t = targets[i];
    if (t === null || t.end.signal < 0 || t.stopGap < -1) return false;
    const signal = net.signals[t.end.signal];
    const { light, left } = lightFor(signal, signal.approaches[t.end.approach], time);
    if (light === 'зелёный') return false;
    if (light === 'красный') return true;
    const canStop = t.stopGap > (m.speed * m.speed) / (2 * BRAKE) + 1;
    const clears = m.speed > 1 && (t.centreGap + CLEAR) / m.speed < left;
    return canStop && !clears;
  });

  /**
   * МАРШРУТ ВЫБИРАЕТСЯ НА ПОДЪЕЗДЕ. Пока машина не знает, куда поедет,
   * её путь через перекрёсток не существует — и приходится запрещать
   * перекрёсток целиком, по одной машине за раз. Как только путь есть,
   * два непересекающихся пути проезжаются одновременно, а два
   * пересекающихся разводятся во времени. Это и есть раздел 13 ПДД.
   */
  movers.forEach((m, i) => {
    if (m.route !== null || m.knocked !== null) return;
    /**
     * У ПРИПАРКОВАННОЙ МАРШРУТА ЧЕРЕЗ ПЕРЕКРЁСТОК НЕТ.
     *
     * Иначе получается состояние, которого быть не может: машина
     * одновременно «стоит в кармане» и «едет через узел». А из него —
     * настоящая беда: её путь считается занимающим перекрёсток, и все,
     * чей путь его пересекает, получают «путь занят» и стоят, пока хозяин
     * не выйдет. Поймано новой меркой простоя: у перекрёстка стояли
     * по девяносто секунд подряд.
     */
    if (m.park !== null) return;
    const t = targets[i];
    if (t === null || t.centreGap < 0 || t.centreGap > 45) return;
    const exits = net.atJunction[t.end.junction].filter((l) => l.shape !== m.shape);
    // ехать некуда — это тупик, и разбирается он разворотом ниже, а не здесь
    if (exits.length === 0) return;
    /**
     * Поворот берётся ИЗ МАРШРУТА, если он есть. Наугад сворачивает только
     * та машина, которой некуда ехать, — на голой сцене без домов.
     */
    const поМаршруту = m.маршрут === null ? null : дальше(m.маршрут, m.shape);
    const нужная = поМаршруту === null ? null : exits.find((l) => l.shape === поМаршруту);
    const pick = нужная ?? exits[Math.floor(roll(m) * exits.length) % exits.length];
    const half = { junction: t.end.junction, shape: pick.shape, s: pick.s,
      dir: pick.s < net.length[pick.shape] / 2 ? 1 : -1, lane: 0 };
    // полоса выезда выбирается по тому, куда сворачиваем (ПДД 8.6)
    m.route = { ...half, lane: exitLane(world, net, m, half, changing) };
  });

  const poses = movers.map((m) => poseOf(world, net, m));

  /** Пути через перекрёстки: считаются один раз за шаг, а не на каждую пару. */
  const paths = movers.map((m) => m.route === null ? null : crossPath(world, net, m.shape, m.dir, m.lane, m.route));
  const entered = movers.map((m) => m.route === null ? -Infinity : inside(world, net, m));

  /**
   * КТО У КАКОГО ПЕРЕКРЁСТКА и КТО СЕЙЧАС ТЕЛО НА ДОРОГЕ — по тем же
   * соображениям, что и полки по дорогам выше: спрашивают про узел, а
   * перебирают весь город.
   *
   * `уУзла` — номера тех, у кого есть путь через этот узел: с ними
   * разбирается очерёдность проезда.
   * `тела` — номера тех, кто УЖЕ внутри какого-нибудь узла, и сбитых
   * где угодно: это препятствия, у которых нет терпения.
   *
   * Оба списка идут по возрастанию номера, то есть в том же порядке, что
   * и общий список, и собираются одним проходом. Ответ от них не меняется.
   */
  const уУзла: number[][] = net.atJunction.map(() => []);
  const тела: number[] = [];
  for (let k = 0; k < movers.length; k++) {
    const o = movers[k];
    if (paths[k] !== null && o.route !== null) уУзла[o.route.junction].push(k);
    if (o.knocked !== null || entered[k] > 0) тела.push(k);
  }

  /**
   * КТО ВЪЕЗЖАЕТ В ЭТОТ ШАГ. Перекрёсток занимают ПУТИ, а не машины: два
   * непересекающихся пути проезжаются вместе — ради этого всё и строилось, —
   * а два пересекающихся ждут друг друга.
   *
   * Решается ДО того, как кто-либо тронулся, и в твёрдом порядке: ближе
   * к своей стоп-линии — раньше очередь. Иначе двое въезжают в один шаг,
   * каждый видя другого ещё снаружи, и запирают узел; а следом набегает
   * замкнутый круг «A ждёт B, B ждёт C, C ждёт A», из которого уже никто
   * никогда не выедет, потому что у неподвижного кузова нет терпения.
   */
  const blocked = movers.map(() => false);
  {
    const busy: { path: Path; at: number }[] = [];
    movers.forEach((m, i) => {
      if (paths[i] !== null && entered[i] > 0) busy.push({ path: paths[i] as Path, at: entered[i] });
    });
    const waiting = movers
      .map((m, i) => ({ i, gap: targets[i]?.stopGap ?? Infinity }))
      .filter(({ i, gap }) => paths[i] !== null && entered[i] <= 0 && gap < 30 && !onRed[i])
      .sort((a, b) => a.gap - b.gap);
    for (const { i } of waiting) {
      const mine = paths[i] as Path;
      const clash = busy.some((b) => {
        const meet = nearest(mine, b.path);
        return meet.gap <= RUB && meet.foe - b.at > -HALF;
      });
      if (clash) blocked[i] = true;
      else busy.push({ path: mine, at: 0 });
    }
  }

  movers.forEach((m, index) => {
    // сбитая машина правилам не подчиняется: она уже не участник, а тело
    if (m.knocked !== null) { rollKnocked(world, net, m, dt, переехал); return; }
    const total = net.length[m.shape];
    const holds: Hold[] = [];

    /**
     * ── ПОЛОСА. Решается до всего остального: от неё зависит, кто впереди.
     *
     * Полосу выбирает всякий, кто ЕДЕТ САМ. Не выбирают её двое: стоящий
     * в кармане (он никуда не едет) и выезжающий из кармана (он уже выбрал
     * полосу, в которую выползает, и менять её на полпути нельзя).
     *
     * Раньше здесь стояло `m.park === null`, то есть полосу переставал
     * выбирать и тот, кто ТОЛЬКО ЕДЕТ К СВОЕМУ КАРМАНУ. А карман — у бордюра,
     * в правой полосе, где стоят все остальные припаркованные. Стоило одной
     * из них оказаться между машиной и её карманом — и объехать было нельзя
     * по устройству: машина упиралась в чужой кузов и ждала вечно, а за ней
     * запирался весь тупик. Поймано на городе: семеро в стометровом тупике,
     * трое стояли дольше минуты.
     */
    if (rules && !стоит(m) && m.park?.phase !== 'выезжает' && entered[index] <= 0)
      m.lane = changing ? wantLane(world, net, наДороге[m.shape], m) : 0;

    // ── поворот дороги впереди: смотрим на несколько шагов вперёд.
    // Внутри перекрёстка смотреть некуда: там своя кривая, а не дорога
    for (const look of entered[index] > 0 ? [] : [8, 18, 32]) {
      const at = m.s + m.dir * look;
      if (at < 0 || at > total) continue;
      const limit = Math.sqrt(COMFORT * G * radius(world, m.shape, at));
      if (limit < m.cruise) holds.push({ gap: look, speed: limit, why: 'поворот' });
    }

    // ── машина впереди. Припаркованная стоит в кармане и полосу не держит:
    // мешает только тот, кто примерно на моей линии движения
    if (headway) {
      for (const other of наДороге[m.shape]) {
        if (other === m) continue;
        // сбитая стоит поперёк и смотрит куда попало: она препятствие,
        // а не лидер, и «в какую сторону она едет» смысла не имеет
        const stray = other.knocked !== null;
        if (!stray && other.dir !== m.dir) continue;
        /**
         * Мешает тот, кто на моей линии движения. Меряем НАСТОЯЩЕЕ смещение,
         * а не номер полосы: пока машина перестраивается, она между полосами,
         * и номер про неё врёт. Полосы разнесены на 3.5 м, кузов 1.95 —
         * порога 2.2 хватает, чтобы соседняя полоса не держала, а своя держала.
         */
        /**
         * Пока машина между полос, она едет по ДВУМ линиям сразу: по той,
         * где кузов, и по той, куда он переезжает. Дистанцию надо держать
         * до обеих — иначе она честно тормозит за своей полосой и въезжает
         * боком в очередь на соседней.
         */
        const near = Math.min(
          Math.abs(other.across - m.across),
          Math.abs(other.across - laneMid(net, m)),
        );
        if (near > (stray ? 3.4 : 2.2)) continue;
        const gap = (other.s - m.s) * m.dir - LENGTH;
        /**
         * Зазор меньше нуля — это уже НАЛОЖЕНИЕ, а не «лидера нет». Раньше
         * такой лидер просто пропадал из расчёта, и машины тихо вползали
         * друг в друга на нулевой скорости. Теперь это самый строгий случай.
         */
        if (gap > -LENGTH && gap < 60)
          holds.push({ gap: Math.max(0.2, gap), speed: stray ? 0 : other.speed,
            why: stray ? 'сбитая машина' : 'машина впереди' });
      }
    }

    /**
     * Машина игрока — такой же участник движения, только считает её не город.
     * Попутная впереди — обычный лидер. Встречная на моей полосе — не лидер,
     * а препятствие: держать дистанцию по ЕГО скорости нельзя, она направлена
     * навстречу. Такую проходим со скоростью ноль, то есть останавливаемся.
     */
    if (you !== null && you.shape === m.shape && Math.abs(you.across - m.across) < 2.6) {
      const gap = (you.s - m.s) * m.dir - LENGTH;
      /**
       * ОТРИЦАТЕЛЬНЫЙ ЗАЗОР — ЭТО УЖЕ НАЛОЖЕНИЕ КУЗОВОВ, а не «позади меня».
       *
       * Ровно та же беда, что была в `aheadOn` и там уже починена: пока
       * стояло `gap > 0`, город переставал видеть игрока в тот самый миг,
       * когда подъезжал к нему вплотную, — и спокойно въезжал в него сзади.
       * В браузерной поездке это выглядело так: игрок едет одиннадцать
       * километров в час, его догоняет городская машина на сорока пяти,
       * и удар ПРИБАВЛЯЕТ ему скорости вместо того, чтобы отнять.
       *
       * Зазор поджимается к нулю: въехал — тормози в пол, пока не разъедетесь.
       * Дальше −LENGTH это уже сосед позади, он не наш.
       */
      if (gap > -LENGTH && gap < 60)
        holds.push({
          gap: Math.max(0, gap),
          speed: you.dir === m.dir ? you.speed : 0,
          why: 'игрок',
        });
    }

    /**
     * ── ПЕРЕКРЁСТОК. Никакой «занятой коробки» больше нет. Есть путь —
     * своя кривая от стоп-линии до стоп-линии, — и точки, в которых он
     * сближается с чужими. Уступаем не перекрёстку, а КОНКРЕТНОЙ точке
     * и конкретной машине, и только если не успеваем пройти её раньше.
     *
     * Раздел 13 ПДД целиком укладывается в три строки приоритета:
     *  13.4 / 13.12 — поворачивающий налево уступает встречным прямо и направо;
     *  13.11        — на равнозначном уступают помехе справа;
     *  13.8         — тому, кто уже в перекрёстке, уступают все.
     */
    const ahead = nextJunction(world, net, m);
    const mine = paths[index];
    let yielded = false;

    /**
     * ── КРАСНЫЙ ВИДЕН РАНЬШЕ, ЧЕМ ВЫБРАН ПОВОРОТ.
     *
     * Раньше и красный, и занятый путь, и приоритет лежали под ОДНИМ
     * условием, куда входило `mine !== null` — то есть «маршрут через узел
     * уже выбран». Маршрут же берётся за 45 метров до узла. Значит машина
     * буквально НЕ ВИДЕЛА горящий красный, пока не подъезжала вплотную.
     * На «решётке» это сходило с рук: там ездят медленно. На настоящем
     * городе поймано замером — машина шла 78 км/ч на давно красный,
     * начинала тормозить за 33 метра, а тормозного пути ей нужно 39,
     * и она вставала носом посреди пешеходного перехода.
     *
     * Два независимых дела были склеены в одно условие. Красный свет —
     * свойство ПОДЪЕЗДА, а не маршрута: на него смотрят до всякого выбора,
     * куда поворачивать.
     *
     * Далеко ли смотреть — тоже не постоянная: ровно свой тормозной путь
     * при спокойном замедлении плюс два корпуса. Тогда «увидел слишком
     * поздно, чтобы остановиться» невыразимо на любой скорости.
     */
    const взгляд = Math.max(70, (m.speed * m.speed) / (2 * COMFORT * G) + 2 * LENGTH);
    if (rules && ahead !== null && ahead.stopGap < взгляд && ahead.stopGap > -0.5) {
      // путь через узел занят чужим — стоим до линии, а не въезжаем и стоим внутри
      if (blocked[index]) {
        holds.push({ gap: Math.max(0.4, ahead.stopGap), speed: 0, why: 'путь занят' });
        yielded = true;
      }
      // красный свет: стоим ДО линии. Проехал линию — доезжай, не замирай в узле
      if (onRed[index]) {
        holds.push({ gap: Math.max(0.4, ahead.stopGap), speed: 0, why: 'красный' });
        yielded = true;
      }
    }

    if (rules && ahead !== null && mine !== null && ahead.stopGap < 70) {
      /**
       * 13.2: не выезжаем на перекрёсток, если за ним затор и придётся
       * встать внутри. Смотрим ровно на ту дорогу, на которую сами едем.
       */
      const r = m.route as Route;
      const outMouth = mouthAt(net, r.junction, r.shape, r.s, -r.dir);
      /**
       * 13.2 — не выезжать, если за перекрёстком придётся встать.
       *
       * Припаркованная машина за перекрёстком — не затор, ЕСЛИ её есть чем
       * объехать. На улице в две полосы в каждую сторону есть; на однополосной
       * нет, и въехавший встанет прямо в узле, заперев всех.
       *
       * Оба края этого правила уже попробованы и оба плохи. «Припаркованная
       * всегда затор» — перекрёсток с занятым карманом за ним не пропускал
       * НИКОГО, машина стояла на зелёном все две минуты. «Припаркованная
       * никогда не затор» — машина въезжала в узел, упиралась в неё и
       * застревала внутри, а по предпроходу все, чей путь её пересекает,
       * получали «путь занят» и стояли по девяносто секунд. Поймано новой
       * меркой простоя: старая, по пройденному пути, этого не видела.
       */
      const объехать = laneCount(net.lanes, r.shape, r.dir as 1 | -1) > 1;
      const jam = наДороге[r.shape].some((o) => o !== m && o.dir === r.dir
        && (объехать ? !стоит(o) : true) && o.speed < 1.5
        && (o.s - outMouth) * r.dir < LENGTH + GAP0
        && (o.s - outMouth) * r.dir > -LENGTH);
      if (jam && ahead.stopGap > -0.5) {
        holds.push({ gap: Math.max(0.4, ahead.stopGap), speed: 0, why: 'затор за перекрёстком' });
        yielded = true;
      }

      const myAt = entered[index];

      /**
       * Дистанция НЕ КОНЧАЕТСЯ на въезде в перекрёсток. Пока машина едет
       * по нему, её `shape` — дорога, с которой она въехала, и очередь
       * на той дороге, куда она выезжает, для неё невидима. Так она
       * и въезжала в стоящих. Считаем зазор насквозь: остаток пути плюс
       * расстояние по выездной дороге.
       */
      if (headway) {
        for (const o of наДороге[r.shape]) {
          if (o === m || o.dir !== r.dir) continue;
          if (Math.abs(o.across - laneAcross(net.lanes, r.shape, r.dir as 1 | -1, r.lane)) > 2.2) continue;
          const gap = (mine.len - myAt) + (o.s - outMouth) * r.dir - LENGTH;
          if (gap > 0 && gap < 60) holds.push({ gap, speed: o.speed, why: 'машина впереди' });
        }
      }

      /**
       * КТО УЖЕ ВНУТРИ — ЭТО ТОЧКА НА МОЁМ ПУТИ, а не «чужой путь».
       * Сравнивать путь с путём здесь нельзя: у двух сходящихся путей одно
       * «самое тесное место», а стоять машина может где угодно вдоль него —
       * и тогда она невидима. Смотрим, где она СЕЙЧАС, и что это за метр
       * моего пути. Едущий в мою же сторону — лидер, его держим по скорости;
       * поперечный или встречный — препятствие, перед ним останавливаемся.
       */
      const bodies: { x: number; z: number; yaw: number; speed: number; why: string }[] = [];
      for (const k of тела) {
        const o = movers[k];
        if (o === m) continue;
        /**
         * Телом на моём пути считается тот, кто УЖЕ В ПЕРЕКРЁСТКЕ, и сбитый
         * где угодно. Ждущий у своей стоп-линии сюда не входит намеренно:
         * он вне узла, его разбирают правила очереди и приоритета, у которых
         * есть терпение.
         *
         * Одно время сюда брали всех, кто рядом с узлом, — чтобы прикрыть
         * ждущего на красном, который стоял на чужом пути. Но стоял он там
         * не поэтому, а потому что стоп-линия отмерялась от ширины СВОЕЙ
         * дороги и на узкой улице оказывалась внутри широкой. Это починено
         * в самой геометрии, и расширение стало не нужно — а вредно: у тела
         * нет терпения, и четверо вокруг узла вставали навсегда, каждый
         * перед чужим неподвижным кузовом.
         */
        const stray = o.knocked !== null;
        if (!stray && (entered[k] <= 0 || o.route?.junction !== r.junction)) continue;
        const still = o.speed < 0.5;
        bodies.push({
          ...poses[k],
          speed: stray || still ? 0 : o.speed,
          why: stray ? 'сбитая машина' : still ? 'стоящая машина' : 'машина в перекрёстке',
        });
      }
      // машина игрока: куда он поедет, город не знает — значит он такое же тело
      if (you !== null) bodies.push({ x: you.x, z: you.z, yaw: you.yaw, speed: you.speed, why: 'игрок' });
      for (const body of bodies) {
        const spot = blockAt(mine, body);
        if (spot.at === Infinity || spot.centre <= myAt) continue; // не мешает или уже позади
        const heading = alongPath(mine, spot.centre).yaw;
        const sameWay = body.why !== 'игрок' && Math.cos(wrap(body.yaw - heading)) > 0.7;
        holds.push({
          gap: Math.max(0.4, spot.at - myAt),
          speed: sameWay ? body.speed : 0, why: body.why,
        });
        yielded = true;
      }

      /**
       * ЧТО БУДЕТ ДАЛЬШЕ — пересечение путей и расчёт промежутка. Считается
       * и для тех, кто уже въехал: раньше, стоило чужой машине пересечь
       * стоп-линию, предсказание про неё пропадало, оставался только её
       * нынешний кузов — и она успевала выехать наперерез тому, кто по
       * старому расчёту «успевал». Въезд не отменяет предсказания.
       */
      for (const k of уУзла[r.junction]) {
        const o = movers[k], his = paths[k];
        if (o === m || his === null) continue;
        // маршрут за шаг может только СНЯТЬСЯ, поэтому полка — заведомо
        // с запасом, и живую проверку надо оставить
        if (o.route?.junction !== r.junction) continue;
        if (o.shape === m.shape && o.dir === m.dir) continue; // сзади — это дистанция, а не перекрёсток
        if (onRed[k] && entered[k] <= 0) continue;             // ему красный, он и не тронется
        const meet = nearest(mine, his);
        if (meet.gap > RUB) continue;                          // пути расходятся
        const toPoint = meet.at - myAt;
        const foeToPoint = meet.foe - entered[k];
        if (toPoint < -HALF || foeToPoint < -HALF) continue;    // точка уже позади

        /**
         * Кто кому уступает — раздел 13 ПДД. Считаем обе стороны, а не только
         * свою: если правила не развели никого (два встречных поворота налево,
         * косой съезд), уступать должен ровно ОДИН — иначе они либо
         * столкнутся, либо встанут оба. Ничья решается тем, кто подъедет
         * позже, а полная ничья — номером, чтобы ответ не зависел от порядка.
         */
        const delta = wrap(his.inYaw - mine.inYaw);
        const rank = (t: number): number => Math.abs(t) < 0.6 ? 0 : t > 0 ? 1 : 2;
        const onc = Math.abs(delta) > 2.36;

        /**
         * 13.9: едущий по ВТОРОСТЕПЕННОЙ уступает всем, кто на главной,
         * независимо от направления их дальнейшего движения. Это сильнее
         * и помехи справа, и правил про поворот налево — поэтому спрашивается
         * первым. Под светофором знаки приоритета не действуют вовсе (13.3),
         * и там `priorityOf` вернёт «равнозначная» просто потому, что
         * знаков на регулируемом узле не расставлено.
         */
        const myRank = priorityOf(net.signs, r.junction, m.shape);
        const hisRank = priorityOf(net.signs, r.junction, o.shape);
        const byRoad = myRank !== hisRank
          ? (myRank === 'второстепенная' || hisRank === 'главная')
          : null;

        const iYield = byRoad !== null ? byRoad
          : onc ? rank(mine.turn) > rank(his.turn) : delta < -0.79 && delta > -2.36;
        const heYields = byRoad !== null ? !byRoad
          : onc ? rank(his.turn) > rank(mine.turn) : delta > 0.79 && delta < 2.36;
        const tie = !iYield && !heYields && (toPoint > foeToPoint + 0.5
          || (Math.abs(toPoint - foeToPoint) <= 0.5 && index > k));
        if (!iYield && !tie) continue;

        // хватает ли промежутка: успею ли пройти точку до того, как он в неё войдёт
        const foeIn = o.speed < 0.2 ? Infinity : (foeToPoint - HALF) / o.speed;
        const clear = timeToCover(toPoint + HALF, m.speed);
        if (foeIn > clear + CRITICAL) continue;                // успеваю

        /**
         * Терпение кончилось — едем: иначе четверо на нерегулируемом встанут
         * навсегда, каждый уступая соседу. На тех, кто уже в перекрёстке,
         * терпение не действует — они выше, отдельным списком, — а красный
         * свет им не отменяется вовсе: это была бы уже не усталость,
         * а проезд на красный.
         */
        if (m.wait > PATIENCE) continue;

        /**
         * Где останавливаться. Встречному уступают ВНУТРИ перекрёстка,
         * выехав на него, — так и написано в правилах, и так все ездят.
         * Помехе справа уступают ДО него: заезжать некуда.
         */
        const at = toPoint - 2;
        holds.push({
          gap: Math.max(0.4, onc || ahead.stopGap < 0 ? at : Math.min(at, ahead.stopGap)),
          speed: 0, why: 'уступает',
        });
        yielded = true;
      }

    }
    if (m.speed < 0.5 && yielded) m.wait += dt; else m.wait = Math.max(0, m.wait - dt * 0.5);

    // ── пешеход на переходе: пропускаем, даже если нам зелёный
    if (rules) {
      for (const p of options.crossing ?? []) {
        if (p.shape !== m.shape) continue;
        const gap = (p.s - m.s) * m.dir;
        if (gap > 0 && gap < 30) holds.push({ gap, speed: 0, why: 'пешеход' });
      }
    }

    /**
     * ── ТУПИК: дальше ехать некуда. Это не только «дороги нет», но и
     * «перекрёсток есть, а выезда с него для меня нет»: в обоих случаях
     * машина разворачивается. Без второго случая она молча уезжала бы
     * за конец дороги в никуда — потому что проехать перекрёсток можно
     * только по маршруту, а маршрута там не берётся.
     */
    const deadEnd = m.route === null && (ahead === null
      || net.atJunction[ahead.end.junction].every((l) => l.shape === m.shape));
    if (deadEnd) {
      // тормозим К ТОЧКЕ РАЗВОРОТА, а не раньше неё: иначе машина встаёт
      // в паре метров от конца и разворот, который включается ближе,
      // никогда не наступает
      const gap = (m.dir > 0 ? total - 2 - m.s : m.s - 2);
      if (gap < 40) holds.push({ gap: Math.max(0.3, gap), speed: 0, why: 'тупик' });
    }

    /**
     * ── ПАРКОВКА. Машина иногда решает встать в свободный карман: тормозит
     * к нему как к любой другой точке впереди, потом смещается вбок,
     * стоит и уезжает. Отдельного «режима парковки» в движении нет —
     * есть та же точка впереди и то же боковое смещение.
     */
    if (m.park !== null) {
      const bay = net.bays[m.park.bay];
      if (m.park.phase === 'въезжает') {
        const gap = (bay.s - m.s) * m.dir;
        holds.push({ gap: Math.max(0.3, gap), speed: 0, why: 'паркуется' });
        // модель следования держит зазор и останавливает машину НЕ ДОЕЗЖАЯ
        // до точки — поэтому «приехал» это «встал рядом», а не «в точке»
        /**
         * Встал — значит встал В КАРМАНЕ, а не где придётся. Без проверки
         * бокового положения машина «парковалась» посреди полосы, если ей
         * не дали доехать вбок, и оставалась там торчать.
         */
        if (gap < ДОЕХАЛ && m.speed < 0.6 && Math.abs(m.across - bay.across) < 0.6) {
          m.park.phase = 'стоит';
          m.speed = 0;
        }
      } else if (m.park.phase === 'стоит') {
        m.speed = 0;
        m.reason = 'стоит в кармане';
        /**
         * Уезжает, когда ВЫШЕЛ ХОЗЯИН, а не когда истёк случайный отсчёт.
         * Час суток приходит снаружи: город знает своё время, машина — нет.
         */
        const час = options.час ?? 0;
        const пора = ((час - m.park.доЧаса + 24) % 24) < 12;
        if (пора) {
          /**
           * Выезжают В СОСЕДНЮЮ ПОЛОСУ, а не вперёд по своей.
           *
           * Карман — это правая полоса (так и в жизни: стоящая машина её
           * занимает). Значит впереди в той же полосе стоит следующая
           * припаркованная машина в шести метрах, и тронуться по своей полосе
           * нельзя НИКОГДА: ряд запирает сам себя. Поймано честной
           * расстановкой: из 149 машин утром уезжали 17.
           *
           * Полоса выбирается до проверки занятости — иначе проверялась бы
           * та полоса, из которой мы и так уезжаем.
           */
          m.lane = options.выезд === 'по своей полосе'
            ? 0
            : Math.min(1, Math.max(0, laneCount(net.lanes, m.shape, m.dir as 1 | -1) - 1));
          if (laneClear(world, net, наДороге[m.shape], m)) m.park.phase = 'выезжает';
        }
        const want = wantAcross(world, net, m);
        m.across += Math.max(-0.9 * dt, Math.min(0.9 * dt, want - m.across));
        return;
      } else {
        /**
         * Выезжает. Полосу проверяем ВСЁ ВРЕМЯ выезда, а не только в миг
         * решения: пока машина выползает, сзади успевает подъехать другая,
         * и они оказываются в одном месте.
         */
        const lane = laneMid(net, m);
        if (Math.abs(m.across - lane) < 0.15) { net.bays[m.park.bay].taken = -1; m.park = null; }
        else if (!laneClear(world, net, наДороге[m.shape], m)) {
          m.speed = 0;
          m.reason = 'выезжает, ждёт';
          return;
        } else {
          m.speed = Math.min(m.speed, 2);
          m.reason = 'выезжает';
          m.across += Math.max(-0.9 * dt, Math.min(0.9 * dt, lane - m.across));
          m.s += m.speed * m.dir * dt;
          return;
        }
      }
    } else if (m.хозяин >= 0 && m.доЧаса !== null && m.маршрут !== null
      && m.route === null && m.маршрут.цель.shape === m.shape
      && (m.маршрут.цель.s - m.s) * m.dir > 0
      && (m.маршрут.цель.s - m.s) * m.dir < 90) {
      /**
       * Машина ищет карман, только когда ПРИЕХАЛА: она на той дороге, где
       * цель, и цель уже впереди, в пределах девяноста метров. До маршрутов
       * тут стоял случайный бросок «раз в тысячу шагов», и машина вставала
       * посреди чужой улицы, чтобы простоять там до вечера.
       *
       * Ничья машина этой ветки не достигает никогда: у неё нет ни хозяина,
       * ни цели. Значит «стоит просто так» записать негде.
       */
      const side = Math.sign(m.dir);
      const found = net.bays.findIndex((b) => b.taken < 0 && b.shape === m.shape
        && Math.sign(b.across) === side
        && (b.s - m.s) * m.dir > 8 && (b.s - m.s) * m.dir < 90);
      if (found >= 0) {
        net.bays[found].taken = index;
        m.park = { bay: found, phase: 'въезжает', доЧаса: m.доЧаса };
        // паркуется — значит перекрёсток проезжать уже не собирается
        m.route = null;
      }
    }

    const drive = follow(m.speed, m.cruise, holds);
    m.reason = drive.why;
    m.accel = Math.max(-6, Math.min(ACCEL, drive.accel));
    m.speed = Math.max(0, m.speed + Math.max(-6, Math.min(ACCEL, drive.accel)) * dt);
    m.s += m.speed * m.dir * dt;

    /**
     * ── ПРОЕЗД ПЕРЕКРЁСТКА. Раньше машина прыгала через узел: пропадала
     * за три метра до него и появлялась за метр после, на другой дороге.
     * Внутри перекрёстка её просто не было — а значит, и столкнуться там
     * было не с чем, и приходилось пускать по одной.
     *
     * Теперь `s` продолжает расти за конец дороги, и это ровно значит
     * «еду по своему пути через перекрёсток». Кончился путь — встаём
     * на ту дорогу, на которую собирались, с тем же остатком метров.
     */
    if (m.route !== null) {
      const path = crossPath(world, net, m.shape, m.dir, m.lane, m.route);
      const at = inside(world, net, m);
      if (at >= path.len) {
        const r = m.route;
        const был = m.shape;
        m.shape = r.shape;
        переехал(m, был);
        m.dir = r.dir;
        m.s = mouthAt(net, r.junction, r.shape, r.s, -r.dir) + r.dir * (at - path.len);
        m.lane = r.lane;
        m.across = laneMid(net, m);
        m.route = null;
        m.wait = 0;
        retune(net, m);   // другая дорога — другой знак
      }
    }

    /**
     * ── ТУПИК: разворот на месте. Дорога и её длина берутся заново: выше
     * машина могла переехать на другую дорогу, и старые числа уже не про неё.
     */
    const tail = net.length[m.shape];
    const stopsHere = net.ends[m.shape][m.dir > 0 ? 1 : 0] === null;
    if (stopsHere && (m.dir > 0 ? m.s > tail - 6 : m.s < 6)) {
      const back = -m.dir as 1 | -1;
      /**
       * Занято ли место, куда мы встанем. Смотрим ТУ ПОЛОСУ, в которой
       * окажемся, а не всё встречное направление: на улице в две полосы
       * в каждую сторону требование «встречных нет вовсе» означает, что
       * развернуться нельзя никогда, пока по улице кто-то едет. Двое
       * упирались в край посёлка и стояли там до конца проверки.
       */
      const куда = laneAcross(net.lanes, m.shape, back, 0);
      const сюда = Math.max(3, Math.min(tail - 3, m.s + back * 2));
      const busy = наДороге[m.shape].some((o) => o !== m
        && o.dir === back && Math.abs(o.s - сюда) < LENGTH + 2
        && Math.abs(o.across - куда) < 2.4);
      if (busy) {
        // стоящая машина обязана говорить, что стоит: с «едет» при нуле км/ч
        // прибор называл эту машину головой затора и не объяснял, чего она ждёт
        m.speed = 0;
        m.reason = 'разворот занят';
        m.s = Math.max(2, Math.min(tail - 2, m.s));
      }
      else {
        m.dir = back;
        m.s = Math.max(3, Math.min(tail - 3, m.s + m.dir * 2));
        // развернулись — значит и полоса теперь другая, правая по новому ходу.
        // Без этой строки машина ехала по встречной, пока смещение плавно
        // переползало через середину дороги
        m.lane = 0;
        m.across = laneMid(net, m);
      }
    }

    /**
     * ── БОКОВОЕ ДВИЖЕНИЕ. Единственное место, где машина едет вбок, —
     * значит и проверка «а там свободно?» должна быть тут одна на всё.
     * Раньше её имело только перестроение, а парковка нет: машина съезжала
     * в карман сквозь того, кто в этот миг перестраивался мимо. Теперь
     * причина смещения не важна — вбок нельзя в занятое, и точка.
     */
    const wantSide = wantAcross(world, net, m);
    /**
     * Шаг запрещён, только если он приближает к тому, с кем мы и так
     * почти соприкасаемся бортами. К соседу в трёх метрах шагнуть можно:
     * между кузовами ещё метр. Запрет «не приближаться ни к кому вообще»
     * замораживал смещение, и машина оставалась на кривой улице ВНЕ своей
     * полосы — на «каше» съездов с проезжей части стало 157 вместо 13.
     */
    const БОРТ = 2.4;
    const бортом = sideBlockers(наДороге[m.shape], m)
      .filter((рядом) => Math.abs(m.across - рядом) < БОРТ);
    const шагК = (цель: number): number =>
      Math.max(-0.9 * dt, Math.min(0.9 * dt, цель - m.across));
    const прочь = (шаг: number): boolean =>
      бортом.every((рядом) => Math.abs(m.across + шаг - рядом) >= Math.abs(m.across - рядом));

    let шаг = шагК(wantSide);
    if (шаг !== 0 && !прочь(шаг)) {
      /**
       * К желаемой полосе нельзя — значит НАЗАД, в ту, из которой вышли.
       *
       * Раньше здесь машина просто замирала, и это создавало состояние,
       * которого быть не должно: **кузов стоит между полосами**. Дальше
       * всё шло само собой — сосед подъезжал по целевой полосе вплотную,
       * а вылезти было уже некуда: шаг к цели приближал к нему, шага назад
       * правило не знало. Поймано 17.09 наложением кузовов на 88% от
       * касания на сцене «город»; до этого запас был 114%, то есть беда
       * лежала рядом и ждала любой перестановки.
       *
       * Отдельного правила это не заводит: «вбок можно только прочь
       * от того, с кем бортами» осталось тем же самым. Изменилось одно —
       * у машины теперь ВСЕГДА есть куда деваться, и «стою между полосами»
       * перестало быть выразимым.
       */
      const назад = laneAcross(net.lanes, m.shape, m.dir as 1 | -1,
        m.lane + (wantSide > m.across ? -1 : 1));
      const обратно = шагК(назад);
      шаг = (обратно !== 0 && прочь(обратно)) ? обратно : 0;
    }
    if (шаг !== 0 && прочь(шаг)) m.across += шаг;

    // курс догоняет дорогу, а не прыгает вместе с ней
    const want = poseOf(world, net, m).yaw;
    const turn = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
    m.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, turn));
  });
}
