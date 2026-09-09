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
import { type Approach, type Signal, buildSignals, lightFor } from './signals.ts';

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

/** Радиус коробки перекрёстка: внутри неё двум машинам тесно. */
const BOX = 11;
/** За сколько секунд ожидания на перекрёстке водитель перестаёт уступать. */
const PATIENCE = 6;

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
   * Какой перекрёсток эта машина заняла. Занятость меряется НЕ радиусом,
   * а владением: въехать может только владелец, и он держит перекрёсток,
   * пока не проедет его насквозь. Радиус не годится — машина входит в него
   * не мгновенно, и двое успевают оказаться внутри одновременно.
   */
  claim: number;
  /** Сколько секунд стоим и уступаем. Против вечного взаимного «после вас». */
  wait: number;
  /** Что сейчас держит: для приборки и проверок. */
  reason: string;
  /**
   * Своё зерно случайности. Общий Math.random() делал каждый прогон другим,
   * и проверка переставала быть повторяемой: одна и та же поломка то ловилась,
   * то нет. Теперь выбор поворота зависит только от машины и её пути.
   */
  seed: number;
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
      claim: -1,
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

/** Куда машина смотрит и где стоит: правостороннее движение. */
export function poseOf(world: World, m: Mover): { x: number; z: number; yaw: number } {
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

/** Сколько метров до перекрёстка впереди и что это за перекрёсток. */
export function nextJunction(net: Network, m: Mover): { end: End; stopGap: number; centreGap: number } | null {
  const slot = m.dir > 0 ? 1 : 0;
  const end = net.ends[m.shape][slot];
  if (end === null) return null;
  const total = net.length[m.shape];
  const atS = slot === 1 ? total : 0;
  const signal = end.signal >= 0 ? net.signals[end.signal] : null;
  const stopS = signal === null ? atS - m.dir * 9 : signal.approaches[end.approach].stopS;
  return { end, stopGap: (stopS - m.s) * m.dir, centreGap: (atS - m.s) * m.dir };
}

/** Что машина видит перед собой на перекрёстке: для проверок и приборки. */
export function watch(net: Network, m: Mover, time: number): {
  junction: number; stopGap: number; centreGap: number; light: string;
} | null {
  const ahead = nextJunction(net, m);
  if (ahead === null) return null;
  const signal = ahead.end.signal >= 0 ? net.signals[ahead.end.signal] : null;
  const light = signal === null ? 'нерегулируемый'
    : lightFor(signal, signal.approaches[ahead.end.approach], time).light;
  return { junction: ahead.end.junction, stopGap: ahead.stopGap, centreGap: ahead.centreGap, light };
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
  const spots = movers.map((m) => poseOf(world, m));
  const targets = movers.map((m) => nextJunction(net, m));

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
    return { shape: at.shape, s: at.s, across: at.across, dir, speed: Math.abs(p.speed), x: p.x, z: p.z };
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
    const clears = m.speed > 1 && (t.centreGap + BOX) / m.speed < left;
    return canStop && !clears;
  });

  /**
   * Владение перекрёстками. Сначала те, кто уже владеет, отпускают его,
   * когда проехали; потом свободный перекрёсток достаётся ближайшему из тех,
   * кому свет разрешает. Всё это ДО того, как кто-либо тронулся: иначе
   * решение зависит от места в списке.
   */
  const holder = world.junctions.map(() => -1);
  movers.forEach((m, i) => {
    if (m.claim < 0) return;
    const j = world.junctions[m.claim];
    const away = Math.hypot(spots[i].x - j.x, spots[i].z - j.z);
    const leaving = targets[i] === null || targets[i]!.end.junction !== m.claim;
    if (away > BOX + 5 && leaving) m.claim = -1; else holder[m.claim] = i;
  });
  if (you !== null) {
    world.junctions.forEach((j, ji) => {
      if (Math.hypot(you.x - j.x, you.z - j.z) < BOX && holder[ji] < 0) holder[ji] = -2;
    });
  }
  movers.forEach((m, i) => {
    const t = targets[i];
    if (m.claim >= 0 || t === null || onRed[i]) return;
    if (t.centreGap <= 0 || t.centreGap > 30) return;
    if (holder[t.end.junction] !== -1) return;
    // ближайший из претендентов — и только он
    const rival = movers.findIndex((o, k) => k !== i && o.claim < 0 && !onRed[k]
      && targets[k] !== null && targets[k]!.end.junction === t.end.junction
      && targets[k]!.centreGap > 0 && targets[k]!.centreGap < t.centreGap);
    if (rival >= 0) return;
    m.claim = t.end.junction;
    holder[t.end.junction] = i;
  });

  movers.forEach((m, index) => {
    const total = net.length[m.shape];
    const holds: Hold[] = [];

    // ── поворот дороги впереди: смотрим на несколько шагов вперёд
    for (const look of [8, 18, 32]) {
      const at = m.s + m.dir * look;
      if (at < 0 || at > total) continue;
      const limit = Math.sqrt(COMFORT * G * radius(world, m.shape, at));
      if (limit < m.cruise) holds.push({ gap: look, speed: limit, why: 'поворот' });
    }

    // ── машина впереди. Припаркованная стоит в кармане и полосу не держит:
    // мешает только тот, кто примерно на моей линии движения
    if (headway) {
      for (const other of movers) {
        if (other === m || other.shape !== m.shape || other.dir !== m.dir) continue;
        if (Math.abs(other.across - m.across) > 2.2) continue;
        const gap = (other.s - m.s) * m.dir - LENGTH;
        if (gap > 0 && gap < 60) holds.push({ gap, speed: other.speed, why: 'машина впереди' });
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

    // ── перекрёсток: светофор, занятая коробка, помеха справа
    const ahead = nextJunction(net, m);
    let mustYield = false;
    if (rules && ahead !== null && ahead.stopGap > -2 && ahead.stopGap < 70) {
      const { end } = ahead;
      const signal = end.signal >= 0 ? net.signals[end.signal] : null;
      const approach: Approach | null = signal === null ? null : signal.approaches[end.approach];

      if (signal !== null && approach !== null) {
        if (onRed[index]) mustYield = true;
      } else if (ahead.stopGap < 24) {
        // ── нерегулируемый: уступаем помехе справа
        const mine = Math.atan2(along(world, m.shape, m.s).fz * m.dir, along(world, m.shape, m.s).fx * m.dir);
        for (const other of movers) {
          if (other === m || other.speed < 0.8) continue;
          const theirs = nextJunction(net, other);
          if (theirs === null || theirs.end.junction !== end.junction) continue;
          if (theirs.centreGap < 0 || theirs.centreGap > 22) continue;
          const oPose = poseOf(world, other);
          const delta = Math.atan2(Math.sin(oPose.yaw - mine), Math.cos(oPose.yaw - mine));
          // помеха справа: тот, кто едет с курсом на 90° меньше моего
          if (delta < -Math.PI / 4 && delta > -Math.PI * 0.75 && theirs.centreGap < ahead.centreGap + 4) {
            mustYield = true;
          }
        }
      }

      /**
       * В занятую коробку не въезжаем ни при каком свете. Занятость меряется
       * НАСТОЯЩИМ расстоянием до узла: вдоль дороги её не видно, потому что
       * на перекрёстке машина переходит с одного участка на другой и её
       * «метр вдоль» скачет.
       */
      // в перекрёсток въезжает только его владелец
      if (ahead.centreGap > 1 && m.claim !== end.junction) mustYield = true;

      /**
       * Терпение кончилось — едем: иначе четверо на нерегулируемом встанут
       * навсегда, каждый уступая соседу. На СВЕТОФОРЕ терпения нет: там
       * ждать положено, и «я устал» — это проезд на красный.
       */
      if (m.speed < 0.5 && mustYield) m.wait += dt; else m.wait = Math.max(0, m.wait - dt * 0.5);
      if (m.wait > PATIENCE && signal === null) mustYield = false;

      if (mustYield && ahead.stopGap > -1) {
        holds.push({ gap: Math.max(0.4, ahead.stopGap), speed: 0, why: signal ? 'красный' : 'уступает' });
      }
    }

    // ── пешеход на переходе: пропускаем, даже если нам зелёный
    if (rules) {
      for (const p of options.crossing ?? []) {
        if (p.shape !== m.shape) continue;
        const gap = (p.s - m.s) * m.dir;
        if (gap > 0 && gap < 30) holds.push({ gap, speed: 0, why: 'пешеход' });
      }
    }

    // ── конец дороги без перекрёстка: разворот
    const deadEnd = net.ends[m.shape][m.dir > 0 ? 1 : 0] === null;
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
    } else if (m.speed > 3 && roll(m) < 0.0015) {
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

    // ── развязка: доехали до конца участка — выбираем следующий
    const nearEnd = m.dir > 0 ? m.s > total - (deadEnd ? 6 : 3) : m.s < (deadEnd ? 6 : 3);
    if (nearEnd) {
      const endS = m.dir > 0 ? total : 0;
      const node = net.nodes[m.shape].find((n) => Math.abs(n.s - endS) < 8);
      const exits = node === undefined ? [] : net.atJunction[node.junction]
        .filter((l) => l.shape !== m.shape)
        .filter((l) => !movers.some((o) => o !== m && o.shape === l.shape && Math.abs(o.s - l.s) < 14));
      if (exits.length > 0) {
        const pick = exits[Math.floor(roll(m) * exits.length) % exits.length];
        const tail = net.length[pick.shape];
        m.shape = pick.shape;
        m.s = pick.s;
        m.dir = pick.s < tail / 2 ? 1 : -1;
        m.s += m.dir * 1;
        m.wait = 0;
        m.across = m.dir * world.shapes[m.shape].halfWidth * 0.5;
      } else {
        const back = -m.dir;
        const busy = movers.some((o) => o !== m && o.shape === m.shape
          && o.dir === back && Math.abs(o.s - m.s) < 14);
        if (busy) { m.speed = 0; m.s = Math.max(2, Math.min(total - 2, m.s)); }
        else {
          m.dir = back;
          m.s = Math.max(3, Math.min(total - 3, m.s + m.dir * 2));
          // развернулись — значит и полоса теперь другая. Без этой строки
          // машина ехала по встречной, пока смещение плавно переползало
          // через середину дороги
          m.across = m.dir * world.shapes[m.shape].halfWidth * 0.5;
        }
      }
    }

    // боковое смещение догоняет желаемое: съезд в карман и выезд из него
    const wantSide = wantAcross(world, net, m);
    m.across += Math.max(-0.9 * dt, Math.min(0.9 * dt, wantSide - m.across));

    // курс догоняет дорогу, а не прыгает вместе с ней
    const want = poseOf(world, m).yaw;
    const turn = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
    m.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, turn));
  });
}
