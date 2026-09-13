/**
 * ПОЛОСЫ: где именно по дороге можно ехать.
 *
 * Дороги у нас многополосные с самого начала — в «решётке» половина улиц
 * четырёхполосные, в «каше» есть шестиполосные, — но движение до сих пор
 * считало, что полоса в сторону одна, и ставило машину на `полуширина / 2`.
 * На четырёхполосной это 4.08 м при середине полосы 2.75: машина всю дорогу
 * жалась к разметке, вторая полоса не существовала, обгонять было негде.
 *
 * ГЛАВНОЕ УСТРОЙСТВО. Полоса не задаётся числом и не подбирается. Она берётся
 * ИЗ ТОЙ ЖЕ таблицы, по которой красится асфальт (`bands` в модуле дороги),
 * и из направления, записанного там же. Поэтому «машина едет по разметке»
 * и «полос в модели больше, чем на асфальте» невыразимы, а не отлавливаются.
 *
 * Нумерация: 0 — самая правая по ходу движения. Так считают и ПДД
 * («занимать правую свободную», 9.4), и дорожная инженерия. Обгон и
 * перестроение влево — это рост номера.
 *
 * Про экран этот файл не знает ничего.
 */

import { bands } from '../world/road.ts';
import type { World } from '../world/world.ts';

/** Одна полоса одной дороги. */
export interface Lane {
  readonly shape: number;
  /** 0 — самая правая по ходу. */
  readonly index: number;
  /** В какую сторону по s едут: +1 по возрастанию, −1 навстречу. */
  readonly dir: 1 | -1;
  /** Середина полосы: метры вправо от осевой, если смотреть по возрастанию s. */
  readonly across: number;
  readonly width: number;
}

/**
 * Полосы одной дороги, уже разложенные по сторонам и упорядоченные.
 * Раскладываются один раз при разборе: в цикле движения их спрашивают
 * десятки тысяч раз за секунду, и фильтровать там заново нельзя.
 */
export interface RoadLanes {
  readonly all: readonly Lane[];
  /** Едущие по возрастанию s, от правой полосы к левой. */
  readonly forward: readonly Lane[];
  /** Едущие навстречу, тоже от правой к левой. */
  readonly backward: readonly Lane[];
}

/** Полосы всех дорог мира, по дорогам. */
export type Lanes = readonly RoadLanes[];

/**
 * Разбор мира на полосы. Считается один раз: дороги не меняются, пока их
 * не перестроят, а тогда пересчитывается весь мир целиком.
 */
export function buildLanes(world: World): Lanes {
  return world.shapes.map((shape, si) => {
    const strips = bands(shape.type);
    const out: Lane[] = [];
    // bands идёт ровно по type.lanes, один к одному: смещения берём оттуда,
    // сторону движения — отсюда. Второй раз складывать ширины нельзя,
    // иначе у полос появится два разных места сразу
    shape.type.lanes.forEach((lane, i) => {
      if (lane.kind !== 'travel' || lane.direction === 0) return;
      const strip = strips[i];
      out.push({
        shape: si,
        index: 0,
        dir: lane.direction,
        across: (strip.from + strip.to) / 2,
        width: strip.to - strip.from,
      });
    });
    /**
     * Нумеруем от правой. Право по ходу — это положительное `across`,
     * умноженное на сторону: у едущих по возрастанию s правая полоса та,
     * что дальше от осевой в плюс, у встречных — та, что дальше в минус.
     */
    const numbered: Lane[] = [];
    const side = (dir: 1 | -1): Lane[] => {
      const mine = out.filter((l) => l.dir === dir);
      mine.sort((a, b) => Math.abs(b.across) - Math.abs(a.across));
      const done = mine.map((l, k) => ({ ...l, index: k }));
      numbered.push(...done);
      return done;
    };
    const forward = side(1);
    const backward = side(-1);
    return { all: numbered, forward, backward };
  });
}

/** Полосы одной дороги в одну сторону, от правой к левой. */
export function sideOf(lanes: Lanes, shape: number, dir: 1 | -1): readonly Lane[] {
  return dir > 0 ? lanes[shape].forward : lanes[shape].backward;
}

/** Сколько полос в эту сторону. Ноль — по этой дороге туда не ездят. */
export function laneCount(lanes: Lanes, shape: number, dir: 1 | -1): number {
  return sideOf(lanes, shape, dir).length;
}

/**
 * Середина полосы номер `index`. Номер больше, чем есть, прижимается
 * к самой левой: «полоса номер пять на двухполосной» невыразима не потому,
 * что запрещена, а потому, что её неоткуда взять.
 */
export function laneAcross(lanes: Lanes, shape: number, dir: 1 | -1, index: number): number {
  const side = sideOf(lanes, shape, dir);
  if (side.length === 0) return dir * world_half(lanes, shape) * 0.5;
  const pick = side[Math.max(0, Math.min(side.length - 1, Math.round(index)))];
  return pick.across;
}

/**
 * Запасной ответ, если у дороги нет полос для езды вовсе (такое бывает
 * у совсем узких): половина того, что есть. Отдельного случая в правилах
 * это не создаёт — просто число, от которого можно оттолкнуться.
 */
function world_half(lanes: Lanes, shape: number): number {
  const all = lanes[shape].all;
  if (all.length === 0) return 0;
  return Math.max(...all.map((l) => Math.abs(l.across)));
}

/** На какой полосе оказалось это боковое смещение. Ближайшая по середине. */
export function laneAt(lanes: Lanes, shape: number, dir: 1 | -1, across: number): number {
  const side = sideOf(lanes, shape, dir);
  if (side.length === 0) return 0;
  let best = 0, near = Infinity;
  for (const l of side) {
    const d = Math.abs(l.across - across);
    if (d < near) { near = d; best = l.index; }
  }
  return best;
}
