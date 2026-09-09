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
import { type Signal, buildSignals, lightFor, stopLine } from './signals.ts';

const G = 9.80665;
/** С какой боковой перегрузкой ездит обычный водитель. */
const COMFORT = 0.28;
/** Быстрее этого по городу никто не едет, м/с. */
const CRUISE = 16;

// ── параметры модели следования (IDM)
/** Максимальное ускорение, м/с². */
const ACCEL = 1.8;
/** Комфортное торможение, м/с². */
const BRAKE = 2.6;
/** Зазор в стоящей пробке, м. */
const GAP0 = 3.2;
/** Желаемый временной интервал до передней машины, с. */
const HEADWAY = 1.3;
/** Длина машины, м: зазор считается от бампера, а не от середины. */
const LENGTH = 4.4;

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

export interface Mover {
  shape: number;
  s: number;
  dir: number;
  speed: number;
  yaw: number;
  colour: number;
  /** Своя крейсерская скорость: одни торопятся, другие нет. */
  cruise: number;
  /**
   * Сколько метров вправо от осевой линии. Обычно это середина своей полосы,
   * у припаркованной — карман у бордюра. Отдельная величина, а не число
   * внутри показа: из неё потом вырастут и перестроения, и объезд.
   */
  across: number;
  /** Место в кармане, если едет парковаться или стоит. */
  park: { bay: number; phase: 'въезжает' | 'стоит' | 'выезжает'; left: number } | null;
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
}

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

  const signals = buildSignals(world);
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
  world.shapes.forEach((shape, si) => {
    if (shape.halfWidth < 6) return;
    const total = length[si];
    const edge = shape.outerHalf + 4;
    for (let at = edge; at < total - edge; at += 6.5) {
      if (nodes[si].some((n) => Math.abs(n.s - at) < shape.outerHalf + 6)) continue;
      for (const side of [1, -1]) bays.push({ shape: si, s: at, across: side * (shape.halfWidth - 1.4), taken: -1 });
    }
  });

  return { length, atJunction, nodes, signals, ends, bays };
}

/** Где дорога в этом месте и куда она смотрит. */
export function along(world: World, shape: number, s: number): { x: number; z: number; fx: number; fz: number } {
  const st = world.shapes[shape].stations;
  const total = st.at(-1)?.s ?? 0;
  const t = Math.max(0, Math.min(total, s));
  let i = 0;
  while (i + 2 < st.length && st[i + 1].s < t) i++;
  const a = st[i], b = st[i + 1];
  const k = (t - a.s) / Math.max(1e-6, b.s - a.s);
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * k, z: a.z + dz * k, fx: dx / len, fz: dz / len };
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

/** Насколько круто дорога заворачивает здесь: радиус в метрах. */
function radius(world: World, shape: number, s: number): number {
  const back = along(world, shape, s - 5), fwd = along(world, shape, s + 5);
  const turn = Math.atan2(fwd.fz, fwd.fx) - Math.atan2(back.fz, back.fx);
  const wrapped = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  return wrapped < 1e-4 ? 1e5 : 10 / wrapped;
}

const COLOURS = [0x9fa5ab, 0x2b3a4a, 0x7d2b2b, 0xd8d3c6, 0x35513f, 0x1c1e22, 0x8a7b4f];

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
    if (movers.some((o) => o.shape === shape && Math.abs(o.s - s) < 16)) continue;
    // не ставим машину на подъезде к перекрёстку: она родится на ходу перед
    // стоп-линией и проедет на красный, ещё не сделав ни одного решения
    if (net.nodes[shape].some((n) => Math.abs(n.s - s) < 26)) continue;
    const spot = along(world, shape, s);
    movers.push({
      shape, s, dir, speed: 8 + next() * 5, wait: 0, reason: 'едет',
      seed: Math.floor(next() * 2147483647),
      across: dir * world.shapes[shape].halfWidth * 0.5,
      park: null,
      route: null,
      knocked: null,
      cruise: CRUISE * (0.6 + next() * 0.4),
      yaw: Math.atan2(spot.fz * dir, spot.fx * dir),
      colour: COLOURS[Math.floor(next() * COLOURS.length) % COLOURS.length],
    });
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

/** Середина своей полосы на этом метре дороги, и куда она смотрит. */
function lanePoint(world: World, shape: number, s: number, dir: number):
{ x: number; z: number; fx: number; fz: number } {
  const spot = along(world, shape, s);
  const off = dir * world.shapes[shape].halfWidth * 0.5;
  return { x: spot.x - spot.fz * off, z: spot.z + spot.fx * off, fx: spot.fx * dir, fz: spot.fz * dir };
}

/** Метр, на котором дорога кончается и начинается перекрёсток. */
function mouthAt(world: World, shape: number, s: number, dir: number): number {
  return stopLine(world.shapes[shape].halfWidth, s, dir);
}

/** Свой въезд в перекрёсток: метр, за которым машина уже внутри. */
function myMouth(world: World, net: Network, m: Mover): number {
  return mouthAt(world, m.shape, m.dir > 0 ? net.length[m.shape] : 0, m.dir);
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
export function crossPath(world: World, net: Network, shape: number, dir: number, r: Route): Path {
  const a = lanePoint(world, shape, mouthAt(world, shape, dir > 0 ? net.length[shape] : 0, dir), dir);
  const b = lanePoint(world, r.shape, mouthAt(world, r.shape, r.s, -r.dir), r.dir);
  // точка схода касательных: где продолжение въезда встречает продолжение выезда
  const det = a.fx * b.fz - a.fz * b.fx;
  let cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
  if (Math.abs(det) > 1e-4) {
    const t = ((b.x - a.x) * b.fz - (b.z - a.z) * b.fx) / det;
    if (t > 0 && t < 60) { cx = a.x + a.fx * t; cz = a.z + a.fz * t; }
  }
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, z: u * u * a.z + 2 * u * t * cz + t * t * b.z });
  }
  const mark = [0];
  for (let i = 0; i + 1 < pts.length; i++)
    mark.push(mark[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z));
  const inYaw = Math.atan2(a.fz, a.fx);
  const outYaw = Math.atan2(b.fz, b.fx);
  return { pts, mark, len: mark[mark.length - 1], inYaw, turn: wrap(outYaw - inYaw) };
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
  let best = { at: 0, foe: 0, gap: Infinity };
  for (let i = 0; i < a.pts.length; i++)
    for (let k = 0; k < b.pts.length; k++) {
      const d = Math.hypot(a.pts[i].x - b.pts[k].x, a.pts[i].z - b.pts[k].z);
      if (d < best.gap) best = { at: a.mark[i], foe: b.mark[k], gap: d };
    }
  return best;
}

/** Куда машина смотрит и где стоит: правостороннее движение. */
export function poseOf(world: World, net: Network, m: Mover): { x: number; z: number; yaw: number } {
  if (m.knocked !== null) return { x: m.knocked.x, z: m.knocked.z, yaw: m.knocked.yaw };
  if (m.route !== null) {
    const at = inside(world, net, m);
    if (at > 0) return alongPath(crossPath(world, net, m.shape, m.dir, m.route), at);
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
  const lane = m.dir * world.shapes[m.shape].halfWidth * 0.5;
  if (m.park === null || m.park.phase === 'выезжает') return lane;
  const bay = net.bays[m.park.bay];
  const gap = (bay.s - m.s) * m.dir;
  return gap > 8 ? lane : bay.across;
}

/** Свободна ли полоса рядом и сзади — чтобы выехать из кармана. */
function laneClear(world: World, movers: readonly Mover[], m: Mover): boolean {
  const lane = m.dir * world.shapes[m.shape].halfWidth * 0.5;
  return !movers.some((o) => o !== m && o.shape === m.shape && o.dir === m.dir
    && Math.abs(o.across - lane) < 2.4
    // назад смотрим далеко: подъезжающий сзади проедет эти метры,
    // пока машина выползает из кармана
    && (m.s - o.s) * m.dir > -22 && (m.s - o.s) * m.dir < 20);
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
export function nextJunction(world: World, net: Network, m: Mover):
{ end: End; stopGap: number; centreGap: number } | null {
  const slot = m.dir > 0 ? 1 : 0;
  const end = net.ends[m.shape][slot];
  if (end === null) return null;
  const atS = slot === 1 ? net.length[m.shape] : 0;
  const stopS = stopLine(world.shapes[m.shape].halfWidth, atS, m.dir);
  return { end, stopGap: (stopS - m.s) * m.dir, centreGap: (atS - m.s) * m.dir };
}

/** Что машина видит перед собой на перекрёстке: для проверок и приборки. */
export function watch(world: World, net: Network, m: Mover, time: number): {
  junction: number; stopGap: number; centreGap: number; light: string;
} | null {
  const ahead = nextJunction(world, net, m);
  if (ahead === null) return null;
  const signal = ahead.end.signal >= 0 ? net.signals[ahead.end.signal] : null;
  const light = signal === null ? 'нерегулируемый'
    : lightFor(signal, signal.approaches[ahead.end.approach], time).light;
  return { junction: ahead.end.junction, stopGap: ahead.stopGap, centreGap: ahead.centreGap, light };
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
function rollKnocked(world: World, net: Network, m: Mover, dt: number): void {
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
    m.shape = at.shape;
    m.s = Math.max(0, Math.min(net.length[at.shape], at.s));
    m.across = at.across;
  }
  m.yaw = k.yaw;
  m.speed = Math.hypot(k.vx, k.vz);
  m.reason = 'сбит';

  k.still = m.speed < 0.4 ? k.still + dt : 0;
  if (k.still > 1.5) {
    // пришёл в себя: снова едет по своей полосе, в ту сторону, куда смотрит
    const lane = along(world, m.shape, m.s);
    m.dir = Math.cos(k.yaw) * lane.fx + Math.sin(k.yaw) * lane.fz >= 0 ? 1 : -1;
    m.across = m.dir * world.shapes[m.shape].halfWidth * 0.5;
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
    /** Машина игрока: город обязан её видеть, иначе он едет сквозь неё. */
    player?: { x: number; z: number; speed: number; yaw: number } | null;
  } = {},
): void {
  const headway = options.headway ?? true;
  const rules = options.rules ?? true;

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
    const t = targets[i];
    if (t === null || t.centreGap < 0 || t.centreGap > 45) return;
    const exits = net.atJunction[t.end.junction].filter((l) => l.shape !== m.shape);
    // ехать некуда — это тупик, и разбирается он разворотом ниже, а не здесь
    if (exits.length === 0) return;
    const pick = exits[Math.floor(roll(m) * exits.length) % exits.length];
    m.route = {
      junction: t.end.junction, shape: pick.shape, s: pick.s,
      dir: pick.s < net.length[pick.shape] / 2 ? 1 : -1,
    };
  });

  const poses = movers.map((m) => poseOf(world, net, m));

  /** Пути через перекрёстки: считаются один раз за шаг, а не на каждую пару. */
  const paths = movers.map((m) => m.route === null ? null : crossPath(world, net, m.shape, m.dir, m.route));
  const entered = movers.map((m) => m.route === null ? -Infinity : inside(world, net, m));

  movers.forEach((m, index) => {
    // сбитая машина правилам не подчиняется: она уже не участник, а тело
    if (m.knocked !== null) { rollKnocked(world, net, m, dt); return; }
    const total = net.length[m.shape];
    const holds: Hold[] = [];

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
      for (const other of movers) {
        if (other === m || other.shape !== m.shape) continue;
        // сбитая стоит поперёк и смотрит куда попало: она препятствие,
        // а не лидер, и «в какую сторону она едет» смысла не имеет
        const stray = other.knocked !== null;
        if (!stray && other.dir !== m.dir) continue;
        if (Math.abs(other.across - m.across) > (stray ? 3.4 : 2.2)) continue;
        const gap = (other.s - m.s) * m.dir - LENGTH;
        if (gap > 0 && gap < 60)
          holds.push({ gap, speed: stray ? 0 : other.speed, why: stray ? 'сбитая машина' : 'машина впереди' });
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
      if (gap > 0 && gap < 60)
        holds.push({ gap, speed: you.dir === m.dir ? you.speed : 0, why: 'игрок' });
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
    if (rules && ahead !== null && mine !== null && ahead.stopGap < 70) {
      // красный свет: стоим ДО линии. Проехал линию — доезжай, не замирай в узле
      if (onRed[index] && ahead.stopGap > -0.5) {
        holds.push({ gap: Math.max(0.4, ahead.stopGap), speed: 0, why: 'красный' });
        yielded = true;
      }

      /**
       * 13.2: не выезжаем на перекрёсток, если за ним затор и придётся
       * встать внутри. Смотрим ровно на ту дорогу, на которую сами едем.
       */
      const r = m.route as Route;
      const outMouth = mouthAt(world, r.shape, r.s, -r.dir);
      const jam = movers.some((o) => o !== m && o.shape === r.shape && o.dir === r.dir
        && o.speed < 1.5 && (o.s - outMouth) * r.dir < LENGTH + GAP0
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
        for (const o of movers) {
          if (o === m || o.shape !== r.shape || o.dir !== r.dir) continue;
          if (Math.abs(o.across - r.dir * world.shapes[r.shape].halfWidth * 0.5) > 2.2) continue;
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
      for (let k = 0; k < movers.length; k++) {
        const o = movers[k];
        if (o === m) continue;
        // сбитая машина — препятствие всегда и везде, она уже не по правилам
        const stray = o.knocked !== null;
        if (!stray && (entered[k] <= 0 || o.route?.junction !== r.junction)) continue;
        bodies.push({ ...poses[k], speed: stray ? 0 : o.speed, why: stray ? 'сбитая машина' : 'машина в перекрёстке' });
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
      for (let k = 0; k < movers.length; k++) {
        const o = movers[k], his = paths[k];
        if (o === m || his === null) continue;
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
        const iYield = onc ? rank(mine.turn) > rank(his.turn) : delta < -0.79 && delta > -2.36;
        const heYields = onc ? rank(his.turn) > rank(mine.turn) : delta > 0.79 && delta < 2.36;
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
        if (gap < 4.5 && m.speed < 0.6) { m.park.phase = 'стоит'; m.speed = 0; }
      } else if (m.park.phase === 'стоит') {
        m.park.left -= dt;
        m.speed = 0;
        m.reason = 'стоит в кармане';
        if (m.park.left <= 0 && laneClear(world, movers, m)) m.park.phase = 'выезжает';
        const want = wantAcross(world, net, m);
        m.across += Math.max(-0.9 * dt, Math.min(0.9 * dt, want - m.across));
        return;
      } else {
        /**
         * Выезжает. Полосу проверяем ВСЁ ВРЕМЯ выезда, а не только в миг
         * решения: пока машина выползает, сзади успевает подъехать другая,
         * и они оказываются в одном месте.
         */
        const lane = m.dir * world.shapes[m.shape].halfWidth * 0.5;
        if (Math.abs(m.across - lane) < 0.15) { net.bays[m.park.bay].taken = -1; m.park = null; }
        else if (!laneClear(world, movers, m)) {
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
    } else if (m.speed > 3 && m.route === null && roll(m) < 0.0015) {
      // ищем свободный карман по своей стороне впереди
      const side = Math.sign(m.dir);
      const found = net.bays.findIndex((b) => b.taken < 0 && b.shape === m.shape
        && Math.sign(b.across) === side
        && (b.s - m.s) * m.dir > 14 && (b.s - m.s) * m.dir < 70);
      if (found >= 0) {
        net.bays[found].taken = index;
        m.park = { bay: found, phase: 'въезжает', left: 8 + roll(m) * 25 };
      }
    }

    const drive = follow(m.speed, m.cruise, holds);
    m.reason = drive.why;
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
      const path = crossPath(world, net, m.shape, m.dir, m.route);
      const at = inside(world, net, m);
      if (at >= path.len) {
        const r = m.route;
        m.shape = r.shape;
        m.dir = r.dir;
        m.s = mouthAt(world, r.shape, r.s, -r.dir) + r.dir * (at - path.len);
        m.across = m.dir * world.shapes[m.shape].halfWidth * 0.5;
        m.route = null;
        m.wait = 0;
      }
    }

    /**
     * ── ТУПИК: разворот на месте. Дорога и её длина берутся заново: выше
     * машина могла переехать на другую дорогу, и старые числа уже не про неё.
     */
    const tail = net.length[m.shape];
    const stopsHere = net.ends[m.shape][m.dir > 0 ? 1 : 0] === null;
    if (stopsHere && (m.dir > 0 ? m.s > tail - 6 : m.s < 6)) {
      const back = -m.dir;
      const busy = movers.some((o) => o !== m && o.shape === m.shape
        && o.dir === back && Math.abs(o.s - m.s) < 14);
      if (busy) { m.speed = 0; m.s = Math.max(2, Math.min(tail - 2, m.s)); }
      else {
        m.dir = back;
        m.s = Math.max(3, Math.min(tail - 3, m.s + m.dir * 2));
        // развернулись — значит и полоса теперь другая. Без этой строки
        // машина ехала по встречной, пока смещение плавно переползало
        // через середину дороги
        m.across = m.dir * world.shapes[m.shape].halfWidth * 0.5;
      }
    }

    // боковое смещение догоняет желаемое: съезд в карман и выезд из него
    const wantSide = wantAcross(world, net, m);
    m.across += Math.max(-0.9 * dt, Math.min(0.9 * dt, wantSide - m.across));

    // курс догоняет дорогу, а не прыгает вместе с ней
    const want = poseOf(world, net, m).yaw;
    const turn = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
    m.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, turn));
  });
}
