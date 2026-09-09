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

export interface Network {
  readonly length: number[];
  readonly atJunction: Link[][];
  readonly nodes: { s: number; junction: number }[][];
  readonly signals: Signal[];
  /** По дороге: конец при s=0 и конец при s=длина. */
  readonly ends: (End | null)[][];
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

  return { length, atJunction, nodes, signals, ends };
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

/** Насколько круто дорога заворачивает здесь: радиус в метрах. */
function radius(world: World, shape: number, s: number): number {
  const back = along(world, shape, s - 5), fwd = along(world, shape, s + 5);
  const turn = Math.atan2(fwd.fz, fwd.fx) - Math.atan2(back.fz, back.fx);
  const wrapped = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  return wrapped < 1e-4 ? 1e5 : 10 / wrapped;
}

const COLOURS = [0x9fa5ab, 0x2b3a4a, 0x7d2b2b, 0xd8d3c6, 0x35513f, 0x1c1e22, 0x8a7b4f];

export function placeTraffic(world: World, net: Network, count: number, seed = 1): Mover[] {
  let rnd = seed * 9301 + 49297;
  const next = (): number => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };

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
      cruise: CRUISE * (0.6 + next() * 0.4),
      yaw: Math.atan2(spot.fz * dir, spot.fx * dir),
      colour: COLOURS[Math.floor(next() * COLOURS.length) % COLOURS.length],
    });
  }
  return movers;
}

/** Свой генератор: одна и та же машина в одном и том же месте решит одинаково. */
function roll(m: Mover): number {
  m.seed = (m.seed * 1103515245 + 12345) % 2147483648;
  return m.seed / 2147483648;
}

/** Куда машина смотрит и где стоит: правостороннее движение. */
export function poseOf(world: World, m: Mover): { x: number; z: number; yaw: number } {
  const spot = along(world, m.shape, m.s);
  const fx = spot.fx * m.dir, fz = spot.fz * m.dir;
  // право по ходу — это cross(вперёд, вверх) = (−fz, fx)
  const lane = world.shapes[m.shape].halfWidth * 0.5;
  return { x: spot.x - fz * lane, z: spot.z + fx * lane, yaw: Math.atan2(fz, fx) };
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
  options: { headway?: boolean; rules?: boolean; crossing?: readonly OnCrossing[] } = {},
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
  const occupied = world.junctions.map(() => 0);
  const inBox = movers.map((_, i) => {
    let where = -1;
    world.junctions.forEach((j, ji) => {
      if (Math.hypot(spots[i].x - j.x, spots[i].z - j.z) < BOX) { occupied[ji]++; where = ji; }
    });
    return where;
  });

  const targets = movers.map((m) => nextJunction(net, m));
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
   * Кто первый в очереди на въезд в каждый перекрёсток. Только он может
   * заехать, и только в пустую коробку: иначе двое, увидев пустой
   * перекрёсток в одно и то же мгновение, въезжают в него вместе.
   */
  const firstAt = new Map<number, number>();
  movers.forEach((m, i) => {
    const t = targets[i];
    if (t === null || onRed[i] || t.centreGap <= 0 || t.centreGap > 34) return;
    const best = firstAt.get(t.end.junction);
    if (best === undefined || t.centreGap < (targets[best]?.centreGap ?? Infinity)) {
      firstAt.set(t.end.junction, i);
    }
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

    // ── машина впереди
    if (headway) {
      for (const other of movers) {
        if (other === m || other.shape !== m.shape || other.dir !== m.dir) continue;
        const gap = (other.s - m.s) * m.dir - LENGTH;
        if (gap > 0 && gap < 60) holds.push({ gap, speed: other.speed, why: 'машина впереди' });
      }
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
      if (ahead.centreGap > 1 && inBox[index] < 0) {
        if (occupied[end.junction] > 0) mustYield = true;
        if (firstAt.get(end.junction) !== index) mustYield = true;
      }

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
      } else {
        const back = -m.dir;
        const busy = movers.some((o) => o !== m && o.shape === m.shape
          && o.dir === back && Math.abs(o.s - m.s) < 14);
        if (busy) { m.speed = 0; m.s = Math.max(2, Math.min(total - 2, m.s)); }
        else { m.dir = back; m.s = Math.max(3, Math.min(total - 3, m.s + m.dir * 2)); }
      }
    }

    // курс догоняет дорогу, а не прыгает вместе с ней
    const want = poseOf(world, m).yaw;
    const turn = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
    m.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, turn));
  });
}
