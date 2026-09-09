/**
 * Светофоры. Один на перекрёсток, где сходятся три дороги и больше.
 *
 * Устройство взято у дорожной инженерии, а не придумано: у фазы есть зелёный,
 * потом жёлтый (переход, машина не может встать мгновенно), потом «всё
 * красное» — время на то, чтобы перекрёсток опустел. Дальше другая фаза.
 * Типовые длительности для городской улицы: жёлтый 3 с, всё красное 2 с.
 *
 * Направления делятся на две группы по оси подъезда: север-юг и запад-восток.
 * Для решётки это ровно то, что нужно, и для косых перекрёстков тоже работает:
 * группа выбирается по тому, к какой оси ближе направление въезда.
 */

import type { World } from '../world/world.ts';

export type Light = 'зелёный' | 'жёлтый' | 'красный';

/** Одна ветка перекрёстка: откуда в него въезжают. */
export interface Approach {
  /** Дорога и метр, на котором она упирается в перекрёсток. */
  readonly shape: number;
  readonly s: number;
  /** В какую сторону по s едут, чтобы попасть в перекрёсток. */
  readonly dir: number;
  /** Куда смотрит машина, въезжая: радианы. */
  readonly heading: number;
  /** Группа фазы: 0 или 1. */
  readonly group: number;
  /** Где стоп-линия: метр на дороге. */
  readonly stopS: number;
}

export interface Signal {
  readonly junction: number;
  readonly x: number;
  readonly z: number;
  readonly approaches: Approach[];
  /** Сдвиг фазы, чтобы соседние перекрёстки не мигали в такт. */
  readonly offset: number;
}

/**
 * Где стоп-линия: метр на дороге, за которым дорога кончается и начинается
 * сам перекрёсток. Одна формула на весь город — и светофор, и трафик берут
 * край перекрёстка отсюда. Второго способа мерить этот край нет, и потому
 * «стоп-линия в одном месте, а перекрёсток начинается в другом» невыразимо.
 */
export function stopLine(halfWidth: number, s: number, dir: number): number {
  return s - dir * (halfWidth + 2.5);
}

/** Длительности одной фазы, секунды. */
export const GREEN = 14;
export const YELLOW = 4;
export const ALL_RED = 2;
const PHASE = GREEN + YELLOW + ALL_RED;
const CYCLE = PHASE * 2;

/**
 * Разбор сети на светофоры. Считается один раз по геометрии: у мира графа
 * развязок нет, есть точки узлов и дороги, которые в них упираются.
 */
export function buildSignals(world: World): Signal[] {
  const signals: Signal[] = [];

  world.junctions.forEach((j, ji) => {
    const approaches: Approach[] = [];
    world.shapes.forEach((shape, si) => {
      const st = shape.stations;
      for (const end of [0, st.length - 1]) {
        const station = st[end];
        if (Math.hypot(station.x - j.x, station.z - j.z) > 7) continue;
        // въезжаем В перекрёсток: значит едем к этому концу
        const dir = end === 0 ? -1 : 1;
        const back = st[end === 0 ? Math.min(3, st.length - 1) : Math.max(0, st.length - 4)];
        const heading = Math.atan2(station.z - back.z, station.x - back.x);
        approaches.push({
          shape: si,
          s: station.s,
          dir,
          heading,
          group: Math.abs(Math.cos(heading)) > Math.abs(Math.sin(heading)) ? 0 : 1,
          stopS: stopLine(shape.halfWidth, station.s, dir),
        });
      }
    });
    if (approaches.length < 3) return;
    // светофор нужен только там, где есть обе группы: иначе это не пересечение
    if (!approaches.some((a) => a.group === 0) || !approaches.some((a) => a.group === 1)) return;
    signals.push({ junction: ji, x: j.x, z: j.z, approaches, offset: (ji * 7) % CYCLE });
  });

  return signals;
}

/**
 * Какой свет горит этой ветке и сколько ему осталось.
 *
 * Остаток нужен для жёлтого: водитель едет на жёлтый не потому, что «жёлтый
 * разрешает», а потому, что успевает освободить перекрёсток до красного.
 * Без остатка приходится гадать, и часть машин выезжает уже на красный.
 */
export function lightFor(signal: Signal, approach: Approach, time: number): { light: Light; left: number } {
  const t = (time + signal.offset) % CYCLE;
  const mine = approach.group === 0 ? t < PHASE : t >= PHASE;
  const inPhase = approach.group === 0 ? t : t - PHASE;
  if (!mine) {
    // до своего зелёного: либо ждём вторую половину цикла, либо первую
    const untilMine = approach.group === 0 ? CYCLE - t : PHASE - t;
    return { light: 'красный', left: untilMine };
  }
  if (inPhase < GREEN) return { light: 'зелёный', left: GREEN - inPhase };
  if (inPhase < GREEN + YELLOW) return { light: 'жёлтый', left: GREEN + YELLOW - inPhase };
  return { light: 'красный', left: PHASE - inPhase };
}

/**
 * Пешеходам зелёный тогда, когда красный тем, кто их пересекает.
 * Переход через дорогу группы 0 разрешён, пока едет группа 1.
 */
export function walkLight(signal: Signal, crossesGroup: number, time: number): { light: Light; left: number } {
  const t = (time + signal.offset) % CYCLE;
  const carsGoing = t < PHASE ? 0 : 1;
  const inPhase = t < PHASE ? t : t - PHASE;
  if (carsGoing === crossesGroup) return { light: 'красный', left: PHASE - inPhase };
  // последние секунды зелёной фазы — уже не начинать переход
  return inPhase < GREEN - 5
    ? { light: 'зелёный', left: GREEN - 5 - inPhase }
    : { light: 'жёлтый', left: GREEN + YELLOW - inPhase };
}
